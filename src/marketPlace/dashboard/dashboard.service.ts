import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { OrderStatus, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { DashboardItemsQueryDto } from './dto/dashboard-items-query.dto';
import { MarketPlaceOverviewFilterDto, MarketPlaceOverviewRange } from './dto/marketplace-overview-filter.dto';
import { DashboardPaginationDto } from './dto/dashboard-pagination.dto';

@Injectable()
export class DashboardService {
    constructor(private readonly prisma: PrismaService) { }

    private assertUserId(userId?: string): string {
        if (!userId) throw new UnauthorizedException('User not authenticated');
        return userId;
    }

    private async getSellerClosetOrThrow(userId: string) {
        const closet = await this.prisma.mycloset.findUnique({
            where: { userId },
            select: { id: true, userId: true },
        });

        if (!closet) {
            throw new NotFoundException('Seller closet not found');
        }

        return closet;
    }

    private async getClosetViewsTotal(closetId: string): Promise<number> {
        return this.prisma.closetView.count({
            where: { closetId },
        });
    }

    private getRangeDates(range?: MarketPlaceOverviewRange) {
        const now = new Date();
        const days = range === MarketPlaceOverviewRange.MONTHLY ? 30 : 7;
        const fromDate = new Date(now);
        fromDate.setUTCDate(fromDate.getUTCDate() - (days - 1));
        fromDate.setUTCHours(0, 0, 0, 0);

        return {
            range: range || MarketPlaceOverviewRange.WEEKLY,
            days,
            fromDate,
            toDate: now,
        };
    }

    private calculatePercentageChange(current: number, previous: number) {
        if (previous === 0) {
            if (current === 0) return 0;
            return 100;
        }

        return Number((((current - previous) / previous) * 100).toFixed(2));
    }

    private async getDailyViewPoints(closetId: string, fromDate: Date, toDate: Date) {
        const rows = await this.prisma.$queryRaw<Array<{ day: Date; count: bigint | number }>>`
            SELECT DATE("createdAt") AS day, COUNT(*)::bigint AS count
            FROM "ClosetView"
            WHERE "closetId" = ${closetId}
              AND "createdAt" >= ${fromDate}
              AND "createdAt" <= ${toDate}
            GROUP BY DATE("createdAt")
            ORDER BY day ASC
        `;

        const countMap = new Map<string, number>();
        for (const row of rows) {
            const key = row.day.toISOString().slice(0, 10);
            countMap.set(key, Number(row.count));
        }

        const formatter = new Intl.DateTimeFormat('en-US', {
            month: 'short',
            day: 'numeric',
            timeZone: 'UTC',
        });

        const points: Array<{ date: string; views: number }> = [];
        const cursor = new Date(fromDate);
        cursor.setUTCHours(0, 0, 0, 0);

        while (cursor <= toDate) {
            const key = cursor.toISOString().slice(0, 10);
            points.push({
                date: formatter.format(cursor),
                views: countMap.get(key) || 0,
            });

            cursor.setUTCDate(cursor.getUTCDate() + 1);
        }

        return points;
    }

    private async getTopPerformingItem(
        closetId: string,
        sellerId: string,
        fromDate: Date,
        toDate: Date,
    ) {
        const [items, likesGrouped, ordersGrouped] = await Promise.all([
            this.prisma.closetItems.findMany({
                where: { closetId, isDeleted: false },
                select: {
                    id: true,
                    name: true,
                    images: true,
                    price: true,
                    soldCount: true,
                    createdAt: true,
                },
            }),
            this.prisma.closetItemLike.groupBy({
                by: ['closetItemId'],
                where: {
                    createdAt: { gte: fromDate, lte: toDate },
                    closetItem: { closetId },
                },
                _count: { closetItemId: true },
            }),
            this.prisma.orderItem.groupBy({
                by: ['productId'],
                where: {
                    order: {
                        sellerId,
                        paymentStatus: PaymentStatus.PAID,
                        createdAt: { gte: fromDate, lte: toDate },
                    },
                    product: { closetId },
                },
                _count: { productId: true },
                _sum: { quantity: true },
            }),
        ]);

        if (!items.length) {
            return null;
        }

        const likesMap = new Map<string, number>(
            likesGrouped.map((row) => [row.closetItemId, row._count.closetItemId]),
        );
        const ordersMap = new Map<string, { orderCount: number; quantitySold: number }>(
            ordersGrouped.map((row) => [
                row.productId,
                {
                    orderCount: row._count.productId,
                    quantitySold: Number(row._sum.quantity || 0),
                },
            ]),
        );

        const ranked = items
            .map((item) => {
                const orderStats = ordersMap.get(item.id);
                return {
                    ...item,
                    orderCount: orderStats?.orderCount || 0,
                    likeCount: likesMap.get(item.id) || 0,
                    quantitySoldInRange: orderStats?.quantitySold || 0,
                };
            })
            .sort((a, b) => {
                if (b.orderCount !== a.orderCount) return b.orderCount - a.orderCount;
                if (b.likeCount !== a.likeCount) return b.likeCount - a.likeCount;
                if (b.quantitySoldInRange !== a.quantitySoldInRange) return b.quantitySoldInRange - a.quantitySoldInRange;
                return b.createdAt.getTime() - a.createdAt.getTime();
            });

        const top = ranked[0];

        return {
            id: top.id,
            name: top.name,
            image: top.images[0] || null,
            price: top.price,
            orderCount: top.orderCount,
            likeCount: top.likeCount,
            quantitySoldInRange: top.quantitySoldInRange,
        };
    }

    async getMarketPlaceOverview(userId?: string, query?: MarketPlaceOverviewFilterDto) {
        const sellerId = this.assertUserId(userId);
        const closet = await this.getSellerClosetOrThrow(sellerId);
        const { range, days, fromDate, toDate } = this.getRangeDates(query?.range);

        const previousToDate = new Date(fromDate);
        previousToDate.setMilliseconds(previousToDate.getMilliseconds() - 1);
        const previousFromDate = new Date(previousToDate);
        previousFromDate.setUTCDate(previousFromDate.getUTCDate() - (days - 1));
        previousFromDate.setUTCHours(0, 0, 0, 0);

        const dateWhere = {
            gte: fromDate,
            lte: toDate,
        };

        const previousDateWhere = {
            gte: previousFromDate,
            lte: previousToDate,
        };

        const [
            viewsCount,
            likesCount,
            ordersCount,
            cancelledOrdersCount,
            revenueAgg,
            previousViewsCount,
            previousLikesCount,
            previousOrdersCount,
            previousCancelledOrdersCount,
            previousRevenueAgg,
        ] = await Promise.all([
            this.prisma.closetView.count({
                where: {
                    closetId: closet.id,
                    createdAt: dateWhere,
                },
            }),
            this.prisma.closetItemLike.count({
                where: {
                    createdAt: dateWhere,
                    closetItem: {
                        closetId: closet.id,
                    },
                },
            }),
            this.prisma.order.count({
                where: {
                    sellerId,
                    createdAt: dateWhere,
                },
            }),
            this.prisma.order.count({
                where: {
                    sellerId,
                    orderStatus: OrderStatus.CANCELLED,
                    createdAt: dateWhere,
                },
            }),
            this.prisma.order.aggregate({
                where: {
                    sellerId,
                    paymentStatus: PaymentStatus.PAID,
                    createdAt: dateWhere,
                },
                _sum: {
                    total: true,
                },
            }),
            this.prisma.closetView.count({
                where: {
                    closetId: closet.id,
                    createdAt: previousDateWhere,
                },
            }),
            this.prisma.closetItemLike.count({
                where: {
                    createdAt: previousDateWhere,
                    closetItem: {
                        closetId: closet.id,
                    },
                },
            }),
            this.prisma.order.count({
                where: {
                    sellerId,
                    createdAt: previousDateWhere,
                },
            }),
            this.prisma.order.count({
                where: {
                    sellerId,
                    orderStatus: OrderStatus.CANCELLED,
                    createdAt: previousDateWhere,
                },
            }),
            this.prisma.order.aggregate({
                where: {
                    sellerId,
                    paymentStatus: PaymentStatus.PAID,
                    createdAt: previousDateWhere,
                },
                _sum: {
                    total: true,
                },
            }),
        ]);

        const revenue = Number(revenueAgg._sum.total || 0);
        const previousRevenue = Number(previousRevenueAgg._sum.total || 0);

        return {
            range,
            fromDate,
            toDate,
            viewsCount,
            likesCount,
            ordersCount,
            cancelledOrdersCount,
            revenue,
            previousPeriod: {
                fromDate: previousFromDate,
                toDate: previousToDate,
                viewsCount: previousViewsCount,
                likesCount: previousLikesCount,
                ordersCount: previousOrdersCount,
                cancelledOrdersCount: previousCancelledOrdersCount,
                revenue: previousRevenue,
            },
            changes: {
                viewsPercent: this.calculatePercentageChange(viewsCount, previousViewsCount),
                likesPercent: this.calculatePercentageChange(likesCount, previousLikesCount),
                ordersPercent: this.calculatePercentageChange(ordersCount, previousOrdersCount),
                cancelledOrdersPercent: this.calculatePercentageChange(cancelledOrdersCount, previousCancelledOrdersCount),
                revenuePercent: this.calculatePercentageChange(revenue, previousRevenue),
            },
        };
    }

    async getMarketPlaceAnalytics(userId?: string, query?: MarketPlaceOverviewFilterDto) {
        const sellerId = this.assertUserId(userId);
        const closet = await this.getSellerClosetOrThrow(sellerId);
        const { range, fromDate, toDate } = this.getRangeDates(query?.range);

        const [overview, performance, topPerformingItem] = await Promise.all([
            this.getMarketPlaceOverview(userId, query),
            this.getDailyViewPoints(closet.id, fromDate, toDate),
            this.getTopPerformingItem(closet.id, sellerId, fromDate, toDate),
        ]);

        return {
            range: overview.range,
            fromDate: overview.fromDate,
            toDate: overview.toDate,
            performance,
            summary: {
                totalViews: overview.viewsCount,
                totalLikes: overview.likesCount,
                totalOrders: overview.ordersCount,
                totalCancelledOrders: overview.cancelledOrdersCount,
                totalRevenue: overview.revenue,
            },
            changes: {
                viewsPercent: overview.changes.viewsPercent,
                likesPercent: overview.changes.likesPercent,
                ordersPercent: overview.changes.ordersPercent,
                cancelledOrdersPercent: overview.changes.cancelledOrdersPercent,
                revenuePercent: overview.changes.revenuePercent,
            },
            topPerformingItem,
        };
    }

    async getOverview(userId?: string) {
        const sellerId = this.assertUserId(userId);
        const closet = await this.getSellerClosetOrThrow(sellerId);

        const [totalItems, totalOrders, revenueAggregate, soldAggregate, views, totalLikes] = await Promise.all([
            this.prisma.closetItems.count({ where: { closetId: closet.id, isDeleted: false } }),
            this.prisma.order.count({ where: { sellerId } }),
            this.prisma.order.aggregate({
                where: {
                    sellerId,
                    paymentStatus: PaymentStatus.PAID,
                },
                _sum: { total: true },
            }),
            this.prisma.orderItem.aggregate({
                where: {
                    order: {
                        sellerId,
                    },
                },
                _sum: { quantity: true },
            }),
            this.getClosetViewsTotal(closet.id),
            this.prisma.closetItemLike.count({
                where: {
                    closetItem: {
                        closetId: closet.id,
                    },
                },
            }),
        ]);

        return {
            totalItems,
            orders: totalOrders,
            revenue: Number(revenueAggregate._sum.total || 0),
            sold: Number(soldAggregate._sum.quantity || 0),
            views,
            likes: totalLikes,
        };
    }

    async getRecentOrders(userId?: string, query?: DashboardPaginationDto) {
        const sellerId = this.assertUserId(userId);
        await this.getSellerClosetOrThrow(sellerId);

        const page = query?.page ?? 1;
        const limit = query?.limit ?? 10;
        const skip = (page - 1) * limit;

        const where: Prisma.OrderWhereInput = { sellerId };

        const [total, orders] = await this.prisma.$transaction([
            this.prisma.order.count({ where }),
            this.prisma.order.findMany({
                where,
                skip,
                take: limit,
                orderBy: { createdAt: 'desc' },
                select: {
                    id: true,
                    orderNumber: true,
                    total: true,
                    orderStatus: true,
                    createdAt: true,
                    buyer: {
                        select: {
                            id: true,
                            displayName: true,
                            userName: true,
                        },
                    },
                },
            }),
        ]);

        return {
            data: orders.map((order) => ({
                id: order.id,
                orderNumber: order.orderNumber,
                buyerId: order.buyer.id,
                buyerName: order.buyer.displayName || order.buyer.userName || 'Unknown Buyer',
                total: order.total,
                orderStatus: order.orderStatus,
                createdAt: order.createdAt,
            })),
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        };
    }

    async getClosetItems(userId?: string, query?: DashboardItemsQueryDto) {
        const sellerId = this.assertUserId(userId);
        const closet = await this.getSellerClosetOrThrow(sellerId);

        const page = query?.page ?? 1;
        const limit = query?.limit ?? 10;
        const skip = (page - 1) * limit;

        const where: Prisma.ClosetItemsWhereInput = {
            closetId: closet.id,
            isDeleted: false,
            ...(query?.category ? { category: query.category } : {}),
            ...(typeof query?.isActive === 'boolean' ? { isActive: query.isActive } : {}),
        };

        const [total, items] = await this.prisma.$transaction([
            this.prisma.closetItems.count({ where }),
            this.prisma.closetItems.findMany({
                where,
                skip,
                take: limit,
                orderBy: { createdAt: 'desc' },
                select: {
                    id: true,
                    name: true,
                    images: true,
                    price: true,
                    quantity: true,
                    soldCount: true,
                    isActive: true,
                    category: true,
                    createdAt: true,
                    _count: {
                        select: {
                            likes: true,
                        },
                    },
                },
            }),
        ]);

        return {
            data: items.map((item) => ({
                id: item.id,
                productName: item.name,
                images: item.images,
                price: item.price,
                availableQuantity: item.quantity,
                soldCount: item.soldCount,
                views: 0,
                likes: item._count.likes,
                isActive: item.isActive,
                category: item.category,
                createdAt: item.createdAt,
            })),
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        };
    }
}
