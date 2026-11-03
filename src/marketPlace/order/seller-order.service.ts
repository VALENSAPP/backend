import {
    BadRequestException,
    ForbiddenException,
    Inject,
    Injectable,
    NotFoundException,
    UnauthorizedException,
    forwardRef,
} from '@nestjs/common';
import { CancellationStatus, CartItemShippingChoice, OrderStatus, PaymentStatus, Prisma, ShippingStatus, TransferStatus } from '@prisma/client';
import * as sgMail from '@sendgrid/mail';
import { MailService } from '../../common/mail/mail.service';
import { formatPickupAvailableHours } from '../../common/pickup-hours.util';
import { NotificationService } from '../../notification/notification.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ClosetChatService } from '../closet-chat/closet-chat.service';
import { ShippingService } from '../shipping/shipping.service';
import { SellerOrderListQueryDto, SellerOrderShippingType } from './dto/seller-order-list-query.dto';
import { ShipOrderDto } from './dto/ship-order.dto';
import { SellerCancelOrderDto } from './dto/seller-cancel-order.dto';
import { ApproveCancellationDto, DeclineCancellationDto } from './dto/seller-respond-cancellation.dto';
import { OrderPayoutService } from './order-payout.service';
import { OrderService } from './order.service';

@Injectable()
export class SellerOrderService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly notificationService: NotificationService,
        private readonly orderPayoutService: OrderPayoutService,
        private readonly mailService: MailService,
        private readonly closetChatService: ClosetChatService,
        @Inject(forwardRef(() => OrderService))
        private readonly orderService: OrderService,
        @Inject(forwardRef(() => ShippingService))
        private readonly shippingService: ShippingService,
    ) { }

    private assertSellerUserId(userId?: string): string {
        if (!userId) throw new UnauthorizedException('User not authenticated');
        return userId;
    }

    private async getOwnedOrderOrThrow(sellerId: string, orderId: string) {
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: {
                seller: { select: { id: true, userName: true, displayName: true, email: true, image: true } },
                buyer: { select: { id: true, userName: true, displayName: true, email: true, image: true } },
                address: true,
                payment: true,
                items: {
                    include: {
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
            },
        });

        if (!order) throw new NotFoundException('Order not found');
        if (order.sellerId !== sellerId) throw new ForbiddenException('Forbidden: you do not own this order');

        return order;
    }

    private ensureTransition(current: OrderStatus, expectedCurrent: OrderStatus, next: OrderStatus) {
        if (current !== expectedCurrent) {
            throw new BadRequestException(
                `Invalid status transition. Allowed: ${expectedCurrent} -> ${next}. Current status: ${current}`,
            );
        }
    }

    private async sendDeliveryOtpEmail(to: string, buyerName: string, orderNumber: string, otp: string, expiresInMinutes: number) {
        try {
            sgMail.setApiKey(process.env.SENDGRID_API_KEY!);

            const appRedirectUrl =
                process.env.APP_REDIRECT_URL ||
                (process.env.BASE_URL ? `${process.env.BASE_URL.replace(/\/$/, '')}/open-app` : '') ||
                (process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL.replace(/\/$/, '')}/open-app` : '') ||
                'https://api.valens.app/open-app';
            const logoUrl =
                process.env.APP_LOGO_URL ||
                'https://valens-s3-2026.s3.us-west-1.amazonaws.com/assets/valens-logo.png';

            const htmlContent = `
<div style="max-width:580px;margin:30px auto;background:#ffffff;border-radius:16px;padding:30px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;border:1px solid #edf2f7;box-shadow:0 4px 20px rgba(0,0,0,0.06);">
    <div style="text-align:center;margin-bottom:18px;">
        <a href="${appRedirectUrl}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;display:inline-block;">
            <img src="${logoUrl}" alt="Valens" style="max-width:220px;height:auto;display:block;margin:0 auto;border:0;" />
        </a>
    </div>
    <div style="border-top:3px dotted #c4b5fd;margin:0 0 24px 0;"></div>
    <div style="color:#374151;font-size:15px;line-height:1.65;">
        <p style="margin:0 0 14px 0;font-size:16px;color:#1f2937;">Hi <strong>${buyerName}</strong>,</p>
        <p style="margin:0 0 14px 0;">Your one-time code (OTP) to confirm handover for order <strong>#${orderNumber}</strong> is:</p>
        <div style="background:#f5f3ff;border:1px solid #ddd6fe;border-radius:12px;padding:20px;text-align:center;margin:20px 0;">
            <div style="font-size:36px;font-weight:800;letter-spacing:6px;color:#7c3aed;line-height:1.2;">${otp}</div>
            <div style="font-size:12px;font-weight:700;letter-spacing:1px;color:#6d28d9;margin-top:6px;">DELIVERY CONFIRMATION OTP</div>
        </div>
        <p style="margin:0 0 10px 0;font-size:14px;color:#4b5563;">This OTP will expire in <strong>${expiresInMinutes} minutes</strong> for security reasons.</p>
        <p style="margin:0 0 14px 0;font-size:14px;color:#dc2626;font-weight:600;">⚠️ Please share this OTP with the seller ONLY after you have physically received and inspected your item.</p>
    </div>
    <div style="margin-top:28px;padding-top:20px;border-top:1px solid #f3f4f6;font-size:12px;color:#9ca3af;text-align:center;">
        <p style="margin:4px 0;color:#6b7280;"><a href="${appRedirectUrl}" target="_blank" rel="noopener noreferrer" style="color:#6b7280;text-decoration:none;"><strong>Valens Technologies INC.</strong></a></p>
        <p style="margin:4px 0;">&copy; 2026 Valens Technologies INC. All rights reserved.</p>
    </div>
</div>`;

            await sgMail.send({
                to,
                from: process.env.SENDGRID_FROM_EMAIL!,
                subject: `Delivery OTP for order ${orderNumber}`,
                text: `Hi ${buyerName}, your OTP to confirm handover for order ${orderNumber} is ${otp}. This OTP is valid for ${expiresInMinutes} minutes. Share this OTP with seller only after receiving your product.\n\nValens Technologies INC.`,
                html: htmlContent,
            });
        } catch (error) {
            console.error('SendGrid error while sending delivery OTP:', error);
            throw new BadRequestException('Failed to send delivery OTP email');
        }
    }

    async sendDeliveryOtp(userId: string | undefined, orderId: string, expiresInMinutes = 10) {
        const sellerId = this.assertSellerUserId(userId);
        const order = await this.getOwnedOrderOrThrow(sellerId, orderId);

        this.ensureTransition(order.orderStatus, OrderStatus.PROCESSING, OrderStatus.DELIVERED);

        if (!order.buyer?.email) {
            throw new BadRequestException('Buyer email is not available for this order');
        }

        const ttlMinutes = Math.min(Math.max(expiresInMinutes, 1), 30);
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const otpExpiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

        await this.prisma.order.update({
            where: { id: order.id },
            data: {
                deliveryOtp: otp,
                deliveryOtpExpiresAt: otpExpiresAt,
                deliveryOtpSentAt: new Date(),
            },
        });

        const buyerName = order.buyer.displayName || order.buyer.userName || 'Buyer';
        await this.sendDeliveryOtpEmail(order.buyer.email, buyerName, order.orderNumber, otp, ttlMinutes);

        return {
            message: 'Delivery OTP sent to buyer email successfully',
            orderId: order.id,
            orderStatus: order.orderStatus,
            otpExpiresAt,
        };
    }

    async getSellerOrders(userId: string | undefined, query: SellerOrderListQueryDto) {
        const sellerId = this.assertSellerUserId(userId);

        const page = query.page ?? 1;
        const limit = query.limit ?? 10;
        const skip = (page - 1) * limit;
        const shippingType = query.shippingType ?? SellerOrderShippingType.ALL;

        const shippingTypeWhere: Prisma.OrderWhereInput =
            shippingType === SellerOrderShippingType.LOCAL_PICKUP
                ? { items: { some: { selectedShippingChoice: CartItemShippingChoice.local_pick } } }
                : shippingType === SellerOrderShippingType.SHIP_TO_DELIVER
                    ? { items: { some: { selectedShippingChoice: CartItemShippingChoice.ship_items } } }
                    : {};

        const selectFields = {
            id: true,
            orderNumber: true,
            total: true,
            orderStatus: true,
            paymentStatus: true,
            cancellationStatus: true,
            cancellationReason: true,
            cancellationDeclineReason: true,
            cancellationRequestedAt: true,
            cancellationRespondedAt: true,
            refundAmount: true,
            refundStatus: true,
            isViewedBySeller: true,
            sellerViewedAt: true,
            createdAt: true,
            buyer: {
                select: {
                    id: true,
                    userName: true,
                    displayName: true,
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
        };

        const isCancelledQuery = query.status === OrderStatus.CANCELLED;
        let total = 0;
        let orders: any[] = [];

        if (isCancelledQuery) {
            // Include both pending cancellation requests and already-cancelled orders in Cancel tab
            const pendingRequestWhere: Prisma.OrderWhereInput = {
                sellerId,
                cancellationStatus: CancellationStatus.REQUESTED,
                ...shippingTypeWhere,
            };

            const confirmedCancelledWhere: Prisma.OrderWhereInput = {
                sellerId,
                orderStatus: OrderStatus.CANCELLED,
                cancellationStatus: { not: CancellationStatus.REQUESTED },
                ...shippingTypeWhere,
            };

            const [pendingCount, cancelledCount] = await Promise.all([
                this.prisma.order.count({ where: pendingRequestWhere }),
                this.prisma.order.count({ where: confirmedCancelledWhere }),
            ]);

            total = pendingCount + cancelledCount;

            // Prioritize pending cancellation requests at the top of the "Cancel" tab
            if (skip < pendingCount) {
                const pendingOrders = await this.prisma.order.findMany({
                    where: pendingRequestWhere,
                    skip,
                    take: limit,
                    orderBy: { createdAt: 'desc' },
                    select: selectFields,
                });
                orders.push(...pendingOrders);

                const remainingLimit = limit - pendingOrders.length;
                if (remainingLimit > 0) {
                    const cancelledOrders = await this.prisma.order.findMany({
                        where: confirmedCancelledWhere,
                        skip: 0,
                        take: remainingLimit,
                        orderBy: { createdAt: 'desc' },
                        select: selectFields,
                    });
                    orders.push(...cancelledOrders);
                }
            } else {
                const adjustedSkip = skip - pendingCount;
                orders = await this.prisma.order.findMany({
                    where: confirmedCancelledWhere,
                    skip: adjustedSkip,
                    take: limit,
                    orderBy: { createdAt: 'desc' },
                    select: selectFields,
                });
            }
        } else {
            const where: Prisma.OrderWhereInput = {
                sellerId,
                ...(query.status
                    ? {
                        orderStatus: query.status,
                        ...(query.cancellationStatus
                            ? {}
                            : { cancellationStatus: { not: CancellationStatus.REQUESTED } }),
                    }
                    : {}),
                ...(query.cancellationStatus ? { cancellationStatus: query.cancellationStatus } : {}),
                ...shippingTypeWhere,
            };

            const [countResult, ordersResult] = await this.prisma.$transaction([
                this.prisma.order.count({ where }),
                this.prisma.order.findMany({
                    where,
                    skip,
                    take: limit,
                    orderBy: { createdAt: 'desc' },
                    select: selectFields,
                }),
            ]);

            total = countResult;
            orders = ordersResult;
        }

        return {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
            data: orders.map((order) => {
                const isLocalPickupOrder =
                    order.items.length > 0 &&
                    order.items.every((item: any) => item.selectedShippingChoice === CartItemShippingChoice.local_pick);

                return {
                    id: order.id,
                    orderNumber: order.orderNumber,
                    buyerId: order.buyer.id,
                    buyerName: order.buyer.displayName || order.buyer.userName || 'Unknown Buyer',
                    totalAmount: order.total,
                    isViewedBySeller: order.isViewedBySeller,
                    sellerViewedAt: order.sellerViewedAt,
                    orderStatus:
                        isLocalPickupOrder && order.orderStatus === OrderStatus.PENDING
                            ? 'localpickup'
                            : order.orderStatus,
                    paymentStatus: order.paymentStatus,
                    cancellationStatus: order.cancellationStatus,
                    cancellationReason: order.cancellationReason,
                    cancellationDeclineReason: order.cancellationDeclineReason,
                    cancellationRequestedAt: order.cancellationRequestedAt,
                    cancellationRespondedAt: order.cancellationRespondedAt,
                    isCancellationPending: order.cancellationStatus === CancellationStatus.REQUESTED,
                    isCancellationApproved: order.cancellationStatus === CancellationStatus.APPROVED,
                    canSellerApproveCancellation: order.cancellationStatus === CancellationStatus.REQUESTED,
                    refundAmount: order.refundAmount,
                    refundStatus: order.refundStatus,
                    createdAt: order.createdAt,
                    totalItemCount: order.items.length,
                    items: order.items.map((item: any) => ({
                        id: item.id,
                        productId: item.productId,
                        productName: item.productName,
                        productImage: item.productImage,
                        quantity: item.quantity,
                        price: item.price,
                        subtotal: item.subtotal,
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
            }),
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        };
    }

    async getUnviewedOrderIds(userId: string | undefined) {
        const sellerId = this.assertSellerUserId(userId);

        const unviewedOrders = await this.prisma.order.findMany({
            where: {
                sellerId,
                isViewedBySeller: false,
            },
            select: {
                id: true,
                orderNumber: true,
                createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
        });

        return {
            success: true,
            count: unviewedOrders.length,
            unviewedOrderIds: unviewedOrders.map((o) => o.id),
            orders: unviewedOrders,
        };
    }

    async markAllOrdersAsViewed(userId: string | undefined) {
        const sellerId = this.assertSellerUserId(userId);

        const result = await this.prisma.order.updateMany({
            where: {
                sellerId,
                isViewedBySeller: false,
            },
            data: {
                isViewedBySeller: true,
                sellerViewedAt: new Date(),
            },
        });

        return {
            success: true,
            message: 'All orders marked as viewed successfully',
            updatedCount: result.count,
        };
    }

    async markOrderAsViewed(userId: string | undefined, orderId: string) {
        const sellerId = this.assertSellerUserId(userId);
        const order = await this.getOwnedOrderOrThrow(sellerId, orderId);

        if (!order.isViewedBySeller) {
            await this.prisma.order.update({
                where: { id: order.id },
                data: {
                    isViewedBySeller: true,
                    sellerViewedAt: new Date(),
                },
            });
        }

        return {
            success: true,
            message: 'Order marked as viewed successfully',
            orderId: order.id,
            isViewedBySeller: true,
        };
    }

    async getSellerOrderDetails(userId: string | undefined, orderId: string) {
        const sellerId = this.assertSellerUserId(userId);
        const order = await this.getOwnedOrderOrThrow(sellerId, orderId);

        // Auto mark as viewed when seller opens full order details if not already viewed
        if (!order.isViewedBySeller) {
            await this.prisma.order.update({
                where: { id: order.id },
                data: {
                    isViewedBySeller: true,
                    sellerViewedAt: new Date(),
                },
            });
            order.isViewedBySeller = true;
            order.sellerViewedAt = new Date();
        }

        return order;
    }

    private async sendLocalPickupReadyEmail(order: any, sellerUsername: string) {
        try {
            if (!order.buyer?.email) return;

            const firstItem = order.items?.[0];
            const pickupAddress = firstItem?.pickupAddress || firstItem?.product?.pickupAddress;
            const pickupHoursRaw = firstItem?.pickupAvailableHours || firstItem?.product?.pickupAvailableHours;
            const pickupCity = firstItem?.product?.pickUpCity;

            const pickupLocationDisplay = [pickupAddress, pickupCity].filter(Boolean).join(', ');

            const pickupAddressRow = pickupLocationDisplay
                ? `<tr><td style="padding: 5px 0; color: #6b7280; font-size: 14px; font-weight: 500; vertical-align: top;">Pickup Location:</td><td style="padding: 5px 0; color: #111827; font-size: 14px; font-weight: 600; text-align: right;">${pickupLocationDisplay}</td></tr>`
                : '';

            const formattedPickupHours = formatPickupAvailableHours(pickupHoursRaw);
            const formattedPickupHoursHtml = formattedPickupHours
                ? formattedPickupHours.replace(/\n/g, '<br/>')
                : '';

            const pickupHoursRow = formattedPickupHoursHtml
                ? `<tr><td style="padding: 5px 0; color: #6b7280; font-size: 14px; font-weight: 500; vertical-align: top;">Pickup Hours:</td><td style="padding: 5px 0; color: #111827; font-size: 14px; font-weight: 600; text-align: right; line-height: 1.4;">${formattedPickupHoursHtml}</td></tr>`
                : '';

            const appBaseUrl = process.env.APP_BASE_URL || 'https://valensapp.com';
            const orderDetailsLink = `${appBaseUrl}/orders/${order.id}`;
            const chatLink = `${appBaseUrl}/marketplace/chat?orderId=${order.id}`;

            const baseUrl = process.env.BASE_URL || 'https://api.valens.app';
            const sellerProfileUrl = order.seller?.id ? `${baseUrl.replace(/\/$/, '')}/profile/${order.seller.id}` : `${baseUrl}/open-app`;
            const buyerProfileUrl = order.buyer?.id ? `${baseUrl.replace(/\/$/, '')}/profile/${order.buyer.id}` : `${baseUrl}/open-app`;

            const plainText = `Your Order Is Ready for Pickup! 🎉\n\nGood news! ${sellerUsername} is preparing your order and is ready to coordinate the pickup with you.\n\nPlease check the pickup location, date, and time in your order details and arrive at the agreed time.\n\nNeed to make arrangements or have a question? Chat directly with the seller through Valens.`;

            await this.mailService.sendTemplateEmail({
                to: order.buyer.email,
                subject: 'Your Order Is Ready for Pickup! 🎉',
                templateFile: 'local-pickup-order-ready.html',
                replacements: {
                    seller_username: sellerUsername,
                    seller_profile_url: sellerProfileUrl,
                    sellerProfileUrl,
                    buyer_name: order.buyer?.displayName || order.buyer?.userName || 'Valued Customer',
                    buyer_profile_url: buyerProfileUrl,
                    buyerProfileUrl,
                    order_number: order.orderNumber,
                    product_name: firstItem?.productName || firstItem?.product?.name || 'your item',
                    pickup_address_row: pickupAddressRow,
                    pickup_hours_row: pickupHoursRow,
                    order_total: `$${Number(order.total || 0).toFixed(2)}`,
                    order_details_link: orderDetailsLink,
                    chat_link: chatLink,
                },
                text: plainText,
            });
        } catch (error) {
            console.error('Failed to send local pickup ready email to buyer:', error);
        }
    }

    private async sendShipItemsProcessingEmail(order: any, sellerUsername: string) {
        try {
            if (!order.buyer?.email) return;

            const firstItem = order.items?.[0];
            const appBaseUrl = process.env.APP_BASE_URL || 'https://valensapp.com';
            const orderDetailsLink = `${appBaseUrl}/orders/${order.id}`;
            const chatLink = `${appBaseUrl}/marketplace/chat?orderId=${order.id}`;

            const plainText = `Your Order Is Being Prepared for Shipping! 📦\n\nGood news! ${sellerUsername} is preparing your order for shipment.\n\nOnce your order has been shipped, you’ll receive a notification with the carrier and tracking number so you can follow your package until delivery.\n\nHave a question about your order? Chat directly with the seller through Valens.`;

            const baseUrl = process.env.BASE_URL || 'https://api.valens.app';
            const sellerProfileUrl = order.seller?.id ? `${baseUrl.replace(/\/$/, '')}/profile/${order.seller.id}` : `${baseUrl}/open-app`;

            await this.mailService.sendTemplateEmail({
                to: order.buyer.email,
                subject: 'Your Order Is Being Prepared for Shipping! 📦',
                templateFile: 'ship-items-order-processing.html',
                replacements: {
                    seller_username: sellerUsername,
                    seller_profile_url: sellerProfileUrl,
                    sellerProfileUrl,
                    order_number: order.orderNumber,
                    product_name: firstItem?.productName || firstItem?.product?.name || 'your item',
                    order_total: `$${Number(order.total || 0).toFixed(2)}`,
                    order_details_link: orderDetailsLink,
                    chat_link: chatLink,
                },
                text: plainText,
            });
        } catch (error) {
            console.error('Failed to send ship-items processing email to buyer:', error);
        }
    }

    private async sendLocalPickupCompletedSellerEmail(order: any) {
        try {
            if (!order.seller?.email) return;

            const firstItem = order.items?.[0];
            const sellerName = order.seller?.displayName || order.seller?.userName || 'Seller';
            const buyerName = order.buyer?.displayName || order.buyer?.userName || 'Buyer';
            const productName = firstItem?.productName || firstItem?.product?.name || 'your item';
            const orderTotal = `$${Number(order.total || 0).toFixed(2)}`;

            const appBaseUrl = process.env.APP_BASE_URL || 'https://valensapp.com';
            const orderDetailsLink = `${appBaseUrl}/orders/${order.id}`;

            const plainText = `Your Valens pickup was completed successfully\n\nCongratulations on your sale! Your buyer successfully picked up the item at the scheduled location.\nThe transaction is now complete.\nThank you for selling on Valens.`;

            const baseUrl = process.env.BASE_URL || 'https://api.valens.app';
            const sellerProfileUrl = order.seller?.id ? `${baseUrl.replace(/\/$/, '')}/profile/${order.seller.id}` : `${baseUrl}/open-app`;
            const buyerProfileUrl = order.buyer?.id ? `${baseUrl.replace(/\/$/, '')}/profile/${order.buyer.id}` : `${baseUrl}/open-app`;

            await this.mailService.sendTemplateEmail({
                to: order.seller.email,
                subject: 'Your Valens pickup was completed successfully',
                templateFile: 'local-pickup-completed-seller.html',
                replacements: {
                    seller_name: sellerName,
                    seller_profile_url: sellerProfileUrl,
                    sellerProfileUrl,
                    buyer_name: buyerName,
                    buyer_profile_url: buyerProfileUrl,
                    buyerProfileUrl,
                    order_number: order.orderNumber,
                    product_name: productName,
                    order_total: orderTotal,
                    order_details_link: orderDetailsLink,
                },
                text: plainText,
            });
        } catch (error) {
            console.error('Failed to send local pickup completed email to seller:', error);
        }
    }

    async markOrderProcessing(userId: string | undefined, orderId: string) {
        const sellerId = this.assertSellerUserId(userId);
        const order = await this.getOwnedOrderOrThrow(sellerId, orderId);

        this.ensureTransition(order.orderStatus, OrderStatus.PENDING, OrderStatus.PROCESSING);

        const updatedOrder = await this.prisma.order.update({
            where: { id: order.id },
            data: { orderStatus: OrderStatus.PROCESSING },
            select: { id: true, orderStatus: true, buyerId: true, orderNumber: true },
        });

        const isLocalPickupOrder =
            order.items.length > 0 &&
            order.items.some((item) => item.selectedShippingChoice === CartItemShippingChoice.local_pick);

        const sellerUsername = (order as any).seller?.userName || (order as any).seller?.displayName || 'Seller';

        const firstItem = order.items?.[0];
        const itemImage = firstItem?.productImage || firstItem?.product?.images?.[0] || '';
        const itemName = firstItem?.productName || firstItem?.product?.name || '';
        const totalPrice = String(order.total ?? 0);
        const itemPrice = firstItem?.price !== undefined ? String(firstItem.price) : '0';
        const sellerAvatar = order.seller?.image || '';

        if (isLocalPickupOrder) {
            // 1. Send closet chat message from seller side to buyer
            try {
                await this.closetChatService.sendLocalPickupProcessingMessage(order.id, sellerUsername);
            } catch (chatError) {
                console.error('Failed to send local pickup processing message to closet chat:', chatError);
            }

            // 2. Send email to buyer
            await this.sendLocalPickupReadyEmail(order, sellerUsername);

            // 3. Send push notification to buyer
            await this.notificationService.sendNotificationToUser(
                updatedOrder.buyerId,
                'Your Order is being prepared! 📦',
                `${sellerUsername} is getting your order ready. Check your pickup details and chat with the seller if you need to coordinate anything.`,
                {
                    type: 'seller_order_processing',
                    orderId: updatedOrder.id,
                    orderNumber: updatedOrder.orderNumber,
                    shippingType: 'local_pickup',
                    image: itemImage,
                    productImage: itemImage,
                    name: itemName,
                    productName: itemName,
                    itemName: itemName,
                    price: totalPrice,
                    total: totalPrice,
                    itemPrice: itemPrice,
                    avatar: sellerAvatar,
                    sellerAvatar: sellerAvatar,
                    sellerName: sellerUsername,
                    iscancel: false,
                    isCancel: false,
                    isCancelled: false,
                },
            );
        } else {
            // 1. Send closet chat message from seller side to buyer
            try {
                await this.closetChatService.sendShipItemsProcessingMessage(order.id, sellerUsername);
            } catch (chatError) {
                console.error('Failed to send ship items processing message to closet chat:', chatError);
            }

            // 2. Send email to buyer
            await this.sendShipItemsProcessingEmail(order, sellerUsername);

            // 3. Send push notification to buyer
            await this.notificationService.sendNotificationToUser(
                updatedOrder.buyerId,
                'Your Order is being prepared! 📦',
                `${sellerUsername} is preparing your order for shipment. We’ll notify you as soon as it ships and your tracking information is available.`,
                {
                    type: 'seller_order_processing',
                    orderId: updatedOrder.id,
                    orderNumber: updatedOrder.orderNumber,
                    shippingType: 'ship_items',
                    image: itemImage,
                    productImage: itemImage,
                    name: itemName,
                    productName: itemName,
                    itemName: itemName,
                    price: totalPrice,
                    total: totalPrice,
                    itemPrice: itemPrice,
                    avatar: sellerAvatar,
                    sellerAvatar: sellerAvatar,
                    sellerName: sellerUsername,
                    iscancel: false,
                    isCancel: false,
                    isCancelled: false,
                },
            );
        }

        return {
            message: 'Order marked as processing successfully',
            orderId: updatedOrder.id,
            orderStatus: updatedOrder.orderStatus,
        };
    }

    async markOrderShipped(userId: string | undefined, orderId: string, dto: ShipOrderDto) {
        const sellerId = this.assertSellerUserId(userId);
        const order = await this.getOwnedOrderOrThrow(sellerId, orderId);

        this.ensureTransition(order.orderStatus, OrderStatus.PROCESSING, OrderStatus.SHIPPED);

        if (order.cancellationStatus === CancellationStatus.REQUESTED) {
            throw new BadRequestException(
                'Cannot mark order as shipped while a buyer cancellation request is pending review. Please approve or decline the cancellation request first.',
            );
        }

        const carrier = dto.carrier.trim();
        const trackingNumber = dto.trackingNumber.trim();
        if (!carrier || !trackingNumber) {
            throw new BadRequestException('carrier and trackingNumber are required');
        }

        // EasyPost when configured; otherwise manual ship proceeds unchanged.
        const trackerResult = await this.shippingService.createTrackerForOrder({
            orderId: order.id,
            carrier,
            trackingNumber,
        });

        const shippingProvider = trackerResult.skipped ? 'MANUAL' : 'EASYPOST';
        const shippingStatus = trackerResult.skipped
            ? ShippingStatus.TRACKING_SUBMITTED
            : trackerResult.shippingStatus;

        const updatedOrder = await this.prisma.order.update({
            where: { id: order.id },
            data: {
                orderStatus: OrderStatus.SHIPPED,
                shippingCarrier: carrier,
                trackingNumber,
                shippingProvider,
                shippingStatus,
                easypostTrackerId: trackerResult.trackerId || null,
                trackingValidatedAt: trackerResult.trackingValidatedAt || null,
                lastTrackingPayload: trackerResult.raw
                    ? (trackerResult.raw as Prisma.InputJsonValue)
                    : undefined,
            },
            select: {
                id: true,
                orderStatus: true,
                buyerId: true,
                orderNumber: true,
                shippingCarrier: true,
                trackingNumber: true,
                shippingStatus: true,
                shippingProvider: true,
                easypostTrackerId: true,
                trackingValidatedAt: true,
            },
        });

        const firstItem = order.items?.[0];
        const itemImage = firstItem?.productImage || firstItem?.product?.images?.[0] || '';
        const itemName = firstItem?.productName || firstItem?.product?.name || '';
        const totalPrice = String(order.total ?? 0);
        const itemPrice = firstItem?.price !== undefined ? String(firstItem.price) : '0';
        const sellerAvatar = order.seller?.image || '';
        const sellerName = order.seller?.displayName || order.seller?.userName || 'Seller';

        await this.notificationService.sendNotificationToUser(
            updatedOrder.buyerId,
            'Order Shipped',
            trackerResult.skipped
                ? 'Your order has been shipped.'
                : 'Your order has been shipped. Tracking was validated with the carrier.',
            {
                type: 'seller_order_shipped',
                orderId: updatedOrder.id,
                orderNumber: updatedOrder.orderNumber,
                carrier: updatedOrder.shippingCarrier || carrier,
                trackingNumber: updatedOrder.trackingNumber || trackingNumber,
                shippingProvider: updatedOrder.shippingProvider || shippingProvider,
                image: itemImage,
                productImage: itemImage,
                name: itemName,
                productName: itemName,
                itemName: itemName,
                price: totalPrice,
                total: totalPrice,
                itemPrice: itemPrice,
                avatar: sellerAvatar,
                sellerAvatar: sellerAvatar,
                sellerName: sellerName,
                iscancel: false,
                isCancel: false,
                isCancelled: false,
            },
        );
        console.log('Notification sent to buyer for order shipped:', updatedOrder.trackingNumber || trackingNumber);
        return {
            message: trackerResult.skipped
                ? 'Order marked as shipped successfully (manual — EasyPost not configured)'
                : 'Order marked as shipped successfully (tracking validated via EasyPost)',
            orderId: updatedOrder.id,
            orderStatus: updatedOrder.orderStatus,
            shippingCarrier: updatedOrder.shippingCarrier,
            trackingNumber: updatedOrder.trackingNumber,
            shippingStatus: updatedOrder.shippingStatus,
            shippingProvider: updatedOrder.shippingProvider,
            easypostTrackerId: updatedOrder.easypostTrackerId,
            trackingValidatedAt: updatedOrder.trackingValidatedAt,
            easypostConfigured: this.shippingService.isConfigured(),

        };
    }

    async markOrderDelivered(userId: string | undefined, orderId: string, otp: string) {
        const sellerId = this.assertSellerUserId(userId);
        const order = await this.getOwnedOrderOrThrow(sellerId, orderId);

        this.ensureTransition(order.orderStatus, OrderStatus.PROCESSING, OrderStatus.DELIVERED);

        if (!order.deliveryOtp || !order.deliveryOtpExpiresAt) {
            throw new BadRequestException('Delivery OTP not found. Please send OTP first.');
        }

        if (order.deliveryOtpExpiresAt < new Date()) {
            throw new BadRequestException('Delivery OTP expired. Please send a new OTP.');
        }

        if (order.deliveryOtp !== otp) {
            throw new BadRequestException('Invalid delivery OTP');
        }

        // Manual deliver / Pickup delivery with OTP
        const updatedOrder = await this.prisma.order.update({
            where: { id: order.id },
            data: {
                orderStatus: OrderStatus.DELIVERED,
                shippingStatus: ShippingStatus.DELIVERED,
                shippingProvider: order.shippingProvider || 'MANUAL',
                deliveredAt: new Date(),
                deliveryOtp: null,
                deliveryOtpExpiresAt: null,
                deliveryOtpSentAt: null,
            },
            select: { id: true, orderStatus: true, buyerId: true, sellerId: true, orderNumber: true, shippingStatus: true },
        });

        // Release funds immediately to seller available wallet balance (no 48h hold for local pickup)
        const payoutResult = await this.orderPayoutService.releaseIfEligible(updatedOrder.id, {
            skipProtectionCheck: true,
            suppressNotification: true,
        });

        const firstItem = order.items?.[0];
        const itemImage = firstItem?.productImage || firstItem?.product?.images?.[0] || '';
        const itemName = firstItem?.productName || firstItem?.product?.name || '';
        const totalPrice = String(order.total ?? 0);
        const itemPrice = firstItem?.price !== undefined ? String(firstItem.price) : '0';
        const sellerAvatar = order.seller?.image || '';
        const sellerName = order.seller?.displayName || order.seller?.userName || 'Seller';
        const buyerAvatar = order.buyer?.image || '';
        const buyerUsername = order.buyer?.userName || order.buyer?.displayName || 'Buyer';
        const buyerName = order.buyer?.displayName || order.buyer?.userName || 'Buyer';

        // 1. Send dedicated pickup completion Push Notification to Seller
        await this.notificationService.sendNotificationToUser(
            updatedOrder.sellerId,
            '🎉 Sale completed!',
            `${buyerUsername} successfully picked up the order! Thank you for selling on Valens!`,
            {
                type: 'seller_pickup_completed',
                orderId: updatedOrder.id,
                orderNumber: updatedOrder.orderNumber,
                image: itemImage,
                productImage: itemImage,
                name: itemName,
                productName: itemName,
                itemName: itemName,
                price: totalPrice,
                total: totalPrice,
                itemPrice: itemPrice,
                avatar: buyerAvatar,
                buyerAvatar: buyerAvatar,
                buyerName: buyerName,
                iscancel: false,
                isCancel: false,
                isCancelled: false,
            },
        );

        // 2. Send dedicated pickup completion Email to Seller
        await this.sendLocalPickupCompletedSellerEmail(order);

        // 3. Send Pickup Handover Confirmation to Buyer
        await this.notificationService.sendNotificationToUser(
            updatedOrder.buyerId,
            '🎉 Pickup Completed!',
            'Your pickup was completed successfully. Thanks for shopping on Valens!',
            {
                type: 'buyer_pickup_completed',
                orderId: updatedOrder.id,
                orderNumber: updatedOrder.orderNumber,
                image: itemImage,
                productImage: itemImage,
                name: itemName,
                productName: itemName,
                itemName: itemName,
                price: totalPrice,
                total: totalPrice,
                itemPrice: itemPrice,
                avatar: sellerAvatar,
                sellerAvatar: sellerAvatar,
                sellerName: sellerName,
                iscancel: false,
                isCancel: false,
                isCancelled: false,
            },
        );

        return {
            message: 'Order marked as delivered successfully. Funds released to available balance.',
            orderId: updatedOrder.id,
            orderStatus: updatedOrder.orderStatus,
            shippingStatus: updatedOrder.shippingStatus,
            transferStatus: payoutResult.transferStatus || TransferStatus.RELEASED,
            payoutReleasedAt: payoutResult.payoutReleasedAt || new Date(),
            deliverySource: 'MANUAL',
        };
    }

    async approveCancellationRequest(userId: string | undefined, orderId: string, dto: ApproveCancellationDto) {
        const sellerId = this.assertSellerUserId(userId);
        const order = await this.getOwnedOrderOrThrow(sellerId, orderId);

        if (order.cancellationStatus !== CancellationStatus.REQUESTED) {
            throw new BadRequestException(
                `No pending cancellation request found for this order. Current cancellation status: ${order.cancellationStatus}`,
            );
        }

        const res = await this.orderService.executeRefundAndCancel({
            orderId: order.id,
            cancelledBy: 'BUYER',
            reason: order.cancellationReason || 'Buyer cancellation request approved by seller',
            restock: dto.restock !== false,
        });

        return {
            ...res,
            message: 'Cancellation request approved. Full refund processed and order cancelled successfully.',
        };
    }

    async declineCancellationRequest(userId: string | undefined, orderId: string, dto: DeclineCancellationDto) {
        const sellerId = this.assertSellerUserId(userId);
        const order = await this.getOwnedOrderOrThrow(sellerId, orderId);

        if (order.cancellationStatus !== CancellationStatus.REQUESTED) {
            throw new BadRequestException(
                `No pending cancellation request found for this order. Current cancellation status: ${order.cancellationStatus}`,
            );
        }

        const now = new Date();
        const updatedOrder = await this.prisma.order.update({
            where: { id: order.id },
            data: {
                cancellationStatus: CancellationStatus.DECLINED,
                cancellationDeclineReason: dto.declineReason,
                cancellationRespondedAt: now,
            },
        });

        // Send email to buyer
        await this.orderService.sendCancellationDeclinedEmailToBuyer({
            orderId: order.id,
            declineReason: dto.declineReason,
        });

        // Send chat message in closet-chat
        try {
            await this.closetChatService.sendCancellationDeclinedMessage({
                orderId: order.id,
                declineReason: dto.declineReason,
            });
        } catch (chatErr) {
            console.error('Failed to post cancellation declined message to closet chat:', chatErr);
        }

        const firstItem = order.items?.[0];
        const itemImage = firstItem?.productImage || firstItem?.product?.images?.[0] || '';
        const itemName = firstItem?.productName || firstItem?.product?.name || '';
        const totalPrice = String(order.total ?? 0);
        const itemPrice = firstItem?.price !== undefined ? String(firstItem.price) : '0';
        const sellerAvatar = order.seller?.image || '';
        const sellerName = order.seller?.displayName || order.seller?.userName || 'Seller';

        const reasonStr = dto.declineReason ? `\nReason: ${dto.declineReason}` : '';
        const declineNotificationBody = `ℹ️ Cancellation request for Order #${order.orderNumber} was declined by ${sellerName}.${reasonStr}\nOrder fulfillment will continue.`;

        // Update existing notification records for this order to declined status
        await this.notificationService.updateOrderNotificationsCancellationStatus({
            orderId: order.id,
            cancellationStatus: 'DECLINED',
            declineReason: dto.declineReason,
            isCancelled: false,
            orderStatus: updatedOrder.orderStatus,
        });

        // Send push notification to buyer
        await this.notificationService.sendNotificationToUser(
            order.buyerId,
            'Cancellation Request Declined',
            declineNotificationBody,
            {
                type: 'marketplace_cancellation_declined',
                orderId: order.id,
                orderNumber: order.orderNumber,
                cancellationStatus: 'DECLINED',
                cancellationDeclineReason: dto.declineReason,
                declineReason: dto.declineReason,
                isCancellationPending: false,
                isCancellationApproved: false,
                isCancellationDeclined: true,
                image: itemImage,
                productImage: itemImage,
                name: itemName || sellerName,
                productName: itemName,
                itemName: itemName,
                price: totalPrice,
                total: totalPrice,
                itemPrice: itemPrice,
                avatar: sellerAvatar,
                sellerAvatar: sellerAvatar,
                sellerName: sellerName,
                iscancel: false,
                isCancel: false,
                isCancelled: false,
            },
        );

        return {
            success: true,
            message: 'Cancellation request declined. Order remains active for fulfillment.',
            orderId: updatedOrder.id,
            orderNumber: updatedOrder.orderNumber,
            orderStatus: updatedOrder.orderStatus,
            cancellationStatus: updatedOrder.cancellationStatus,
            cancellationDeclineReason: updatedOrder.cancellationDeclineReason,
            cancellationRespondedAt: updatedOrder.cancellationRespondedAt,
        };
    }

    async cancelOrderBySeller(userId: string | undefined, orderId: string, dto: SellerCancelOrderDto) {
        const sellerId = this.assertSellerUserId(userId);
        const order = await this.getOwnedOrderOrThrow(sellerId, orderId);

        return this.orderService.executeRefundAndCancel({
            orderId: order.id,
            cancelledBy: 'SELLER',
            reason: dto.reason,
            restock: dto.restock !== false,
        });
    }
}
