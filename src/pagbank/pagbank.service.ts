import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { NotificationService } from '../notification/notification.service';
import { PagBankClient } from './pagbank.client';
import { CurrencyConverterService } from '../common/currency/currency-converter.service';
import { normalizeCountryCode } from '../common/payment-provider.util';

export type PagBankCheckoutResult = {
    provider: 'PAGBANK';
    orderId: string;
    referenceId: string;
    currency: 'brl';
    amountMinor: number;
    checkoutUrl: string | null;
    qrCode: string | null;
    pixCopyPaste: string | null;
    expiresAt: string | null;
};

@Injectable()
export class PagBankService {
    private readonly logger = new Logger(PagBankService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly client: PagBankClient,
        private readonly walletService: WalletService,
        private readonly notificationService: NotificationService,
        private readonly currencyConverter: CurrencyConverterService,
    ) { }

    isConfigured(): boolean {
        return !!(process.env.PAGBANK_TOKEN || process.env.PAGBANK_ACCOUNT_TOKEN);
    }

    isConnectConfigured(): boolean {
        return this.isConfigured() && !!(process.env.PAGBANK_CLIENT_ID && (process.env.PAGBANK_CONNECT_REDIRECT_URI || process.env.BACKEND_URL));
    }

    private getConnectAuthorizeBaseUrl(): string {
        const env = (process.env.PAGBANK_ENV || 'sandbox').toLowerCase();
        return (
            process.env.PAGBANK_CONNECT_AUTHORIZE_URL ||
            (env === 'production'
                ? 'https://connect.pagbank.com.br/oauth2/authorize'
                : 'https://connect.sandbox.pagbank.com.br/oauth2/authorize')
        );
    }

    private getRedirectUri(): string {
        const base = (
            process.env.PAGBANK_CONNECT_REDIRECT_URI ||
            process.env.PAGBANK_CONNECT_RETURN_BASE_URL ||
            process.env.BACKEND_URL ||
            process.env.BASE_URL ||
            'https://api.valens.app'
        ).replace(/\/$/, '');
        if (base.includes('/billing/pagbank/callback')) return base;
        return `${base}/billing/pagbank/callback`;
    }

    private getNotificationUrl(): string {
        const base = (
            process.env.BACKEND_URL ||
            process.env.BASE_URL ||
            process.env.PAGBANK_NOTIFICATION_URL ||
            process.env.PAGBANK_CONNECT_RETURN_BASE_URL ||
            'https://api.valens.app'
        ).replace(/\/$/, '');
        if (base.includes('/billing/pagbank/webhook')) return base;
        return `${base}/billing/pagbank/webhook`;
    }

    async getOnboardingStatus(userId: string): Promise<{
        canReceivePayments: boolean;
        accountId?: string;
        message?: string;
        provider: 'PAGBANK';
    }> {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                pagbankAccountId: true,
                pagbankAccessToken: true,
                pagbankTokenExpiresAt: true,
            },
        });
        if (!user) throw new BadRequestException('User not found');

        if (!user.pagbankAccountId || !user.pagbankAccessToken) {
            return {
                provider: 'PAGBANK',
                canReceivePayments: false,
                message: 'Complete PagBank onboarding to withdraw available balance.',
            };
        }

        const expired =
            !!user.pagbankTokenExpiresAt &&
            user.pagbankTokenExpiresAt.getTime() <= Date.now() + 60_000;

        if (expired) {
            try {
                await this.refreshSellerToken(userId);
            } catch {
                return {
                    provider: 'PAGBANK',
                    canReceivePayments: false,
                    accountId: user.pagbankAccountId,
                    message: 'PagBank authorization expired. Reconnect your PagBank account.',
                };
            }
        }

        return {
            provider: 'PAGBANK',
            canReceivePayments: true,
            accountId: user.pagbankAccountId,
        };
    }

    private signConnectState(payload: string): string {
        // Bind the return to this platform, application and callback without a new secret.
        return createHmac('sha256', this.client.getPlatformToken())
            .update(`${process.env.PAGBANK_CLIENT_ID}\n${this.getRedirectUri()}\n${payload}`)
            .digest('base64url');
    }

    private createConnectState(userId: string): string {
        const payload = `v1.${userId}.${Date.now().toString(36)}.${randomBytes(16).toString('base64url')}`;
        const state = `${payload}.${this.signConnectState(payload)}`;
        if (state.length > 128) {
            throw new BadRequestException('Invalid PagBank Connect user identifier');
        }
        return state;
    }

    private getConnectStateUserId(state: string): string {
        if (typeof state !== 'string' || state.length > 128) {
            throw new BadRequestException('Invalid PagBank Connect state');
        }
        const parts = state.split('.');
        const [version, userId, issuedAtValue, nonce, signature] = parts;
        if (parts.length !== 5 || version !== 'v1' ||
            !/^[a-zA-Z0-9_-]+$/.test(userId || '') ||
            !/^[a-z0-9]+$/.test(issuedAtValue || '') ||
            !/^[a-zA-Z0-9_-]{22}$/.test(nonce || '') ||
            !/^[a-zA-Z0-9_-]{43}$/.test(signature || '')) {
            throw new BadRequestException('Invalid PagBank Connect state');
        }
        const issuedAt = Number.parseInt(issuedAtValue, 36);
        const now = Date.now();
        const expected = this.signConnectState(parts.slice(0, 4).join('.'));
        if (!Number.isSafeInteger(issuedAt) || issuedAt.toString(36) !== issuedAtValue ||
            issuedAt > now + 60_000 || now - issuedAt > 15 * 60_000 ||
            !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
            throw new BadRequestException('Invalid or expired PagBank Connect state');
        }
        return userId;
    }

    private async requestConnectToken(endpoint: '/oauth2/token' | '/oauth2/refresh', body: object) {
        const clientId = process.env.PAGBANK_CLIENT_ID;
        if (!clientId) {
            throw new BadRequestException('PAGBANK_CLIENT_ID is required for token exchange');
        }
        const api = this.client.createApi();
        try {
            const { data } = await api.post(endpoint, body, {
                headers: {
                    X_CLIENT_ID: clientId,
                    ...(process.env.PAGBANK_CLIENT_SECRET
                        ? { X_CLIENT_SECRET: process.env.PAGBANK_CLIENT_SECRET }
                        : {}),
                },
                maxRedirects: 0,
            });
            return data;
        } catch (error: any) {
            const status = Number.isInteger(error?.response?.status) ? error.response.status : 'unknown';
            // Provider payloads and Axios errors can contain credentials or authorization codes.
            this.logger.error(`PagBank Connect token request failed (HTTP ${status})`);
            throw new BadRequestException('PagBank authorization could not be completed. Reconnect your PagBank account.');
        }
    }

    private readConnectTokens(data: any, expectedAccountId?: string) {
        const accessToken = typeof data?.access_token === 'string' ? data.access_token.trim() : '';
        const refreshToken = typeof data?.refresh_token === 'string' ? data.refresh_token.trim() : '';
        const accountId = data?.account_id === undefined && expectedAccountId
            ? expectedAccountId
            : typeof data?.account_id === 'string' ? data.account_id.trim() : '';
        const expiresIn = Number(data?.expires_in);
        const expiresAt = new Date(Date.now() + expiresIn * 1000);
        if (!accessToken || !accountId || !Number.isFinite(expiresIn) || expiresIn <= 0 ||
            !Number.isFinite(expiresAt.getTime())) {
            throw new BadRequestException('PagBank returned incomplete authorization details');
        }
        if (expectedAccountId && accountId !== expectedAccountId) {
            throw new BadRequestException('PagBank returned a different connected account');
        }
        return { accessToken, refreshToken: refreshToken || null, accountId, expiresAt };
    }

    async createAccountOnboardingLink(userId: string): Promise<{ onboardingUrl: string; provider: 'PAGBANK' }> {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user) throw new BadRequestException('User not found');

        const clientId = process.env.PAGBANK_CLIENT_ID;
        if (!clientId) {
            throw new BadRequestException('PagBank Connect is not configured. Set PAGBANK_CLIENT_ID.');
        }

        const redirectUri = this.getRedirectUri();
        const state = this.createConnectState(userId);
        const scope = process.env.PAGBANK_CONNECT_SCOPE || 'payments.read payments.create accounts.read';
        const params = new URLSearchParams({
            client_id: clientId,
            response_type: 'code',
            redirect_uri: redirectUri,
            state,
            scope,
        });

        return {
            provider: 'PAGBANK',
            onboardingUrl: `${this.getConnectAuthorizeBaseUrl()}?${params.toString()}`,
        };
    }

    async handleConnectCallback(params: { code: string; state: string }) {
        if (typeof params.code !== 'string' || !params.code.trim()) {
            throw new BadRequestException('Missing code from PagBank Connect');
        }
        const userId = this.getConnectStateUserId(params.state);
        const data = await this.requestConnectToken('/oauth2/token', {
            grant_type: 'authorization_code',
            code: params.code,
            redirect_uri: this.getRedirectUri(),
        });
        const { accessToken, refreshToken, accountId, expiresAt } = this.readConnectTokens(data);

        await this.prisma.user.update({
            where: { id: userId },
            data: {
                paymentProvider: 'PAGBANK',
                pagbankAccessToken: accessToken,
                pagbankRefreshToken: refreshToken,
                pagbankAccountId: accountId,
                pagbankTokenExpiresAt: expiresAt,
            },
        });

        return { userId, accountId };
    }

    async refreshSellerToken(userId: string) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { pagbankRefreshToken: true, pagbankAccountId: true },
        });
        if (!user?.pagbankRefreshToken || !user.pagbankAccountId) {
            throw new BadRequestException('No PagBank refresh token or account. Reconnect PagBank account.');
        }

        const data = await this.requestConnectToken('/oauth2/refresh', {
            grant_type: 'refresh_token',
            refresh_token: user.pagbankRefreshToken,
        });
        const tokens = this.readConnectTokens(data, user.pagbankAccountId);
        if (!tokens.refreshToken) {
            throw new BadRequestException('PagBank did not return a renewed refresh token');
        }
        await this.prisma.user.update({
            where: { id: userId },
            data: {
                pagbankAccessToken: tokens.accessToken,
                pagbankRefreshToken: tokens.refreshToken,
                pagbankTokenExpiresAt: tokens.expiresAt,
            },
        });

        return tokens.accessToken;
    }

    /**
     * Create a PIX QR order on the platform PagBank account (funds held on platform).
     */
    async createPixCheckout(params: {
        referenceId: string;
        amountMinor: number;
        description: string;
        customerName?: string;
        customerEmail?: string;
        customerTaxId?: string;
        expirationMinutes?: number;
    }): Promise<PagBankCheckoutResult> {
        if (!this.isConfigured()) {
            throw new BadRequestException(
                'PagBank is not configured. Set PAGBANK_TOKEN to enable Brazil payments.',
            );
        }
        if (params.amountMinor <= 0) {
            throw new BadRequestException('Invalid PagBank amount');
        }

        const expiration = new Date(
            Date.now() + (params.expirationMinutes || 60) * 60 * 1000,
        );

        const body: any = {
            reference_id: params.referenceId.slice(0, 64),
            items: [
                {
                    name: params.description.slice(0, 100),
                    quantity: 1,
                    unit_amount: params.amountMinor,
                },
            ],
            qr_codes: [
                {
                    amount: { value: params.amountMinor },
                    expiration_date: expiration.toISOString(),
                },
            ],
            notification_urls: [this.getNotificationUrl()],
        };

        const cleanTaxId = (params.customerTaxId || '').replace(/\D/g, '');
        const taxId =
            cleanTaxId.length === 11 || cleanTaxId.length === 14
                ? cleanTaxId
                : (process.env.PAGBANK_DEFAULT_TAX_ID || '12345678909').replace(/\D/g, '');

        body.customer = {
            name: (params.customerName || 'Valens Customer').trim().slice(0, 30) || 'Valens Customer',
            email: params.customerEmail && params.customerEmail.includes('@') ? params.customerEmail.trim() : 'customer@valens.app',
            tax_id: taxId,
        };

        const order = await this.client.post<any>('/orders', body);
        const qr = order?.qr_codes?.[0];
        const png = qr?.links?.find((l: any) => l.rel === 'QRCODE.PNG')?.href || null;

        return {
            provider: 'PAGBANK',
            orderId: order.id,
            referenceId: order.reference_id || params.referenceId,
            currency: 'brl',
            amountMinor: params.amountMinor,
            checkoutUrl: png,
            qrCode: png,
            pixCopyPaste: qr?.text || null,
            expiresAt: qr?.expiration_date || expiration.toISOString(),
        };
    }

    async getOrder(orderId: string) {
        return this.client.get<any>(`/orders/${orderId}`);
    }

    verifyWebhookSignature(rawBody: string | Buffer, authenticityToken?: string): boolean {
        const accountToken =
            process.env.PAGBANK_WEBHOOK_SECRET ||
            process.env.PAGBANK_TOKEN ||
            process.env.PAGBANK_ACCOUNT_TOKEN;
        if (!accountToken || !authenticityToken) {
            // If secret not configured, accept in sandbox only
            return (process.env.PAGBANK_ENV || 'sandbox').toLowerCase() !== 'production';
        }
        const payload = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
        const expected = createHash('sha256')
            .update(`${accountToken}-${payload}`)
            .digest('hex');
        return expected.toLowerCase() === authenticityToken.toLowerCase();
    }

    isOrderPaid(order: any): boolean {
        const charges = order?.charges || [];
        if (charges.some((c: any) => (c.status || '').toUpperCase() === 'PAID')) return true;
        const status = (order?.status || '').toUpperCase();
        return status === 'PAID' || status === 'AUTHORIZED';
    }

    async payoutToConnectedAccount(params: {
        userId: string;
        amountMinor: number;
        currency: string;
        withdrawalId: string;
    }): Promise<{ transferId: string }> {
        const status = await this.getOnboardingStatus(params.userId);
        if (!status.canReceivePayments || !status.accountId) {
            throw new BadRequestException(
                status.message || 'Complete PagBank onboarding before withdrawing.',
            );
        }
        if (!this.isConfigured()) {
            throw new BadRequestException('PagBank platform token missing (PAGBANK_TOKEN).');
        }

        const platformAccountId = process.env.PAGBANK_PLATFORM_ACCOUNT_ID;
        if (!platformAccountId) {
            throw new BadRequestException(
                'Set PAGBANK_PLATFORM_ACCOUNT_ID for seller payouts (platform source account).',
            );
        }

        const transfer = await this.client.postSecure<any>('/transfers', {
            reference_id: `wd_${params.withdrawalId}`.slice(0, 64),
            amount: {
                value: params.amountMinor,
                currency: (params.currency || 'BRL').toUpperCase(),
            },
            from_account: { id: platformAccountId },
            to_account: { id: status.accountId },
        });

        const transferId = transfer?.id || transfer?.transfer_id;
        if (!transferId) {
            throw new BadRequestException('PagBank transfer did not return an id');
        }
        return { transferId };
    }

    /**
     * Refund a paid PagBank charge (partial or full). Uses charge cancel API.
     */
    async refundCharge(params: {
        orderId: string;
        amountMinor: number;
        reason?: string;
    }): Promise<{ refundId?: string }> {
        if (!this.isConfigured()) {
            throw new BadRequestException('PagBank is not configured for refunds');
        }
        if (params.amountMinor <= 0) {
            throw new BadRequestException('Invalid refund amount');
        }

        const order = await this.getOrder(params.orderId);
        const charge =
            (order?.charges || []).find((c: any) =>
                ['PAID', 'AUTHORIZED'].includes(String(c.status || '').toUpperCase()),
            ) || order?.charges?.[0];

        if (!charge?.id) {
            throw new BadRequestException('No PagBank charge found to refund');
        }

        const result = await this.client.post<any>(`/charges/${charge.id}/cancel`, {
            amount: { value: params.amountMinor },
        });

        return { refundId: result?.id || charge.id };
    }

    /**
     * Handle PagBank transfer webhook status (seller withdrawal).
     * On FAILED/CANCELED/DENIED → reverse wallet debit.
     */
    async handleTransferWebhook(payload: any) {
        const transferId =
            payload?.id ||
            payload?.transfer_id ||
            payload?.resourceId ||
            payload?.resource_id;
        const status = String(payload?.status || payload?.transfer_status || '').toUpperCase();
        const referenceId = String(payload?.reference_id || '');

        if (!transferId && !referenceId) {
            return { processed: false, reason: 'No transfer id' };
        }

        const withdrawal = await this.prisma.withdrawalRecord.findFirst({
            where: {
                OR: [
                    ...(transferId ? [{ transferId: String(transferId) }, { txhash: String(transferId) }] : []),
                    ...(referenceId.startsWith('wd_')
                        ? [{ id: referenceId.slice(3) }]
                        : referenceId
                            ? [{ id: referenceId }]
                            : []),
                ],
            },
        });

        if (!withdrawal) {
            return { processed: false, reason: 'Withdrawal not found' };
        }

        const failedStatuses = new Set(['FAILED', 'CANCELED', 'CANCELLED', 'DENIED', 'ERROR', 'REVERSED']);
        const successStatuses = new Set(['DONE', 'PAID', 'COMPLETED', 'SUCCESS', 'SETTLED']);

        if (successStatuses.has(status)) {
            if (withdrawal.status !== 'success') {
                await this.prisma.withdrawalRecord.update({
                    where: { id: withdrawal.id },
                    data: {
                        status: 'success',
                        transferId: String(transferId || withdrawal.transferId || ''),
                        txhash: String(transferId || withdrawal.txhash || ''),
                    },
                });
            }
            return { processed: true, type: 'transfer', status: 'success', withdrawalId: withdrawal.id };
        }

        if (!failedStatuses.has(status) && status) {
            return { processed: false, reason: `Unhandled transfer status ${status}` };
        }

        // Empty status with transfer payload: only reverse if clearly failed fields present
        if (!status && !payload?.error && !payload?.error_messages) {
            return { processed: false, reason: 'No transfer status' };
        }

        if (withdrawal.status === 'failed' || withdrawal.status === 'reversed') {
            return { processed: true, type: 'transfer', skipped: true, withdrawalId: withdrawal.id };
        }

        const amountMinor = Math.round(
            Number(
                withdrawal.amountMinor ??
                Math.round(Number(withdrawal.withdrawAmount || 0) * 100),
            ),
        );
        if (amountMinor > 0) {
            await this.walletService.reverseWithdrawal({
                userId: withdrawal.userId,
                amountMinor,
                currency: withdrawal.currency || 'brl',
                provider: 'PAGBANK',
                withdrawalId: withdrawal.id,
                note: `PagBank transfer ${status || 'failed'} ${transferId || ''}`,
            });
        }

        await this.prisma.withdrawalRecord.update({
            where: { id: withdrawal.id },
            data: {
                status: 'failed',
                failureReason: `PagBank transfer ${status || 'failed'}`,
                transferId: transferId ? String(transferId) : withdrawal.transferId,
            },
        });

        return { processed: true, type: 'transfer', status: 'failed', withdrawalId: withdrawal.id };
    }

    private isBoostMarketplacePayment(mp: { metadata?: any }): boolean {
        const metadata = (mp.metadata || {}) as Record<string, unknown>;
        return (
            metadata?.type === 'marketplace_battle_boost' ||
            metadata?.domain === 'MARKETPLACE_BATTLE_BOOST'
        );
    }

    private isPromotionMarketplacePayment(mp: { metadata?: any }): boolean {
        const metadata = (mp.metadata || {}) as Record<string, unknown>;
        return (
            metadata?.type === 'marketplace_winner_promotion' ||
            metadata?.domain === 'MARKETPLACE_WINNER_PROMOTION'
        );
    }

    private async grantSubscriptionHits(userId: string, hitCount: number, periodEnd: Date) {
        if (!userId || hitCount <= 0) return;
        const existingPostHit = await this.prisma.postHit.findFirst({ where: { userId } });
        if (existingPostHit) {
            const purchasedHits = existingPostHit.purchasedHitsLeft || 0;
            await this.prisma.postHit.update({
                where: { id: existingPostHit.id },
                data: {
                    subscriptionHitsLeft: hitCount,
                    subscriptionHitsExpiresAt: periodEnd,
                    hitLeft: hitCount + purchasedHits,
                },
            });
        } else {
            await this.prisma.postHit.create({
                data: {
                    userId,
                    subscriptionHitsLeft: hitCount,
                    subscriptionHitsExpiresAt: periodEnd,
                    purchasedHitsLeft: 0,
                    hitLeft: hitCount,
                },
            });
        }
    }

    private async grantPurchasedHits(userId: string, hitCount: number) {
        if (!userId || hitCount <= 0) return;
        const MAX_PURCHASED_HITS = 5;
        const existingPostHit = await this.prisma.postHit.findFirst({ where: { userId } });
        const now = new Date();
        if (existingPostHit) {
            const isSubActive =
                existingPostHit.subscriptionHitsExpiresAt &&
                existingPostHit.subscriptionHitsExpiresAt > now;
            const activeSubHits = isSubActive ? (existingPostHit.subscriptionHitsLeft || 0) : 0;
            const currentPurchased = existingPostHit.purchasedHitsLeft || 0;
            const newPurchasedHits = Math.min(MAX_PURCHASED_HITS, currentPurchased + hitCount);
            const newTotalHitLeft = activeSubHits + newPurchasedHits;
            await this.prisma.postHit.update({
                where: { id: existingPostHit.id },
                data: {
                    purchasedHitsLeft: newPurchasedHits,
                    hitLeft: newTotalHitLeft,
                },
            });
        } else {
            const newPurchasedHits = Math.min(MAX_PURCHASED_HITS, hitCount);
            await this.prisma.postHit.create({
                data: {
                    userId,
                    purchasedHitsLeft: newPurchasedHits,
                    subscriptionHitsLeft: 0,
                    subscriptionHitsExpiresAt: null,
                    hitLeft: newPurchasedHits,
                },
            });
        }
    }

    private async creditPagBankReceivedAvailableWallet(params: {
        userId: string;
        amountMinorBrl: number;
        source: 'TIP' | 'FOLLOWING' | 'FAN_SUBSCRIPTION' | 'MISSION_DONATION' | 'EBOOK' | 'SHOP_EBOOK' | 'OTHER';
        refId: string;
        note?: string;
    }) {
        if (!params.userId || params.amountMinorBrl <= 0) return;
        const receiver = await this.prisma.user.findUnique({
            where: { id: params.userId },
            select: { paymentProvider: true, country: true },
        });
        const isStripe =
            (receiver?.paymentProvider || '').toUpperCase() === 'STRIPE' ||
            (receiver?.country && normalizeCountryCode(receiver.country) !== 'BR');
        const provider: 'PAGBANK' | 'STRIPE' = isStripe ? 'STRIPE' : 'PAGBANK';
        const targetCurrency = provider === 'PAGBANK' ? 'brl' : 'usd';

        let finalMinor = Math.round(params.amountMinorBrl);
        if (targetCurrency === 'usd') {
            finalMinor = await this.currencyConverter.convertMinor(finalMinor, 'brl', 'usd');
        }

        await this.walletService.creditAvailable({
            userId: params.userId,
            amountMinor: finalMinor,
            currency: targetCurrency,
            provider,
            source: params.source as any,
            refType: 'PAYMENT',
            refId: params.refId,
            note: `${params.note || 'PagBank payment'}${targetCurrency === 'usd' ? ` (converted from ${params.amountMinorBrl} BRL centavos)` : ''}`,
        });
    }

    /**
     * Process paid order: credit seller wallet / complete pending payment rows.
     */
    async handlePaidOrder(order: any) {
        if (!this.isOrderPaid(order)) {
            return { processed: false, reason: 'Order not paid' };
        }

        const orderId = order.id as string;
        const referenceId = String(order.reference_id || '');

        // Marketplace payment (cart checkout, battle boost, or winner promotion)
        const mp = await this.prisma.marketPlacePayments.findFirst({
            where: {
                OR: [{ id: referenceId }, { paymentIntentId: orderId }, { transactionId: orderId }],
            },
        });
        if (mp) {
            const isBoost = this.isBoostMarketplacePayment(mp);
            const isPromotion = this.isPromotionMarketplacePayment(mp);
            const paymentType = isBoost
                ? 'marketplace_battle_boost'
                : isPromotion
                ? 'marketplace_winner_promotion'
                : 'marketplace';

            if (mp.status === 'PAID') {
                return {
                    processed: true,
                    type: paymentType,
                    paymentId: mp.id,
                    skipped: true,
                };
            }
            await this.prisma.marketPlacePayments.update({
                where: { id: mp.id },
                data: {
                    status: 'PAID',
                    paymentIntentId: orderId,
                    transactionId: orderId,
                    provider: 'PAGBANK',
                },
            });
            return {
                processed: true,
                type: paymentType,
                paymentId: mp.id,
                orderId,
            };
        }

        // Tip / following / fan / platform purchases via Payment table
        const payment = await this.prisma.payment.findFirst({
            where: {
                OR: [{ id: referenceId }, { stripePaymentIntentId: orderId }],
            },
        });
        if (payment) {
            if (payment.status === 'succeeded' || payment.status === 'completed') {
                return { processed: true, type: payment.forPayment, skipped: true };
            }

            await this.prisma.payment.update({
                where: { id: payment.id },
                data: {
                    status: payment.forPayment === 'missionDonation' || payment.forPayment === 'donation'
                        ? 'completed'
                        : 'succeeded',
                    stripePaymentIntentId: orderId,
                    ...(payment.forPayment === 'following'
                        ? (() => {
                            const periodStart = new Date();
                            const periodEnd = new Date(periodStart);
                            periodEnd.setMonth(periodEnd.getMonth() + 1);
                            return { periodStart, periodEnd };
                        })()
                        : {}),
                },
            });

            const receiverId = payment.receiverId;
            // PagBank pending rows store receiver share in `amount` as major currency units (BRL).
            const creditMinor = Math.round(Number(payment.amount || 0) * 100);

            if (receiverId && creditMinor > 0) {
                const source =
                    payment.forPayment === 'TIP'
                        ? 'TIP'
                        : payment.forPayment === 'following'
                            ? 'FOLLOWING'
                            : payment.forPayment === 'fanSubscriptionBuy'
                                ? 'FAN_SUBSCRIPTION'
                                : payment.forPayment === 'missionDonation'
                                    ? 'MISSION_DONATION'
                                    : 'OTHER';

                await this.creditPagBankReceivedAvailableWallet({
                    userId: receiverId,
                    amountMinorBrl: creditMinor,
                    source,
                    refId: orderId,
                    note: `PagBank ${payment.forPayment} ${payment.id}`,
                });
            }

            if (payment.forPayment === 'following' && payment.userId && receiverId) {
                const periodStart = payment.periodStart || new Date();
                const periodEnd =
                    payment.periodEnd ||
                    (() => {
                        const d = new Date(periodStart);
                        d.setMonth(d.getMonth() + 1);
                        return d;
                    })();

                const existingFanSub = await this.prisma.fansSubscriptionBuyData.findFirst({
                    where: {
                        fanUserId: payment.userId,
                        buyUserId: receiverId,
                    },
                });
                if (existingFanSub) {
                    await this.prisma.fansSubscriptionBuyData.update({
                        where: { id: existingFanSub.id },
                        data: {
                            startDate: periodStart,
                            endDate: periodEnd,
                            status: 'ACTIVE',
                            priceAtSubscription: payment.totalAmount || payment.amount,
                            paymentProvider: 'PAGBANK',
                        },
                    });
                } else {
                    await this.prisma.fansSubscriptionBuyData.create({
                        data: {
                            fanUserId: payment.userId,
                            buyUserId: receiverId,
                            startDate: periodStart,
                            endDate: periodEnd,
                            status: 'ACTIVE',
                            priceAtSubscription: payment.totalAmount || payment.amount,
                            paymentProvider: 'PAGBANK',
                        },
                    });
                }
            }

            if (payment.forPayment === 'buyHit') {
                const hitCount = parseInt(payment.stripeInvoiceId || '0', 10);
                await this.grantPurchasedHits(payment.userId, hitCount);
            }

            if (payment.forPayment === 'fanSubscription') {
                await this.prisma.user.update({
                    where: { id: payment.userId },
                    data: { fansPage: 1 },
                });
            }

            if (payment.forPayment === 'subscription') {
                const periodStart = payment.periodStart || new Date();
                const periodEnd =
                    payment.periodEnd ||
                    (() => {
                        const d = new Date(periodStart);
                        d.setMonth(d.getMonth() + 1);
                        return d;
                    })();

                await this.prisma.user.update({
                    where: { id: payment.userId },
                    data: {
                        subscriptionStatus: 'ACTIVE',
                        subscriptionStart: periodStart,
                        subscriptionEnd: null,
                        currentPeriodEnd: periodEnd,
                    },
                });
                await this.grantSubscriptionHits(payment.userId, 5, periodEnd);
            }

            if (payment.forPayment === 'donation' || payment.forPayment === 'missionDonation') {
                await this.prisma.donationData.updateMany({
                    where: {
                        OR: [
                            { stripeCheckoutSessionId: referenceId },
                            { stripeCheckoutSessionId: orderId },
                            { stripePaymentIntentId: orderId },
                            { stripePaymentIntentId: referenceId },
                        ],
                        status: 'pending',
                    },
                    data: {
                        status: 'completed',
                        completedAt: new Date(),
                        stripePaymentIntentId: orderId,
                    },
                });
            }

            if (payment.forPayment === 'missionDonation') {
                const completedDonation = await this.prisma.donationData.findFirst({
                    where: {
                        OR: [
                            { stripeCheckoutSessionId: orderId },
                            { stripePaymentIntentId: orderId },
                            { stripeCheckoutSessionId: referenceId },
                        ],
                        status: 'completed',
                        action: 'missionDonation',
                    },
                    select: { id: true, postId: true },
                });

                if (completedDonation?.id) {
                    try {
                        await this.notificationService.sendMissionContributionConfirmed(completedDonation.id);
                        await this.notificationService.sendNewMissionBackerNotification(completedDonation.id);
                        if (completedDonation.postId) {
                            await this.notificationService.sendMissionGoalMilestoneIfNeeded(completedDonation.postId);
                            await this.notificationService.sendMissionFullyFundedIfNeeded(completedDonation.postId);
                        }
                    } catch (error: any) {
                        this.logger.warn(
                            `PagBank mission donation notifications failed: ${error?.message || error}`,
                        );
                    }
                }
            }

            if (payment.forPayment === 'fanSubscriptionBuy' && payment.userId && receiverId) {
                const fanUserId = payment.stripeInvoiceId;
                if (fanUserId) {
                    const existing = await this.prisma.fansSubscriptionBuyData.findFirst({
                        where: {
                            fanUserId,
                            buyUserId: receiverId,
                            status: 'ACTIVE',
                            endDate: { gt: new Date() },
                        },
                    });
                    if (!existing) {
                        const startDate = new Date();
                        const endDate = new Date(startDate);
                        endDate.setMonth(endDate.getMonth() + 1);
                        await this.prisma.fansSubscriptionBuyData.create({
                            data: {
                                fanUserId,
                                buyUserId: receiverId,
                                startDate,
                                endDate,
                                status: 'ACTIVE',
                            },
                        });
                    }

                    try {
                        const notifs = await this.prisma.notification.findMany({
                            where: { userId: fanUserId },
                        });
                        for (const notif of notifs) {
                            const data = notif.data as any;
                            if (data && data.type === 'subscription_price_changed' && data.creatorId === receiverId) {
                                await this.prisma.notification.update({
                                    where: { id: notif.id },
                                    data: {
                                        data: {
                                            ...data,
                                            status: 'ACCEPTED',
                                            priceUpdateStatus: 'ACCEPTED',
                                            isAccepted: true,
                                            isDeclined: false,
                                            isPending: false,
                                            hasPurchasedNewPrice: true,
                                            isCancelled: 'false',
                                            autoRenew: 'true',
                                            cancelAtPeriodEnd: 'false',
                                        },
                                    },
                                });
                            }
                        }
                    } catch (err: any) {
                        this.logger.error(`PagBank failed to update price change notification status: ${err?.message || err}`);
                    }
                } else {
                    this.logger.warn(
                        `PagBank fanSubscriptionBuy ${payment.id} missing fanUserId (stripeInvoiceId)`,
                    );
                }
            }

            return { processed: true, type: payment.forPayment, paymentId: payment.id };
        }

        // Ebook
        const ebook = await (this.prisma as any).ebookPayments.findFirst({
            where: {
                OR: [{ id: referenceId }, { paymentIntentId: orderId }, { checkoutSessionId: orderId }],
            },
        });
        if (ebook) {
            if (ebook.status === 'SUCCEEDED') return { processed: true, type: 'ebook', skipped: true };
            await (this.prisma as any).ebookPayments.update({
                where: { id: ebook.id },
                data: { status: 'SUCCEEDED', paymentIntentId: orderId, provider: 'PAGBANK' },
            });
            if (ebook.sellerAmount > 0) {
                await this.creditPagBankReceivedAvailableWallet({
                    userId: ebook.sellerId,
                    amountMinorBrl: ebook.sellerAmount,
                    source: 'EBOOK',
                    refId: ebook.id,
                    note: `PagBank ebook ${ebook.id}`,
                });
            }
            return { processed: true, type: 'ebook', paymentId: ebook.id };
        }

        const shopEbook = await (this.prisma as any).shopEbookPayments.findFirst({
            where: {
                OR: [{ id: referenceId }, { paymentIntentId: orderId }, { checkoutSessionId: orderId }],
            },
        });
        if (shopEbook) {
            if (shopEbook.status === 'SUCCEEDED') return { processed: true, type: 'shop_ebook', skipped: true };
            await (this.prisma as any).shopEbookPayments.update({
                where: { id: shopEbook.id },
                data: { status: 'SUCCEEDED', paymentIntentId: orderId, provider: 'PAGBANK' },
            });
            if (shopEbook.sellerAmount > 0) {
                await this.creditPagBankReceivedAvailableWallet({
                    userId: shopEbook.sellerId,
                    amountMinorBrl: shopEbook.sellerAmount,
                    source: 'SHOP_EBOOK',
                    refId: shopEbook.id,
                    note: `PagBank shop ebook ${shopEbook.id}`,
                });
            }
            return { processed: true, type: 'shop_ebook', paymentId: shopEbook.id };
        }

        this.logger.warn(`PagBank paid order ${orderId} with unmatched reference ${referenceId}`);
        return { processed: false, reason: 'No matching payment record' };
    }
}
