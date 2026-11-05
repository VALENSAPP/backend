import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { formatCurrencyAmount, getCurrencySymbol, isBrazilUser } from '../common/payment-provider.util';
import {
    WalletCreditParams,
    WalletLedgerEntryType,
    WalletProvider,
} from './wallet.types';

type TxClient = Prisma.TransactionClient;

@Injectable()
export class WalletService {
    private readonly logger = new Logger(WalletService.name);

    constructor(private readonly prisma: PrismaService) { }

    private normalizeCurrency(currency?: string): string {
        return (currency || 'usd').trim().toLowerCase() || 'usd';
    }

    private normalizeProvider(provider?: WalletProvider): WalletProvider {
        return provider === 'PAGBANK' ? 'PAGBANK' : 'STRIPE';
    }

    private toMajor(amountMinor: number): number {
        return Number((amountMinor / 100).toFixed(2));
    }

    private async ensureWallet(
        tx: TxClient,
        userId: string,
        currency: string,
        provider: WalletProvider,
    ) {
        return tx.sellerWallet.upsert({
            where: {
                userId_currency_provider: { userId, currency, provider },
            },
            create: {
                userId,
                currency,
                provider,
                pendingBalance: 0,
                availableBalance: 0,
            },
            update: {},
        });
    }

    private async findExistingEntry(
        tx: TxClient,
        refType: string,
        refId: string,
        entryType: WalletLedgerEntryType,
    ) {
        return tx.walletLedgerEntry.findUnique({
            where: {
                refType_refId_entryType: { refType, refId, entryType },
            },
        });
    }

    /**
     * Marketplace: credit pending (not withdrawable until 48h release).
     * Idempotent on (refType, refId, PENDING_CREDIT).
     */
    async creditPending(params: WalletCreditParams, tx?: TxClient) {
        const run = async (client: TxClient) => {
            const amountMinor = Math.trunc(params.amountMinor);
            if (amountMinor <= 0) {
                throw new BadRequestException('amountMinor must be positive');
            }

            const currency = this.normalizeCurrency(params.currency);
            const provider = this.normalizeProvider(params.provider);

            const existing = await this.findExistingEntry(
                client,
                params.refType,
                params.refId,
                'PENDING_CREDIT',
            );
            if (existing) {
                return { skipped: true as const, entryId: existing.id, amountMinor: existing.amountMinor };
            }

            const wallet = await this.ensureWallet(client, params.userId, currency, provider);

            const updatedWallet = await client.sellerWallet.update({
                where: { id: wallet.id },
                data: { pendingBalance: { increment: amountMinor } },
            });
            const entry = await client.walletLedgerEntry.create({
                data: {
                    walletId: wallet.id,
                    userId: params.userId,
                    entryType: 'PENDING_CREDIT',
                    source: params.source,
                    amountMinor,
                    currency,
                    provider,
                    refType: params.refType,
                    refId: params.refId,
                    note: params.note,
                },
            });

            return {
                skipped: false as const,
                entryId: entry.id,
                amountMinor,
                pendingBalance: updatedWallet.pendingBalance,
                availableBalance: updatedWallet.availableBalance,
            };
        };

        if (tx) return run(tx);
        return this.prisma.$transaction((client) => run(client));
    }

    /**
     * Tips / ebooks / other: credit available immediately (withdrawable).
     * Idempotent on (refType, refId, AVAILABLE_CREDIT).
     */
    async creditAvailable(params: WalletCreditParams, tx?: TxClient) {
        const run = async (client: TxClient) => {
            const amountMinor = Math.trunc(params.amountMinor);
            if (amountMinor <= 0) {
                throw new BadRequestException('amountMinor must be positive');
            }

            const currency = this.normalizeCurrency(params.currency);
            const provider = this.normalizeProvider(params.provider);

            const existing = await this.findExistingEntry(
                client,
                params.refType,
                params.refId,
                'AVAILABLE_CREDIT',
            );
            if (existing) {
                return { skipped: true as const, entryId: existing.id, amountMinor: existing.amountMinor };
            }

            const wallet = await this.ensureWallet(client, params.userId, currency, provider);

            const updatedWallet = await client.sellerWallet.update({
                where: { id: wallet.id },
                data: { availableBalance: { increment: amountMinor } },
            });
            const entry = await client.walletLedgerEntry.create({
                data: {
                    walletId: wallet.id,
                    userId: params.userId,
                    entryType: 'AVAILABLE_CREDIT',
                    source: params.source,
                    amountMinor,
                    currency,
                    provider,
                    refType: params.refType,
                    refId: params.refId,
                    note: params.note,
                },
            });

            return {
                skipped: false as const,
                entryId: entry.id,
                amountMinor,
                pendingBalance: updatedWallet.pendingBalance,
                availableBalance: updatedWallet.availableBalance,
            };
        };

        if (tx) return run(tx);
        return this.prisma.$transaction((client) => run(client));
    }

    /**
     * After marketplace 48h (or buyer confirm): pending → available.
     * Idempotent on (refType, refId, PENDING_TO_AVAILABLE).
     * Legacy fallback: if no PENDING_CREDIT exists, credits available once.
     */
    async movePendingToAvailable(params: WalletCreditParams, tx?: TxClient) {
        const run = async (client: TxClient) => {
            const amountMinor = Math.trunc(params.amountMinor);
            if (amountMinor <= 0) {
                throw new BadRequestException('amountMinor must be positive');
            }

            const currency = this.normalizeCurrency(params.currency);
            const provider = this.normalizeProvider(params.provider);

            const alreadyMoved = await this.findExistingEntry(
                client,
                params.refType,
                params.refId,
                'PENDING_TO_AVAILABLE',
            );
            if (alreadyMoved) {
                return {
                    skipped: true as const,
                    entryId: alreadyMoved.id,
                    amountMinor: alreadyMoved.amountMinor,
                    mode: 'already_moved' as const,
                };
            }

            const pendingCredit = await this.findExistingEntry(
                client,
                params.refType,
                params.refId,
                'PENDING_CREDIT',
            );

            // Legacy orders created before wallet: credit available directly once.
            if (!pendingCredit) {
                const credited = await this.creditAvailable(
                    {
                        ...params,
                        amountMinor,
                        currency,
                        provider,
                        note: params.note || 'Legacy marketplace release (no pending credit)',
                    },
                    client,
                );

                return {
                    skipped: credited.skipped,
                    entryId: credited.entryId,
                    amountMinor: credited.amountMinor,
                    mode: 'legacy_available_credit' as const,
                    pendingBalance: 'pendingBalance' in credited ? credited.pendingBalance : undefined,
                    availableBalance: 'availableBalance' in credited ? credited.availableBalance : undefined,
                };
            }

            const wallet = await this.ensureWallet(client, params.userId, currency, provider);
            if (wallet.pendingBalance < amountMinor) {
                this.logger.warn(
                    `Wallet ${wallet.id} pending ${wallet.pendingBalance} < move ${amountMinor} for ${params.refType}:${params.refId}`,
                );
                throw new BadRequestException('Insufficient pending balance to release');
            }

            const updatedWallet = await client.sellerWallet.update({
                where: { id: wallet.id },
                data: {
                    pendingBalance: { decrement: amountMinor },
                    availableBalance: { increment: amountMinor },
                },
            });

            const entry = await client.walletLedgerEntry.create({
                data: {
                    walletId: wallet.id,
                    userId: params.userId,
                    entryType: 'PENDING_TO_AVAILABLE',
                    source: params.source,
                    amountMinor,
                    currency,
                    provider,
                    refType: params.refType,
                    refId: params.refId,
                    note: params.note,
                },
            });

            return {
                skipped: false as const,
                entryId: entry.id,
                amountMinor,
                mode: 'moved' as const,
                pendingBalance: updatedWallet.pendingBalance,
                availableBalance: updatedWallet.availableBalance,
            };
        };

        if (tx) return run(tx);
        return this.prisma.$transaction((client) => run(client));
    }

    /**
     * Marketplace order cancelled / refunded: reverse pending credit from seller wallet.
     * Idempotent on (refType, refId, PENDING_REVERSAL).
     */
    async reversePendingCredit(params: WalletCreditParams, tx?: TxClient) {
        const run = async (client: TxClient) => {
            const amountMinor = Math.trunc(params.amountMinor);
            if (amountMinor <= 0) {
                return { skipped: true as const, reason: 'amountMinor must be positive' };
            }

            const currency = this.normalizeCurrency(params.currency);
            const provider = this.normalizeProvider(params.provider);

            const alreadyReversed = await this.findExistingEntry(
                client,
                params.refType,
                params.refId,
                'PENDING_REVERSAL',
            );
            if (alreadyReversed) {
                return {
                    skipped: true as const,
                    entryId: alreadyReversed.id,
                    amountMinor: alreadyReversed.amountMinor,
                };
            }

            const pendingCredit = await this.findExistingEntry(
                client,
                params.refType,
                params.refId,
                'PENDING_CREDIT',
            );
            if (!pendingCredit) {
                return { skipped: true as const, reason: 'No pending credit found to reverse' };
            }

            const wallet = await this.ensureWallet(client, params.userId, currency, provider);
            const debitAmount = Math.min(wallet.pendingBalance, amountMinor);

            const updatedWallet = await client.sellerWallet.update({
                where: { id: wallet.id },
                data: {
                    pendingBalance: { decrement: debitAmount },
                },
            });

            const entry = await client.walletLedgerEntry.create({
                data: {
                    walletId: wallet.id,
                    userId: params.userId,
                    entryType: 'PENDING_REVERSAL',
                    source: params.source,
                    amountMinor,
                    currency,
                    provider,
                    refType: params.refType,
                    refId: params.refId,
                    note: params.note || `Reversed pending credit for ${params.refType} ${params.refId}`,
                },
            });

            return {
                skipped: false as const,
                entryId: entry.id,
                amountMinor,
                pendingBalance: updatedWallet.pendingBalance,
                availableBalance: updatedWallet.availableBalance,
            };
        };

        if (tx) return run(tx);
        return this.prisma.$transaction((client) => run(client));
    }

    async getBalance(userId: string, options?: { currency?: string; provider?: WalletProvider }) {
        const currency = options?.currency
            ? this.normalizeCurrency(options.currency)
            : undefined;
        const provider = options?.provider
            ? this.normalizeProvider(options.provider)
            : undefined;

        const wallets = await this.prisma.sellerWallet.findMany({
            where: {
                userId,
                ...(currency ? { currency } : {}),
                ...(provider ? { provider } : {}),
            },
            orderBy: [{ provider: 'asc' }, { currency: 'asc' }],
        });

        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { country: true },
        });
        const isBrazil = isBrazilUser(user?.country);
        const resolvedCurrency = (currency || (isBrazil ? 'BRL' : 'USD')).toUpperCase();
        const resolvedSymbol = getCurrencySymbol(resolvedCurrency);

        const items = wallets.map((w) => {
            const sym = getCurrencySymbol(w.currency);
            return {
                walletId: w.id,
                currency: w.currency.toUpperCase(),
                currencySymbol: sym,
                provider: w.provider,
                pendingBalanceMinor: w.pendingBalance,
                availableBalanceMinor: w.availableBalance,
                withdrawableBalanceMinor: w.availableBalance,
                pendingBalance: this.toMajor(w.pendingBalance),
                availableBalance: this.toMajor(w.availableBalance),
                withdrawableBalance: this.toMajor(w.availableBalance),
                formattedPendingBalance: formatCurrencyAmount(this.toMajor(w.pendingBalance), w.currency),
                formattedAvailableBalance: formatCurrencyAmount(this.toMajor(w.availableBalance), w.currency),
                formattedWithdrawableBalance: formatCurrencyAmount(this.toMajor(w.availableBalance), w.currency),
                updatedAt: w.updatedAt,
            };
        });

        const totals = items.reduce(
            (acc, row) => {
                acc.pendingBalanceMinor += row.pendingBalanceMinor;
                acc.availableBalanceMinor += row.availableBalanceMinor;
                return acc;
            },
            { pendingBalanceMinor: 0, availableBalanceMinor: 0 },
        );

        return {
            currency: resolvedCurrency,
            currencySymbol: resolvedSymbol,
            pendingBalanceMinor: totals.pendingBalanceMinor,
            availableBalanceMinor: totals.availableBalanceMinor,
            withdrawableBalanceMinor: totals.availableBalanceMinor,
            pendingBalance: this.toMajor(totals.pendingBalanceMinor),
            availableBalance: this.toMajor(totals.availableBalanceMinor),
            /** Sum of marketplace unlocked + other earnings — only this can be withdrawn. */
            withdrawableBalance: this.toMajor(totals.availableBalanceMinor),
            formattedPendingBalance: formatCurrencyAmount(this.toMajor(totals.pendingBalanceMinor), resolvedCurrency),
            formattedAvailableBalance: formatCurrencyAmount(this.toMajor(totals.availableBalanceMinor), resolvedCurrency),
            formattedWithdrawableBalance: formatCurrencyAmount(this.toMajor(totals.availableBalanceMinor), resolvedCurrency),
            wallets: items,
            note: 'Pending = marketplace inside 48h protection. Available/withdrawable = unlocked marketplace + other earnings.',
        };
    }

    /**
     * Lock/spend available balance for a withdrawal request.
     * Idempotent on (WITHDRAWAL, refId, WITHDRAWAL).
     */
    async debitAvailableForWithdrawal(params: {
        userId: string;
        amountMinor: number;
        currency?: string;
        provider?: WalletProvider;
        withdrawalId: string;
        note?: string;
    }, tx?: TxClient) {
        const run = async (client: TxClient) => {
            const amountMinor = Math.trunc(params.amountMinor);
            if (amountMinor <= 0) {
                throw new BadRequestException('amountMinor must be positive');
            }

            const currency = this.normalizeCurrency(params.currency);
            const provider = this.normalizeProvider(params.provider);

            const existing = await this.findExistingEntry(
                client,
                'WITHDRAWAL',
                params.withdrawalId,
                'WITHDRAWAL',
            );
            if (existing) {
                return {
                    skipped: true as const,
                    entryId: existing.id,
                    amountMinor: existing.amountMinor,
                };
            }

            const wallet = await this.ensureWallet(client, params.userId, currency, provider);
            if (wallet.availableBalance < amountMinor) {
                throw new BadRequestException(
                    `Insufficient available balance. Available: ${(wallet.availableBalance / 100).toFixed(2)}, requested: ${(amountMinor / 100).toFixed(2)}`,
                );
            }

            const updatedWallet = await client.sellerWallet.update({
                where: { id: wallet.id },
                data: { availableBalance: { decrement: amountMinor } },
            });

            const entry = await client.walletLedgerEntry.create({
                data: {
                    walletId: wallet.id,
                    userId: params.userId,
                    entryType: 'WITHDRAWAL',
                    source: 'OTHER',
                    amountMinor,
                    currency,
                    provider,
                    refType: 'WITHDRAWAL',
                    refId: params.withdrawalId,
                    note: params.note || 'Withdrawal to connected account',
                },
            });

            return {
                skipped: false as const,
                entryId: entry.id,
                amountMinor,
                pendingBalance: updatedWallet.pendingBalance,
                availableBalance: updatedWallet.availableBalance,
            };
        };

        if (tx) return run(tx);
        return this.prisma.$transaction((client) => run(client));
    }

    /**
     * Restore available balance when a withdrawal transfer fails/reverses.
     * Idempotent on (WITHDRAWAL, refId, WITHDRAWAL_REVERSAL).
     */
    async reverseWithdrawal(params: {
        userId: string;
        amountMinor: number;
        currency?: string;
        provider?: WalletProvider;
        withdrawalId: string;
        note?: string;
    }, tx?: TxClient) {
        const run = async (client: TxClient) => {
            const amountMinor = Math.trunc(params.amountMinor);
            if (amountMinor <= 0) {
                throw new BadRequestException('amountMinor must be positive');
            }

            const currency = this.normalizeCurrency(params.currency);
            const provider = this.normalizeProvider(params.provider);

            const existing = await this.findExistingEntry(
                client,
                'WITHDRAWAL',
                params.withdrawalId,
                'WITHDRAWAL_REVERSAL',
            );
            if (existing) {
                return {
                    skipped: true as const,
                    entryId: existing.id,
                    amountMinor: existing.amountMinor,
                };
            }

            const debit = await this.findExistingEntry(
                client,
                'WITHDRAWAL',
                params.withdrawalId,
                'WITHDRAWAL',
            );
            if (!debit) {
                this.logger.warn(
                    `No WITHDRAWAL ledger for ${params.withdrawalId}; skipping reverse`,
                );
                return { skipped: true as const, entryId: null, amountMinor: 0 };
            }

            const wallet = await this.ensureWallet(client, params.userId, currency, provider);
            const updatedWallet = await client.sellerWallet.update({
                where: { id: wallet.id },
                data: { availableBalance: { increment: amountMinor } },
            });

            const entry = await client.walletLedgerEntry.create({
                data: {
                    walletId: wallet.id,
                    userId: params.userId,
                    entryType: 'WITHDRAWAL_REVERSAL',
                    source: 'OTHER',
                    amountMinor,
                    currency,
                    provider,
                    refType: 'WITHDRAWAL',
                    refId: params.withdrawalId,
                    note: params.note || 'Withdrawal reversed / failed',
                },
            });

            return {
                skipped: false as const,
                entryId: entry.id,
                amountMinor,
                pendingBalance: updatedWallet.pendingBalance,
                availableBalance: updatedWallet.availableBalance,
            };
        };

        if (tx) return run(tx);
        return this.prisma.$transaction((client) => run(client));
    }
}
