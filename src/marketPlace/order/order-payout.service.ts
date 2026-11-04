import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DisputeStatus, OrderStatus, PaymentStatus, TransferStatus } from '@prisma/client';
import { NotificationService } from '../../notification/notification.service';
import { PrismaService } from '../../prisma/prisma.service';
import { WalletService } from '../../wallet/wallet.service';

@Injectable()
export class OrderPayoutService {
    private readonly logger = new Logger(OrderPayoutService.name);
    /** Buyer protection window after delivery before available-balance release. */
    readonly protectionWindowMs = 48 * 60 * 60 * 1000;

    constructor(
        private readonly prisma: PrismaService,
        private readonly notificationService: NotificationService,
        private readonly walletService: WalletService,
    ) { }

    /**
     * Called when an order becomes DELIVERED.
     * Schedules seller earnings unlock after the buyer protection window.
     */
    async scheduleProtectionWindow(orderId: string) {
        const now = new Date();
        const protectionEndsAt = new Date(now.getTime() + this.protectionWindowMs);

        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            select: {
                id: true,
                orderStatus: true,
                paymentStatus: true,
                transferStatus: true,
                disputeStatus: true,
                sellerAmountMinor: true,
            },
        });

        if (!order) throw new NotFoundException('Order not found');
        if (order.orderStatus !== OrderStatus.DELIVERED) {
            throw new BadRequestException('Protection window can only start after delivery');
        }
        if (order.paymentStatus !== PaymentStatus.PAID) {
            throw new BadRequestException('Order payment is not in a payable state');
        }
        if (order.transferStatus === TransferStatus.RELEASED) {
            return { message: 'Earnings already released to available balance', orderId, transferStatus: order.transferStatus, skipped: false };
        }
        if (order.transferStatus === TransferStatus.FROZEN || order.disputeStatus === DisputeStatus.OPEN) {
            return { message: 'Payout is frozen due to dispute', orderId, transferStatus: order.transferStatus, skipped: true };
        }
        if (!order.sellerAmountMinor || order.sellerAmountMinor <= 0) {
            this.logger.warn(
                `Order ${orderId} missing escrow payout fields; skipping protection schedule (legacy/non-escrow order)`,
            );
            return {
                message: 'Order delivered without escrow schedule (missing payout fields)',
                orderId,
                transferStatus: order.transferStatus,
                protectionEndsAt: null as Date | null,
                deliveredAt: null as Date | null,
                skipped: true,
            };
        }

        const updated = await this.prisma.order.update({
            where: { id: orderId },
            data: {
                deliveredAt: now,
                protectionEndsAt,
                transferStatus: TransferStatus.SCHEDULED,
            },
            select: {
                id: true,
                transferStatus: true,
                protectionEndsAt: true,
                deliveredAt: true,
                buyerId: true,
                sellerId: true,
                orderNumber: true,
            },
        });

        await this.notificationService.sendNotificationToUser(
            updated.buyerId,
            'Confirm your delivery',
            'Your order was marked delivered.',
            {
                type: 'marketplace_delivery_protection_started',
                orderId: updated.id,
                orderNumber: updated.orderNumber,
                protectionEndsAt: updated.protectionEndsAt?.toISOString() || '',
                iscancel: false,
                isCancel: false,
                isCancelled: false,
            },
        );

        await this.notificationService.sendNotificationToUser(
            updated.sellerId,
            'Delivered – Earnings Pending',
            'Buyer has 48 hours to confirm. Earnings move to your available balance after the protection window.',
            {
                type: 'marketplace_payout_scheduled',
                orderId: updated.id,
                orderNumber: updated.orderNumber,
                protectionEndsAt: updated.protectionEndsAt?.toISOString() || '',
                iscancel: false,
                isCancel: false,
                isCancelled: false,
            },
        );

        return {
            message: 'Buyer protection window started',
            orderId: updated.id,
            transferStatus: updated.transferStatus,
            protectionEndsAt: updated.protectionEndsAt,
            deliveredAt: updated.deliveredAt,
            skipped: false,
        };
    }

    /**
     * Moves marketplace seller earnings from pending → available wallet balance.
     * Does NOT transfer to Stripe/PagBank Connect (withdrawal is a separate step).
     */
    async releaseIfEligible(orderId: string, options?: { skipProtectionCheck?: boolean; suppressNotification?: boolean }) {
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: {
                payment: { select: { id: true, currency: true, provider: true } },
                seller: { select: { id: true } },
            },
        });

        if (!order) throw new NotFoundException('Order not found');

        if (order.orderStatus !== OrderStatus.DELIVERED) {
            return { released: false, reason: 'Order is not delivered', orderId };
        }
        if (order.paymentStatus !== PaymentStatus.PAID) {
            return { released: false, reason: 'Payment is not PAID', orderId };
        }
        if (order.disputeStatus !== DisputeStatus.NONE) {
            return { released: false, reason: 'Dispute is open or unresolved', orderId };
        }
        if (order.transferStatus === TransferStatus.RELEASED) {
            return { released: false, reason: 'Already released', orderId };
        }
        if (order.transferStatus === TransferStatus.FROZEN) {
            return { released: false, reason: 'Payout is frozen', orderId };
        }
        if (
            order.transferStatus !== TransferStatus.SCHEDULED &&
            order.transferStatus !== TransferStatus.FAILED &&
            order.transferStatus !== TransferStatus.PENDING
        ) {
            return { released: false, reason: `Unexpected transfer status: ${order.transferStatus}`, orderId };
        }

        if (!options?.skipProtectionCheck) {
            if (!order.protectionEndsAt || order.protectionEndsAt.getTime() > Date.now()) {
                return { released: false, reason: 'Protection window has not expired', orderId };
            }
        }

        const sellerAmountMinor = order.sellerAmountMinor ?? 0;
        if (sellerAmountMinor <= 0) {
            await this.prisma.order.update({
                where: { id: orderId },
                data: { transferStatus: TransferStatus.FAILED },
            });
            return { released: false, reason: 'Missing seller amount', orderId };
        }

        const currency = (order.payment?.currency || 'usd').toLowerCase();
        const providerFromPayment =
            (order.payment?.provider || '').toUpperCase() === 'PAGBANK' ? 'PAGBANK' : null;
        const seller = await this.prisma.user.findUnique({
            where: { id: order.sellerId },
            select: { paymentProvider: true },
        });
        const provider =
            // providerFromPayment ||
            // ((seller?.paymentProvider || '').toUpperCase() === 'PAGBANK' ? 'PAGBANK' : 'STRIPE');
            'STRIPE';
        const _unused = providerFromPayment;
            // ((seller?.paymentProvider || '').toUpperCase() === 'PAGBANK' ? 'PAGBANK' : 'STRIPE');

        try {
            const walletResult = await this.walletService.movePendingToAvailable({
                userId: order.sellerId,
                amountMinor: sellerAmountMinor,
                currency,
                provider,
                source: 'MARKETPLACE',
                refType: 'ORDER',
                refId: order.id,
                note: `Marketplace release ${order.orderNumber}`,
            });

            const updated = await this.prisma.order.update({
                where: { id: order.id },
                data: {
                    transferStatus: TransferStatus.RELEASED,
                    payoutReleasedAt: new Date(),
                },
                select: {
                    id: true,
                    orderNumber: true,
                    sellerId: true,
                    buyerId: true,
                    sellerAmountMinor: true,
                    transferStatus: true,
                    payoutReleasedAt: true,
                },
            });

            if (!options?.suppressNotification) {
                await this.notificationService.sendNotificationToUser(
                    updated.sellerId,
                    'Earnings Available',
                    'Your marketplace earnings are now available to withdraw.',
                    {
                        type: 'marketplace_earnings_available',
                        orderId: updated.id,
                        orderNumber: updated.orderNumber,
                        amountMinor: String(updated.sellerAmountMinor ?? 0),
                        walletEntryId: walletResult.entryId,
                        iscancel: false,
                        isCancel: false,
                        isCancelled: false,
                    },
                );
            }

            return {
                released: true,
                orderId: updated.id,
                transferStatus: updated.transferStatus,
                payoutReleasedAt: updated.payoutReleasedAt,
                walletEntryId: walletResult.entryId,
                mode: walletResult.mode,
            };
        } catch (error: any) {
            this.logger.error(
                `Failed to release earnings to wallet for order ${orderId}: ${error?.message || error}`,
                error?.stack,
            );

            await this.prisma.order.update({
                where: { id: orderId },
                data: { transferStatus: TransferStatus.FAILED },
            });

            return {
                released: false,
                reason: error?.message || 'Wallet release failed',
                orderId,
            };
        }
    }

    async freezePayout(orderId: string, reason?: string) {
        const order = await this.prisma.order.update({
            where: { id: orderId },
            data: {
                transferStatus: TransferStatus.FROZEN,
                disputeStatus: DisputeStatus.OPEN,
                disputeReason: reason?.trim() || 'Buyer reported a problem',
            },
            select: {
                id: true,
                orderNumber: true,
                sellerId: true,
                buyerId: true,
                transferStatus: true,
                disputeStatus: true,
            },
        });

        await this.notificationService.sendNotificationToUser(
            order.sellerId,
            'Payout Frozen',
            'A buyer reported a problem. Your payout is on hold.',
            {
                type: 'marketplace_payout_frozen',
                orderId: order.id,
                orderNumber: order.orderNumber,
                iscancel: false,
                isCancel: false,
                isCancelled: false,
            },
        );

        return order;
    }

    async processDuePayouts(limit = 50) {
        const dueOrders = await this.prisma.order.findMany({
            where: {
                orderStatus: OrderStatus.DELIVERED,
                paymentStatus: PaymentStatus.PAID,
                disputeStatus: DisputeStatus.NONE,
                transferStatus: { in: [TransferStatus.SCHEDULED, TransferStatus.FAILED] },
                protectionEndsAt: { lte: new Date() },
            },
            select: { id: true },
            take: limit,
            orderBy: { protectionEndsAt: 'asc' },
        });

        let released = 0;
        let failed = 0;
        let skipped = 0;

        for (const row of dueOrders) {
            const result = await this.releaseIfEligible(row.id);
            if (result.released) released += 1;
            else if (result.reason?.includes('Wallet') || result.reason?.includes('Missing') || result.reason?.includes('Insufficient')) failed += 1;
            else skipped += 1;
        }

        return { scanned: dueOrders.length, released, failed, skipped };
    }
}
