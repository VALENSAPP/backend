import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service';
import { resolvePaymentCountry } from '../common/country.util';

export type ConnectAccountStatus =
    | 'not_started'
    | 'onboarding'
    | 'requirements_due'
    | 'in_review'
    | 'enabled'
    | 'restricted';

/**
 * Stripe Connect (Express) onboarding for payouts.
 *
 * - The account is created with the user's real country (verified KYC country, ISO alpha-2).
 * - Only the `transfers` capability is requested (Valens pays users; users don't take card payments
 *   on their own account, and cross-border accounts can't have card_payments).
 * - Payout schedule is set to manual so Valens creates each bank payout itself and can track it
 *   (Funds on the way / Arriving at your bank).
 * - Onboarding pages are Stripe-hosted. The refresh/return URLs carry a signed token so the backend can
 *   issue a fresh link (expired link) and sync the account status (return) without app changes.
 */
@Injectable()
export class StripeConnectService {
    private readonly logger = new Logger(StripeConnectService.name);
    private readonly stripe: Stripe;

    constructor(private readonly prisma: PrismaService) {
        this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
            apiVersion: '2024-06-20',
        });
    }

    get client(): Stripe {
        return this.stripe;
    }

    // ---------------------------------------------------------------------------
    // Onboarding link
    // ---------------------------------------------------------------------------

    async createOnboardingLink(userId: string): Promise<{ onboardingUrl: string; provider: 'STRIPE'; country: string; accountId: string }> {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user) throw new BadRequestException('User not found');

        if (!user.kyc) {
            throw new BadRequestException({
                message: 'Complete identity verification (KYC) before connecting your payout account.',
                code: 'KYC_REQUIRED',
            });
        }

        const country = resolvePaymentCountry(user);
        if (!country) {
            throw new BadRequestException({
                message: 'We could not determine your country from your verification. Please contact support.',
                code: 'COUNTRY_REQUIRED',
            });
        }

        let accountId = user.stripeAccountId;

        if (accountId) {
            // A Stripe account's country can never change. Accounts created before this fix may have the
            // wrong country (e.g. Brazilian users were created as US). If the user never finished
            // onboarding on it, replace it with an account in the correct country.
            try {
                const existing = await this.stripe.accounts.retrieve(accountId);
                if (existing.country && existing.country.toUpperCase() !== country) {
                    if (!existing.details_submitted) {
                        this.logger.warn(
                            `[Connect] Replacing unfinished account ${accountId} (${existing.country}) for user ${userId} with a ${country} account`,
                        );
                        accountId = null;
                    } else {
                        this.logger.warn(
                            `[Connect] User ${userId} has a completed ${existing.country} account but KYC country is ${country}; keeping existing account`,
                        );
                    }
                }
            } catch (error: any) {
                if (error?.code === 'resource_missing' || error?.statusCode === 404) {
                    accountId = null;
                } else {
                    throw error;
                }
            }
        }

        if (!accountId) {
            accountId = await this.createExpressAccount(userId, country, user.email);
        } else {
            await this.ensureManualPayoutSchedule(accountId);
        }

        const onboardingUrl = await this.createAccountLink(userId, accountId);
        return { onboardingUrl, provider: 'STRIPE', country, accountId };
    }

    private async createExpressAccount(userId: string, country: string, email?: string | null): Promise<string> {
        try {
            const account = await this.stripe.accounts.create({
                type: 'express',
                country,
                email: email || undefined,
                capabilities: {
                    transfers: { requested: true },
                },
                settings: {
                    payouts: {
                        schedule: { interval: 'manual' },
                    },
                },
                metadata: { valensUserId: userId },
            });

            await this.prisma.user.update({
                where: { id: userId },
                data: {
                    stripeAccountId: account.id,
                    stripeAccountCountry: account.country?.toUpperCase() || country,
                    stripeAccountEmail: account.email || email || null,
                    stripeAccountStatus: 'onboarding',
                    stripeDetailsSubmitted: false,
                    stripePayoutsEnabled: false,
                    stripeBankName: null,
                    stripeBankLast4: null,
                    stripeBankCurrency: null,
                    stripeAccountSyncedAt: new Date(),
                },
            });

            return account.id;
        } catch (error: any) {
            this.logger.error(`[Connect] accounts.create failed for ${userId} (${country}): ${error?.message}`);
            const message: string = error?.message || '';
            if (error?.type === 'StripeInvalidRequestError' && /country/i.test(message)) {
                throw new BadRequestException({
                    message: `Payouts are not available yet for your country (${country}).`,
                    code: 'STRIPE_COUNTRY_NOT_SUPPORTED',
                    country,
                });
            }
            throw new BadRequestException('Failed to create payout account. Please try again later.');
        }
    }

    private async ensureManualPayoutSchedule(accountId: string) {
        try {
            const account = await this.stripe.accounts.retrieve(accountId);
            if (account.settings?.payouts?.schedule?.interval !== 'manual') {
                await this.stripe.accounts.update(accountId, {
                    settings: { payouts: { schedule: { interval: 'manual' } } },
                });
            }
        } catch (error: any) {
            this.logger.warn(`[Connect] Could not set manual payout schedule on ${accountId}: ${error?.message}`);
        }
    }

    private baseUrl(): string {
        const baseUrl = (process.env.STRIPE_CONNECT_RETURN_BASE_URL || process.env.BACKEND_URL || process.env.FRONTEND_URL || '').replace(/\/$/, '');
        if (!baseUrl) {
            throw new BadRequestException(
                'Set STRIPE_CONNECT_RETURN_BASE_URL, BACKEND_URL, or FRONTEND_URL so Stripe can redirect after onboarding.',
            );
        }
        return baseUrl;
    }

    private async createAccountLink(userId: string, accountId: string): Promise<string> {
        const base = this.baseUrl();
        const token = this.signToken(userId, accountId);
        try {
            const link = await this.stripe.accountLinks.create({
                account: accountId,
                refresh_url: `${base}/withdrawal/reauth?token=${encodeURIComponent(token)}`,
                return_url: `${base}/withdrawal/success?token=${encodeURIComponent(token)}`,
                type: 'account_onboarding',
            });
            return link.url;
        } catch (error: any) {
            this.logger.error(`[Connect] accountLinks.create failed for ${accountId}: ${error?.message}`);
            throw new BadRequestException('Failed to create onboarding link. Please try again later.');
        }
    }

    // ---------------------------------------------------------------------------
    // Signed tokens for Stripe refresh/return URLs (no login session in the browser)
    // ---------------------------------------------------------------------------

    private tokenSecret(): string {
        const secret = process.env.STRIPE_CONNECT_LINK_SECRET || process.env.JWT_SECRET;
        if (!secret) throw new BadRequestException('STRIPE_CONNECT_LINK_SECRET (or JWT_SECRET) is not configured');
        return secret;
    }

    private signToken(userId: string, accountId: string): string {
        // Valid for 7 days: long enough for users who come back later to an expired Stripe page.
        const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
        const payload = Buffer.from(JSON.stringify({ u: userId, a: accountId, e: exp })).toString('base64url');
        const sig = createHmac('sha256', this.tokenSecret()).update(payload).digest('base64url');
        return `${payload}.${sig}`;
    }

    verifyToken(token?: string | null): { userId: string; accountId: string } | null {
        if (!token || !token.includes('.')) return null;
        const [payload, sig] = token.split('.');
        const expected = createHmac('sha256', this.tokenSecret()).update(payload).digest('base64url');
        const a = Buffer.from(sig || '');
        const b = Buffer.from(expected);
        if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
        try {
            const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
            if (!data?.u || !data?.a || !data?.e || data.e < Math.floor(Date.now() / 1000)) return null;
            return { userId: String(data.u), accountId: String(data.a) };
        } catch {
            return null;
        }
    }

    /** Stripe "refresh_url": the link expired or was reused — issue a new one for the same account. */
    async refreshLinkFromToken(token?: string | null): Promise<string | null> {
        const verified = this.verifyToken(token);
        if (!verified) return null;
        const user = await this.prisma.user.findUnique({
            where: { id: verified.userId },
            select: { stripeAccountId: true },
        });
        if (!user?.stripeAccountId || user.stripeAccountId !== verified.accountId) return null;
        return this.createAccountLink(verified.userId, verified.accountId);
    }

    /** Stripe "return_url": user finished (or left) onboarding — sync status right away. */
    async syncFromToken(token?: string | null) {
        const verified = this.verifyToken(token);
        if (!verified) return null;
        return this.syncAccountById(verified.accountId);
    }

    // ---------------------------------------------------------------------------
    // Status sync (return page, account.updated webhook, status endpoint)
    // ---------------------------------------------------------------------------

    computeStatus(account: Stripe.Account): ConnectAccountStatus {
        if (!account.details_submitted) return 'onboarding';
        const disabledReason = account.requirements?.disabled_reason || '';
        if (disabledReason) {
            if (disabledReason.includes('past_due')) return 'requirements_due';
            if (disabledReason.includes('pending_verification')) return 'in_review';
            return 'restricted';
        }
        if ((account.requirements?.currently_due || []).length > 0) return 'requirements_due';
        if (account.payouts_enabled) return 'enabled';
        return 'in_review';
    }

    private bankFromAccount(account: Stripe.Account) {
        const list = (account.external_accounts?.data || []) as Array<Stripe.BankAccount | Stripe.Card>;
        const preferred =
            list.find((ea: any) => ea.default_for_currency) ||
            list[0];
        if (!preferred) return { bankName: null, last4: null, currency: null };
        if ((preferred as any).object === 'bank_account') {
            const bank = preferred as Stripe.BankAccount;
            return { bankName: bank.bank_name || null, last4: bank.last4 || null, currency: bank.currency || null };
        }
        const card = preferred as Stripe.Card;
        return { bankName: card.brand || 'Card', last4: card.last4 || null, currency: card.currency || null };
    }

    async syncAccount(account: Stripe.Account) {
        const user = await this.prisma.user.findFirst({
            where: { stripeAccountId: account.id },
            select: { id: true },
        });
        if (!user) return null;

        const status = this.computeStatus(account);
        const bank = this.bankFromAccount(account);

        const updated = await this.prisma.user.update({
            where: { id: user.id },
            data: {
                stripeAccountCountry: account.country?.toUpperCase() || null,
                stripeAccountEmail: account.email || null,
                stripeAccountStatus: status,
                stripeDetailsSubmitted: !!account.details_submitted,
                stripePayoutsEnabled: !!account.payouts_enabled,
                stripeBankName: bank.bankName,
                stripeBankLast4: bank.last4,
                stripeBankCurrency: bank.currency,
                stripeAccountSyncedAt: new Date(),
            },
            select: { id: true },
        });

        if (account.settings?.payouts?.schedule?.interval !== 'manual') {
            await this.ensureManualPayoutSchedule(account.id);
        }

        return { userId: updated.id, status, payoutsEnabled: !!account.payouts_enabled };
    }

    async syncAccountById(accountId: string) {
        try {
            const account = await this.stripe.accounts.retrieve(accountId);
            return this.syncAccount(account);
        } catch (error: any) {
            this.logger.warn(`[Connect] syncAccountById ${accountId} failed: ${error?.message}`);
            return null;
        }
    }

    /** Status for the app (existing fields kept, new fields added). */
    async getOnboardingStatus(userId: string) {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user) throw new BadRequestException('User not found');

        const country = resolvePaymentCountry(user);
        const base = {
            provider: 'STRIPE' as const,
            country: user.country,
            kycCountry: country,
        };

        if (!user.stripeAccountId) {
            return {
                ...base,
                canReceivePayments: false,
                status: 'not_started' as ConnectAccountStatus,
                message: 'Please complete stripe onboarding',
            };
        }

        try {
            const account = await this.stripe.accounts.retrieve(user.stripeAccountId);
            await this.syncAccount(account);
            const status = this.computeStatus(account);
            const bank = this.bankFromAccount(account);
            const canReceive = !!(account.details_submitted && account.payouts_enabled !== false);
            return {
                ...base,
                canReceivePayments: canReceive,
                accountId: user.stripeAccountId,
                status,
                payoutsEnabled: !!account.payouts_enabled,
                detailsSubmitted: !!account.details_submitted,
                accountCountry: account.country?.toUpperCase() || null,
                email: account.email || null,
                bankName: bank.bankName,
                bankLast4: bank.last4,
                bankCurrency: bank.currency,
                requirementsDue: account.requirements?.currently_due || [],
                message: canReceive ? undefined : 'Finish onboarding (e.g. add bank account) to withdraw.',
            };
        } catch {
            return {
                ...base,
                canReceivePayments: false,
                accountId: user.stripeAccountId,
                status: (user.stripeAccountStatus as ConnectAccountStatus) || 'onboarding',
                message: 'Stripe account not ready.',
            };
        }
    }

    /**
     * Returns the connected account id if the user can receive payouts, else throws.
     * Requires details submitted and payouts enabled.
     */
    async requireReadyAccount(userId: string): Promise<{ accountId: string; account: Stripe.Account }> {
        const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { stripeAccountId: true } });
        if (!user?.stripeAccountId) {
            throw new BadRequestException({
                message: 'Complete Stripe onboarding before withdrawing. Call POST /billing/create-onboarding-link first.',
                code: 'ONBOARDING_REQUIRED',
            });
        }
        const account = await this.stripe.accounts.retrieve(user.stripeAccountId);
        if (!account.details_submitted) {
            throw new BadRequestException({
                message: 'Finish Stripe onboarding (identity and bank details) before withdrawing.',
                code: 'ONBOARDING_INCOMPLETE',
            });
        }
        if (account.payouts_enabled === false) {
            throw new BadRequestException({
                message: 'Stripe has not enabled payouts on your account yet. Check your Stripe account for missing details.',
                code: 'PAYOUTS_NOT_ENABLED',
            });
        }
        return { accountId: user.stripeAccountId, account };
    }

    /** Link to the Stripe Express dashboard (change bank account, see payouts). */
    async createDashboardLink(userId: string): Promise<{ url: string }> {
        const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { stripeAccountId: true } });
        if (!user?.stripeAccountId) {
            throw new BadRequestException({ message: 'No payout account connected yet.', code: 'ONBOARDING_REQUIRED' });
        }
        try {
            const link = await this.stripe.accounts.createLoginLink(user.stripeAccountId);
            return { url: link.url };
        } catch (error: any) {
            this.logger.warn(`[Connect] createLoginLink failed for ${user.stripeAccountId}: ${error?.message}`);
            throw new BadRequestException({
                message: 'Finish onboarding before opening the Stripe dashboard.',
                code: 'ONBOARDING_INCOMPLETE',
            });
        }
    }
}
