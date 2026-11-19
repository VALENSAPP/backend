import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from '../notification/notification.service';
import { WalletService } from '../wallet/wallet.service';
import { assertUserKyc } from '../common/kyc.util';
import { formatCurrencyAmount, getCurrencySymbol } from '../common/payment-provider.util';
import { platformCurrency, resolvePaymentCountry, resolveWalletCurrency } from '../common/country.util';
import { FxUnavailableError, StripeFxService } from '../common/fx/stripe-fx.service';
import { StripeConnectService } from './stripe-connect.service';

const IN_TRANSIT_PAYOUT_STATUSES = ['pending_creation', 'pending', 'in_transit'];

const SOURCE_TITLES: Record<string, string> = {
    MARKETPLACE: 'Marketplace Sale',
    TIP: 'Tip',
    MISSION_DONATION: 'Mission Post',
    FOLLOWING: 'Pay-following',
    FAN_SUBSCRIPTION: 'Fan Subscription',
    EBOOK: 'Ebook',
    SHOP_EBOOK: 'Shop Ebook',
    OTHER: 'Other',
};

export type LedgerFeedFilter = 'all' | 'earned' | 'withdrawn' | 'pending';

/**
 * Withdrawals and bank payouts (Wallet → Transfer to Bank → Funds on the way).
 *
 * Money flow for one withdrawal:
 *  1. Debit the user's wallet (wallet currency: BRL for Brazil, USD otherwise).
 *  2. Convert to the platform currency with Stripe's base rate (bookkeeping only) and create a Stripe
 *     transfer from the Valens balance to the user's connected account (Stripe converts to the
 *     account's currency).
 *  3. Create a payout on the connected account (manual schedule) to the user's bank and track it
 *     through Connect webhooks (payout.paid / payout.failed).
 *
 * Responses of existing endpoints keep their shape; new fields are only added.
 */
@Injectable()
export class PayoutsService {
    private readonly logger = new Logger(PayoutsService.name);
    private payoutRetryRunning = false;
    private autoPayoutRunning = false;

    constructor(
        private readonly prisma: PrismaService,
        private readonly walletService: WalletService,
        private readonly fx: StripeFxService,
        private readonly connect: StripeConnectService,
        private readonly notificationService: NotificationService,
    ) { }

    private get stripe(): Stripe {
        return this.connect.client;
    }

    private toMajor(minor: number): number {
        return Number(((minor || 0) / 100).toFixed(2));
    }

    /** Minimum withdrawal in the wallet currency (minor units). Defaults keep today's minimum of 10.00. */
    minimumWithdrawalMinor(currency: string): number {
        const key = `MIN_WITHDRAWAL_${currency.toUpperCase()}_MINOR`;
        const value = Number(process.env[key] || process.env.MIN_WITHDRAWAL_MINOR || 1000);
        return Number.isFinite(value) && value > 0 ? Math.round(value) : 1000;
    }

    async getUserWalletContext(userId: string) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                country: true,
                kycCountry: true,
                stripeAccountId: true,
                stripeAccountStatus: true,
                stripeAccountEmail: true,
                stripeAccountCountry: true,
                stripePayoutsEnabled: true,
                stripeDetailsSubmitted: true,
                stripeBankName: true,
                stripeBankLast4: true,
                stripeBankCurrency: true,
                email: true,
            },
        });
        if (!user) throw new NotFoundException('User not found');
        const currency = resolveWalletCurrency(user);
        return { user, currency };
    }

    // ---------------------------------------------------------------------------
    // Withdrawal
    // ---------------------------------------------------------------------------

    async requestWithdrawal(userId: string, amount: number, options?: { automatic?: boolean }) {
        await assertUserKyc(this.prisma, userId, 'PAYER');
        if (!userId) throw new BadRequestException('User ID required');
        if (typeof amount !== 'number' || Number.isNaN(amount) || amount <= 0) {
            throw new BadRequestException('Invalid withdrawal amount');
        }

        const { currency } = await this.getUserWalletContext(userId);
        const amountMinor = Math.round(amount * 100);
        const minimumMinor = this.minimumWithdrawalMinor(currency);
        if (amountMinor < minimumMinor) {
            throw new BadRequestException({
                message: `Minimum withdrawal is ${formatCurrencyAmount(this.toMajor(minimumMinor), currency)}`,
                code: 'BELOW_MINIMUM',
                minimumAmount: this.toMajor(minimumMinor),
                currency: currency.toUpperCase(),
            });
        }

        const { accountId } = await this.connect.requireReadyAccount(userId);

        const balance = await this.walletService.getBalance(userId, { currency, provider: 'STRIPE' });
        if (balance.availableBalanceMinor < amountMinor) {
            throw new BadRequestException({
                message: `Insufficient available balance. Available: ${balance.availableBalance.toFixed(2)}, requested: ${amount.toFixed(2)}. Pending (${balance.pendingBalance.toFixed(2)}) cannot be withdrawn until the 48h protection window ends.`,
                code: 'INSUFFICIENT_BALANCE',
            });
        }

        const withdrawal = await this.prisma.withdrawalRecord.create({
            data: {
                userId,
                withdrawAmount: this.toMajor(amountMinor),
                amountMinor,
                currency,
                provider: 'STRIPE',
                status: 'processing',
                processingAt: new Date(),
                isAutomatic: !!options?.automatic,
            },
        });

        try {
            await this.walletService.debitAvailableForWithdrawal({
                userId,
                amountMinor,
                currency,
                provider: 'STRIPE',
                withdrawalId: withdrawal.id,
                note: `Withdrawal request ${withdrawal.id}`,
            });

            // The Valens Stripe balance is held in the platform currency (USD). Convert the wallet amount
            // with Stripe's base rate; Stripe converts again to the bank currency on the connected account.
            const transferCurrency = platformCurrency();
            let transferAmountMinor = amountMinor;
            let fxRate: number | null = null;
            let fxQuoteId: string | null = null;
            if (currency !== transferCurrency) {
                try {
                    const conversion = await this.fx.convertMinor(amountMinor, currency, transferCurrency, { rateType: 'base' });
                    transferAmountMinor = conversion.toAmountMinor;
                    fxRate = conversion.rate;
                    fxQuoteId = conversion.quoteId;
                } catch (error: any) {
                    if (error instanceof FxUnavailableError) {
                        throw new BadRequestException({
                            message: 'Currency conversion is temporarily unavailable. Please try again in a few minutes.',
                            code: 'FX_UNAVAILABLE',
                        });
                    }
                    throw error;
                }
            }
            if (transferAmountMinor <= 0) {
                throw new BadRequestException('Withdrawal amount is too small after conversion');
            }

            const transfer = await this.stripe.transfers.create(
                {
                    amount: transferAmountMinor,
                    currency: transferCurrency,
                    destination: accountId,
                    metadata: {
                        type: 'seller_wallet_withdrawal',
                        withdrawalId: withdrawal.id,
                        userId,
                        walletAmountMinor: String(amountMinor),
                        walletCurrency: currency,
                    },
                },
                { idempotencyKey: `wallet-withdrawal-${withdrawal.id}` },
            );

            // status stays 'success' (= accepted and sent to Stripe) for backward compatibility with the app;
            // bank progress is tracked in payoutStatus.
            await this.prisma.withdrawalRecord.update({
                where: { id: withdrawal.id },
                data: {
                    status: 'success',
                    transferId: transfer.id,
                    txhash: transfer.id,
                    transferAmountMinor,
                    transferCurrency,
                    fxRate,
                    fxQuoteId,
                    transferredAt: new Date(),
                    payoutStatus: 'pending_creation',
                },
            });

            await this.createBankPayout(withdrawal.id);

            try {
                await this.notificationService.sendNotificationToUser(
                    userId,
                    'Transfer requested',
                    `${formatCurrencyAmount(this.toMajor(amountMinor), currency)} is on the way to your bank account.`,
                    {
                        type: 'withdrawal_requested',
                        withdrawalId: withdrawal.id,
                        amount: this.toMajor(amountMinor).toString(),
                        currency: currency.toUpperCase(),
                    },
                );
            } catch (notificationError: any) {
                this.logger.warn(`Withdrawal requested notification failed: ${notificationError?.message}`);
            }

            const updated = await this.prisma.withdrawalRecord.findUniqueOrThrow({ where: { id: withdrawal.id } });
            const nextBalance = await this.walletService.getBalance(userId, { currency, provider: 'STRIPE' });

            return {
                message: 'Withdrawal sent to your connected account',
                withdrawal: {
                    ...this.serializeWithdrawal(updated),
                },
                balance: {
                    pendingBalance: nextBalance.pendingBalance,
                    availableBalance: nextBalance.availableBalance,
                    withdrawableBalance: nextBalance.withdrawableBalance,
                },
            };
        } catch (error: any) {
            const failureReason =
                (typeof error?.response?.message === 'string' && error.response.message) ||
                error?.message ||
                'Withdrawal transfer failed';

            try {
                await this.walletService.reverseWithdrawal({
                    userId,
                    amountMinor,
                    currency,
                    provider: 'STRIPE',
                    withdrawalId: withdrawal.id,
                    note: failureReason,
                });
            } catch (reverseError: any) {
                this.logger.error(`Failed to reverse wallet debit after withdrawal error: ${reverseError?.message}`);
            }

            await this.prisma.withdrawalRecord.update({
                where: { id: withdrawal.id },
                data: {
                    status: 'failed',
                    failureReason,
                    failedAt: new Date(),
                },
            });

            if (error instanceof BadRequestException) throw error;
            throw new BadRequestException(failureReason);
        }
    }

    /**
     * Create the bank payout on the connected account for a transferred withdrawal.
     * Safe to call repeatedly (idempotency key per attempt; skips when a payout already exists).
     */
    async createBankPayout(withdrawalId: string) {
        const w = await this.prisma.withdrawalRecord.findUnique({ where: { id: withdrawalId } });
        if (!w || !w.transferId || w.provider !== 'STRIPE') return;
        if (w.payoutId && w.payoutStatus !== 'failed' && w.payoutStatus !== 'canceled') return;

        const user = await this.prisma.user.findUnique({ where: { id: w.userId }, select: { stripeAccountId: true } });
        if (!user?.stripeAccountId) return;

        try {
            let amount = w.payoutAmountMinor || 0;
            let currency = w.payoutCurrency || '';

            if (!amount || !currency) {
                // How much the transfer became in the connected account's currency (after Stripe's conversion).
                const transfer = await this.stripe.transfers.retrieve(w.transferId, {
                    expand: ['destination_payment.balance_transaction'],
                });
                const destinationPayment = transfer.destination_payment as Stripe.Charge | string | null;
                const bt =
                    destinationPayment && typeof destinationPayment !== 'string'
                        ? (destinationPayment.balance_transaction as Stripe.BalanceTransaction | string | null)
                        : null;
                if (!bt || typeof bt === 'string') {
                    this.logger.warn(`[Payouts] No balance transaction yet for transfer ${w.transferId}`);
                    return;
                }
                if (bt.status !== 'available') {
                    // Funds not yet available on the connected account; the retry job will try again.
                    return;
                }
                amount = bt.net;
                currency = bt.currency;
            }

            const attempt = w.payoutAttempts || 0;
            const payout = await this.stripe.payouts.create(
                {
                    amount,
                    currency,
                    metadata: { withdrawalId: w.id, userId: w.userId },
                },
                {
                    stripeAccount: user.stripeAccountId,
                    idempotencyKey: `wallet-payout-${w.id}-${attempt}`,
                },
            );

            await this.prisma.withdrawalRecord.update({
                where: { id: w.id },
                data: {
                    payoutId: payout.id,
                    payoutStatus: payout.status,
                    payoutAmountMinor: payout.amount,
                    payoutCurrency: payout.currency,
                    payoutArrivalDate: payout.arrival_date ? new Date(payout.arrival_date * 1000) : null,
                    payoutAttempts: { increment: 1 },
                },
            });
        } catch (error: any) {
            this.logger.warn(`[Payouts] createBankPayout ${w.id} failed: ${error?.message}`);
            await this.prisma.withdrawalRecord.update({
                where: { id: w.id },
                data: {
                    payoutAttempts: { increment: 1 },
                    ...(w.payoutStatus === 'failed' ? {} : { payoutStatus: 'pending_creation' }),
                },
            });
        }
    }

    /** Connect webhook: payout.created / payout.updated / payout.paid / payout.failed / payout.canceled. */
    async handleConnectPayoutEvent(payout: Stripe.Payout, eventType: string) {
        const withdrawalId = payout.metadata?.withdrawalId;
        const w = withdrawalId
            ? await this.prisma.withdrawalRecord.findUnique({ where: { id: withdrawalId } })
            : await this.prisma.withdrawalRecord.findFirst({ where: { payoutId: payout.id } });
        if (!w) return;
        // Ignore events for an older (failed) payout once a newer one exists.
        if (w.payoutId && w.payoutId !== payout.id && eventType !== 'payout.created') return;

        const data: any = {
            payoutId: payout.id,
            payoutStatus: payout.status,
            payoutAmountMinor: payout.amount,
            payoutCurrency: payout.currency,
            payoutArrivalDate: payout.arrival_date ? new Date(payout.arrival_date * 1000) : w.payoutArrivalDate,
        };
        if (payout.status === 'paid' && !w.paidAt) data.paidAt = new Date();
        if (payout.status === 'failed' || payout.status === 'canceled') {
            data.failedAt = new Date();
            data.failureReason = `Bank payout ${payout.status}: ${payout.failure_message || payout.failure_code || 'unknown'}`;
        }

        await this.prisma.withdrawalRecord.update({ where: { id: w.id }, data });

        const amountText = formatCurrencyAmount(this.toMajor(payout.amount), payout.currency);
        try {
            if (payout.status === 'paid' && w.payoutStatus !== 'paid') {
                await this.notificationService.sendNotificationToUser(
                    w.userId,
                    'Payout deposited',
                    `${amountText} has been sent to your bank account.`,
                    { type: 'withdrawal_paid', withdrawalId: w.id, amount: this.toMajor(payout.amount).toString(), currency: payout.currency.toUpperCase() },
                );
            } else if ((payout.status === 'failed' || payout.status === 'canceled') && w.payoutStatus !== payout.status) {
                await this.notificationService.sendNotificationToUser(
                    w.userId,
                    'Bank payout issue',
                    'Your bank could not receive the payout. Please check your bank details in Payout Method; we will retry automatically after you update them.',
                    { type: 'withdrawal_failed', withdrawalId: w.id, amount: this.toMajor(payout.amount).toString(), currency: payout.currency.toUpperCase() },
                );
            }
        } catch (notificationError: any) {
            this.logger.warn(`Payout notification failed: ${notificationError?.message}`);
        }
    }

    /** After the user updates bank details, retry failed bank payouts for that account. */
    async retryFailedPayoutsForAccount(accountId: string) {
        const user = await this.prisma.user.findFirst({ where: { stripeAccountId: accountId }, select: { id: true } });
        if (!user) return;
        const failed = await this.prisma.withdrawalRecord.findMany({
            where: { userId: user.id, provider: 'STRIPE', payoutStatus: { in: ['failed', 'canceled'] } },
            select: { id: true },
        });
        for (const row of failed) {
            await this.createBankPayout(row.id);
        }
    }

    @Cron(CronExpression.EVERY_10_MINUTES)
    async retryPendingPayouts() {
        if (this.payoutRetryRunning) return;
        this.payoutRetryRunning = true;
        try {
            const rows = await this.prisma.withdrawalRecord.findMany({
                where: {
                    provider: 'STRIPE',
                    payoutStatus: 'pending_creation',
                    transferId: { not: null },
                    payoutAttempts: { lt: 200 },
                },
                orderBy: { createdAt: 'asc' },
                take: 50,
                select: { id: true },
            });
            for (const row of rows) {
                await this.createBankPayout(row.id);
            }
        } catch (error: any) {
            this.logger.error(`[Payouts] retryPendingPayouts failed: ${error?.message}`);
        } finally {
            this.payoutRetryRunning = false;
        }
    }

    // ---------------------------------------------------------------------------
    // Automatic payouts (Payout Method screen)
    // ---------------------------------------------------------------------------

    async getPayoutSettings(userId: string) {
        const { currency } = await this.getUserWalletContext(userId);
        const settings = await this.prisma.payoutSettings.findUnique({ where: { userId } });
        const minimumMinor = settings?.minimumAmountMinor ?? Math.max(this.minimumWithdrawalMinor(currency), 2000);
        return {
            autoPayoutEnabled: settings?.autoPayoutEnabled ?? false,
            intervalDays: settings?.intervalDays ?? 7,
            minimumAmount: this.toMajor(minimumMinor),
            minimumAmountMinor: minimumMinor,
            formattedMinimumAmount: formatCurrencyAmount(this.toMajor(minimumMinor), currency),
            currency: currency.toUpperCase(),
            currencySymbol: getCurrencySymbol(currency),
            nextRunAt: settings?.nextRunAt ?? null,
            lastRunAt: settings?.lastRunAt ?? null,
            allowedIntervalsDays: [1, 7, 14, 30],
        };
    }

    async updatePayoutSettings(
        userId: string,
        dto: { autoPayoutEnabled?: boolean; intervalDays?: number; minimumAmount?: number },
    ) {
        const { currency } = await this.getUserWalletContext(userId);
        const allowed = [1, 7, 14, 30];
        if (dto.intervalDays !== undefined && !allowed.includes(Number(dto.intervalDays))) {
            throw new BadRequestException(`intervalDays must be one of ${allowed.join(', ')}`);
        }
        let minimumAmountMinor: number | undefined;
        if (dto.minimumAmount !== undefined) {
            minimumAmountMinor = Math.round(Number(dto.minimumAmount) * 100);
            const floor = this.minimumWithdrawalMinor(currency);
            if (!Number.isFinite(minimumAmountMinor) || minimumAmountMinor < floor) {
                throw new BadRequestException(
                    `Minimum amount must be at least ${formatCurrencyAmount(this.toMajor(floor), currency)}`,
                );
            }
        }

        const existing = await this.prisma.payoutSettings.findUnique({ where: { userId } });
        const intervalDays = dto.intervalDays !== undefined ? Number(dto.intervalDays) : existing?.intervalDays ?? 7;
        const enabled = dto.autoPayoutEnabled !== undefined ? !!dto.autoPayoutEnabled : existing?.autoPayoutEnabled ?? false;
        const nextRunAt = enabled
            ? (existing?.autoPayoutEnabled && existing.nextRunAt && dto.intervalDays === undefined
                ? existing.nextRunAt
                : new Date(Date.now() + intervalDays * 24 * 3600 * 1000))
            : null;

        await this.prisma.payoutSettings.upsert({
            where: { userId },
            create: {
                userId,
                autoPayoutEnabled: enabled,
                intervalDays,
                minimumAmountMinor: minimumAmountMinor ?? Math.max(this.minimumWithdrawalMinor(currency), 2000),
                nextRunAt,
            },
            update: {
                autoPayoutEnabled: enabled,
                intervalDays,
                ...(minimumAmountMinor !== undefined ? { minimumAmountMinor } : {}),
                nextRunAt,
            },
        });
        return this.getPayoutSettings(userId);
    }

    @Cron(CronExpression.EVERY_HOUR)
    async runAutomaticPayouts() {
        if (this.autoPayoutRunning) return;
        this.autoPayoutRunning = true;
        try {
            const due = await this.prisma.payoutSettings.findMany({
                where: { autoPayoutEnabled: true, nextRunAt: { lte: new Date() } },
                take: 100,
            });
            for (const settings of due) {
                const nextRunAt = new Date(Date.now() + settings.intervalDays * 24 * 3600 * 1000);
                // Move the schedule first so a crash can't cause a double payout in the same window.
                await this.prisma.payoutSettings.update({
                    where: { id: settings.id },
                    data: { lastRunAt: new Date(), nextRunAt },
                });
                try {
                    const { currency } = await this.getUserWalletContext(settings.userId);
                    const balance = await this.walletService.getBalance(settings.userId, { currency, provider: 'STRIPE' });
                    if (balance.availableBalanceMinor < settings.minimumAmountMinor) continue;
                    await this.requestWithdrawal(settings.userId, this.toMajor(balance.availableBalanceMinor), { automatic: true });
                } catch (error: any) {
                    this.logger.warn(`[Payouts] Automatic payout for ${settings.userId} skipped: ${error?.message}`);
                }
            }
        } finally {
            this.autoPayoutRunning = false;
        }
    }

    // ---------------------------------------------------------------------------
    // Screens: Wallet, Transfer to Bank, Transactions, Funds on the way
    // ---------------------------------------------------------------------------

    private payoutAccountView(user: Awaited<ReturnType<PayoutsService['getUserWalletContext']>>['user']) {
        return {
            provider: 'STRIPE',
            connected: !!user.stripeAccountId,
            status: user.stripeAccountId ? user.stripeAccountStatus || 'onboarding' : 'not_started',
            payoutsEnabled: !!user.stripePayoutsEnabled,
            email: user.stripeAccountEmail || user.email || null,
            country: user.stripeAccountCountry || resolvePaymentCountry(user),
            bankName: user.stripeBankName,
            bankLast4: user.stripeBankLast4,
            bankCurrency: user.stripeBankCurrency ? user.stripeBankCurrency.toUpperCase() : null,
        };
    }

    async getWalletSummary(userId: string) {
        const { user, currency } = await this.getUserWalletContext(userId);
        const balance = await this.walletService.getBalance(userId, { currency, provider: 'STRIPE' });

        const sums = await this.prisma.walletLedgerEntry.groupBy({
            by: ['entryType'],
            where: { userId, currency },
            _sum: { amountMinor: true },
        });
        const sumOf = (type: string) => Number(sums.find((row) => row.entryType === type)?._sum.amountMinor || 0);
        const totalEarnedMinor = sumOf('AVAILABLE_CREDIT') + sumOf('PENDING_CREDIT') - sumOf('PENDING_REVERSAL');
        const totalWithdrawnMinor = sumOf('WITHDRAWAL') - sumOf('WITHDRAWAL_REVERSAL');

        const inTransit = await this.prisma.withdrawalRecord.aggregate({
            where: {
                userId,
                currency,
                status: 'success',
                payoutStatus: { in: IN_TRANSIT_PAYOUT_STATUSES },
            },
            _sum: { amountMinor: true },
        });
        const inTransitMinor = Number(inTransit._sum.amountMinor || 0);

        const recent = await this.getLedgerFeed(userId, { filter: 'earned', page: 1, limit: 5 });
        const settings = await this.getPayoutSettings(userId);
        const fmt = (minor: number) => formatCurrencyAmount(this.toMajor(minor), currency);

        return {
            currency: currency.toUpperCase(),
            currencySymbol: getCurrencySymbol(currency),
            availableBalance: this.toMajor(balance.availableBalanceMinor),
            availableBalanceMinor: balance.availableBalanceMinor,
            formattedAvailableBalance: fmt(balance.availableBalanceMinor),
            pendingBalance: this.toMajor(balance.pendingBalanceMinor),
            pendingBalanceMinor: balance.pendingBalanceMinor,
            formattedPendingBalance: fmt(balance.pendingBalanceMinor),
            inTransitAmount: this.toMajor(inTransitMinor),
            inTransitAmountMinor: inTransitMinor,
            formattedInTransitAmount: fmt(inTransitMinor),
            totalEarned: this.toMajor(totalEarnedMinor),
            totalEarnedMinor,
            formattedTotalEarned: fmt(totalEarnedMinor),
            totalWithdrawn: this.toMajor(totalWithdrawnMinor),
            totalWithdrawnMinor,
            formattedTotalWithdrawn: fmt(totalWithdrawnMinor),
            minimumWithdrawal: this.toMajor(this.minimumWithdrawalMinor(currency)),
            canWithdraw:
                !!user.stripeAccountId &&
                !!user.stripePayoutsEnabled &&
                balance.availableBalanceMinor >= this.minimumWithdrawalMinor(currency),
            payoutAccount: this.payoutAccountView(user),
            payoutSettings: settings,
            recentEarnings: recent.items,
        };
    }

    /** "Transfer to Bank" preview: amount, fee, what arrives in the bank (estimate), arrival time. */
    async getWithdrawalQuote(userId: string, amount?: number) {
        const { user, currency } = await this.getUserWalletContext(userId);
        const balance = await this.walletService.getBalance(userId, { currency, provider: 'STRIPE' });
        const availableMinor = balance.availableBalanceMinor;
        const requestedMinor =
            amount !== undefined && amount !== null && Number.isFinite(Number(amount))
                ? Math.round(Number(amount) * 100)
                : availableMinor;
        const minimumMinor = this.minimumWithdrawalMinor(currency);
        const fmt = (minor: number, cur = currency) => formatCurrencyAmount(this.toMajor(minor), cur);

        let errorCode: string | null = null;
        if (!user.stripeAccountId || !user.stripeDetailsSubmitted) errorCode = 'ONBOARDING_REQUIRED';
        else if (!user.stripePayoutsEnabled) errorCode = 'PAYOUTS_NOT_ENABLED';
        else if (requestedMinor < minimumMinor) errorCode = 'BELOW_MINIMUM';
        else if (requestedMinor > availableMinor) errorCode = 'INSUFFICIENT_BALANCE';

        // Estimate what reaches the bank: wallet → platform currency (base rate) → bank currency (Stripe rate incl. FX fee).
        const bankCurrency = (user.stripeBankCurrency || currency).toLowerCase();
        let estimatedBankAmountMinor: number | null = requestedMinor;
        let estimateNote: string | null = null;
        if (requestedMinor > 0 && bankCurrency !== currency) {
            try {
                const toPlatform = await this.fx.convertMinor(requestedMinor, currency, platformCurrency(), { rateType: 'base' });
                const toBank = await this.fx.convertMinor(toPlatform.toAmountMinor, platformCurrency(), bankCurrency, { rateType: 'exchange' });
                estimatedBankAmountMinor = toBank.toAmountMinor;
                estimateNote = 'Estimated. Stripe converts the currency when it pays out to your bank.';
            } catch {
                estimatedBankAmountMinor = null;
                estimateNote = 'Estimate unavailable right now.';
            }
        } else if (requestedMinor > 0 && currency !== platformCurrency()) {
            // Same currency on both ends, but the money passes through the platform currency.
            estimateNote = 'Estimated. Small differences can come from Stripe currency conversion.';
        }

        return {
            currency: currency.toUpperCase(),
            currencySymbol: getCurrencySymbol(currency),
            availableBalance: this.toMajor(availableMinor),
            formattedAvailableBalance: fmt(availableMinor),
            amount: this.toMajor(requestedMinor),
            formattedAmount: fmt(requestedMinor),
            maxAmount: this.toMajor(availableMinor),
            minimumAmount: this.toMajor(minimumMinor),
            formattedMinimumAmount: fmt(minimumMinor),
            fee: 0,
            formattedFee: fmt(0),
            youWillReceive: this.toMajor(requestedMinor),
            formattedYouWillReceive: fmt(requestedMinor),
            bankCurrency: bankCurrency.toUpperCase(),
            estimatedBankAmount: estimatedBankAmountMinor != null ? this.toMajor(estimatedBankAmountMinor) : null,
            formattedEstimatedBankAmount:
                estimatedBankAmountMinor != null ? fmt(estimatedBankAmountMinor, bankCurrency) : null,
            estimateNote,
            estimatedArrival: '1-2 business days',
            payoutAccount: this.payoutAccountView(user),
            canWithdraw: errorCode === null,
            errorCode,
        };
    }

    /** Transactions screen: All / Earned / Withdrawn / Pending, newest first. */
    async getLedgerFeed(
        userId: string,
        query: { filter?: string; source?: string; page?: number; limit?: number },
    ) {
        const { currency } = await this.getUserWalletContext(userId);
        const filter = (['all', 'earned', 'withdrawn', 'pending'].includes(String(query.filter || 'all').toLowerCase())
            ? String(query.filter || 'all').toLowerCase()
            : 'all') as LedgerFeedFilter;
        const page = Math.max(1, Number(query.page) || 1);
        const limit = Math.min(Math.max(1, Number(query.limit) || 20), 50);
        const source = query.source ? String(query.source).toUpperCase() : undefined;
        const take = page * limit;

        const items: any[] = [];

        const wantEarnings = filter !== 'withdrawn';
        const wantWithdrawals = filter === 'all' || filter === 'withdrawn' || filter === 'pending';

        if (wantEarnings) {
            const entries = await this.prisma.walletLedgerEntry.findMany({
                where: {
                    userId,
                    currency,
                    entryType: filter === 'pending' ? 'PENDING_CREDIT' : { in: ['AVAILABLE_CREDIT', 'PENDING_CREDIT'] },
                    ...(source ? { source } : {}),
                },
                orderBy: { createdAt: 'desc' },
                take: filter === 'pending' ? 500 : take,
            });

            const pendingRefIds = entries.filter((e) => e.entryType === 'PENDING_CREDIT' && e.refId).map((e) => e.refId as string);
            const settled = pendingRefIds.length
                ? await this.prisma.walletLedgerEntry.findMany({
                    where: {
                        userId,
                        refId: { in: pendingRefIds },
                        entryType: { in: ['PENDING_TO_AVAILABLE', 'PENDING_REVERSAL'] },
                    },
                    select: { refId: true, entryType: true },
                })
                : [];
            const settledMap = new Map<string | null, string>(settled.map((row) => [row.refId, row.entryType] as [string | null, string]));

            for (const entry of entries) {
                let status = 'available';
                if (entry.entryType === 'PENDING_CREDIT') {
                    const settledType = entry.refId ? settledMap.get(entry.refId) : undefined;
                    status = settledType === 'PENDING_TO_AVAILABLE' ? 'available' : settledType === 'PENDING_REVERSAL' ? 'reversed' : 'pending';
                }
                if (filter === 'pending' && status !== 'pending') continue;
                items.push({
                    id: entry.id,
                    kind: 'earning',
                    type: 'credit',
                    source: entry.source,
                    title: SOURCE_TITLES[entry.source] || entry.source,
                    amount: this.toMajor(entry.amountMinor),
                    amountMinor: entry.amountMinor,
                    currency: entry.currency.toUpperCase(),
                    formattedAmount: `+ ${formatCurrencyAmount(this.toMajor(entry.amountMinor), entry.currency)}`,
                    status,
                    originalAmount: entry.originalAmountMinor != null ? this.toMajor(entry.originalAmountMinor) : null,
                    originalCurrency: entry.originalCurrency ? entry.originalCurrency.toUpperCase() : null,
                    formattedOriginalAmount:
                        entry.originalAmountMinor != null && entry.originalCurrency
                            ? formatCurrencyAmount(this.toMajor(entry.originalAmountMinor), entry.originalCurrency)
                            : null,
                    fxRate: entry.fxRate,
                    refType: entry.refType,
                    refId: entry.refId,
                    createdAt: entry.createdAt,
                });
            }
        }

        if (wantWithdrawals && !source) {
            const withdrawals = await this.prisma.withdrawalRecord.findMany({
                where: {
                    userId,
                    currency,
                    ...(filter === 'pending'
                        ? { status: 'success', payoutStatus: { in: IN_TRANSIT_PAYOUT_STATUSES } }
                        : { status: { in: ['success', 'failed', 'processing'] } }),
                },
                orderBy: { createdAt: 'desc' },
                take: filter === 'pending' ? 500 : take,
            });
            for (const w of withdrawals) {
                const view = this.serializeWithdrawal(w);
                items.push({
                    id: w.id,
                    kind: 'withdrawal',
                    type: 'debit',
                    source: 'WITHDRAWAL',
                    title: w.isAutomatic ? 'Automatic payout to Bank' : 'Payout to Bank',
                    amount: -this.toMajor(view.amountMinor),
                    amountMinor: view.amountMinor,
                    currency: currency.toUpperCase(),
                    formattedAmount: `- ${formatCurrencyAmount(this.toMajor(view.amountMinor), currency)}`,
                    status: view.displayStatus,
                    withdrawalId: w.id,
                    createdAt: w.createdAt,
                });
            }
        }

        items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        const start = (page - 1) * limit;
        return {
            currency: currency.toUpperCase(),
            filter,
            page,
            limit,
            hasMore: items.length > start + limit,
            items: items.slice(start, start + limit),
        };
    }

    serializeWithdrawal(w: any) {
        const amountMinor = w.amountMinor ?? Math.round(Number(w.withdrawAmount || 0) * 100);
        let displayStatus: string;
        if (w.status === 'failed' || w.status === 'requires_onboarding') displayStatus = 'failed';
        else if (w.status === 'processing') displayStatus = 'processing';
        else if (w.payoutStatus === 'paid') displayStatus = 'completed';
        else if (w.payoutStatus === 'failed' || w.payoutStatus === 'canceled') displayStatus = 'bank_failed';
        else if (w.payoutStatus === 'in_transit') displayStatus = 'in_transit';
        else if (w.status === 'success' && !w.payoutStatus) displayStatus = 'completed'; // legacy records
        else displayStatus = 'processing';

        return {
            id: w.id,
            amount: w.withdrawAmount,
            amountMinor,
            currency: w.currency,
            provider: w.provider,
            status: w.status,
            transferId: w.transferId || w.txhash,
            failureReason: w.failureReason,
            processingAt: w.processingAt,
            createdAt: w.createdAt,
            updatedAt: w.updatedAt,
            // New fields
            displayStatus,
            formattedAmount: formatCurrencyAmount(this.toMajor(amountMinor), w.currency || 'usd'),
            transferAmount: w.transferAmountMinor != null ? this.toMajor(w.transferAmountMinor) : null,
            transferCurrency: w.transferCurrency ? String(w.transferCurrency).toUpperCase() : null,
            fxRate: w.fxRate ?? null,
            payoutId: w.payoutId ?? null,
            payoutStatus: w.payoutStatus ?? null,
            payoutAmount: w.payoutAmountMinor != null ? this.toMajor(w.payoutAmountMinor) : null,
            payoutCurrency: w.payoutCurrency ? String(w.payoutCurrency).toUpperCase() : null,
            formattedPayoutAmount:
                w.payoutAmountMinor != null && w.payoutCurrency
                    ? formatCurrencyAmount(this.toMajor(w.payoutAmountMinor), w.payoutCurrency)
                    : null,
            estimatedArrival: w.payoutArrivalDate ?? null,
            transferredAt: w.transferredAt ?? null,
            paidAt: w.paidAt ?? null,
            failedAt: w.failedAt ?? null,
            isAutomatic: !!w.isAutomatic,
        };
    }

    /** "Funds on the way" timeline. */
    async getWithdrawalDetail(userId: string, withdrawalId: string) {
        const w = await this.prisma.withdrawalRecord.findFirst({ where: { id: withdrawalId, userId } });
        if (!w) throw new NotFoundException('Withdrawal not found');
        const view = this.serializeWithdrawal(w);
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { stripeBankName: true, stripeBankLast4: true },
        });

        const timeline = [
            { step: 'requested', title: 'Transfer requested', done: true, at: w.createdAt },
            {
                step: 'processing',
                title: 'Processing with Stripe',
                done: !!w.transferredAt,
                at: w.transferredAt,
            },
            {
                step: 'arriving',
                title: 'Arriving at your bank',
                done: w.payoutStatus === 'paid',
                at: w.paidAt,
                estimatedAt: w.payoutArrivalDate,
            },
        ];

        return {
            ...view,
            bankName: user?.stripeBankName ?? null,
            bankLast4: user?.stripeBankLast4 ?? null,
            timeline,
        };
    }

    async getWithdrawalHistory(userId: string) {
        const withdrawals = await this.prisma.withdrawalRecord.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
        });
        return { withdrawals: withdrawals.map((w) => this.serializeWithdrawal(w)) };
    }

    /** "B receives ≈" preview when sending a tip (optional for the app). */
    async estimateTipReceived(payerUserId: string, receiverUserId: string, amount: number) {
        const [payer, receiver] = await Promise.all([
            this.prisma.user.findUnique({ where: { id: payerUserId }, select: { country: true, kycCountry: true } }),
            this.prisma.user.findUnique({ where: { id: receiverUserId }, select: { country: true, kycCountry: true } }),
        ]);
        if (!receiver) throw new NotFoundException('Receiver not found');
        // The tip checkout charges Brazilian payers in BRL and everyone else in USD.
        const payerCurrency = resolveWalletCurrency(payer);
        const receiverCurrency = resolveWalletCurrency(receiver);
        const amountMinor = Math.round(Number(amount || 0) * 100);
        const minimumMinor = Number(process.env[`MIN_TIP_${payerCurrency.toUpperCase()}_MINOR`] || process.env.MIN_TIP_MINOR || 0);

        let receivedMinor: number | null = amountMinor;
        let fxRate: number | null = 1;
        if (payerCurrency !== receiverCurrency && amountMinor > 0) {
            try {
                const conversion = await this.fx.convertMinor(amountMinor, payerCurrency, receiverCurrency, { rateType: 'base' });
                receivedMinor = conversion.toAmountMinor;
                fxRate = conversion.rate;
            } catch {
                receivedMinor = null;
                fxRate = null;
            }
        }

        return {
            sendCurrency: payerCurrency.toUpperCase(),
            sendAmount: this.toMajor(amountMinor),
            formattedSendAmount: formatCurrencyAmount(this.toMajor(amountMinor), payerCurrency),
            receiveCurrency: receiverCurrency.toUpperCase(),
            estimatedReceiveAmount: receivedMinor != null ? this.toMajor(receivedMinor) : null,
            formattedEstimatedReceiveAmount: receivedMinor != null ? formatCurrencyAmount(this.toMajor(receivedMinor), receiverCurrency) : null,
            fxRate,
            platformFee: 0,
            minimumAmount: minimumMinor > 0 ? this.toMajor(minimumMinor) : null,
            note: payerCurrency !== receiverCurrency ? 'Estimate. Final amount uses Stripe\'s rate when the payment completes.' : null,
        };
    }
}
