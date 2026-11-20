import { Prisma, ProService } from '@prisma/client';
import { SERVICE_TYPE_LABELS } from '../pro-services.constants';
import { formatMinutesToClock, toMajor } from '../pro-services.utils';

/** Everything needed to show a full service (owner editor or public details page). */
export const SERVICE_FULL_INCLUDE = {
    mentorship: true,
    packageDetail: true,
    eventDetail: true,
    ticketTypes: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
    cohorts: { orderBy: { startAt: 'asc' } },
    attachments: { orderBy: { createdAt: 'asc' } },
    availabilityRules: { orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }] },
    availabilityExceptions: { orderBy: { date: 'asc' } },
} satisfies Prisma.ProServiceInclude;

export type FullService = Prisma.ProServiceGetPayload<{ include: typeof SERVICE_FULL_INCLUDE }>;

/** Fields needed for a card in a list. */
export const SERVICE_CARD_INCLUDE = {
    mentorship: { select: { programType: true, programLengthWeeks: true, sessionsCount: true, mode: true } },
    eventDetail: { select: { startAt: true, endAt: true, venueName: true } },
    packageDetail: { select: { sessionsPerMonth: true } },
} satisfies Prisma.ProServiceInclude;

export type CardService = Prisma.ProServiceGetPayload<{ include: typeof SERVICE_CARD_INCLUDE }>;

/** "3-Month Program", "2-Week Program", "60 minutes", "Event", "Monthly" */
export function buildProgramLabel(service: Pick<ProService, 'type' | 'durationMinutes'> & {
    mentorship?: { programType: string; programLengthWeeks: number | null } | null;
}): string {
    if (service.type === 'EVENT') return 'Event';
    if (service.type === 'MONTHLY_PACKAGE') return 'Monthly';
    const m = service.mentorship;
    if (service.type === 'MENTORSHIP' && m && m.programType !== 'ONE_SESSION' && m.programLengthWeeks) {
        const weeks = m.programLengthWeeks;
        if (weeks < 4) return `${weeks}-Week Program`;
        const months = Math.max(1, Math.round(weeks / 4.345));
        return `${months}-Month Program`;
    }
    return service.durationMinutes ? `${service.durationMinutes} minutes` : SERVICE_TYPE_LABELS[service.type];
}

/** Total the buyer pays for one booking of this service (program = price x sessions). */
export function bookingTotalMinor(service: Pick<ProService, 'type' | 'priceMinor'> & {
    mentorship?: { sessionsCount: number } | null;
}): number {
    if (service.type === 'MENTORSHIP') {
        return service.priceMinor * Math.max(1, service.mentorship?.sessionsCount || 1);
    }
    return service.priceMinor;
}

export function presentCard(service: CardService, opts: { isFavorite?: boolean; isMostPopular?: boolean } = {}) {
    const sessionsCount = service.type === 'MENTORSHIP' ? service.mentorship?.sessionsCount || 1 : 1;
    return {
        id: service.id,
        type: service.type,
        status: service.status,
        title: service.title,
        description: service.description,
        coverImage: service.coverImage,
        category: service.category,
        format: service.format,
        durationMinutes: service.durationMinutes,
        programLabel: buildProgramLabel(service),
        sessionsCount,
        currency: service.currency,
        /** Per session, per month, or lowest ticket price ("Tickets from") for events */
        price: toMajor(service.priceMinor),
        priceUnit: priceUnit(service.type),
        totalPrice: toMajor(bookingTotalMinor(service)),
        sessionsPerMonth: service.packageDetail?.sessionsPerMonth ?? null,
        event: service.eventDetail
            ? { startAt: service.eventDetail.startAt, endAt: service.eventDetail.endAt, venueName: service.eventDetail.venueName }
            : null,
        ratingAvg: Number(service.ratingAvg.toFixed(1)),
        reviewCount: service.reviewCount,
        bookingCount: service.bookingCount,
        isMostPopular: Boolean(opts.isMostPopular),
        isFavorite: Boolean(opts.isFavorite),
        publishedAt: service.publishedAt,
    };
}

export function presentFull(
    service: FullService,
    opts: { revealPrivate: boolean; isOwner: boolean; isFavorite?: boolean },
) {
    const card = presentCard(service, { isFavorite: opts.isFavorite });
    const now = Date.now();

    return {
        ...card,
        includedItems: service.includedItems,
        timezone: service.timezone,
        location:
            service.format === 'IN_PERSON'
                ? {
                    city: service.city,
                    country: service.country,
                    // Exact address + phone only after payment (or for the owner)
                    address: opts.revealPrivate ? service.address : null,
                    contactPhone: opts.revealPrivate ? service.contactPhone : null,
                    isRevealed: opts.revealPrivate,
                }
                : null,
        mentorship: service.mentorship
            ? {
                programType: service.mentorship.programType,
                programLengthWeeks: service.mentorship.programLengthWeeks,
                sessionsCount: service.mentorship.sessionsCount,
                frequency: service.mentorship.frequency,
                mode: service.mentorship.mode,
                maxParticipants: service.mentorship.maxParticipants,
                goals: service.mentorship.goals,
                allowCustomStart: service.mentorship.allowCustomStart,
            }
            : null,
        cohorts: service.cohorts
            .filter((c) => opts.isOwner || (c.isActive && c.startAt.getTime() > now))
            .map((c) => ({
                id: c.id,
                startAt: c.startAt,
                seatsTotal: c.seatsTotal,
                seatsTaken: c.seatsTaken,
                seatsLeft: Math.max(0, c.seatsTotal - c.seatsTaken),
                isActive: c.isActive,
            })),
        package: service.packageDetail
            ? {
                sessionsPerMonth: service.packageDetail.sessionsPerMonth,
                maxSubscribers: service.packageDetail.maxSubscribers,
                minNoticeHours: service.packageDetail.minNoticeHours,
                cancelNoticeHours: service.packageDetail.cancelNoticeHours,
                bufferMinutes: service.packageDetail.bufferMinutes,
                autoHideUnavailable: service.packageDetail.autoHideUnavailable,
                includesPrivateCircle: service.packageDetail.includesPrivateCircle,
            }
            : null,
        event: service.eventDetail
            ? {
                startAt: service.eventDetail.startAt,
                endAt: service.eventDetail.endAt,
                venueName: service.eventDetail.venueName,
                venueAddress: service.eventDetail.venueAddress,
                ageRestriction: service.eventDetail.ageRestriction,
                dressCode: service.eventDetail.dressCode,
                salesStartAt: service.eventDetail.salesStartAt,
                salesEndAt: service.eventDetail.salesEndAt,
            }
            : null,
        ticketTypes: service.ticketTypes
            .filter((t) => opts.isOwner || t.isActive)
            .map((t) => ({
                id: t.id,
                name: t.name,
                description: t.description,
                price: toMajor(t.priceMinor),
                isFree: t.priceMinor === 0,
                quantity: t.quantity,
                soldCount: opts.isOwner ? t.soldCount : undefined,
                remaining: Math.max(0, t.quantity - t.soldCount),
                isSoldOut: t.soldCount >= t.quantity,
                isActive: t.isActive,
            })),
        attachments: opts.revealPrivate
            ? service.attachments.map((a) => ({ id: a.id, kind: a.kind, url: a.url, fileName: a.fileName, mimeType: a.mimeType }))
            : service.attachments.map((a) => ({ id: a.id, kind: a.kind, fileName: a.fileName })),
        availability: opts.isOwner ? presentAvailability(service) : undefined,
        createdAt: service.createdAt,
        updatedAt: service.updatedAt,
    };
}

export function presentAvailability(service: Pick<FullService, 'timezone' | 'availabilityRules' | 'availabilityExceptions'>) {
    return {
        timezone: service.timezone,
        rules: service.availabilityRules.map((r) => ({
            id: r.id,
            dayOfWeek: r.dayOfWeek,
            start: formatMinutesToClock(r.startMinute),
            end: formatMinutesToClock(r.endMinute),
        })),
        exceptions: service.availabilityExceptions.map((e) => ({
            id: e.id,
            date: e.date.toISOString().slice(0, 10),
            start: e.startMinute === null ? null : formatMinutesToClock(e.startMinute),
            end: e.endMinute === null ? null : formatMinutesToClock(e.endMinute),
            reason: e.reason,
        })),
    };
}

function priceUnit(type: ProService['type']): 'SESSION' | 'MONTH' | 'TICKET_FROM' | 'BOOKING' {
    switch (type) {
        case 'MONTHLY_PACKAGE':
            return 'MONTH';
        case 'EVENT':
            return 'TICKET_FROM';
        case 'APPOINTMENT':
            return 'BOOKING';
        default:
            return 'SESSION';
    }
}
