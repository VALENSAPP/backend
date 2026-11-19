import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { resolveWalletCurrency } from '../common/country.util';
import { FxConversion, FxRateType, FxUnavailableError, StripeFxService } from '../common/fx/stripe-fx.service';
import { WalletService } from './wallet.service';
import { WalletLedgerRefType, WalletLedgerSource } from './wallet.types';

type TxClient = Prisma.TransactionClient;

export interface CreditEarningParams {
    /** Receiver (creator / seller). */
    userId: string;
    /** Amount the receiver earns, in the payment currency (minor units, after platform fee). */
    sourceAmountMinor: number;
    /** Currency the payer was charged in (e.g. usd for India, brl for Brazil). */
    sourceCurrency: string;
    source: WalletLedgerSource;
    refType: WalletLedgerRefType;
    refId: string;
    note?: string;
    /** AVAILABLE = withdrawable now (tips, subscriptions…). PENDING = marketplace 48h hold. */
    mode?: 'AVAILABLE' | 'PENDING';
    /**
     * base = Stripe mid rate without Stripe's FX fee (receiver gets the whole amount — used for tips).
     * exchange = Stripe rate including Stripe's FX fee.
     */
    rateType?: FxRateType;
    /** Record to stamp with what the receiver actually received. */
    receipt?: { type: 'PAYMENT' | 'DONATION'; id: string };
}

export interface CreditEarningResult {
    status: 'credited' | 'already_credited' | 'deferred' | 'skipped';
    targetCurrency: string;
    receivedAmountMinor?: number;
    fxRate?: number;
    fxQuoteId?: string | null;
    fxSource?: string;
    reason?: string;
}

/**
 * Single place where any earning is converted (with Stripe's rate) and credited to the receiver's wallet.
 *
 * Rules:
 * - Wallet currency = receiver's currency (BRL for Brazil by KYC country, USD otherwise).
 * - Conversion only with Stripe FX Quotes. If Stripe is unavailable the credit is saved in
 *   PendingWalletCredit and retried by a cron — never credited with a guessed rate.
 * - The receipt (Payment / DonationData) is stamped with receivedAmountMinor/receivedCurrency/fxRate
 *   so the sender sees what they sent and the receiver sees what they received.
 */
@Injectable()
export class EarningsCreditService {
    private readonly logger = new Logger(EarningsCreditService.name);
    private retryRunning = false;

    constructor(
        private readonly prisma: PrismaService,
        private readonly walletService: WalletService,
        private readonly fx: StripeFxService,
    ) { }

    async creditEarning(params: CreditEarningParams, tx?: TxClient): Promise<CreditEarningResult> {
        const client = tx || this.prisma;
        const mode = params.mode || 'AVAILABLE';
        const rateType: FxRateType = params.rateType || 'exchange';
        const sourceAmountMinor = Math.round(params.sourceAmountMinor || 0);
        const sourceCurrency = (params.sourceCurrency || 'usd').toLowerCase();

        if (!params.userId || sourceAmountMinor <= 0) {
            return { status: 'skipped', targetCurrency: sourceCurrency, reason: 'nothing to credit' };
        }

        const receiver = await client.user.findUnique({
            where: { id: params.userId },
            select: { country: true, kycCountry: true },
        });
        const targetCurrency = resolveWalletCurrency(receiver);

        let conversion: FxConversion;
        try {
            conversion = await this.fx.convertMinor(sourceAmountMinor, sourceCurrency, targetCurrency, {
                rateType,
                // Inside a DB transaction keep the call short so the transaction does not time out.
                timeoutMs: tx ? 3000 : 5000,
                attempts: tx ? 1 : 2,
            });
        } catch (error: any) {
            if (!(error instanceof FxUnavailableError)) throw error;
            await this.deferCredit(client, params, { mode, rateType, sourceAmountMinor, sourceCurrency, targetCurrency }, error.message);
            this.logger.warn(
                `[EarningsCredit] Deferred ${params.refType}:${params.refId} (${sourceAmountMinor} ${sourceCurrency}->${targetCurrency}): ${error.message}`,
            );
            return { status: 'deferred', targetCurrency, reason: error.message };
        }

        if (conversion.toAmountMinor <= 0) {
            return { status: 'skipped', targetCurrency, reason: 'converted amount is zero' };
        }

        const converted = conversion.source !== 'same_currency';
        const creditParams = {
            userId: params.userId,
            amountMinor: conversion.toAmountMinor,
            currency: targetCurrency,
            provider: 'STRIPE' as const,
            source: params.source,
            refType: params.refType,
            refId: params.refId,
            note: converted
                ? `${params.note || 'Earning'} (${(sourceAmountMinor / 100).toFixed(2)} ${sourceCurrency.toUpperCase()} → ${(conversion.toAmountMinor / 100).toFixed(2)} ${targetCurrency.toUpperCase()} @ ${conversion.rate} Stripe ${rateType} rate)`
                : params.note,
            ...(converted
                ? {
                    originalAmountMinor: sourceAmountMinor,
                    originalCurrency: sourceCurrency,
                    fxRate: conversion.rate,
                    fxQuoteId: conversion.quoteId,
                }
                : {}),
        };

        const credited =
            mode === 'PENDING'
                ? await this.walletService.creditPending(creditParams, tx)
                : await this.walletService.creditAvailable(creditParams, tx);

        // If this ref was already credited earlier, report the amount that was actually credited then.
        const receivedAmountMinor = credited.skipped ? credited.amountMinor : conversion.toAmountMinor;

        if (params.receipt) {
            await this.stampReceipt(client, params.receipt, {
                receivedAmountMinor,
                receivedCurrency: targetCurrency,
                fxRate: converted ? conversion.rate : 1,
                fxQuoteId: conversion.quoteId,
                fxSource: conversion.source,
            });
        }

        return {
            status: credited.skipped ? 'already_credited' : 'credited',
            targetCurrency,
            receivedAmountMinor,
            fxRate: conversion.rate,
            fxQuoteId: conversion.quoteId,
            fxSource: conversion.source,
        };
    }

    /** True while a converted credit for this ref is still waiting for Stripe FX. */
    async hasDeferredCredit(refType: string, refId: string): Promise<boolean> {
        const row = await this.prisma.pendingWalletCredit.findFirst({
            where: { refType, refId, status: 'PENDING' },
            select: { id: true },
        });
        return !!row;
    }

    private async deferCredit(
        client: TxClient | PrismaService,
        params: CreditEarningParams,
        resolved: { mode: string; rateType: FxRateType; sourceAmountMinor: number; sourceCurrency: string; targetCurrency: string },
        error: string,
    ) {
        await client.pendingWalletCredit.upsert({
            where: {
                refType_refId_mode: { refType: params.refType, refId: params.refId, mode: resolved.mode },
            },
            create: {
                userId: params.userId,
                mode: resolved.mode,
                source: params.source,
                refType: params.refType,
                refId: params.refId,
                sourceAmountMinor: resolved.sourceAmountMinor,
                sourceCurrency: resolved.sourceCurrency,
                targetCurrency: resolved.targetCurrency,
                rateType: resolved.rateType,
                note: params.note,
                receiptType: params.receipt?.type,
                receiptId: params.receipt?.id,
                lastError: error.slice(0, 500),
            },
            update: { lastError: error.slice(0, 500) },
        });
    }

    private async stampReceipt(
        client: TxClient | PrismaService,
        receipt: { type: 'PAYMENT' | 'DONATION'; id: string },
        data: { receivedAmountMinor: number; receivedCurrency: string; fxRate: number; fxQuoteId: string | null; fxSource: string },
    ) {
        const update = {
            receivedAmountMinor: data.receivedAmountMinor,
            receivedCurrency: data.receivedCurrency,
            fxRate: data.fxRate,
            fxQuoteId: data.fxQuoteId,
            fxSource: data.fxSource,
            fxConvertedAt: new Date(),
        };
        try {
            if (receipt.type === 'PAYMENT') {
                await client.payment.updateMany({ where: { id: receipt.id }, data: update });
            } else {
                await client.donationData.updateMany({ where: { id: receipt.id }, data: update });
            }
        } catch (error: any) {
            // The wallet credit already happened; a failed stamp must not undo it.
            this.logger.error(`[EarningsCredit] Failed to stamp ${receipt.type} ${receipt.id}: ${error?.message}`);
        }
    }

    /** Retry earnings that were waiting for Stripe FX. */
    @Cron(CronExpression.EVERY_5_MINUTES)
    async retryDeferredCredits() {
        if (this.retryRunning) return;
        this.retryRunning = true;
        try {
            const rows = await this.prisma.pendingWalletCredit.findMany({
                where: { status: 'PENDING' },
                orderBy: { createdAt: 'asc' },
                take: 50,
            });
            for (const row of rows) {
                try {
                    const result = await this.creditEarning({
                        userId: row.userId,
                        sourceAmountMinor: row.sourceAmountMinor,
                        sourceCurrency: row.sourceCurrency,
                        source: row.source as WalletLedgerSource,
                        refType: row.refType as WalletLedgerRefType,
                        refId: row.refId,
                        note: row.note || undefined,
                        mode: row.mode === 'PENDING' ? 'PENDING' : 'AVAILABLE',
                        rateType: row.rateType === 'base' ? 'base' : 'exchange',
                        receipt:
                            row.receiptType && row.receiptId
                                ? { type: row.receiptType === 'DONATION' ? 'DONATION' : 'PAYMENT', id: row.receiptId }
                                : undefined,
                    });
                    if (result.status === 'credited' || result.status === 'already_credited' || result.status === 'skipped') {
                        await this.prisma.pendingWalletCredit.update({
                            where: { id: row.id },
                            data: { status: 'DONE', attempts: { increment: 1 }, lastError: null },
                        });
                    } else {
                        await this.prisma.pendingWalletCredit.update({
                            where: { id: row.id },
                            data: {
                                attempts: { increment: 1 },
                                // ~24h of retries every 5 minutes, then needs manual attention.
                                ...(row.attempts + 1 >= 288 ? { status: 'FAILED' } : {}),
                            },
                        });
                    }
                } catch (error: any) {
                    await this.prisma.pendingWalletCredit.update({
                        where: { id: row.id },
                        data: {
                            attempts: { increment: 1 },
                            lastError: String(error?.message || error).slice(0, 500),
                            ...(row.attempts + 1 >= 288 ? { status: 'FAILED' } : {}),
                        },
                    });
                }
            }
        } finally {
            this.retryRunning = false;
        }
    }
}
