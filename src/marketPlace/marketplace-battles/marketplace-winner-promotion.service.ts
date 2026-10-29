import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import {
    MarketplaceBattleOutcome,
    MarketplaceBattleStatus,
    MarketplaceWinnerPromotionStatus,
    MarketplaceWinnerPromotionType,
    Prisma,
} from '@prisma/client';
import Stripe from 'stripe';
import { PrismaService } from '../../prisma/prisma.service';
import { assertUserKyc } from '../../common/kyc.util';
import { PagBankService } from '../../pagbank/pagbank.service';
import { PaymentProviderResolver } from '../payment/payment-provider.resolver';
import { CreateMarketplaceWinnerPromotionDto } from './dto/create-marketplace-winner-promotion.dto';
import {
    MARKETPLACE_WINNER_PROMOTION_SORT_FIELDS,
    MarketplaceWinnerPromotionListQueryDto,
} from './dto/marketplace-winner-promotion-list-query.dto';
import { MarketplaceWinnerPromotionActiveQueryDto } from './dto/marketplace-winner-promotion-active-query.dto';

const PROMOTION_PAYMENT_TYPE = 'marketplace_winner_promotion';
const WINNER_PROMOTION_DISCOUNT_PERCENT = 10;

const MARKETPLACE_BATTLE_LIST_PRODUCT_SELECT = {
    id: true,
    name: true,
    description: true,
    category: true,
    price: true,
    shippingFee: true,
    condition: true,
    images: true,
    brand: true,
    quantity: true,
    isActive: true,
    isDeleted: true,
    closet: {
        select: {
            id: true,
            userId: true,
            shopName: true,
            shopUsername: true,
            shopLogo: true,
            user: {
                select: {
                    id: true,
                    displayName: true,
                    userName: true,
                    image: true,
                },
            },
        },
    },
} as const;

@Injectable()
export class MarketplaceWinnerPromotionService {
    private readonly stripe: Stripe;

    constructor(
        private readonly prisma: PrismaService,
        private readonly paymentProviderResolver: PaymentProviderResolver,
        private readonly pagBankService: PagBankService,
    ) {
        this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
            apiVersion: '2024-06-20',
        });
    }

    private assertUserId(userId?: string): string {
        if (!userId) throw new UnauthorizedException('User not authenticated');
        return userId;
    }

    private toMinorUnits(amount: Prisma.Decimal): number {
        const asFixed = amount.toFixed(2);
        return Math.round(Number(asFixed) * 100);
    }

    private normalizeCurrency(value: string): string {
        return String(value || '').trim().toUpperCase();
    }

    async getActivePromotionPackages() {
        return this.prisma.marketplaceWinnerPromotionPackage.findMany({
            where: { isActive: true },
            orderBy: [{ createdAt: 'asc' }],
            select: {
                id: true,
                name: true,
                description: true,
                price: true,
                currency: true,
                durationHours: true,
            },
        });
    }

    async getPromotionByBattleId(battleId: string) {
        const now = new Date();

        const promotion =
            (await this.prisma.marketplaceWinnerPromotion.findFirst({
                where: {
                    battleId,
                    status: MarketplaceWinnerPromotionStatus.ACTIVE,
                    endAt: { gt: now },
                },
                orderBy: [{ createdAt: 'desc' }],
                select: { id: true, status: true, endAt: true },
            })) ||
            (await this.prisma.marketplaceWinnerPromotion.findFirst({
                where: {
                    battleId,
                    status: MarketplaceWinnerPromotionStatus.PENDING_PAYMENT,
                },
                orderBy: [{ createdAt: 'desc' }],
                select: { id: true, status: true, endAt: true },
            }));

        return {
            hasPromotion: Boolean(promotion),
            promotionId: promotion?.id ?? null,
            status: promotion?.status ?? null,
            endAt: promotion?.endAt ?? null,
        };
    }

    async createPromotionIntent(
        userId: string,
        battleId: string,
        dto: CreateMarketplaceWinnerPromotionDto,
    ) {
        const sellerId = this.assertUserId(userId);
        await assertUserKyc(this.prisma, sellerId, 'PAYER');
        const normalizedMessage = dto.message?.trim() || null;
        const now = new Date();

        return this.prisma.$transaction(
            async (tx) => {
                await tx.$queryRaw`
                    SELECT id
                    FROM "MarketplaceBattle"
                    WHERE id = ${battleId}
                    FOR UPDATE
                `;

                const battle = await tx.marketplaceBattle.findUnique({
                    where: { id: battleId },
                    select: {
                        id: true,
                        sellerId: true,
                        opponentSellerId: true,
                        closetId: true,
                        status: true,
                        outcome: true,
                        winnerParticipantId: true,
                    },
                });

                if (!battle) {
                    throw new NotFoundException('Marketplace battle not found');
                }

                if (battle.sellerId !== sellerId && battle.opponentSellerId !== sellerId) {
                    throw new ForbiddenException('Forbidden: you are not a participant in this marketplace battle');
                }

                if (
                    battle.status !== MarketplaceBattleStatus.COMPLETED ||
                    battle.outcome !== MarketplaceBattleOutcome.WINNER ||
                    !battle.winnerParticipantId
                ) {
                    throw new BadRequestException('Winner promotion requires a completed marketplace battle with a winner');
                }

                const winnerParticipant = await tx.marketplaceBattleParticipant.findUnique({
                    where: { id: battle.winnerParticipantId },
                    select: {
                        id: true,
                        battleId: true,
                        productId: true,
                        isWinner: true,
                        product: {
                            select: {
                                id: true,
                                userId: true,
                                closetId: true,
                                price: true,
                                shippingFee: true,
                                isActive: true,
                                isDeleted: true,
                                quantity: true,
                            },
                        },
                    },
                });

                if (
                    !winnerParticipant ||
                    winnerParticipant.battleId !== battle.id ||
                    !winnerParticipant.isWinner ||
                    !winnerParticipant.product
                ) {
                    throw new BadRequestException('Winning product is not available for promotion');
                }

                if (winnerParticipant.product.userId !== sellerId) {
                    throw new BadRequestException('Only the winning product seller can create a winner promotion');
                }

                if (
                    !winnerParticipant.product.isActive ||
                    winnerParticipant.product.isDeleted
                ) {
                    throw new BadRequestException('Winning product is not eligible for promotion');
                }

                let promoPackage = dto.packageId
                    ? await tx.marketplaceWinnerPromotionPackage.findUnique({
                        where: { id: dto.packageId },
                        select: {
                            id: true,
                            name: true,
                            description: true,
                            isActive: true,
                            price: true,
                            currency: true,
                            durationHours: true,
                        },
                    })
                    : await tx.marketplaceWinnerPromotionPackage.findFirst({
                        where: { isActive: true },
                        orderBy: [{ createdAt: 'asc' }],
                        select: {
                            id: true,
                            name: true,
                            description: true,
                            isActive: true,
                            price: true,
                            currency: true,
                            durationHours: true,
                        },
                    });

                if (!promoPackage || !promoPackage.isActive) {
                    throw new BadRequestException('Marketplace winner promotion package is not available');
                }

                if (promoPackage.price.lte(0)) {
                    throw new BadRequestException('Invalid promotion package price');
                }

                const normalizedCurrency = this.normalizeCurrency(promoPackage.currency);
                if (!normalizedCurrency) {
                    throw new BadRequestException('Invalid promotion package currency');
                }

                const isFreeShippingPkg =
                    Boolean(promoPackage.description?.toUpperCase().includes('FREE_SHIPPING')) ||
                    Boolean(promoPackage.description?.toUpperCase().includes('FREE SHIPPING')) ||
                    Boolean(promoPackage.name?.toUpperCase().includes('FREE SHIPPING'));

                const effectivePromoType: MarketplaceWinnerPromotionType =
                    dto.promoType ||
                    (isFreeShippingPkg
                        ? MarketplaceWinnerPromotionType.FREE_SHIPPING
                        : MarketplaceWinnerPromotionType.DISCOUNT_10_PERCENT_24H);

                const isDiscount = effectivePromoType === MarketplaceWinnerPromotionType.DISCOUNT_10_PERCENT_24H;
                const isFreeShipping = effectivePromoType === MarketplaceWinnerPromotionType.FREE_SHIPPING;

                let discountPercent: number | null = null;
                if (isDiscount) {
                    discountPercent = dto.discount ?? WINNER_PROMOTION_DISCOUNT_PERCENT;
                    if (!Number.isFinite(discountPercent) || discountPercent < 10 || discountPercent > 90) {
                        throw new BadRequestException('discount must be between 10 and 90');
                    }
                }

                // Clear unpaid intents so seller can start a fresh promotion checkout
                const pendingPromos = await tx.marketplaceWinnerPromotion.findMany({
                    where: {
                        battleId: battle.id,
                        status: MarketplaceWinnerPromotionStatus.PENDING_PAYMENT,
                    },
                    select: { id: true, paymentId: true },
                });

                if (pendingPromos.length > 0) {
                    const pendingPaymentIds = pendingPromos
                        .map((promo) => promo.paymentId)
                        .filter((paymentId): paymentId is string => Boolean(paymentId));

                    if (pendingPaymentIds.length > 0) {
                        await tx.marketPlacePayments.updateMany({
                            where: {
                                id: { in: pendingPaymentIds },
                                status: 'PENDING',
                            },
                            data: { status: 'CANCELLED' },
                        });
                    }

                    await tx.marketplaceWinnerPromotion.updateMany({
                        where: {
                            id: { in: pendingPromos.map((promo) => promo.id) },
                            status: MarketplaceWinnerPromotionStatus.PENDING_PAYMENT,
                        },
                        data: {
                            status: MarketplaceWinnerPromotionStatus.CANCELLED,
                            cancelledAt: now,
                        },
                    });
                }

                const existingActive = await tx.marketplaceWinnerPromotion.findFirst({
                    where: {
                        battleId: battle.id,
                        status: MarketplaceWinnerPromotionStatus.ACTIVE,
                        endAt: { gt: now },
                    },
                    select: { id: true, status: true },
                });

                if (existingActive) {
                    throw new ConflictException('already promoted');
                }

                const originalPrice = Number(winnerParticipant.product.price);
                const originalShippingFee = winnerParticipant.product.shippingFee ?? 0;
                const promoPrice =
                    isDiscount && discountPercent
                        ? Number((originalPrice * (1 - discountPercent / 100)).toFixed(2))
                        : originalPrice;
                const promoShippingFee = isFreeShipping ? 0 : originalShippingFee;

                const promotion = await tx.marketplaceWinnerPromotion.create({
                    data: {
                        sellerId,
                        closetId: winnerParticipant.product.closetId,
                        battleId: battle.id,
                        participantId: winnerParticipant.id,
                        productId: winnerParticipant.productId,
                        packageId: promoPackage.id,
                        promoType: effectivePromoType,
                        message: normalizedMessage,
                        discountPercent: isDiscount ? discountPercent : null,
                        freeShipping: isFreeShipping,
                        originalPrice,
                        promoPrice,
                        originalShippingFee,
                        promoShippingFee,
                        amount: promoPackage.price,
                        currency: normalizedCurrency,
                        status: MarketplaceWinnerPromotionStatus.PENDING_PAYMENT,
                    },
                    include: {
                        product: {
                            select: MARKETPLACE_BATTLE_LIST_PRODUCT_SELECT,
                        },
                    },
                });

                return promotion;
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
    }

    async createOrReusePromotionPayment(userId: string, promotionId: string) {
        const sellerId = this.assertUserId(userId);

        const promotion = await this.prisma.marketplaceWinnerPromotion.findUnique({
            where: { id: promotionId },
            include: {
                payment: true,
                package: true,
            },
        });

        if (!promotion) {
            throw new NotFoundException('Marketplace winner promotion not found');
        }

        if (promotion.sellerId !== sellerId) {
            throw new ForbiddenException('Forbidden: you do not own this promotion');
        }

        if (promotion.status === MarketplaceWinnerPromotionStatus.ACTIVE) {
            const stillActive = promotion.endAt && promotion.endAt.getTime() > Date.now();
            if (stillActive) {
                throw new ConflictException('already promoted');
            }
            throw new BadRequestException(
                'This promotion has ended. Create a new promotion intent, then create payment.',
            );
        }

        if (promotion.status !== MarketplaceWinnerPromotionStatus.PENDING_PAYMENT) {
            throw new BadRequestException(
                `Promotion payment can be created only when status is PENDING_PAYMENT (current: ${promotion.status}). Create a new promotion intent first, then call payment with the new promotionId.`,
            );
        }

        const provider = await this.paymentProviderResolver.resolveProviderForMarketplaceBoost(sellerId);

        const successUrl = process.env.STRIPE_SUCCESS_URL as string;
        const cancelUrl = process.env.STRIPE_CANCEL_URL as string;
        if (provider === 'STRIPE' && (!successUrl || !cancelUrl)) {
            throw new BadRequestException('Missing STRIPE_SUCCESS_URL/STRIPE_CANCEL_URL env vars');
        }

        if (promotion.paymentId && promotion.payment) {
            const metadata = (promotion.payment.metadata as Prisma.JsonObject | null) || null;
            const checkoutUrl = typeof metadata?.checkoutUrl === 'string' ? metadata.checkoutUrl : null;
            const checkoutSessionId = typeof metadata?.checkoutSessionId === 'string' ? metadata.checkoutSessionId : null;
            const qrCode = typeof metadata?.qrCode === 'string' ? metadata.qrCode : null;
            const pixCopyPaste = typeof metadata?.pixCopyPaste === 'string' ? metadata.pixCopyPaste : null;

            if (
                promotion.payment.status === 'PENDING' &&
                (checkoutUrl || pixCopyPaste) &&
                (checkoutSessionId || promotion.payment.paymentIntentId)
            ) {
                return {
                    promotionId: promotion.id,
                    status: promotion.status,
                    payment: {
                        provider,
                        paymentId: promotion.payment.id,
                        checkoutUrl,
                        checkoutSessionId: checkoutSessionId || promotion.payment.paymentIntentId,
                        clientSecret: null,
                        qrCode,
                        pixCopyPaste,
                    },
                };
            }
        }

        const amountToPay = promotion.amount ?? promotion.package?.price;
        if (!amountToPay) {
            throw new BadRequestException('Missing promotion amount');
        }

        const amountMinor = this.toMinorUnits(amountToPay);
        const currencyCode = promotion.currency ?? promotion.package?.currency ?? 'USD';
        const currencyLower =
            provider === 'PAGBANK' ? 'brl' : this.normalizeCurrency(currencyCode).toLowerCase();

        const payment = await this.prisma.marketPlacePayments.create({
            data: {
                userId: sellerId,
                amount: amountMinor,
                currency: currencyLower,
                provider,
                status: 'PENDING',
                metadata: {
                    type: PROMOTION_PAYMENT_TYPE,
                    domain: 'MARKETPLACE_WINNER_PROMOTION',
                    promotionId: promotion.id,
                    battleId: promotion.battleId,
                    sellerId,
                    promoType: promotion.promoType,
                    idempotencyKey: `marketplace-winner-promotion:${promotion.id}:payment`,
                },
            },
        });

        if (provider === 'PAGBANK') {
            const seller = await this.prisma.user.findUnique({
                where: { id: sellerId },
                select: { email: true, displayName: true, userName: true },
            });
            const checkout = await this.pagBankService.createPixCheckout({
                referenceId: payment.id,
                amountMinor,
                description: 'Marketplace Winner Promotion',
                customerEmail: seller?.email || undefined,
                customerName: seller?.displayName || seller?.userName || undefined,
            });

            await this.prisma.$transaction(async (tx) => {
                await tx.marketPlacePayments.update({
                    where: { id: payment.id },
                    data: {
                        paymentIntentId: checkout.orderId,
                        metadata: {
                            type: PROMOTION_PAYMENT_TYPE,
                            domain: 'MARKETPLACE_WINNER_PROMOTION',
                            promotionId: promotion.id,
                            battleId: promotion.battleId,
                            sellerId,
                            promoType: promotion.promoType,
                            idempotencyKey: `marketplace-winner-promotion:${promotion.id}:payment`,
                            checkoutSessionId: checkout.orderId,
                            checkoutUrl: checkout.checkoutUrl,
                            qrCode: checkout.qrCode,
                            pixCopyPaste: checkout.pixCopyPaste,
                        },
                    },
                });

                await tx.marketplaceWinnerPromotion.update({
                    where: { id: promotion.id },
                    data: {
                        paymentId: payment.id,
                        paymentProvider: provider,
                    },
                });
            });

            return {
                promotionId: promotion.id,
                status: MarketplaceWinnerPromotionStatus.PENDING_PAYMENT,
                payment: {
                    provider,
                    paymentId: payment.id,
                    checkoutUrl: checkout.checkoutUrl,
                    checkoutSessionId: checkout.orderId,
                    clientSecret: null,
                    qrCode: checkout.qrCode,
                    pixCopyPaste: checkout.pixCopyPaste,
                },
            };
        }

        const session = await this.stripe.checkout.sessions.create({
            mode: 'payment',
            success_url: successUrl,
            cancel_url: cancelUrl,
            line_items: [
                {
                    quantity: 1,
                    price_data: {
                        currency: currencyLower,
                        unit_amount: amountMinor,
                        product_data: {
                            name: 'Marketplace Winner Promotion',
                        },
                    },
                },
            ],
            metadata: {
                type: PROMOTION_PAYMENT_TYPE,
                paymentId: payment.id,
                promotionId: promotion.id,
                battleId: promotion.battleId,
                sellerId,
                promoType: String(promotion.promoType),
            },
            payment_intent_data: {
                metadata: {
                    type: PROMOTION_PAYMENT_TYPE,
                    paymentId: payment.id,
                    promotionId: promotion.id,
                    battleId: promotion.battleId,
                    sellerId,
                    promoType: String(promotion.promoType),
                },
            },
        });

        await this.prisma.$transaction(async (tx) => {
            await tx.marketPlacePayments.update({
                where: { id: payment.id },
                data: {
                    paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
                    metadata: {
                        type: PROMOTION_PAYMENT_TYPE,
                        domain: 'MARKETPLACE_WINNER_PROMOTION',
                        promotionId: promotion.id,
                        battleId: promotion.battleId,
                        sellerId,
                        promoType: promotion.promoType,
                        idempotencyKey: `marketplace-winner-promotion:${promotion.id}:payment`,
                        checkoutSessionId: session.id,
                        checkoutUrl: session.url,
                    },
                },
            });

            await tx.marketplaceWinnerPromotion.update({
                where: { id: promotion.id },
                data: {
                    paymentId: payment.id,
                    paymentProvider: provider,
                },
            });
        });

        return {
            promotionId: promotion.id,
            status: MarketplaceWinnerPromotionStatus.PENDING_PAYMENT,
            payment: {
                provider,
                paymentId: payment.id,
                checkoutUrl: session.url,
                checkoutSessionId: session.id,
                clientSecret: session.client_secret || null,
                qrCode: null,
                pixCopyPaste: null,
            },
        };
    }

    async getMyPromotions(userId: string, query: MarketplaceWinnerPromotionListQueryDto) {
        const sellerId = this.assertUserId(userId);
        const page = query.page ?? 1;
        const limit = query.limit ?? 10;
        const skip = (page - 1) * limit;

        const sortBy = query.sortBy ?? 'createdAt';
        const sortOrder = query.sortOrder ?? 'desc';

        const where: Prisma.MarketplaceWinnerPromotionWhereInput = {
            sellerId,
            ...(query.status ? { status: query.status } : {}),
            ...(query.battleId ? { battleId: query.battleId } : {}),
        };

        const [total, promotions] = await Promise.all([
            this.prisma.marketplaceWinnerPromotion.count({ where }),
            this.prisma.marketplaceWinnerPromotion.findMany({
                where,
                skip,
                take: limit,
                orderBy: [{ [sortBy]: sortOrder }],
                include: {
                    package: true,
                    product: {
                        select: MARKETPLACE_BATTLE_LIST_PRODUCT_SELECT,
                    },
                    battle: {
                        select: {
                            id: true,
                            title: true,
                            status: true,
                            startAt: true,
                            endAt: true,
                        },
                    },
                    payment: {
                        select: {
                            id: true,
                            status: true,
                            provider: true,
                            createdAt: true,
                            updatedAt: true,
                        },
                    },
                },
            }),
        ]);

        return {
            promotions,
            total,
            page,
            limit,
            totalPages: total === 0 ? 0 : Math.ceil(total / limit),
        };
    }

    async getMyPromotionById(userId: string, promotionId: string) {
        const sellerId = this.assertUserId(userId);

        const promotion = await this.prisma.marketplaceWinnerPromotion.findUnique({
            where: { id: promotionId },
            include: {
                package: true,
                product: {
                    select: MARKETPLACE_BATTLE_LIST_PRODUCT_SELECT,
                },
                battle: {
                    select: {
                        id: true,
                        title: true,
                        status: true,
                        startAt: true,
                        endAt: true,
                    },
                },
                payment: {
                    select: {
                        id: true,
                        status: true,
                        provider: true,
                        createdAt: true,
                        updatedAt: true,
                    },
                },
            },
        });

        if (!promotion) {
            throw new NotFoundException('Marketplace winner promotion not found');
        }

        if (promotion.sellerId !== sellerId) {
            throw new ForbiddenException('Forbidden: you do not own this promotion');
        }

        return promotion;
    }

    async getActivePromotionsPublic(query: MarketplaceWinnerPromotionActiveQueryDto) {
        const now = new Date();

        const promotions = await this.prisma.marketplaceWinnerPromotion.findMany({
            where: {
                status: MarketplaceWinnerPromotionStatus.ACTIVE,
                startAt: { lte: now },
                endAt: { gt: now },
            },
            orderBy: [{ activatedAt: 'desc' }, { createdAt: 'desc' }],
            include: {
                product: {
                    select: MARKETPLACE_BATTLE_LIST_PRODUCT_SELECT,
                },
                battle: {
                    select: {
                        id: true,
                        title: true,
                        category: true,
                        status: true,
                        startAt: true,
                        endAt: true,
                    },
                },
            },
        });

        const page = query.page ?? 1;
        const limit = query.limit ?? 10;
        const total = promotions.length;
        const skip = (page - 1) * limit;

        const data = promotions.slice(skip, skip + limit).map((promo) => ({
            promotionId: promo.id,
            promoType: promo.promoType,
            message: promo.message,
            discountPercent: promo.discountPercent,
            freeShipping: promo.freeShipping,
            originalPrice: promo.originalPrice,
            promoPrice: promo.promoPrice,
            originalShippingFee: promo.originalShippingFee,
            promoShippingFee: promo.promoShippingFee,
            startAt: promo.startAt,
            endAt: promo.endAt,
            remainingPromotionSeconds: promo.endAt
                ? Math.max(0, Math.floor((promo.endAt.getTime() - now.getTime()) / 1000))
                : 0,
            product: promo.product,
            battle: promo.battle,
        }));

        return {
            promotions: data,
            total,
            page,
            limit,
            totalPages: total === 0 ? 0 : Math.ceil(total / limit),
        };
    }

    private async activatePromotionFromPayment(
        paymentId: string,
        provider: string,
        paymentAmountMinor: number,
        paymentCurrency: string,
    ) {
        const now = new Date();

        await this.prisma.$transaction(
            async (tx) => {
                const promotion = await tx.marketplaceWinnerPromotion.findFirst({
                    where: { paymentId },
                    include: {
                        package: {
                            select: {
                                durationHours: true,
                            },
                        },
                        battle: {
                            select: {
                                id: true,
                                status: true,
                                outcome: true,
                            },
                        },
                    },
                });

                if (!promotion) return;

                await tx.$queryRaw`
                    SELECT id
                    FROM "MarketplaceWinnerPromotion"
                    WHERE id = ${promotion.id}
                    FOR UPDATE
                `;

                const lockedPromotion = await tx.marketplaceWinnerPromotion.findUnique({
                    where: { id: promotion.id },
                    include: {
                        package: {
                            select: { durationHours: true },
                        },
                        battle: {
                            select: {
                                id: true,
                                status: true,
                                outcome: true,
                            },
                        },
                        payment: {
                            select: {
                                id: true,
                                amount: true,
                                currency: true,
                                provider: true,
                                status: true,
                            },
                        },
                    },
                });

                if (!lockedPromotion) return;

                if (lockedPromotion.status === MarketplaceWinnerPromotionStatus.ACTIVE) return;

                if (
                    lockedPromotion.status === MarketplaceWinnerPromotionStatus.EXPIRED ||
                    lockedPromotion.status === MarketplaceWinnerPromotionStatus.CANCELLED ||
                    lockedPromotion.status === MarketplaceWinnerPromotionStatus.FAILED
                ) {
                    return;
                }

                if (lockedPromotion.status !== MarketplaceWinnerPromotionStatus.PENDING_PAYMENT) {
                    return;
                }

                if (!lockedPromotion.payment || lockedPromotion.payment.id !== paymentId) {
                    return;
                }

                const expectedMinor = lockedPromotion.amount
                    ? this.toMinorUnits(lockedPromotion.amount)
                    : 0;
                if (expectedMinor !== paymentAmountMinor) {
                    await tx.marketplaceWinnerPromotion.update({
                        where: { id: lockedPromotion.id },
                        data: {
                            status: MarketplaceWinnerPromotionStatus.FAILED,
                            failedAt: now,
                        },
                    });
                    return;
                }

                if (
                    lockedPromotion.currency &&
                    this.normalizeCurrency(lockedPromotion.currency) !== this.normalizeCurrency(paymentCurrency)
                ) {
                    await tx.marketplaceWinnerPromotion.update({
                        where: { id: lockedPromotion.id },
                        data: {
                            status: MarketplaceWinnerPromotionStatus.FAILED,
                            failedAt: now,
                        },
                    });
                    return;
                }

                if (this.normalizeCurrency(lockedPromotion.payment.provider) !== this.normalizeCurrency(provider)) {
                    await tx.marketplaceWinnerPromotion.update({
                        where: { id: lockedPromotion.id },
                        data: {
                            status: MarketplaceWinnerPromotionStatus.FAILED,
                            failedAt: now,
                        },
                    });
                    return;
                }

                if (lockedPromotion.payment.status !== 'PAID') {
                    return;
                }

                const durationHours = lockedPromotion.package?.durationHours ?? 24;
                const computedEndAt = new Date(now.getTime() + durationHours * 60 * 60 * 1000);

                await tx.marketplaceWinnerPromotion.updateMany({
                    where: {
                        id: lockedPromotion.id,
                        status: MarketplaceWinnerPromotionStatus.PENDING_PAYMENT,
                    },
                    data: {
                        status: MarketplaceWinnerPromotionStatus.ACTIVE,
                        paymentProvider: provider,
                        startAt: now,
                        endAt: computedEndAt,
                        activatedAt: now,
                    },
                });
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
    }

    async handlePagBankPromotionPaid(paymentId: string) {
        const payment = await this.prisma.marketPlacePayments.findUnique({
            where: { id: paymentId },
            select: {
                id: true,
                provider: true,
                amount: true,
                currency: true,
                status: true,
                metadata: true,
            },
        });
        if (!payment) return { activated: false, reason: 'payment_not_found' };

        const metadata = (payment.metadata as Prisma.JsonObject | null) || null;
        if (metadata?.type !== PROMOTION_PAYMENT_TYPE && metadata?.domain !== 'MARKETPLACE_WINNER_PROMOTION') {
            return { activated: false, reason: 'not_promotion_payment' };
        }

        if (payment.status !== 'PAID') {
            await this.prisma.marketPlacePayments.update({
                where: { id: payment.id },
                data: { status: 'PAID' },
            });
        }

        await this.activatePromotionFromPayment(
            payment.id,
            payment.provider,
            payment.amount,
            payment.currency,
        );
        return { activated: true, paymentId: payment.id };
    }

    async handleVerifiedPaymentSuccess(paymentIntent: Stripe.PaymentIntent) {
        if (paymentIntent.metadata?.type !== PROMOTION_PAYMENT_TYPE) return;

        const payment = await this.prisma.marketPlacePayments.findFirst({
            where: {
                OR: [
                    { paymentIntentId: paymentIntent.id },
                    ...(paymentIntent.metadata?.paymentId ? [{ id: paymentIntent.metadata.paymentId }] : []),
                ],
            },
            select: {
                id: true,
                provider: true,
            },
        });

        if (!payment) return;

        await this.prisma.marketPlacePayments.update({
            where: { id: payment.id },
            data: {
                status: 'PAID',
                paymentIntentId: paymentIntent.id,
            },
        });

        await this.activatePromotionFromPayment(
            payment.id,
            payment.provider,
            paymentIntent.amount,
            paymentIntent.currency,
        );
    }

    async handleVerifiedPaymentFailure(paymentIntent: Stripe.PaymentIntent) {
        if (paymentIntent.metadata?.type !== PROMOTION_PAYMENT_TYPE) return;

        const payment = await this.prisma.marketPlacePayments.findFirst({
            where: {
                OR: [
                    { paymentIntentId: paymentIntent.id },
                    ...(paymentIntent.metadata?.paymentId ? [{ id: paymentIntent.metadata.paymentId }] : []),
                ],
            },
            select: { id: true },
        });

        if (!payment) return;

        await this.prisma.$transaction(async (tx) => {
            await tx.marketPlacePayments.update({
                where: { id: payment.id },
                data: { status: 'FAILED', paymentIntentId: paymentIntent.id },
            });

            await tx.marketplaceWinnerPromotion.updateMany({
                where: {
                    paymentId: payment.id,
                    status: MarketplaceWinnerPromotionStatus.PENDING_PAYMENT,
                },
                data: {
                    status: MarketplaceWinnerPromotionStatus.FAILED,
                    failedAt: new Date(),
                },
            });
        });
    }

    async handleCheckoutExpired(session: Stripe.Checkout.Session) {
        if (session.metadata?.type !== PROMOTION_PAYMENT_TYPE) return;
        const paymentId = session.metadata?.paymentId;
        if (!paymentId) return;

        await this.prisma.$transaction(async (tx) => {
            await tx.marketPlacePayments.updateMany({
                where: { id: paymentId, status: 'PENDING' },
                data: { status: 'CANCELLED' },
            });

            await tx.marketplaceWinnerPromotion.updateMany({
                where: {
                    paymentId,
                    status: MarketplaceWinnerPromotionStatus.PENDING_PAYMENT,
                },
                data: {
                    status: MarketplaceWinnerPromotionStatus.CANCELLED,
                    cancelledAt: new Date(),
                },
            });
        });
    }
}
