import { BadRequestException, Inject, Injectable, NotFoundException, UnauthorizedException, forwardRef } from '@nestjs/common';
import { CancellationStatus, CartItemShippingChoice, DisputeStatus, OrderStatus, PaymentStatus, Prisma, ShippingStatus, TransferStatus } from '@prisma/client';
import Stripe from 'stripe';
import { ClosetChatService } from '../closet-chat/closet-chat.service';
import { MailService } from '../../common/mail/mail.service';
import { NotificationService } from '../../notification/notification.service';
import { PrismaService } from '../../prisma/prisma.service';
import { WalletService } from '../../wallet/wallet.service';
import { PagBankService } from '../../pagbank/pagbank.service';
import { CurrencyConverterService } from '../../common/currency/currency-converter.service';
import { formatCurrencyAmount, getCurrencySymbol, isBrazilUser, normalizeCountryCode } from '../../common/payment-provider.util';
import { BuyerOrderListQueryDto } from './dto/buyer-order-list-query.dto';
import { OrderPayoutService } from './order-payout.service';

@Injectable()
export class OrderService {
    private readonly stripe: Stripe;
    private readonly marketplaceType = 'marketplace_mycloset';

    constructor(
        private readonly prisma: PrismaService,
        private readonly notificationService: NotificationService,
        private readonly mailService: MailService,
        private readonly closetChatService: ClosetChatService,
        private readonly orderPayoutService: OrderPayoutService,
        private readonly walletService: WalletService,
        @Inject(forwardRef(() => PagBankService))
        private readonly pagBankService: PagBankService,
        private readonly currencyConverter: CurrencyConverterService,
    ) {
        this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
            apiVersion: '2024-06-20',
        });
    }

    private toMajor(valueMinor: number) {
        return Number((valueMinor / 100).toFixed(2));
    }

    private toMinor(valueMajor: number) {
        return Math.round(Number(valueMajor.toFixed(2)) * 100);
    }

    private async generateOrderNumber(tx: Prisma.TransactionClient) {
        const now = new Date();
        const y = now.getUTCFullYear();
        const m = String(now.getUTCMonth() + 1).padStart(2, '0');
        const d = String(now.getUTCDate()).padStart(2, '0');

        for (let attempt = 0; attempt < 5; attempt++) {
            const randomPart = Math.floor(10000 + Math.random() * 90000);
            const candidate = `MC-${y}${m}${d}-${randomPart}`;
            const existing = await tx.order.findUnique({
                where: { orderNumber: candidate },
                select: { id: true },
            });
            if (!existing) return candidate;
        }

        throw new BadRequestException('Unable to generate unique order number');
    }

    async createOrderFromPaymentIntent(paymentIntent: Stripe.PaymentIntent) {
        if (paymentIntent.status !== 'succeeded') return;
        if (paymentIntent.metadata?.type !== this.marketplaceType) return;

        const paymentRecord = await this.prisma.marketPlacePayments.findFirst({
            where: {
                OR: [
                    { paymentIntentId: paymentIntent.id },
                    ...(paymentIntent.metadata?.paymentId ? [{ id: paymentIntent.metadata.paymentId }] : []),
                ],
            },
        });

        if (!paymentRecord) throw new NotFoundException('Marketplace payment record not found');

        const metadata = (paymentRecord.metadata as Prisma.JsonObject | null) || null;
        const itemsRaw = (metadata?.items as Prisma.JsonArray | undefined) || [];
        const addressId = typeof metadata?.addressId === 'string' && metadata.addressId.trim().length > 0
            ? metadata.addressId.trim()
            : null;

        if (!paymentRecord.userId || !paymentRecord.cartId || !itemsRaw.length) {
            throw new BadRequestException('Payment metadata is incomplete for order creation');
        }

        const buyerId = paymentRecord.userId;
        const cartId = paymentRecord.cartId;

        let createdOrderIds: string[] = [];
        let createdNewOrders = false;
        const orderNotifications: Array<{
            sellerId: string;
            orderId: string;
            orderNumber: string;
            image?: string;
            productName?: string;
            price?: string;
            pointsEarned?: number;
        }> = [];

        await this.prisma.$transaction(async (tx) => {
            const existingOrders = await tx.order.findMany({
                where: { paymentId: paymentRecord.id },
                select: { id: true, orderNumber: true, sellerId: true },
            });
            if (existingOrders.length) {
                createdOrderIds = existingOrders.map((existingOrder) => existingOrder.id);
                await tx.marketPlacePayments.update({
                    where: { id: paymentRecord.id },
                    data: {
                        status: 'PAID',
                        transactionId: typeof paymentIntent.latest_charge === 'string' ? paymentIntent.latest_charge : null,
                        paymentIntentId: paymentIntent.id,
                        orderId: existingOrders[0].id,
                    },
                });
                return;
            }
            createdNewOrders = true;

            const parsedItems = itemsRaw.map((entry) => {
                const item = entry as Prisma.JsonObject;
                const shippingMinor = Number(item.shippingMinor ?? 0);
                const selectedShippingChoice =
                    item.selectedShippingChoice === CartItemShippingChoice.ship_items ||
                        item.selectedShippingChoice === CartItemShippingChoice.local_pick
                        ? item.selectedShippingChoice
                        : shippingMinor > 0
                            ? CartItemShippingChoice.ship_items
                            : CartItemShippingChoice.local_pick;
                return {
                    productId: String(item.productId),
                    sellerId: String(item.sellerId),
                    quantity: Number(item.quantity),
                    unitPriceMinor: Number(item.unitPriceMinor),
                    subtotalMinor: Number(item.subtotalMinor),
                    shippingMinor,
                    selectedShippingChoice,
                };
            });

            const requiresShippingAddress = parsedItems.some(
                (item) => item.selectedShippingChoice === CartItemShippingChoice.ship_items,
            );

            if (requiresShippingAddress && !addressId) {
                throw new BadRequestException('Payment metadata is incomplete: shipping address required for shipped items');
            }

            let address: { id: string } | null = null;
            if (addressId) {
                address = await tx.userAddrees.findFirst({
                    where: { id: addressId, userId: buyerId },
                    select: { id: true },
                });
                if (!address && requiresShippingAddress) {
                    throw new BadRequestException('Selected address is invalid for this user');
                }
            }

            // Create one order per cart item line, while preserving the single payment.
            const orderLines: Array<{
                sellerId: string;
                closetId: string;
                productId: string;
                quantity: number;
                unitPriceMinor: number;
                subtotalMinor: number;
                shippingMinor: number;
                selectedShippingChoice: CartItemShippingChoice;
                productName: string;
                productImage: string;
                pickupAddress: string | null;
                pickupAvailableHours: string | null;
            }> = [];

            for (const item of parsedItems) {
                const product = await tx.closetItems.findUnique({
                    where: { id: item.productId },
                    select: {
                        id: true,
                        name: true,
                        images: true,
                        closetId: true,
                        quantity: true,
                        isActive: true,
                        isDeleted: true,
                        pickupAddress: true,
                        pickupAvailableHours: true,
                    },
                });

                if (!product) throw new NotFoundException(`Product not found: ${item.productId}`);
                if (!product.isActive || product.isDeleted) throw new BadRequestException(`Product unavailable: ${product.name}`);
                if (product.quantity < item.quantity) {
                    throw new BadRequestException(`Only ${product.quantity} quantity available for ${product.name}`);
                }

                orderLines.push({
                    sellerId: item.sellerId,
                    closetId: product.closetId,
                    productId: item.productId,
                    quantity: item.quantity,
                    unitPriceMinor: item.unitPriceMinor,
                    subtotalMinor: item.subtotalMinor,
                    shippingMinor: item.shippingMinor,
                    selectedShippingChoice: item.selectedShippingChoice,
                    productName: product.name,
                    productImage: product.images[0] || '',
                    pickupAddress: product.pickupAddress,
                    pickupAvailableHours: product.pickupAvailableHours,
                });
            }

            const platformFeePercent =
                typeof metadata?.platformFeePercent === 'number' ? metadata.platformFeePercent : 0.15;
            const sellerStripeAccountId =
                typeof metadata?.sellerStripeAccountId === 'string'
                    ? metadata.sellerStripeAccountId
                    : null;
            const stripeChargeId =
                typeof paymentIntent.latest_charge === 'string' ? paymentIntent.latest_charge : null;

            // Fallback: resolve Connect account from seller if not in payment metadata (legacy payments).
            let resolvedSellerStripeAccountId = sellerStripeAccountId;
            if (!resolvedSellerStripeAccountId) {
                const firstSellerId = orderLines[0]?.sellerId;
                if (firstSellerId) {
                    const sellerUser = await tx.user.findUnique({
                        where: { id: firstSellerId },
                        select: { stripeAccountId: true },
                    });
                    resolvedSellerStripeAccountId = sellerUser?.stripeAccountId || null;
                }
            }

            let totalPointsAwardedToBuyer = 0;

            for (const item of orderLines) {
                const subtotalMinor = item.subtotalMinor;
                const shippingMinor = item.shippingMinor;
                const totalMinor = subtotalMinor + shippingMinor;
                const platformFeeMinor = Math.round(totalMinor * platformFeePercent);
                const sellerAmountMinor = Math.max(0, totalMinor - platformFeeMinor);
                const subtotalMajor = this.toMajor(subtotalMinor);
                const earnedPoints = Math.round(subtotalMajor);

                const order = await tx.order.create({
                    data: {
                        orderNumber: await this.generateOrderNumber(tx),
                        buyerId,
                        sellerId: item.sellerId,
                        closetId: item.closetId,
                        addressId: address?.id ?? null,
                        paymentId: paymentRecord.id,
                        subtotal: subtotalMajor,
                        shippingCost: this.toMajor(shippingMinor),
                        serviceFee: this.toMajor(platformFeeMinor),
                        total: this.toMajor(totalMinor),
                        paymentMethod: paymentRecord.provider || 'STRIPE',
                        paymentStatus: PaymentStatus.PAID,
                        orderStatus: OrderStatus.PENDING,
                        platformFeeMinor,
                        sellerAmountMinor,
                        sellerStripeAccountId: resolvedSellerStripeAccountId,
                        stripeChargeId,
                        transferStatus: TransferStatus.PENDING,
                        disputeStatus: DisputeStatus.NONE,
                    },
                });

                if (earnedPoints > 0) {
                    await tx.shopRewardPointsAward.create({
                        data: {
                            orderId: order.id,
                            userId: buyerId,
                            points: earnedPoints,
                            subtotal: subtotalMajor,
                            awardedAt: new Date(),
                        },
                    });
                    totalPointsAwardedToBuyer += earnedPoints;
                }

                const sellerForNotif = await tx.user.findUnique({
                    where: { id: item.sellerId },
                    select: { paymentProvider: true, country: true },
                });
                const isSellerBrazil = isBrazilUser(sellerForNotif?.country);
                const notifCurrency = isSellerBrazil ? 'BRL' : (paymentRecord.currency?.toUpperCase() || 'USD');
                const notifSymbol = getCurrencySymbol(notifCurrency);

                createdOrderIds.push(order.id);
                orderNotifications.push({
                    sellerId: item.sellerId,
                    orderId: order.id,
                    orderNumber: order.orderNumber,
                    image: item.productImage || '',
                    productName: item.productName || '',
                    price: `${notifSymbol} ${this.toMajor(totalMinor).toFixed(2)}`,
                    pointsEarned: earnedPoints,
                });

                if (sellerAmountMinor > 0) {
                    const provider: 'PAGBANK' | 'STRIPE' = 'STRIPE';
                    const targetCurrency = isSellerBrazil ? 'brl' : 'usd';
                    const sourceCurrency = (paymentRecord.currency || targetCurrency).toLowerCase();

                    let finalSellerAmountMinor = Math.round(sellerAmountMinor);
                    if (sourceCurrency !== targetCurrency) {
                        finalSellerAmountMinor = await this.currencyConverter.convertMinor(
                            sellerAmountMinor,
                            sourceCurrency,
                            targetCurrency,
                        );
                    }

                    await this.walletService.creditPending(
                        {
                            userId: item.sellerId,
                            amountMinor: finalSellerAmountMinor,
                            currency: targetCurrency,
                            provider,
                            source: 'MARKETPLACE',
                            refType: 'ORDER',
                            refId: order.id,
                            note: `Marketplace order ${order.orderNumber}${sourceCurrency !== targetCurrency ? ` (converted from ${sellerAmountMinor} ${sourceCurrency.toUpperCase()})` : ''}`,
                        },
                        tx,
                    );
                }

                await tx.orderItem.create({
                    data: {
                        orderId: order.id,
                        productId: item.productId,
                        productName: item.productName,
                        productImage: item.productImage,
                        quantity: item.quantity,
                        price: this.toMajor(item.unitPriceMinor),
                        subtotal: this.toMajor(item.subtotalMinor),
                        selectedShippingChoice: item.selectedShippingChoice,
                        selectedShippingFee: this.toMajor(item.shippingMinor),
                        pickupAddress:
                            item.selectedShippingChoice === CartItemShippingChoice.local_pick
                                ? item.pickupAddress
                                : null,
                        pickupAvailableHours:
                            item.selectedShippingChoice === CartItemShippingChoice.local_pick
                                ? item.pickupAvailableHours
                                : null,
                    },
                });

                await tx.closetItems.update({
                    where: { id: item.productId },
                    data: {
                        quantity: { decrement: item.quantity },
                        soldCount: { increment: item.quantity },
                    },
                });
            }

            if (totalPointsAwardedToBuyer > 0) {
                await tx.user.update({
                    where: { id: buyerId },
                    data: {
                        shopPlatformPoints: { increment: totalPointsAwardedToBuyer },
                        totalPlatformPoints: { increment: totalPointsAwardedToBuyer },
                    },
                });
            }

            await tx.cartItems.deleteMany({ where: { cartId } });
            await tx.cart.deleteMany({ where: { id: cartId } });

            await tx.marketPlacePayments.update({
                where: { id: paymentRecord.id },
                data: {
                    status: 'PAID',
                    transactionId: typeof paymentIntent.latest_charge === 'string' ? paymentIntent.latest_charge : null,
                    paymentIntentId: paymentIntent.id,
                    orderId: createdOrderIds[0] || null,
                },
            });

        });

        for (const orderId of createdOrderIds) {
            await this.closetChatService.ensureOrderPlacedThreadAndMessage(orderId);
        }

        if (createdNewOrders) {
            const buyer = await this.prisma.user.findUnique({
                where: { id: buyerId },
                select: { id: true, userName: true, displayName: true, image: true },
            });
            const buyerUsername = buyer?.userName || buyer?.displayName || 'A buyer';
            const buyerName = buyer?.displayName || buyer?.userName || 'Buyer';
            const buyerAvatar = buyer?.image || '';

            for (const orderNotification of orderNotifications) {
                // Send notification to seller
                await this.notificationService.sendNotificationToUser(
                    orderNotification.sellerId,
                    'You have a new order',
                    `${buyerUsername} has placed a new order in your closet.`,
                    {
                        type: 'marketplace_order_paid',
                        paymentId: paymentRecord.id,
                        paymentIntentId: paymentRecord.paymentIntentId || paymentIntent.id,
                        transactionId:
                            paymentRecord.transactionId ||
                            (typeof paymentIntent.latest_charge === 'string' ? paymentIntent.latest_charge : ''),
                        orderId: orderNotification.orderId,
                        orderNumber: orderNotification.orderNumber,
                        image: orderNotification.image || '',
                        productImage: orderNotification.image || '',
                        name: orderNotification.productName || '',
                        productName: orderNotification.productName || '',
                        itemName: orderNotification.productName || '',
                        price: orderNotification.price || '',
                        total: orderNotification.price || '',
                        avatar: buyerAvatar,
                        buyerAvatar,
                        buyerImage: buyerAvatar,
                        buyerName,
                        buyerUsername: buyer?.userName || '',
                        iscancel: false,
                        isCancel: false,
                        isCancelled: false,
                    },
                );

                // Send notification to buyer
                const buyerBody = (orderNotification.pointsEarned && orderNotification.pointsEarned > 0)
                    ? `Your order #${orderNotification.orderNumber} has been placed successfully. You earned ${orderNotification.pointsEarned} Platform Points!`
                    : `Your order #${orderNotification.orderNumber} has been placed successfully.`;

                await this.notificationService.sendNotificationToUser(
                    buyerId,
                    'Order Placed Successfully',
                    buyerBody,
                    {
                        type: 'marketplace_order_placed',
                        paymentId: paymentRecord.id,
                        paymentIntentId: paymentRecord.paymentIntentId || paymentIntent.id,
                        transactionId:
                            paymentRecord.transactionId ||
                            (typeof paymentIntent.latest_charge === 'string' ? paymentIntent.latest_charge : ''),
                        orderId: orderNotification.orderId,
                        orderNumber: orderNotification.orderNumber,
                        image: orderNotification.image || '',
                        productImage: orderNotification.image || '',
                        name: orderNotification.productName || '',
                        productName: orderNotification.productName || '',
                        itemName: orderNotification.productName || '',
                        price: orderNotification.price || '',
                        total: orderNotification.price || '',
                        pointsEarned: orderNotification.pointsEarned || 0,
                        iscancel: false,
                        isCancel: false,
                        isCancelled: false,
                    },
                );

                await this.sendNewOrderEmailToSeller(orderNotification.orderId);
            }
        }

        return { message: 'Order Created Successfully', orderIds: createdOrderIds };
    }

    /** Best-effort email to the seller when a new order is placed; never blocks order creation. */
    private async sendNewOrderEmailToSeller(orderId: string) {
        try {
            const order = await this.prisma.order.findUnique({
                where: { id: orderId },
                select: {
                    orderNumber: true,
                    total: true,
                    seller: {
                        select: {
                            id: true,
                            email: true,
                            displayName: true,
                            userName: true,
                            companyProfile: { select: { email: true } },
                        },
                    },
                    buyer: { select: { id: true, displayName: true, userName: true } },
                    items: { select: { productName: true }, take: 1 },
                },
            });
            if (!order) return;

            const sellerEmail = order.seller?.companyProfile?.email || order.seller?.email;
            if (!sellerEmail) return;

            const baseUrl = process.env.BASE_URL || 'https://api.valens.app';
            const sellerProfileUrl = order.seller?.id ? `${baseUrl.replace(/\/$/, '')}/profile/${order.seller.id}` : `${baseUrl}/open-app`;
            const buyerProfileUrl = order.buyer?.id ? `${baseUrl.replace(/\/$/, '')}/profile/${order.buyer.id}` : `${baseUrl}/open-app`;

            await this.mailService.sendTemplateEmail({
                to: sellerEmail,
                subject: 'You have a new order on Valens',
                templateFile: 'new-order-seller.html',
                replacements: {
                    seller_name: order.seller?.displayName || order.seller?.userName || 'Seller',
                    seller_profile_url: sellerProfileUrl,
                    sellerProfileUrl,
                    buyer_name: order.buyer?.userName || order.buyer?.displayName || 'A buyer',
                    buyer_profile_url: buyerProfileUrl,
                    buyerProfileUrl,
                    order_number: order.orderNumber,
                    product_name: order.items[0]?.productName || 'your item',
                    order_total: `$${order.total.toFixed(2)}`,
                },
            });
        } catch (error) {
            console.error('Failed to send new-order email to seller:', error);
        }
    }

    /** Create marketplace orders after a PagBank PIX payment is confirmed. */
    async createOrderFromPagBankPayment(paymentId: string) {
        const paymentRecord = await this.prisma.marketPlacePayments.findUnique({
            where: { id: paymentId },
        });
        if (!paymentRecord) throw new NotFoundException('Marketplace payment record not found');
        if (paymentRecord.status !== 'PAID') {
            throw new BadRequestException('Marketplace payment is not PAID');
        }

        const fakeIntent = {
            id: paymentRecord.paymentIntentId || paymentRecord.id,
            status: 'succeeded',
            amount: paymentRecord.amount,
            currency: paymentRecord.currency,
            latest_charge: paymentRecord.transactionId,
            metadata: {
                type: this.marketplaceType,
                paymentId: paymentRecord.id,
            },
        } as any;

        return this.createOrderFromPaymentIntent(fakeIntent);
    }

    async getBuyerOrders(userId: string, query?: BuyerOrderListQueryDto) {
        if (!userId) throw new UnauthorizedException('User not authenticated');

        const where: Prisma.OrderWhereInput = {
            buyerId: userId,
            ...(query?.status ? { orderStatus: query.status } : {}),
            ...(query?.cancellationStatus ? { cancellationStatus: query.cancellationStatus } : {}),
        };

        const orders = await this.prisma.order.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            ...(query?.page && query?.limit
                ? {
                    skip: (Math.max(1, Number(query.page)) - 1) * Math.min(100, Math.max(1, Number(query.limit))),
                    take: Math.min(100, Math.max(1, Number(query.limit))),
                }
                : {}),
            include: {
                payment: {
                    select: {
                        currency: true,
                    },
                },
                seller: {
                    select: {
                        id: true,
                        userName: true,
                        displayName: true,
                        image: true,
                    },
                },
                items: {
                    select: {
                        id: true,
                        productId: true,
                        productName: true,
                        productImage: true,
                        quantity: true,
                        price: true,
                        subtotal: true,
                        selectedShippingChoice: true,
                        selectedShippingFee: true,
                        pickupAddress: true,
                        pickupAvailableHours: true,
                        product: {
                            select: {
                                id: true,
                                name: true,
                                images: true,
                                category: true,
                                brand: true,
                                condition: true,
                                isActive: true,
                                isDeleted: true,
                                shippingOption: true,
                                shippingFee: true,
                                estimateShippingTime: true,
                                pickUpCity: true,
                                pickupAddress: true,
                                pickupAvailableHours: true,
                            },
                        },
                    },
                },
                shopRewardPointsAward: {
                    select: {
                        points: true,
                    },
                },
            },
        });

        const buyerUser = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { country: true },
        });
        const isBuyerBrazil = isBrazilUser(buyerUser?.country);

        return orders.map((order) => {
            const isLocalPickupOrder =
                order.items.length > 0 &&
                order.items.every((item) => item.selectedShippingChoice === CartItemShippingChoice.local_pick);
            const paymentCurrency = (order.payment?.currency || '').toUpperCase();
            const orderCurrency = paymentCurrency === 'BRL' || isBuyerBrazil ? 'BRL' : (paymentCurrency || 'USD');
            const orderSymbol = getCurrencySymbol(orderCurrency);

            return {
                ...order,
                currency: orderCurrency,
                currencySymbol: orderSymbol,
                formattedTotal: formatCurrencyAmount(order.total, orderCurrency),
                formattedSubtotal: formatCurrencyAmount(order.subtotal, orderCurrency),
                formattedShippingCost: formatCurrencyAmount(order.shippingCost, orderCurrency),
                formattedServiceFee: formatCurrencyAmount(order.serviceFee, orderCurrency),
                orderStatus:
                    isLocalPickupOrder && order.orderStatus === OrderStatus.PENDING
                        ? 'localpickup'
                        : order.orderStatus,
                pointsEarned: order.shopRewardPointsAward?.points || 0,
                totalItemCount: order.items.length,
                items: order.items.map((item) => ({
                    id: item.id,
                    productId: item.productId,
                    productName: item.productName,
                    productImage: item.productImage,
                    quantity: item.quantity,
                    price: item.price,
                    subtotal: item.subtotal,
                    currency: orderCurrency,
                    currencySymbol: orderSymbol,
                    formattedPrice: formatCurrencyAmount(item.price, orderCurrency),
                    formattedSubtotal: formatCurrencyAmount(item.subtotal, orderCurrency),
                    selectedShippingChoice: item.selectedShippingChoice,
                    selectedShippingFee: item.selectedShippingFee,
                    pickupAddress:
                        item.selectedShippingChoice === CartItemShippingChoice.local_pick
                            ? (item.product?.pickupAddress ?? item.pickupAddress ?? null)
                            : null,
                    pickupAvailableHours:
                        item.selectedShippingChoice === CartItemShippingChoice.local_pick
                            ? (item.product?.pickupAvailableHours ?? item.pickupAvailableHours ?? null)
                            : null,
                    pickUpCity:
                        item.selectedShippingChoice === CartItemShippingChoice.local_pick
                            ? (item.product?.pickUpCity ?? null)
                            : null,
                    product: item.product
                        ? {
                            id: item.product.id,
                            name: item.product.name,
                            images: item.product.images,
                            category: item.product.category,
                            brand: item.product.brand,
                            condition: item.product.condition,
                            isActive: item.product.isActive,
                            isDeleted: item.product.isDeleted,
                            shippingOption: item.product.shippingOption,
                            shippingFee: item.product.shippingFee,
                            estimateShippingTime: item.product.estimateShippingTime,
                            pickUpCity: item.product.pickUpCity,
                            pickupAddress: item.product.pickupAddress,
                            pickupAvailableHours: item.product.pickupAvailableHours,
                        }
                        : null,
                })),
            };
        });
    }

    async getBuyerOrderDetails(userId: string, orderId: string) {
        if (!userId) throw new UnauthorizedException('User not authenticated');

        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: {
                seller: {
                    select: {
                        userName: true,
                        image: true,
                    },
                },
                items: {
                    select: {
                        id: true,
                        productId: true,
                        productName: true,
                        productImage: true,
                        quantity: true,
                        price: true,
                        subtotal: true,
                        selectedShippingChoice: true,
                        selectedShippingFee: true,
                        pickupAddress: true,
                        pickupAvailableHours: true,
                        product: {
                            select: {
                                id: true,
                                name: true,
                                images: true,
                                category: true,
                                brand: true,
                                condition: true,
                                isActive: true,
                                isDeleted: true,
                                shippingOption: true,
                                shippingFee: true,
                                estimateShippingTime: true,
                                pickUpCity: true,
                                pickupAddress: true,
                                pickupAvailableHours: true,
                            },
                        },
                    },
                },
                address: true,
                payment: true,
                shopRewardPointsAward: {
                    select: {
                        points: true,
                    },
                },
            },
        });

        if (!order) throw new NotFoundException('Order not found');
        if (order.buyerId !== userId) throw new UnauthorizedException('Unauthorized');

        const buyerUser = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { country: true },
        });
        const isBuyerBrazil = isBrazilUser(buyerUser?.country);
        const paymentCurrency = (order.payment?.currency || '').toUpperCase();
        const orderCurrency = paymentCurrency === 'BRL' || isBuyerBrazil ? 'BRL' : (paymentCurrency || 'USD');
        const orderSymbol = getCurrencySymbol(orderCurrency);

        return {
            ...order,
            currency: orderCurrency,
            currencySymbol: orderSymbol,
            formattedTotal: formatCurrencyAmount(order.total, orderCurrency),
            formattedSubtotal: formatCurrencyAmount(order.subtotal, orderCurrency),
            formattedShippingCost: formatCurrencyAmount(order.shippingCost, orderCurrency),
            formattedServiceFee: formatCurrencyAmount(order.serviceFee, orderCurrency),
            pointsEarned: order.shopRewardPointsAward?.points || 0,
            totalItemCount: order.items.length,
            items: order.items.map((item) => ({
                id: item.id,
                productId: item.productId,
                productName: item.productName,
                productImage: item.productImage,
                sellerUserName: order.seller?.userName || null,
                sellerImage: order.seller?.image || null,
                quantity: item.quantity,
                price: item.price,
                subtotal: item.subtotal,
                currency: orderCurrency,
                currencySymbol: orderSymbol,
                formattedPrice: formatCurrencyAmount(item.price, orderCurrency),
                formattedSubtotal: formatCurrencyAmount(item.subtotal, orderCurrency),
                selectedShippingChoice: item.selectedShippingChoice,
                selectedShippingFee: item.selectedShippingFee,
                pickupAddress:
                    item.selectedShippingChoice === CartItemShippingChoice.local_pick
                        ? (item.product?.pickupAddress ?? item.pickupAddress ?? null)
                        : null,
                pickupAvailableHours:
                    item.selectedShippingChoice === CartItemShippingChoice.local_pick
                        ? (item.product?.pickupAvailableHours ?? item.pickupAvailableHours ?? null)
                        : null,
                pickUpCity:
                    item.selectedShippingChoice === CartItemShippingChoice.local_pick
                        ? (item.product?.pickUpCity ?? null)
                        : null,
                product: item.product
                    ? {
                        id: item.product.id,
                        name: item.product.name,
                        images: item.product.images,
                        category: item.product.category,
                        brand: item.product.brand,
                        condition: item.product.condition,
                        isActive: item.product.isActive,
                        isDeleted: item.product.isDeleted,
                        shippingOption: item.product.shippingOption,
                        shippingFee: item.product.shippingFee,
                        estimateShippingTime: item.product.estimateShippingTime,
                        pickUpCity: item.product.pickUpCity,
                        pickupAddress: item.product.pickupAddress,
                        pickupAvailableHours: item.product.pickupAvailableHours,
                    }
                    : null,
            })),
        };
    }

    /** Email to buyer confirming their cancellation request was submitted and is pending review. */
    private async sendCancellationRequestEmailToBuyer(params: {
        orderId: string;
        reason?: string;
    }) {
        try {
            const order = await this.prisma.order.findUnique({
                where: { id: params.orderId },
                include: {
                    buyer: { select: { email: true, displayName: true, userName: true } },
                    seller: {
                        select: {
                            displayName: true,
                            userName: true,
                            companyProfile: { select: { businessName: true } },
                        },
                    },
                    items: { select: { productName: true }, take: 1 },
                },
            });
            if (!order || !order.buyer?.email) return;

            const appBaseUrl = process.env.APP_BASE_URL || 'https://valensapp.com';
            const sellerName =
                order.seller?.companyProfile?.businessName ||
                order.seller?.displayName ||
                order.seller?.userName ||
                'Seller';

            await this.mailService.sendTemplateEmail({
                to: order.buyer.email,
                subject: `Cancellation Request Submitted for Order #${order.orderNumber}`,
                templateFile: 'order-cancellation-requested-buyer.html',
                replacements: {
                    buyer_name: order.buyer.displayName || order.buyer.userName || 'Valued Customer',
                    seller_name: sellerName,
                    order_number: order.orderNumber,
                    product_name: order.items[0]?.productName || 'your item',
                    cancellation_reason: params.reason || 'Requested by buyer before shipping',
                    refund_amount: `$${order.total.toFixed(2)}`,
                    order_details_link: `${appBaseUrl}/orders/${order.id}`,
                },
            });
        } catch (error) {
            console.error('Failed to send cancellation request email to buyer:', error);
        }
    }

    /** Email to seller alerting them that buyer requested order cancellation. */
    private async sendCancellationRequestEmailToSeller(params: {
        orderId: string;
        reason?: string;
    }) {
        try {
            const order = await this.prisma.order.findUnique({
                where: { id: params.orderId },
                include: {
                    seller: {
                        select: {
                            email: true,
                            displayName: true,
                            userName: true,
                            companyProfile: { select: { email: true, businessName: true } },
                        },
                    },
                    buyer: { select: { displayName: true, userName: true } },
                    items: { select: { productName: true }, take: 1 },
                },
            });
            if (!order) return;
            const sellerEmail = order.seller?.companyProfile?.email || order.seller?.email;
            if (!sellerEmail) return;

            const appBaseUrl = process.env.APP_BASE_URL || 'https://valensapp.com';
            const sellerName =
                order.seller?.companyProfile?.businessName ||
                order.seller?.displayName ||
                order.seller?.userName ||
                'Seller';

            await this.mailService.sendTemplateEmail({
                to: sellerEmail,
                subject: `Action Required: Cancellation Requested for Order #${order.orderNumber}`,
                templateFile: 'order-cancellation-requested-seller.html',
                replacements: {
                    seller_name: sellerName,
                    buyer_name: order.buyer?.displayName || order.buyer?.userName || 'Buyer',
                    order_number: order.orderNumber,
                    product_name: order.items[0]?.productName || 'your item',
                    cancellation_reason: params.reason || 'Requested by buyer before shipping',
                    order_total: `$${order.total.toFixed(2)}`,
                    order_details_link: `${appBaseUrl}/seller/orders/${order.id}`,
                },
            });
        } catch (error) {
            console.error('Failed to send cancellation request email to seller:', error);
        }
    }

    /** Email to buyer informing them that their cancellation request was declined by the seller. */
    public async sendCancellationDeclinedEmailToBuyer(params: {
        orderId: string;
        declineReason?: string;
    }) {
        try {
            const order = await this.prisma.order.findUnique({
                where: { id: params.orderId },
                include: {
                    buyer: { select: { email: true, displayName: true, userName: true } },
                    seller: {
                        select: {
                            displayName: true,
                            userName: true,
                            companyProfile: { select: { businessName: true } },
                        },
                    },
                    items: { select: { productName: true }, take: 1 },
                },
            });
            if (!order || !order.buyer?.email) return;

            const appBaseUrl = process.env.APP_BASE_URL || 'https://valensapp.com';
            const sellerName =
                order.seller?.companyProfile?.businessName ||
                order.seller?.displayName ||
                order.seller?.userName ||
                'Seller';

            await this.mailService.sendTemplateEmail({
                to: order.buyer.email,
                subject: `Cancellation Request Declined for Order #${order.orderNumber}`,
                templateFile: 'order-cancellation-declined-buyer.html',
                replacements: {
                    buyer_name: order.buyer.displayName || order.buyer.userName || 'Valued Customer',
                    seller_name: sellerName,
                    order_number: order.orderNumber,
                    product_name: order.items[0]?.productName || 'your item',
                    decline_reason: params.declineReason || 'Seller is unable to cancel at this time',
                    order_details_link: `${appBaseUrl}/orders/${order.id}`,
                },
            });
        } catch (error) {
            console.error('Failed to send cancellation declined email to buyer:', error);
        }
    }

    /** Best-effort email to the buyer when an order is cancelled; never blocks cancellation. */
    private async sendCancellationEmailToBuyer(params: {
        orderId: string;
        cancelledBy: string;
        reason?: string;
        refundAmount: number;
    }) {
        try {
            const order = await this.prisma.order.findUnique({
                where: { id: params.orderId },
                include: {
                    buyer: { select: { email: true, displayName: true, userName: true } },
                    items: { select: { productName: true }, take: 1 },
                },
            });
            if (!order || !order.buyer?.email) return;

            const appBaseUrl = process.env.APP_BASE_URL || 'https://valensapp.com';
            await this.mailService.sendTemplateEmail({
                to: order.buyer.email,
                subject: `Your Valens Order #${order.orderNumber} Has Been Cancelled`,
                templateFile: 'order-cancelled-buyer.html',
                replacements: {
                    buyer_name: order.buyer.displayName || order.buyer.userName || 'Valued Customer',
                    order_number: order.orderNumber,
                    product_name: order.items[0]?.productName || 'your item',
                    cancelled_by: params.cancelledBy === 'SELLER' ? 'Seller' : 'You (Buyer)',
                    cancellation_reason: params.reason || 'Order cancelled before shipping',
                    refund_amount: `$${params.refundAmount.toFixed(2)}`,
                    order_details_link: `${appBaseUrl}/orders/${order.id}`,
                },
            });
        } catch (error) {
            console.error('Failed to send cancellation email to buyer:', error);
        }
    }

    /** Best-effort email to the seller when an order is cancelled; never blocks cancellation. */
    private async sendCancellationEmailToSeller(params: {
        orderId: string;
        cancelledBy: string;
        reason?: string;
    }) {
        try {
            const order = await this.prisma.order.findUnique({
                where: { id: params.orderId },
                include: {
                    seller: {
                        select: {
                            email: true,
                            displayName: true,
                            userName: true,
                            companyProfile: { select: { email: true } },
                        },
                    },
                    buyer: { select: { displayName: true, userName: true } },
                    items: { select: { productName: true }, take: 1 },
                },
            });
            if (!order) return;
            const sellerEmail = order.seller?.companyProfile?.email || order.seller?.email;
            if (!sellerEmail) return;

            const appBaseUrl = process.env.APP_BASE_URL || 'https://valensapp.com';
            await this.mailService.sendTemplateEmail({
                to: sellerEmail,
                subject: `Order #${order.orderNumber} Has Been Cancelled`,
                templateFile: 'order-cancelled-seller.html',
                replacements: {
                    seller_name: order.seller?.displayName || order.seller?.userName || 'Seller',
                    buyer_name: order.buyer?.displayName || order.buyer?.userName || 'Buyer',
                    order_number: order.orderNumber,
                    product_name: order.items[0]?.productName || 'your item',
                    cancelled_by: params.cancelledBy === 'SELLER' ? 'You (Seller)' : 'Buyer',
                    cancellation_reason: params.reason || 'Order cancelled before shipping',
                    inventory_status: 'Restocked to your closet',
                    order_details_link: `${appBaseUrl}/seller/orders/${order.id}`,
                },
            });
        } catch (error) {
            console.error('Failed to send cancellation email to seller:', error);
        }
    }

    async executeRefundAndCancel(params: {
        orderId: string;
        cancelledBy: 'BUYER' | 'SELLER' | 'ADMIN';
        reason?: string;
        restock?: boolean;
    }) {
        const { orderId, cancelledBy, reason, restock = true } = params;

        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: {
                items: true,
                payment: true,
                seller: {
                    select: {
                        id: true,
                        paymentProvider: true,
                        email: true,
                        displayName: true,
                        userName: true,
                        image: true,
                        companyProfile: { select: { email: true } },
                    },
                },
                buyer: { select: { id: true, email: true, displayName: true, userName: true, image: true } },
            },
        });

        if (!order) throw new NotFoundException('Order not found');

        const cancellableStatuses = new Set<OrderStatus>([
            OrderStatus.PENDING,
            OrderStatus.CONFIRMED,
            OrderStatus.PROCESSING,
        ]);
        if (!cancellableStatuses.has(order.orderStatus)) {
            throw new BadRequestException(
                `Order cannot be cancelled in status ${order.orderStatus}. Only unshipped orders can be cancelled.`,
            );
        }

        if (order.transferStatus === TransferStatus.RELEASED) {
            throw new BadRequestException('Order payout already released; cannot cancel.');
        }

        let refundId: string | null = null;
        let refundStatus = 'NONE';
        const totalMinor = this.toMinor(order.total);

        // Process refund through payment gateway if order was PAID
        if (order.paymentStatus === PaymentStatus.PAID && order.payment?.paymentIntentId && totalMinor > 0) {
            const provider = (order.payment.provider || '').toUpperCase();
            try {
                if (provider === 'PAGBANK') {
                    const pagbankRes = await this.pagBankService.refundCharge({
                        orderId: order.payment.paymentIntentId,
                        amountMinor: totalMinor,
                        reason: reason || `${cancelledBy.toLowerCase()}_cancelled`,
                    });
                    refundId = pagbankRes.refundId || order.payment.paymentIntentId;
                    refundStatus = 'REFUNDED';
                } else {
                    const stripeRefund = await this.stripe.refunds.create({
                        payment_intent: order.payment.paymentIntentId,
                        amount: totalMinor,
                        metadata: {
                            orderId: order.id,
                            orderNumber: order.orderNumber,
                            cancelledBy,
                            reason: reason || `${cancelledBy.toLowerCase()}_cancelled`,
                        },
                    });
                    refundId = stripeRefund.id;
                    refundStatus = 'REFUNDED';
                }
            } catch (refundError: any) {
                console.error(`Refund failed for order ${order.id}:`, refundError);
                throw new BadRequestException(
                    `Payment refund failed: ${refundError?.message || 'Payment provider error'}`,
                );
            }
        }

        const now = new Date();

        await this.prisma.$transaction(async (tx) => {
            // 1. Update Order
            await tx.order.update({
                where: { id: order.id },
                data: {
                    orderStatus: OrderStatus.CANCELLED,
                    cancellationStatus: CancellationStatus.APPROVED,
                    paymentStatus:
                        order.paymentStatus === PaymentStatus.PAID ? PaymentStatus.REFUNDED : order.paymentStatus,
                    transferStatus: TransferStatus.FROZEN,
                    cancellationReason: reason || `Cancelled by ${cancelledBy.toLowerCase()}`,
                    cancelledBy,
                    cancellationAgreedAt: now,
                    cancellationRespondedAt: now,
                    refundId,
                    refundAmount: order.paymentStatus === PaymentStatus.PAID ? order.total : 0,
                    refundedAt: refundStatus === 'REFUNDED' ? now : null,
                    refundStatus,
                },
            });

            // 2. Reverse seller pending balance in wallet
            if (order.sellerAmountMinor && order.sellerAmountMinor > 0) {
                const sellerProvider =
                    (order.seller?.paymentProvider || '').toUpperCase() === 'PAGBANK' ? 'PAGBANK' : 'STRIPE';
                await this.walletService.reversePendingCredit(
                    {
                        userId: order.sellerId,
                        amountMinor: order.sellerAmountMinor,
                        currency: order.payment?.currency || 'usd',
                        provider: sellerProvider,
                        source: 'MARKETPLACE',
                        refType: 'ORDER',
                        refId: order.id,
                        note: `Reversed pending balance for cancelled order #${order.orderNumber}`,
                    },
                    tx,
                );
            }

            // 3. Restock inventory
            if (restock) {
                for (const item of order.items) {
                    await tx.closetItems.update({
                        where: { id: item.productId },
                        data: {
                            quantity: { increment: item.quantity },
                            soldCount: { decrement: item.quantity },
                        },
                    });
                }
            }

            // 3b. Reverse shop platform points awarded to buyer if any
            const pointAward = await tx.shopRewardPointsAward.findUnique({
                where: { orderId: order.id },
            });
            if (pointAward && pointAward.points > 0) {
                const buyer = await tx.user.findUnique({
                    where: { id: order.buyerId },
                    select: { shopPlatformPoints: true, totalPlatformPoints: true },
                });
                if (buyer) {
                    const newShopPoints = Math.max(0, (buyer.shopPlatformPoints ?? 0) - pointAward.points);
                    const newTotalPoints = Math.max(0, (buyer.totalPlatformPoints ?? 0) - pointAward.points);
                    await tx.user.update({
                        where: { id: order.buyerId },
                        data: {
                            shopPlatformPoints: newShopPoints,
                            totalPlatformPoints: newTotalPoints,
                        },
                    });
                }
                await tx.shopRewardPointsAward.delete({
                    where: { id: pointAward.id },
                });
            }

            // 4. Update MarketplacePayments status if applicable
            if (order.paymentId) {
                const remainingUncancelled = await tx.order.count({
                    where: {
                        paymentId: order.paymentId,
                        id: { not: order.id },
                        orderStatus: { not: OrderStatus.CANCELLED },
                    },
                });

                if (remainingUncancelled === 0) {
                    await tx.marketPlacePayments.update({
                        where: { id: order.paymentId },
                        data: {
                            status: order.paymentStatus === PaymentStatus.PAID ? 'REFUNDED' : 'CANCELLED',
                        },
                    });
                }
            }
        });

        // 5. System message in closet chat
        try {
            await this.closetChatService.sendOrderCancelledMessage({
                orderId: order.id,
                cancelledBy: cancelledBy === 'SELLER' ? 'SELLER' : 'BUYER',
                reason,
                refundAmount: order.paymentStatus === PaymentStatus.PAID ? order.total : undefined,
            });
        } catch (chatErr) {
            console.error('Failed to post cancel message to closet chat:', chatErr);
        }

        // 6. Emails
        if (order.paymentStatus === PaymentStatus.PAID) {
            await this.sendCancellationEmailToBuyer({
                orderId: order.id,
                cancelledBy,
                reason,
                refundAmount: order.total,
            });
        }
        await this.sendCancellationEmailToSeller({
            orderId: order.id,
            cancelledBy,
            reason,
        });

        // Update existing notification records for this order to cancelled status
        await this.notificationService.updateOrderNotificationsCancelStatus(order.id, true);

        // 7. Push / in-app notifications
        const notificationTarget = cancelledBy === 'BUYER' ? order.sellerId : order.buyerId;
        const whoStr = cancelledBy === 'BUYER' ? 'Buyer' : 'Seller';
        const refundAmount = order.paymentStatus === PaymentStatus.PAID ? order.total : null;
        const refundStr = refundAmount != null ? ` A full refund of $${refundAmount.toFixed(2)} has been issued.` : '';
        const reasonStr = reason ? `\nReason: ${reason}` : '';
        const cancelNotificationBody = `❌ Order #${order.orderNumber} was cancelled by ${whoStr}.${refundStr}${reasonStr}`;

        const firstItem = order.items?.[0];
        const itemImage = firstItem?.productImage || '';
        const itemName = firstItem?.productName || '';
        const totalPrice = String(order.total ?? 0);
        const itemPrice = firstItem?.price !== undefined ? String(firstItem.price) : '0';
        const actorAvatar = cancelledBy === 'BUYER' ? (order.buyer?.image || '') : (order.seller?.image || '');
        const actorName = cancelledBy === 'BUYER'
            ? (order.buyer?.displayName || order.buyer?.userName || 'Buyer')
            : (order.seller?.displayName || order.seller?.userName || 'Seller');

        await this.notificationService.sendNotificationToUser(
            notificationTarget,
            'Order Cancelled',
            cancelNotificationBody,
            {
                type: 'marketplace_order_cancelled',
                orderId: order.id,
                orderNumber: order.orderNumber,
                cancelledBy,
                reason: reason || `Cancelled by ${cancelledBy.toLowerCase()}`,
                image: itemImage,
                productImage: itemImage,
                name: itemName || actorName,
                productName: itemName,
                itemName: itemName,
                price: totalPrice,
                total: totalPrice,
                itemPrice: itemPrice,
                avatar: actorAvatar,
                buyerName: order.buyer?.displayName || order.buyer?.userName || '',
                sellerName: order.seller?.displayName || order.seller?.userName || '',
                cancellationStatus: 'APPROVED',
                isCancellationPending: false,
                isCancellationApproved: true,
                isCancellationDeclined: false,
                iscancel: true,
                isCancel: true,
                isCancelled: true,
            },
        );

        return {
            success: true,
            message: 'Order cancelled and full refund processed successfully',
            orderId: order.id,
            orderNumber: order.orderNumber,
            orderStatus: OrderStatus.CANCELLED,
            paymentStatus:
                order.paymentStatus === PaymentStatus.PAID ? PaymentStatus.REFUNDED : order.paymentStatus,
            refundId,
            refundAmount: order.paymentStatus === PaymentStatus.PAID ? order.total : 0,
            refundTimeline: '5-10 business days for card, within 24h for PIX',
            cancelledBy,
            cancellationReason: reason || `Cancelled by ${cancelledBy.toLowerCase()}`,
        };
    }

    async cancelOrder(userId: string, orderId: string, reason?: string) {
        if (!userId) throw new UnauthorizedException('User not authenticated');

        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: {
                seller: { select: { id: true, userName: true, displayName: true, image: true } },
                buyer: { select: { id: true, userName: true, displayName: true, image: true } },
                items: {
                    select: {
                        id: true,
                        productName: true,
                        productImage: true,
                        price: true,
                        quantity: true,
                        subtotal: true,
                    },
                },
            },
        });

        if (!order) throw new NotFoundException('Order not found');
        if (order.buyerId !== userId) throw new UnauthorizedException('Unauthorized');

        if (
            order.orderStatus === OrderStatus.SHIPPED ||
            order.orderStatus === OrderStatus.DELIVERED ||
            order.shippingStatus === ShippingStatus.IN_TRANSIT ||
            order.shippingStatus === ShippingStatus.OUT_FOR_DELIVERY ||
            order.shippingStatus === ShippingStatus.DELIVERED
        ) {
            throw new BadRequestException(
                'This order has already been shipped/delivered and cannot be cancelled by the buyer.',
            );
        }

        const cancellableStatuses = new Set<OrderStatus>([
            OrderStatus.PENDING,
            OrderStatus.CONFIRMED,
            OrderStatus.PROCESSING,
        ]);
        if (!cancellableStatuses.has(order.orderStatus)) {
            throw new BadRequestException(
                `Order cannot be cancelled in status ${order.orderStatus}. Only unshipped orders can have cancellation requested.`,
            );
        }

        if (order.cancellationStatus === CancellationStatus.REQUESTED) {
            throw new BadRequestException(
                'A cancellation request for this order is already pending seller review.',
            );
        }

        if (order.cancellationStatus === CancellationStatus.APPROVED || order.orderStatus === OrderStatus.CANCELLED) {
            throw new BadRequestException('This order is already cancelled.');
        }

        const now = new Date();
        const updatedOrder = await this.prisma.order.update({
            where: { id: order.id },
            data: {
                cancellationStatus: CancellationStatus.REQUESTED,
                cancellationReason: reason || 'Cancelled by buyer',
                cancellationRequestedAt: now,
                cancelledBy: 'BUYER',
            },
        });

        // Send email to buyer
        await this.sendCancellationRequestEmailToBuyer({
            orderId: order.id,
            reason: reason || 'Cancelled by buyer',
        });

        // Send email to seller
        await this.sendCancellationRequestEmailToSeller({
            orderId: order.id,
            reason: reason || 'Cancelled by buyer',
        });

        // Send chat message in closet-chat
        try {
            await this.closetChatService.sendCancellationRequestedMessage({
                orderId: order.id,
                reason,
            });
        } catch (chatErr) {
            console.error('Failed to post cancellation request message to closet chat:', chatErr);
        }

        const firstItem = order.items?.[0];
        const buyerUsername = order.buyer?.userName || order.buyer?.displayName || 'Buyer';
        const buyerName = order.buyer?.displayName || order.buyer?.userName || 'Buyer';
        const buyerAvatar = order.buyer?.image || '';
        const itemImage = firstItem?.productImage || '';
        const itemName = firstItem?.productName || '';
        const totalPrice = String(order.total ?? 0);
        const itemPrice = firstItem?.price !== undefined ? String(firstItem.price) : '0';

        const reasonStr = reason ? `\nReason: ${reason}` : '';
        const reqNotificationBody = `⚠️ ${buyerUsername} requested to cancel Order #${order.orderNumber}.${reasonStr}\nPlease review and approve or decline in your seller dashboard.`;

        // Send in-app notification to seller
        await this.notificationService.sendNotificationToUser(
            order.sellerId,
            'Cancellation Requested',
            reqNotificationBody,
            {
                type: 'marketplace_cancellation_requested',
                orderId: order.id,
                orderNumber: order.orderNumber,
                cancelledBy: 'BUYER',
                reason: reason || 'Cancelled by buyer',
                image: itemImage,
                productImage: itemImage,
                name: itemName || buyerName,
                productName: itemName,
                itemName: itemName,
                price: totalPrice,
                total: totalPrice,
                itemPrice: itemPrice,
                avatar: buyerAvatar,
                buyerAvatar: buyerAvatar,
                buyerImage: buyerAvatar,
                buyerName: buyerName,
                buyerUserName: order.buyer?.userName || '',
                buyerDisplayName: order.buyer?.displayName || '',
                cancellationStatus: 'REQUESTED',
                isCancellationPending: true,
                isCancellationApproved: false,
                isCancellationDeclined: false,
                iscancel: false,
                isCancel: false,
                isCancelled: false,
            },
        );

        return {
            success: true,
            message: 'Cancellation request submitted successfully. Email notifications have been sent and the request is awaiting seller review.',
            orderId: updatedOrder.id,
            orderNumber: updatedOrder.orderNumber,
            orderStatus: updatedOrder.orderStatus,
            cancellationStatus: updatedOrder.cancellationStatus,
            cancellationReason: updatedOrder.cancellationReason,
            cancellationRequestedAt: updatedOrder.cancellationRequestedAt,
            refundAmount: order.paymentStatus === PaymentStatus.PAID ? order.total : 0,
        };
    }

    /**
     * Buyer confirms receipt during/after the protection window → release payout immediately.
     */
    async confirmOrderReceived(userId: string, orderId: string) {
        if (!userId) throw new UnauthorizedException('User not authenticated');

        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            select: {
                id: true,
                buyerId: true,
                orderStatus: true,
                transferStatus: true,
                disputeStatus: true,
                orderNumber: true,
            },
        });

        if (!order) throw new NotFoundException('Order not found');
        if (order.buyerId !== userId) throw new UnauthorizedException('Unauthorized');
        if (order.orderStatus !== OrderStatus.DELIVERED) {
            throw new BadRequestException('Order must be delivered before confirming receipt');
        }
        if (order.disputeStatus === DisputeStatus.OPEN) {
            throw new BadRequestException('Cannot confirm receipt while a dispute is open');
        }
        if (order.transferStatus === TransferStatus.RELEASED) {
            return {
                message: 'Payout already released',
                orderId: order.id,
                transferStatus: order.transferStatus,
            };
        }
        if (order.transferStatus === TransferStatus.FROZEN) {
            throw new BadRequestException('Payout is frozen; contact support');
        }

        // Ensure payout is scheduled, then release without waiting for the full 48h window.
        if (order.transferStatus === TransferStatus.PENDING) {
            await this.orderPayoutService.scheduleProtectionWindow(order.id);
        }

        const result = await this.orderPayoutService.releaseIfEligible(order.id, {
            skipProtectionCheck: true,
        });

        if (!result.released) {
            throw new BadRequestException(result.reason || 'Unable to release payout');
        }

        return {
            message: 'Receipt confirmed. Seller payout released.',
            orderNumber: order.orderNumber,
            ...result,
        };
    }

    /**
     * Buyer reports a delivery problem → freeze seller payout.
     */
    async reportOrderProblem(userId: string, orderId: string, reason?: string) {
        if (!userId) throw new UnauthorizedException('User not authenticated');

        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            select: {
                id: true,
                buyerId: true,
                orderStatus: true,
                transferStatus: true,
                disputeStatus: true,
                orderNumber: true,
            },
        });

        if (!order) throw new NotFoundException('Order not found');
        if (order.buyerId !== userId) throw new UnauthorizedException('Unauthorized');
        if (order.orderStatus !== OrderStatus.DELIVERED) {
            throw new BadRequestException('You can only report a problem after delivery');
        }
        if (order.transferStatus === TransferStatus.RELEASED) {
            throw new BadRequestException('Payout already released; contact support for chargebacks/disputes');
        }
        if (order.disputeStatus === DisputeStatus.OPEN) {
            return {
                message: 'Dispute already open',
                orderId: order.id,
                disputeStatus: order.disputeStatus,
                transferStatus: order.transferStatus,
            };
        }

        const frozen = await this.orderPayoutService.freezePayout(order.id, reason);

        return {
            message: 'Problem reported. Seller payout has been frozen.',
            orderId: frozen.id,
            orderNumber: order.orderNumber,
            transferStatus: frozen.transferStatus,
            disputeStatus: frozen.disputeStatus,
        };
    }
}
