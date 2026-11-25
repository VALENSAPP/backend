import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Stripe from 'stripe';
import { PrismaService } from '../../prisma/prisma.service';
import { assertUserKyc } from '../../common/kyc.util';
import {
    formatCurrencyAmount,
    getCurrencySymbol,
    resolvePaymentProviderFromCountry,
} from '../../common/payment-provider.util';
import { WalletService } from '../../wallet/wallet.service';
import { CreateBookingDto, PayBookingDto } from '../dto/booking.dto';
import { getServiceFeePercent } from '../pro-services.constants';
import { toMajor } from '../pro-services.utils';
import { ProviderService } from './provider.service';
import { PlannedSession, SchedulingService } from './scheduling.service';

type Tx = Prisma.TransactionClient;

/** Metadata type used on Stripe checkout sessions and payment intents for service bookings. */
export const SERVICE_BOOKING_STRIPE_TYPE = 'service_booking';

/** How long a slot is held while the client is on Review Order / Payment Method. */
const HOLD_MINUTES = Number(process.env.SERVICES_HOLD_MINUTES || 15);
/** Stripe checkout links live at least 30 minutes, so card payments extend the hold to match. */
const CARD_CHECKOUT_MINUTES = 30;
const MAX_OPEN_HOLDS_PER_BUYER = 3;

const BOOKABLE_TYPES = ['MENTORSHIP', 'CONSULTATION', 'APPOINTMENT'] as const;
const PAID_STATUSES = ['CONFIRMED', 'IN_PROGRESS', 'COMPLETED'] as const;

const BOOKING_INCLUDE = {
    service: {
        select: {
            id: true,
            type: true,
            title: true,
            coverImage: true,
            format: true,
            durationMinutes: true,
            timezone: true,
            address: true,
            city: true,
            country: true,
            contactPhone: true,
            mentorship: { select: { programType: true, programLengthWeeks: true, sessionsCount: true, mode: true } },
        },
    },
    sessions: { orderBy: { startAt: 'asc' } },
    cohort: { select: { id: true, startAt: true } },
    provider: { select: { id: true, userName: true, displayName: true, image: true } },
    buyer: { select: { id: true, userName: true, displayName: true, image: true } },
} satisfies Prisma.ServiceBookingInclude;

type FullBooking = Prisma.ServiceBookingGetPayload<{ include: typeof BOOKING_INCLUDE }>;

@Injectable()
export class BookingService {
    private readonly logger = new Logger(BookingService.name);
    private readonly stripe: Stripe;

    constructor(
        private readonly prisma: PrismaService,
        private readonly scheduling: SchedulingService,
        private readonly providerService: ProviderService,
        private readonly walletService: WalletService,
    ) {
        this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, { apiVersion: '2024-06-20' });
    }

    // ------------------------------------------------------------------
    // Screen C5-C7: choose a time / cohort -> hold it -> Review Order
    // ------------------------------------------------------------------

    async createBooking(buyerId: string, serviceId: string, dto: CreateBookingDto) {
        const service = await this.scheduling.loadSchedulable(serviceId);
        if (service.status !== 'ACTIVE') throw new NotFoundException('Service not found');
        if (!(BOOKABLE_TYPES as readonly string[]).includes(service.type)) {
            throw new BadRequestException(
                service.type === 'EVENT' ? 'Events are bought with tickets' : 'Monthly packages are bought by subscribing',
            );
        }
        if (service.providerUserId === buyerId) throw new BadRequestException("You can't book your own service");
        if (service.priceMinor <= 0) throw new BadRequestException('This service has no price set');

        const providerEligibility = await this.providerService.getEligibility(service.providerUserId);
        if (!providerEligibility.canSell) throw new BadRequestException('This service is not available right now');

        const openHolds = await this.prisma.serviceBooking.count({
            where: { buyerId, status: 'PENDING_PAYMENT', holdExpiresAt: { gt: new Date() } },
        });
        if (openHolds >= MAX_OPEN_HOLDS_PER_BUYER) {
            throw new BadRequestException('You have unfinished bookings. Complete or wait for them to expire first.');
        }

        // Work out the first session time and how it was chosen
        const isGroup = service.mentorship?.mode === 'GROUP';
        let firstStart: Date;
        let startOption: 'SLOT' | 'COHORT';
        let cohortId: string | null = null;

        if (dto.cohortId) {
            if (service.type !== 'MENTORSHIP') throw new BadRequestException('Cohorts are only for mentorships');
            const cohort = await this.prisma.mentorshipCohort.findFirst({
                where: { id: dto.cohortId, serviceId, isActive: true },
            });
            if (!cohort || cohort.startAt.getTime() <= Date.now()) throw new BadRequestException('This cohort is no longer open');
            if (cohort.seatsTaken >= cohort.seatsTotal) throw new ConflictException('This cohort is full');
            firstStart = cohort.startAt;
            startOption = 'COHORT';
            cohortId = cohort.id;
        } else {
            if (isGroup) throw new BadRequestException('Choose a cohort to join this group mentorship');
            if (service.mentorship && !service.mentorship.allowCustomStart) {
                throw new BadRequestException('Choose one of the available start dates');
            }
            if (!dto.startAt) throw new BadRequestException('Choose a time');
            firstStart = new Date(dto.startAt);
            if (Number.isNaN(firstStart.getTime())) throw new BadRequestException('Invalid time');
            if (firstStart.getTime() < Date.now() + this.scheduling.minNoticeMinutes(service) * 60000) {
                throw new BadRequestException('This time is too soon. Choose a later time.');
            }
            if (!this.scheduling.isInsideAvailability(service, firstStart)) {
                throw new BadRequestException('This time is not available. Choose a time from the list.');
            }
            startOption = 'SLOT';
        }

        const planned = this.scheduling.planSessions(service, firstStart);

        // Later program sessions must also fall inside availability (not needed for provider-defined cohorts)
        if (startOption === 'SLOT') {
            const outside = planned.slice(1).find((p) => !this.scheduling.isInsideAvailability(service, p.startAt));
            if (outside) {
                throw new BadRequestException(
                    `Session on ${outside.startAt.toISOString()} falls outside the provider's availability. Choose another start time.`,
                );
            }
        }

        const unitPriceMinor = service.priceMinor;
        const quantity = planned.length;
        const amountMinor = unitPriceMinor * quantity;
        const feePercent = getServiceFeePercent(service.type);
        const feeMinor = Math.round(amountMinor * feePercent);
        const providerNetMinor = Math.max(0, amountMinor - feeMinor);
        const holdExpiresAt = new Date(Date.now() + HOLD_MINUTES * 60000);

        const booking = await this.prisma.$transaction(async (tx) => {
            // One booking at a time per provider, so two clients can't take the same slot
            await this.lockProvider(tx, service.providerUserId);

            if (startOption === 'SLOT') {
                const conflicts = await this.scheduling.findConflicts(tx, service, planned);
                if (conflicts.length) {
                    throw new ConflictException({
                        statusCode: 409,
                        error: 'Conflict',
                        code: 'SLOT_TAKEN',
                        message: 'This time was just booked. Please choose another time.',
                        conflicts: conflicts.map((c) => c.startAt),
                    });
                }
            } else if (cohortId) {
                // Safe without a column-to-column check: bookings for this provider run one at a time (lock above)
                const taken = await this.retakeCohortSeat(tx, cohortId);
                if (!taken) throw new ConflictException('This cohort is full');
            }

            return tx.serviceBooking.create({
                data: {
                    serviceId: service.id,
                    buyerId,
                    providerUserId: service.providerUserId,
                    cohortId,
                    status: 'PENDING_PAYMENT',
                    currency: service.currency,
                    unitPriceMinor,
                    quantity,
                    amountMinor,
                    feePercent,
                    feeMinor,
                    providerNetMinor,
                    note: dto.note?.trim() || null,
                    startOption,
                    requestedStartAt: firstStart,
                    holdExpiresAt,
                    sessions: {
                        create: planned.map((p: PlannedSession) => ({
                            serviceId: service.id,
                            providerUserId: service.providerUserId,
                            clientUserId: buyerId,
                            startAt: p.startAt,
                            endAt: p.endAt,
                        })),
                    },
                },
                include: BOOKING_INCLUDE,
            });
        });

        return {
            booking: this.present(booking, buyerId),
            paymentOptions: await this.paymentOptions(buyerId, booking.currency, booking.amountMinor),
        };
    }

    // ------------------------------------------------------------------
    // Screen C8-C9: Payment Method -> pay
    // ------------------------------------------------------------------

    async payBooking(buyerId: string, bookingId: string, dto: PayBookingDto) {
        const booking = await this.prisma.serviceBooking.findUnique({ where: { id: bookingId }, include: BOOKING_INCLUDE });
        if (!booking || booking.buyerId !== buyerId) throw new NotFoundException('Booking not found');
        if ((PAID_STATUSES as readonly string[]).includes(booking.status)) {
            return { paid: true, method: booking.paymentMethod, booking: this.present(booking, buyerId) };
        }
        if (booking.status !== 'PENDING_PAYMENT' || !booking.holdExpiresAt || booking.holdExpiresAt.getTime() <= Date.now()) {
            throw new BadRequestException('This booking expired. Please choose a time again.');
        }

        await assertUserKyc(this.prisma, buyerId, 'PAYER');
        await assertUserKyc(this.prisma, booking.providerUserId, 'RECEIVER');

        if (dto.method === 'WALLET') {
            await this.prisma.$transaction(async (tx) => {
                await this.lockProvider(tx, booking.providerUserId);
                const fresh = await tx.serviceBooking.findUnique({ where: { id: bookingId } });
                if (!fresh || fresh.status !== 'PENDING_PAYMENT') {
                    throw new BadRequestException('This booking can no longer be paid');
                }
                await this.walletService.debitAvailableForPurchase(
                    {
                        userId: buyerId,
                        amountMinor: booking.amountMinor,
                        currency: booking.currency,
                        provider: 'STRIPE',
                        source: 'SERVICES',
                        refType: 'SERVICE_BOOKING',
                        refId: booking.id,
                        note: `Service booking: ${booking.service.title}`,
                    },
                    tx,
                );
                await this.confirmInTx(tx, bookingId, { method: 'WALLET', provider: 'WALLET' });
            });

            const paid = await this.prisma.serviceBooking.findUnique({ where: { id: bookingId }, include: BOOKING_INCLUDE });
            return { paid: true, method: 'WALLET', booking: this.present(paid as FullBooking, buyerId) };
        }

        // CARD: same Stripe Checkout flow as the marketplace
        const buyer = await this.prisma.user.findUnique({ where: { id: buyerId }, select: { country: true } });
        const provider = resolvePaymentProviderFromCountry(buyer?.country);
        if (provider !== 'STRIPE') throw new BadRequestException('Card payment is not available in your country yet');

        // Reuse an open checkout instead of creating a second one
        if (booking.stripeCheckoutSessionId) {
            try {
                const existing = await this.stripe.checkout.sessions.retrieve(booking.stripeCheckoutSessionId);
                if (existing.status === 'open' && existing.url) return this.cardResponse(booking, existing);
            } catch (error: any) {
                this.logger.warn(`Could not reuse checkout ${booking.stripeCheckoutSessionId}: ${error?.message || error}`);
            }
        }

        const successUrl = process.env.SERVICES_STRIPE_SUCCESS_URL || process.env.STRIPE_SUCCESS_URL;
        const cancelUrl = process.env.SERVICES_STRIPE_CANCEL_URL || process.env.STRIPE_CANCEL_URL;
        if (!successUrl || !cancelUrl) throw new BadRequestException('Missing STRIPE_SUCCESS_URL/STRIPE_CANCEL_URL env vars');

        const expiresAtSec = Math.floor(Date.now() / 1000) + (CARD_CHECKOUT_MINUTES + 1) * 60;
        const metadata = {
            type: SERVICE_BOOKING_STRIPE_TYPE,
            bookingId: booking.id,
            serviceId: booking.serviceId,
            buyerId,
            providerUserId: booking.providerUserId,
        };

        let session: Stripe.Checkout.Session;
        try {
            session = await this.stripe.checkout.sessions.create({
                mode: 'payment',
                success_url: successUrl,
                cancel_url: cancelUrl,
                expires_at: expiresAtSec,
                line_items: [
                    {
                        quantity: 1,
                        price_data: {
                            currency: booking.currency,
                            unit_amount: booking.amountMinor,
                            product_data: {
                                name: booking.service.title,
                                description:
                                    booking.quantity > 1
                                        ? `${booking.quantity} sessions x ${formatCurrencyAmount(toMajor(booking.unitPriceMinor), booking.currency)}`
                                        : `${booking.service.durationMinutes || ''} min session`.trim(),
                            },
                        },
                    },
                ],
                metadata,
                payment_intent_data: { transfer_group: booking.id, metadata },
            });
        } catch (error: any) {
            this.logger.error(`Stripe checkout failed for booking ${booking.id}: ${error?.message || error}`);
            throw new BadRequestException('Stripe API failure while creating checkout session');
        }

        const holdUntil = new Date((expiresAtSec + 60) * 1000);
        const updated = await this.prisma.serviceBooking.update({
            where: { id: booking.id },
            data: {
                stripeCheckoutSessionId: session.id,
                paymentMethod: 'CARD',
                paymentProvider: 'STRIPE',
                holdExpiresAt:
                    booking.holdExpiresAt && booking.holdExpiresAt > holdUntil ? booking.holdExpiresAt : holdUntil,
            },
            include: BOOKING_INCLUDE,
        });
        return this.cardResponse(updated, session);
    }

    // ------------------------------------------------------------------
    // Screen C9 / C10: Processing -> Payment Successful
    // ------------------------------------------------------------------

    async getBooking(userId: string, bookingId: string) {
        const booking = await this.prisma.serviceBooking.findUnique({ where: { id: bookingId }, include: BOOKING_INCLUDE });
        if (!booking || (booking.buyerId !== userId && booking.providerUserId !== userId)) {
            throw new NotFoundException('Booking not found');
        }
        return this.present(booking, userId);
    }

    // ------------------------------------------------------------------
    // Stripe webhook entry points (called from BillingWebhookController)
    // ------------------------------------------------------------------

    async handleCheckoutCompleted(session: Stripe.Checkout.Session) {
        if (session.metadata?.type !== SERVICE_BOOKING_STRIPE_TYPE) return;
        if (session.payment_status !== 'paid') return;
        const bookingId = session.metadata?.bookingId;
        const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
        if (bookingId) await this.confirmFromStripe(bookingId, paymentIntentId || null);
    }

    async handlePaymentIntentSucceeded(paymentIntent: Stripe.PaymentIntent) {
        if (paymentIntent.metadata?.type !== SERVICE_BOOKING_STRIPE_TYPE) return;
        const bookingId = paymentIntent.metadata?.bookingId;
        if (bookingId) await this.confirmFromStripe(bookingId, paymentIntent.id);
    }

    async handleCheckoutExpired(session: Stripe.Checkout.Session) {
        if (session.metadata?.type !== SERVICE_BOOKING_STRIPE_TYPE) return;
        const bookingId = session.metadata?.bookingId;
        if (bookingId) await this.expireBooking(bookingId, { expireStripe: false });
    }

    /**
     * Card payment succeeded. Idempotent: the webhook can arrive twice (checkout + payment intent).
     * If the hold already expired, the booking is revived when its times are still free;
     * otherwise the payment is refunded in full.
     */
    private async confirmFromStripe(bookingId: string, paymentIntentId: string | null) {
        let refundNeeded = false;

        await this.prisma.$transaction(async (tx) => {
            const booking = await tx.serviceBooking.findUnique({
                where: { id: bookingId },
                include: { sessions: true, service: { include: { mentorship: true, packageDetail: true, availabilityRules: true, availabilityExceptions: true } } },
            });
            if (!booking) {
                this.logger.warn(`Stripe payment for unknown service booking ${bookingId}`);
                return;
            }
            await this.lockProvider(tx, booking.providerUserId);

            if ((PAID_STATUSES as readonly string[]).includes(booking.status) || booking.status === 'REFUNDED') return;

            if (booking.status === 'EXPIRED' || booking.status === 'CANCELLED') {
                const planned = booking.sessions.map((s) => ({ startAt: s.startAt, endAt: s.endAt }));
                const stillFree = booking.cohortId
                    ? await this.retakeCohortSeat(tx, booking.cohortId)
                    : (await this.scheduling.findConflicts(tx, booking.service, planned, booking.id)).length === 0;
                if (!stillFree || planned.some((p) => p.startAt.getTime() <= Date.now())) {
                    await tx.serviceBooking.update({
                        where: { id: bookingId },
                        data: {
                            status: 'REFUNDED',
                            stripePaymentIntentId: paymentIntentId,
                            refundedMinor: booking.amountMinor,
                            cancelReason: 'Paid after the hold expired and the time was no longer free',
                        },
                    });
                    refundNeeded = true;
                    return;
                }
                await tx.serviceSession.updateMany({
                    where: { bookingId, status: 'CANCELLED' },
                    data: { status: 'SCHEDULED', cancelledAt: null, cancelledById: null },
                });
            }

            await this.confirmInTx(tx, bookingId, { method: 'CARD', provider: 'STRIPE', paymentIntentId });
        });

        if (refundNeeded && paymentIntentId) {
            try {
                await this.stripe.refunds.create(
                    { payment_intent: paymentIntentId, reason: 'requested_by_customer', metadata: { bookingId } },
                    { idempotencyKey: `service-booking-late-refund-${bookingId}` },
                );
                this.logger.warn(`Refunded late payment for expired service booking ${bookingId}`);
            } catch (error: any) {
                this.logger.error(`Refund failed for service booking ${bookingId}: ${error?.message || error}`);
            }
        }
    }

    /** Marks a booking paid, credits the provider (pending, per session) and updates counters. */
    private async confirmInTx(
        tx: Tx,
        bookingId: string,
        payment: { method: 'CARD' | 'WALLET'; provider: string; paymentIntentId?: string | null },
    ) {
        const booking = await tx.serviceBooking.findUnique({
            where: { id: bookingId },
            include: { sessions: { orderBy: { startAt: 'asc' } }, service: { select: { id: true, title: true } } },
        });
        if (!booking) return;

        await tx.serviceBooking.update({
            where: { id: bookingId },
            data: {
                status: 'CONFIRMED',
                paymentMethod: payment.method,
                paymentProvider: payment.provider,
                stripePaymentIntentId: payment.paymentIntentId ?? booking.stripePaymentIntentId,
                confirmedAt: new Date(),
                holdExpiresAt: null,
            },
        });

        // Provider share goes to PENDING, split per session so each one can be released when it happens
        const sessions = booking.sessions;
        const count = Math.max(1, sessions.length);
        const base = Math.floor(booking.providerNetMinor / count);
        const remainder = booking.providerNetMinor - base * count;
        for (const [index, session] of sessions.entries()) {
            const amountMinor = base + (index === 0 ? remainder : 0);
            if (amountMinor <= 0) continue;
            await this.walletService.creditPending(
                {
                    userId: booking.providerUserId,
                    amountMinor,
                    currency: booking.currency,
                    provider: 'STRIPE',
                    source: 'SERVICES',
                    refType: 'SERVICE_SESSION',
                    refId: session.id,
                    note: `${booking.service.title} - session ${index + 1} of ${count}`,
                },
                tx,
            );
        }

        await tx.proService.update({
            where: { id: booking.serviceId },
            data: { bookingCount: { increment: 1 }, popularityScore: { increment: 1 } },
        });

        const clients = await tx.serviceBooking.groupBy({
            by: ['buyerId'],
            where: { providerUserId: booking.providerUserId, status: { in: [...PAID_STATUSES] } },
        });
        await tx.serviceProvider.updateMany({
            where: { userId: booking.providerUserId },
            data: { clientCount: clients.length },
        });
    }

    // ------------------------------------------------------------------
    // Holds
    // ------------------------------------------------------------------

    /** Releases unpaid holds. Called every minute by BookingLifecycleService. */
    async expireDueHolds(limit = 100): Promise<number> {
        const due = await this.prisma.serviceBooking.findMany({
            where: { status: 'PENDING_PAYMENT', holdExpiresAt: { lt: new Date() } },
            select: { id: true },
            take: limit,
        });
        for (const b of due) {
            try {
                await this.expireBooking(b.id, { expireStripe: true });
            } catch (error: any) {
                this.logger.error(`Could not expire service booking ${b.id}: ${error?.message || error}`);
            }
        }
        return due.length;
    }

    private async expireBooking(bookingId: string, opts: { expireStripe: boolean }) {
        let checkoutId: string | null = null;
        await this.prisma.$transaction(async (tx) => {
            const updated = await tx.serviceBooking.updateMany({
                where: { id: bookingId, status: 'PENDING_PAYMENT' },
                data: { status: 'EXPIRED', holdExpiresAt: null },
            });
            if (!updated.count) return;
            const booking = await tx.serviceBooking.findUnique({ where: { id: bookingId } });
            await tx.serviceSession.updateMany({
                where: { bookingId, status: 'SCHEDULED' },
                data: { status: 'CANCELLED', cancelledAt: new Date() },
            });
            if (booking?.cohortId) {
                await tx.mentorshipCohort.updateMany({
                    where: { id: booking.cohortId, seatsTaken: { gt: 0 } },
                    data: { seatsTaken: { decrement: 1 } },
                });
            }
            checkoutId = booking?.stripeCheckoutSessionId ?? null;
        });

        // Close the Stripe link so the client can't pay for a released slot
        if (opts.expireStripe && checkoutId) {
            try {
                await this.stripe.checkout.sessions.expire(checkoutId);
            } catch {
                // Already completed or expired: a late payment is handled by confirmFromStripe
            }
        }
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /** Serializes bookings per provider inside a transaction (Postgres advisory lock). */
    private async lockProvider(tx: Tx, providerUserId: string) {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${providerUserId}))::text`;
    }

    private async retakeCohortSeat(tx: Tx, cohortId: string): Promise<boolean> {
        const cohort = await tx.mentorshipCohort.findUnique({ where: { id: cohortId } });
        if (!cohort || cohort.seatsTaken >= cohort.seatsTotal) return false;
        await tx.mentorshipCohort.update({ where: { id: cohortId }, data: { seatsTaken: { increment: 1 } } });
        return true;
    }

    private async paymentOptions(buyerId: string, currency: string, amountMinor: number) {
        const balance = await this.walletService.getBalance(buyerId, { currency, provider: 'STRIPE' });
        const availableMinor = balance.availableBalanceMinor;
        return {
            card: { enabled: true },
            wallet: {
                availableBalance: toMajor(availableMinor),
                formattedAvailableBalance: formatCurrencyAmount(toMajor(availableMinor), currency),
                enabled: availableMinor >= amountMinor,
            },
        };
    }

    private cardResponse(booking: FullBooking, session: Stripe.Checkout.Session) {
        return {
            paid: false,
            method: 'CARD',
            provider: 'STRIPE',
            checkoutUrl: session.url,
            checkoutSessionId: session.id,
            amount: toMajor(booking.amountMinor),
            currency: booking.currency.toUpperCase(),
            currencySymbol: getCurrencySymbol(booking.currency),
            formattedAmount: formatCurrencyAmount(toMajor(booking.amountMinor), booking.currency),
            holdExpiresAt: booking.holdExpiresAt,
            bookingId: booking.id,
        };
    }

    present(booking: FullBooking, viewerId: string) {
        const isProvider = booking.providerUserId === viewerId;
        const isPaid = (PAID_STATUSES as readonly string[]).includes(booking.status);
        const s = booking.service;
        return {
            id: booking.id,
            status: booking.status,
            role: isProvider ? 'PROVIDER' : 'CLIENT',
            service: {
                id: s.id,
                type: s.type,
                title: s.title,
                coverImage: s.coverImage,
                format: s.format,
                durationMinutes: s.durationMinutes,
                timezone: s.timezone,
                mentorship: s.mentorship,
                location:
                    s.format === 'IN_PERSON'
                        ? {
                            city: s.city,
                            country: s.country,
                            address: isPaid || isProvider ? s.address : null,
                            contactPhone: isPaid || isProvider ? s.contactPhone : null,
                            isRevealed: isPaid || isProvider,
                        }
                        : null,
            },
            provider: booking.provider,
            client: booking.buyer,
            cohort: booking.cohort,
            startOption: booking.startOption,
            note: booking.note,
            sessions: booking.sessions.map((x, i) => ({
                id: x.id,
                number: i + 1,
                startAt: x.startAt,
                endAt: x.endAt,
                status: x.status,
            })),
            quantity: booking.quantity,
            unitPrice: toMajor(booking.unitPriceMinor),
            total: toMajor(booking.amountMinor),
            currency: booking.currency,
            formattedTotal: formatCurrencyAmount(toMajor(booking.amountMinor), booking.currency),
            // Buyers pay the listed price; the fee is the provider's cost, so only they see it
            ...(isProvider
                ? { feePercent: booking.feePercent, fee: toMajor(booking.feeMinor), providerNet: toMajor(booking.providerNetMinor) }
                : {}),
            paymentMethod: booking.paymentMethod,
            holdExpiresAt: booking.status === 'PENDING_PAYMENT' ? booking.holdExpiresAt : null,
            refunded: toMajor(booking.refundedMinor),
            confirmedAt: booking.confirmedAt,
            createdAt: booking.createdAt,
        };
    }
}

