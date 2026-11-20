import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PageQueryDto, UserServicesQueryDto } from '../dto/query.dto';
import { presentCard, presentFull, SERVICE_CARD_INCLUDE, SERVICE_FULL_INCLUDE } from './service-presenter';

const PUBLIC_USER_SELECT = {
    id: true,
    userName: true,
    displayName: true,
    image: true,
    bio: true,
    kyc: true,
    isDeleted: true,
    isBlocked: true,
} satisfies Prisma.UserSelect;

@Injectable()
export class PublicService {
    constructor(private readonly prisma: PrismaService) { }

    /** Screen C1 / E1: a provider's Services page (header, filter chips, list). */
    async getProviderPage(providerUserId: string, viewerId: string | null, query: UserServicesQueryDto) {
        const user = await this.prisma.user.findUnique({
            where: { id: providerUserId },
            select: { ...PUBLIC_USER_SELECT, serviceProvider: true },
        });
        if (!user || user.isDeleted || user.isBlocked || !user.serviceProvider?.isActive) {
            throw new NotFoundException('This user does not offer services');
        }

        const page = query.page || 1;
        const limit = query.limit || 20;
        const baseWhere: Prisma.ProServiceWhereInput = { providerUserId, status: 'ACTIVE' };
        const where: Prisma.ProServiceWhereInput = { ...baseWhere, ...(query.type ? { type: query.type } : {}) };

        const [total, rows, byType, topService] = await Promise.all([
            this.prisma.proService.count({ where }),
            this.prisma.proService.findMany({
                where,
                include: SERVICE_CARD_INCLUDE,
                orderBy: this.orderBy(query.sort),
                skip: (page - 1) * limit,
                take: limit,
            }),
            this.prisma.proService.groupBy({ by: ['type'], where: baseWhere, _count: { _all: true } }),
            this.prisma.proService.findFirst({
                where: { ...baseWhere, bookingCount: { gt: 0 } },
                orderBy: [{ popularityScore: 'desc' }, { bookingCount: 'desc' }],
                select: { id: true },
            }),
        ]);

        const favoriteIds = await this.favoriteIdsFor(viewerId, rows.map((r) => r.id));
        const countsByType: Record<string, number> = {};
        let allCount = 0;
        for (const row of byType) {
            countsByType[row.type] = row._count._all;
            allCount += row._count._all;
        }

        const sp = user.serviceProvider!;
        return {
            provider: {
                userId: user.id,
                userName: user.userName,
                displayName: user.displayName,
                image: user.image,
                isVerified: Boolean(user.kyc),
                headline: sp.headline,
                about: sp.about,
                ratingAvg: Number(sp.ratingAvg.toFixed(1)),
                reviewCount: sp.reviewCount,
                clientCount: sp.clientCount,
            },
            filters: { all: allCount, ...countsByType },
            items: rows.map((s) =>
                presentCard(s, { isFavorite: favoriteIds.has(s.id), isMostPopular: s.id === topService?.id }),
            ),
            page,
            limit,
            total,
            hasMore: page * limit < total,
        };
    }

    /** Screen C3 / E2 / M1: service details. Address, phone and files only after purchase. */
    async getDetails(serviceId: string, viewerId: string | null) {
        const service = await this.prisma.proService.findUnique({
            where: { id: serviceId },
            include: { ...SERVICE_FULL_INCLUDE, provider: { select: PUBLIC_USER_SELECT } },
        });
        const isOwner = Boolean(viewerId && service?.providerUserId === viewerId);
        if (!service || (!isOwner && service.status !== 'ACTIVE')) throw new NotFoundException('Service not found');
        if (!isOwner && (service.provider.isDeleted || service.provider.isBlocked)) {
            throw new NotFoundException('Service not found');
        }

        const [hasPurchased, favoriteIds] = await Promise.all([
            isOwner ? Promise.resolve(true) : this.hasPurchased(serviceId, viewerId),
            this.favoriteIdsFor(viewerId, [serviceId]),
        ]);

        const provider = await this.prisma.serviceProvider.findUnique({ where: { userId: service.providerUserId } });

        return {
            ...presentFull(service, { revealPrivate: hasPurchased, isOwner, isFavorite: favoriteIds.has(serviceId) }),
            isOwner,
            hasPurchased,
            provider: {
                userId: service.provider.id,
                userName: service.provider.userName,
                displayName: service.provider.displayName,
                image: service.provider.image,
                isVerified: Boolean(service.provider.kyc),
                headline: provider?.headline ?? null,
                ratingAvg: Number((provider?.ratingAvg ?? 0).toFixed(1)),
                reviewCount: provider?.reviewCount ?? 0,
                clientCount: provider?.clientCount ?? 0,
            },
        };
    }

    /** Screen C4: reviews of one service. */
    async getReviews(serviceId: string, query: PageQueryDto) {
        const service = await this.prisma.proService.findUnique({
            where: { id: serviceId },
            select: { id: true, status: true, ratingAvg: true, reviewCount: true },
        });
        if (!service || service.status === 'ARCHIVED') throw new NotFoundException('Service not found');

        const page = query.page || 1;
        const limit = query.limit || 20;
        const [rows, distribution] = await Promise.all([
            this.prisma.serviceReview.findMany({
                where: { serviceId },
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
                include: { reviewer: { select: { id: true, userName: true, displayName: true, image: true } } },
            }),
            this.prisma.serviceReview.groupBy({ by: ['rating'], where: { serviceId }, _count: { _all: true } }),
        ]);

        const stars: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
        for (const d of distribution) stars[String(d.rating)] = d._count._all;

        return {
            ratingAvg: Number(service.ratingAvg.toFixed(1)),
            reviewCount: service.reviewCount,
            stars,
            items: rows.map((r) => ({
                id: r.id,
                rating: r.rating,
                comment: r.comment,
                createdAt: r.createdAt,
                reviewer: r.reviewer,
            })),
            page,
            limit,
            hasMore: page * limit < service.reviewCount,
        };
    }

    /** Screen C2: bookmark / heart. */
    async addFavorite(userId: string, serviceId: string) {
        const service = await this.prisma.proService.findUnique({ where: { id: serviceId }, select: { status: true } });
        if (!service || service.status !== 'ACTIVE') throw new NotFoundException('Service not found');
        await this.prisma.serviceFavorite.upsert({
            where: { userId_serviceId: { userId, serviceId } },
            create: { userId, serviceId },
            update: {},
        });
        return { serviceId, isFavorite: true };
    }

    async removeFavorite(userId: string, serviceId: string) {
        await this.prisma.serviceFavorite.deleteMany({ where: { userId, serviceId } });
        return { serviceId, isFavorite: false };
    }

    async listFavorites(userId: string, query: PageQueryDto) {
        const page = query.page || 1;
        const limit = query.limit || 20;
        const where: Prisma.ServiceFavoriteWhereInput = { userId, service: { status: 'ACTIVE' } };
        const [total, rows] = await Promise.all([
            this.prisma.serviceFavorite.count({ where }),
            this.prisma.serviceFavorite.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
                include: { service: { include: SERVICE_CARD_INCLUDE } },
            }),
        ]);
        return {
            items: rows.map((f) => presentCard(f.service, { isFavorite: true })),
            page,
            limit,
            total,
            hasMore: page * limit < total,
        };
    }

    private orderBy(sort: UserServicesQueryDto['sort']): Prisma.ProServiceOrderByWithRelationInput[] {
        switch (sort) {
            case 'newest':
                return [{ publishedAt: 'desc' }, { createdAt: 'desc' }];
            case 'price_asc':
                return [{ priceMinor: 'asc' }, { createdAt: 'desc' }];
            case 'price_desc':
                return [{ priceMinor: 'desc' }, { createdAt: 'desc' }];
            case 'rating':
                return [{ ratingAvg: 'desc' }, { reviewCount: 'desc' }];
            case 'popular':
            default:
                return [{ popularityScore: 'desc' }, { bookingCount: 'desc' }, { publishedAt: 'desc' }];
        }
    }

    private async favoriteIdsFor(viewerId: string | null, serviceIds: string[]): Promise<Set<string>> {
        if (!viewerId || !serviceIds.length) return new Set();
        const rows = await this.prisma.serviceFavorite.findMany({
            where: { userId: viewerId, serviceId: { in: serviceIds } },
            select: { serviceId: true },
        });
        return new Set(rows.map((r) => r.serviceId));
    }

    /** Paid booking, active package or a paid ticket for this service. */
    private async hasPurchased(serviceId: string, viewerId: string | null): Promise<boolean> {
        if (!viewerId) return false;
        const [booking, subscription, tickets] = await Promise.all([
            this.prisma.serviceBooking.count({
                where: { serviceId, buyerId: viewerId, status: { in: ['CONFIRMED', 'IN_PROGRESS', 'COMPLETED'] } },
            }),
            this.prisma.packageSubscription.count({
                where: { serviceId, subscriberId: viewerId, status: { in: ['ACTIVE', 'PAST_DUE'] } },
            }),
            this.prisma.ticketOrder.count({ where: { serviceId, buyerId: viewerId, status: 'PAID' } }),
        ]);
        return booking + subscription + tickets > 0;
    }
}
