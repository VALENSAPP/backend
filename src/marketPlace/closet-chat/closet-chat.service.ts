import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ClosetChatMessageEventType, ClosetChatMessageType, ClosetChatThreadStatus, Prisma } from '@prisma/client';
import { NotificationService } from '../../notification/notification.service';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ClosetChatService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly notificationService: NotificationService,
    ) { }

    private async assertThreadParticipant(threadId: string, userId: string) {
        const thread = await this.prisma.closetChatThread.findUnique({
            where: { id: threadId },
            select: {
                id: true,
                buyerId: true,
                sellerId: true,
                status: true,
            },
        });

        if (!thread) throw new NotFoundException('Closet chat thread not found');
        if (thread.buyerId !== userId && thread.sellerId !== userId) {
            throw new UnauthorizedException('Unauthorized');
        }

        return thread;
    }

    async getMyThreads(userId: string) {
        if (!userId) throw new UnauthorizedException('User not authenticated');

        const threads = await this.prisma.closetChatThread.findMany({
            where: {
                OR: [{ buyerId: userId }, { sellerId: userId }],
            },
            include: {
                buyer: {
                    select: { id: true, displayName: true, image: true, profile: true, profileStatus: true },
                },
                seller: {
                    select: { id: true, displayName: true, image: true, profile: true, profileStatus: true },
                },
                order: {
                    select: {
                        id: true,
                        orderNumber: true,
                        orderStatus: true,
                        paymentStatus: true,
                        createdAt: true,
                    },
                },
                messages: {
                    orderBy: { createdAt: 'desc' },
                    take: 1,
                    select: {
                        id: true,
                        content: true,
                        type: true,
                        eventType: true,
                        senderId: true,
                        receiverId: true,
                        isSeen: true,
                        createdAt: true,
                    },
                },
            },
            orderBy: [{ lastMessageAt: 'desc' }, { updatedAt: 'desc' }],
        });

        const threadIds = threads.map((thread) => thread.id);
        const unreadByThread = threadIds.length
            ? await this.prisma.closetChatMessage.groupBy({
                by: ['threadId'],
                where: {
                    threadId: { in: threadIds },
                    receiverId: userId,
                    isSeen: false,
                },
                _count: { _all: true },
            })
            : [];

        const unreadMap = new Map(unreadByThread.map((row) => [row.threadId, row._count._all]));
        const totalUnreadCount = unreadByThread.reduce((sum, row) => sum + row._count._all, 0);

        const mappedThreads = threads.map((thread) => {
            const lastMessage = thread.messages[0] || null;
            const otherUser = thread.buyerId === userId ? thread.seller : thread.buyer;

            return {
                id: thread.id,
                orderId: thread.orderId,
                closetId: thread.closetId,
                status: thread.status,
                createdAt: thread.createdAt,
                updatedAt: thread.updatedAt,
                lastMessageAt: thread.lastMessageAt,
                otherUser,
                order: thread.order,
                unreadcount: unreadMap.get(thread.id) || 0,
                // unreadCount: unreadMap.get(thread.id) || 0,
                lastMessage,
            };
        });

        return {
            totalUnreadcount: totalUnreadCount,
            threads: mappedThreads,
        };
    }

    async getThreadMessages(userId: string, threadId: string, page = 1, limit = 20) {
        if (!userId) throw new UnauthorizedException('User not authenticated');
        if (!threadId) throw new BadRequestException('threadId is required');

        await this.assertThreadParticipant(threadId, userId);

        const safePage = Math.max(page, 1);
        const safeLimit = Math.min(Math.max(limit, 1), 100);
        const skip = (safePage - 1) * safeLimit;

        const [total, messages] = await Promise.all([
            this.prisma.closetChatMessage.count({ where: { threadId } }),
            this.prisma.closetChatMessage.findMany({
                where: { threadId },
                include: {
                    sender: { select: { id: true, displayName: true, image: true } },
                    receiver: { select: { id: true, displayName: true, image: true } },
                },
                orderBy: { createdAt: 'asc' },
                skip,
                take: safeLimit,
            }),
        ]);

        return {
            threadId,
            page: safePage,
            limit: safeLimit,
            total,
            messages,
        };
    }

    async sendMessage(userId: string, threadId: string, content: string) {
        if (!userId) throw new UnauthorizedException('User not authenticated');
        if (!threadId) throw new BadRequestException('threadId is required');
        if (!content || !content.trim()) throw new BadRequestException('Message required');

        const thread = await this.assertThreadParticipant(threadId, userId);
        if (thread.status === ClosetChatThreadStatus.CLOSED) {
            throw new BadRequestException('Chat thread is closed');
        }

        const receiverId = thread.buyerId === userId ? thread.sellerId : thread.buyerId;
        const text = content.trim();

        const message = await this.prisma.$transaction(async (tx) => {
            const createdMessage = await tx.closetChatMessage.create({
                data: {
                    threadId,
                    senderId: userId,
                    receiverId,
                    content: text,
                    type: ClosetChatMessageType.USER,
                },
            });

            await tx.closetChatThread.update({
                where: { id: threadId },
                data: { lastMessageAt: createdMessage.createdAt },
            });

            return createdMessage;
        });

        await this.notificationService.sendNotificationToUser(
            receiverId,
            'New chat message',
            'You have a new message in your marketplace chat.',
            {
                type: 'closet_chat_message',
                threadId,
                messageId: message.id,
                senderId: userId,
            },
        );

        return message;
    }

    async markMessageSeen(userId: string, messageId: string) {
        if (!userId) throw new UnauthorizedException('User not authenticated');
        if (!messageId) throw new BadRequestException('messageId is required');

        const existingMessage = await this.prisma.closetChatMessage.findUnique({
            where: { id: messageId },
            select: {
                id: true,
                senderId: true,
                receiverId: true,
                threadId: true,
                isSeen: true,
            },
        });

        if (!existingMessage) {
            throw new NotFoundException('Closet chat message not found');
        }

        if (existingMessage.receiverId !== userId) {
            throw new UnauthorizedException('Unauthorized');
        }

        const updated = await this.prisma.closetChatMessage.updateMany({
            where: {
                id: messageId,
                receiverId: userId,
                isSeen: false,
            },
            data: {
                isSeen: true,
            },
        });

        return {
            message: 'Message seen status updated',
            updatedCount: updated.count,
            threadId: existingMessage.threadId,
            otherUserId: existingMessage.senderId,
        };
    }

    async ensureOrderPlacedThreadAndMessage(orderId: string) {
        if (!orderId) throw new BadRequestException('orderId is required');

        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: {
                items: {
                    select: {
                        product: {
                            select: {
                                id: true,
                                buyerChatEnabled: true,
                            },
                        },
                    },
                },
            },
        });

        if (!order) throw new NotFoundException('Order not found');

        const isBuyerChatEnabled = order.items.some((item) => item.product?.buyerChatEnabled === true);
        if (!isBuyerChatEnabled) {
            return {
                enabled: false,
                threadCreated: false,
                messageCreated: false,
            };
        }

        let threadId = '';
        let messageCreated = false;

        await this.prisma.$transaction(async (tx) => {
            const thread = await tx.closetChatThread.upsert({
                where: { orderId: order.id },
                create: {
                    orderId: order.id,
                    buyerId: order.buyerId,
                    sellerId: order.sellerId,
                    closetId: order.closetId,
                    status: ClosetChatThreadStatus.ACTIVE,
                },
                update: {
                    status: ClosetChatThreadStatus.ACTIVE,
                },
                select: { id: true },
            });

            threadId = thread.id;

            const existingSystemMessage = await tx.closetChatMessage.findFirst({
                where: {
                    threadId: thread.id,
                    eventType: ClosetChatMessageEventType.ORDER_PLACED,
                },
                select: { id: true },
            });

            if (!existingSystemMessage) {
                try {
                    const created = await tx.closetChatMessage.create({
                        data: {
                            threadId: thread.id,
                            senderId: order.buyerId,
                            receiverId: order.sellerId,
                            content: 'I have placed a order',
                            type: ClosetChatMessageType.SYSTEM,
                            eventType: ClosetChatMessageEventType.ORDER_PLACED,
                        },
                        select: { id: true, createdAt: true },
                    });

                    messageCreated = true;

                    await tx.closetChatThread.update({
                        where: { id: thread.id },
                        data: {
                            lastMessageAt: created.createdAt,
                        },
                    });
                } catch (error) {
                    // Handle rare race between duplicated webhook events.
                    if (
                        error instanceof Prisma.PrismaClientKnownRequestError &&
                        error.code === 'P2002'
                    ) {
                        messageCreated = false;
                        return;
                    }
                    throw error;
                }
            }
        });

        return {
            enabled: true,
            threadCreated: true,
            messageCreated,
            threadId,
        };
    }

    async sendLocalPickupProcessingMessage(orderId: string, sellerUsername: string) {
        if (!orderId) throw new BadRequestException('orderId is required');

        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            select: {
                id: true,
                buyerId: true,
                sellerId: true,
                closetId: true,
            },
        });

        if (!order) throw new NotFoundException('Order not found');

        const chatContent = `Your Order Is Ready for Pickup! 🎉\n\nGood news! ${sellerUsername} is preparing your order and is ready to coordinate the pickup with you.\n\nPlease check the pickup location, date, and time in your order details and arrive at the agreed time.\n\nNeed to make arrangements or have a question? Chat directly with the seller through Valens.`;

        let threadId = '';
        let createdMessage: any = null;

        await this.prisma.$transaction(async (tx) => {
            const thread = await tx.closetChatThread.upsert({
                where: { orderId: order.id },
                create: {
                    orderId: order.id,
                    buyerId: order.buyerId,
                    sellerId: order.sellerId,
                    closetId: order.closetId,
                    status: ClosetChatThreadStatus.ACTIVE,
                },
                update: {
                    status: ClosetChatThreadStatus.ACTIVE,
                },
                select: { id: true },
            });

            threadId = thread.id;

            createdMessage = await tx.closetChatMessage.create({
                data: {
                    threadId: thread.id,
                    senderId: order.sellerId,
                    receiverId: order.buyerId,
                    content: chatContent,
                    type: ClosetChatMessageType.USER,
                },
            });

            await tx.closetChatThread.update({
                where: { id: thread.id },
                data: {
                    lastMessageAt: createdMessage.createdAt,
                },
            });
        });

        return {
            threadId,
            message: createdMessage,
        };
    }

    async sendShipItemsProcessingMessage(orderId: string, sellerUsername: string) {
        if (!orderId) throw new BadRequestException('orderId is required');

        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            select: {
                id: true,
                buyerId: true,
                sellerId: true,
                closetId: true,
            },
        });

        if (!order) throw new NotFoundException('Order not found');

        const chatContent = `Your Order Is Being Prepared for Shipping! 📦\n\nGood news! ${sellerUsername} is preparing your order for shipment.\n\nOnce your order has been shipped, you’ll receive a notification with the carrier and tracking number so you can follow your package until delivery.\n\nHave a question about your order? Chat directly with the seller through Valens.`;

        let threadId = '';
        let createdMessage: any = null;

        await this.prisma.$transaction(async (tx) => {
            const thread = await tx.closetChatThread.upsert({
                where: { orderId: order.id },
                create: {
                    orderId: order.id,
                    buyerId: order.buyerId,
                    sellerId: order.sellerId,
                    closetId: order.closetId,
                    status: ClosetChatThreadStatus.ACTIVE,
                },
                update: {
                    status: ClosetChatThreadStatus.ACTIVE,
                },
                select: { id: true },
            });

            threadId = thread.id;

            createdMessage = await tx.closetChatMessage.create({
                data: {
                    threadId: thread.id,
                    senderId: order.sellerId,
                    receiverId: order.buyerId,
                    content: chatContent,
                    type: ClosetChatMessageType.USER,
                },
            });

            await tx.closetChatThread.update({
                where: { id: thread.id },
                data: {
                    lastMessageAt: createdMessage.createdAt,
                },
            });
        });

        return {
            threadId,
            message: createdMessage,
        };
    }

    async sendOrderCancelledMessage(params: {
        orderId: string;
        cancelledBy: 'BUYER' | 'SELLER';
        reason?: string;
        refundAmount?: number;
    }) {
        const { orderId, cancelledBy, reason, refundAmount } = params;
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            select: {
                id: true,
                orderNumber: true,
                buyerId: true,
                sellerId: true,
                closetId: true,
            },
        });

        if (!order) return null;

        const senderId = cancelledBy === 'BUYER' ? order.buyerId : order.sellerId;
        const receiverId = cancelledBy === 'BUYER' ? order.sellerId : order.buyerId;
        const whoStr = cancelledBy === 'BUYER' ? 'Buyer' : 'Seller';
        const refundStr = refundAmount != null ? ` A full refund of $${refundAmount.toFixed(2)} has been issued.` : '';
        const reasonStr = reason ? `\nReason: ${reason}` : '';
        const content = `❌ Order #${order.orderNumber} was cancelled by ${whoStr}.${refundStr}${reasonStr}`;

        let threadId = '';
        let createdMessage: any = null;

        await this.prisma.$transaction(async (tx) => {
            const thread = await tx.closetChatThread.upsert({
                where: { orderId: order.id },
                create: {
                    orderId: order.id,
                    buyerId: order.buyerId,
                    sellerId: order.sellerId,
                    closetId: order.closetId,
                    status: ClosetChatThreadStatus.ACTIVE,
                },
                update: {
                    status: ClosetChatThreadStatus.ACTIVE,
                },
                select: { id: true },
            });

            threadId = thread.id;

            createdMessage = await tx.closetChatMessage.create({
                data: {
                    threadId: thread.id,
                    senderId,
                    receiverId,
                    content,
                    type: ClosetChatMessageType.SYSTEM,
                    eventType: ClosetChatMessageEventType.ORDER_CANCELLED,
                },
            });

            await tx.closetChatThread.update({
                where: { id: thread.id },
                data: {
                    lastMessageAt: createdMessage.createdAt,
                },
            });
        });

        return {
            threadId,
            message: createdMessage,
        };
    }

    async sendCancellationRequestedMessage(params: {
        orderId: string;
        reason?: string;
    }) {
        const { orderId, reason } = params;
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            select: {
                id: true,
                orderNumber: true,
                buyerId: true,
                sellerId: true,
                closetId: true,
                buyer: {
                    select: {
                        userName: true,
                        displayName: true,
                    },
                },
            },
        });

        if (!order) return null;

        const buyerUsername = order.buyer?.userName || order.buyer?.displayName || 'Buyer';
        const senderId = order.buyerId;
        const receiverId = order.sellerId;
        const reasonStr = reason ? `\nReason: ${reason}` : '';
        const content = `⚠️ ${buyerUsername} requested to cancel Order #${order.orderNumber}.${reasonStr}\nPlease review and approve or decline in your seller dashboard.`;

        let threadId = '';
        let createdMessage: any = null;

        await this.prisma.$transaction(async (tx) => {
            const thread = await tx.closetChatThread.upsert({
                where: { orderId: order.id },
                create: {
                    orderId: order.id,
                    buyerId: order.buyerId,
                    sellerId: order.sellerId,
                    closetId: order.closetId,
                    status: ClosetChatThreadStatus.ACTIVE,
                },
                update: {
                    status: ClosetChatThreadStatus.ACTIVE,
                },
                select: { id: true },
            });

            threadId = thread.id;

            createdMessage = await tx.closetChatMessage.upsert({
                where: {
                    threadId_eventType: {
                        threadId: thread.id,
                        eventType: ClosetChatMessageEventType.CANCELLATION_REQUESTED,
                    },
                },
                create: {
                    threadId: thread.id,
                    senderId,
                    receiverId,
                    content,
                    type: ClosetChatMessageType.SYSTEM,
                    eventType: ClosetChatMessageEventType.CANCELLATION_REQUESTED,
                },
                update: {
                    senderId,
                    receiverId,
                    content,
                    type: ClosetChatMessageType.SYSTEM,
                    createdAt: new Date(),
                },
            });

            await tx.closetChatThread.update({
                where: { id: thread.id },
                data: {
                    lastMessageAt: createdMessage.createdAt,
                },
            });
        });

        return {
            threadId,
            message: createdMessage,
        };
    }

    async sendCancellationDeclinedMessage(params: {
        orderId: string;
        declineReason?: string;
    }) {
        const { orderId, declineReason } = params;
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            select: {
                id: true,
                orderNumber: true,
                buyerId: true,
                sellerId: true,
                closetId: true,
            },
        });

        if (!order) return null;

        const senderId = order.sellerId;
        const receiverId = order.buyerId;
        const reasonStr = declineReason ? `\nReason: ${declineReason}` : '';
        const content = `ℹ️ Cancellation request for Order #${order.orderNumber} was declined by Seller.${reasonStr}\nOrder fulfillment will continue.`;

        let threadId = '';
        let createdMessage: any = null;

        await this.prisma.$transaction(async (tx) => {
            const thread = await tx.closetChatThread.upsert({
                where: { orderId: order.id },
                create: {
                    orderId: order.id,
                    buyerId: order.buyerId,
                    sellerId: order.sellerId,
                    closetId: order.closetId,
                    status: ClosetChatThreadStatus.ACTIVE,
                },
                update: {
                    status: ClosetChatThreadStatus.ACTIVE,
                },
                select: { id: true },
            });

            threadId = thread.id;

            createdMessage = await tx.closetChatMessage.upsert({
                where: {
                    threadId_eventType: {
                        threadId: thread.id,
                        eventType: ClosetChatMessageEventType.CANCELLATION_DECLINED,
                    },
                },
                create: {
                    threadId: thread.id,
                    senderId,
                    receiverId,
                    content,
                    type: ClosetChatMessageType.SYSTEM,
                    eventType: ClosetChatMessageEventType.CANCELLATION_DECLINED,
                },
                update: {
                    senderId,
                    receiverId,
                    content,
                    type: ClosetChatMessageType.SYSTEM,
                    createdAt: new Date(),
                },
            });

            await tx.closetChatThread.update({
                where: { id: thread.id },
                data: {
                    lastMessageAt: createdMessage.createdAt,
                },
            });
        });

        return {
            threadId,
            message: createdMessage,
        };
    }
}

