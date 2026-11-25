import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SlotsQueryDto } from '../dto/booking.dto';
import {
    addDays,
    addMonths,
    dateKey,
    dayOfWeek,
    isExactLocalTime,
    localDateKey,
    overlaps,
    parseDateKey,
    toLocalParts,
    zonedTimeToUtc,
} from '../time-zone.util';
import { formatMinutesToClock } from '../pro-services.utils';

type Db = PrismaService | Prisma.TransactionClient;

export interface PlannedSession {
    startAt: Date;
    endAt: Date;
}

/** Service fields the scheduler needs. */
export const SCHEDULING_INCLUDE = {
    mentorship: true,
    packageDetail: true,
    availabilityRules: true,
    availabilityExceptions: true,
} satisfies Prisma.ProServiceInclude;

export type SchedulableService = Prisma.ProServiceGetPayload<{ include: typeof SCHEDULING_INCLUDE }>;

const MAX_RANGE_DAYS = 60;
const DEFAULT_RANGE_DAYS = 14;

@Injectable()
export class SchedulingService {
    constructor(private readonly prisma: PrismaService) { }

    /** Minimum time between "now" and a bookable start. Packages use their own rule. */
    minNoticeMinutes(service: SchedulableService): number {
        if (service.packageDetail) return service.packageDetail.minNoticeHours * 60;
        const fromEnv = Number(process.env.SERVICES_MIN_NOTICE_MINUTES);
        return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : 60;
    }

    /** Minutes kept free before and after each session. */
    bufferMinutes(service: SchedulableService): number {
        if (service.packageDetail) return service.packageDetail.bufferMinutes;
        const fromEnv = Number(process.env.SERVICES_DEFAULT_BUFFER_MINUTES);
        return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : 0;
    }

    timezoneOf(service: SchedulableService): string {
        return service.timezone || 'UTC';
    }

    async loadSchedulable(serviceId: string, db: Db = this.prisma): Promise<SchedulableService> {
        const service = await db.proService.findUnique({ where: { id: serviceId }, include: SCHEDULING_INCLUDE });
        if (!service) throw new NotFoundException('Service not found');
        return service;
    }

    /**
     * Screen C5 / M4: free start times, grouped by local date.
     * Free = inside weekly availability, not a day off, after the minimum notice,
     * and not overlapping anything the provider already has (any service, holds included).
     */
    async getAvailableSlots(serviceId: string, query: SlotsQueryDto) {
        const service = await this.loadSchedulable(serviceId);
        if (service.status !== 'ACTIVE') throw new NotFoundException('Service not found');
        if (service.type === 'EVENT') throw new BadRequestException('Events are booked with tickets, not time slots');
        if (service.mentorship?.mode === 'GROUP') {
            throw new BadRequestException('Group mentorships start on a cohort date; use the cohorts list');
        }
        if (!service.durationMinutes) throw new BadRequestException('This service has no session length set');

        const tz = this.timezoneOf(service);
        const days = Math.min(MAX_RANGE_DAYS, query.days || DEFAULT_RANGE_DAYS);
        const today = parseDateKey(localDateKey(new Date(), tz))!;
        let start = query.from ? parseDateKey(query.from) : today;
        if (!start) throw new BadRequestException('from must be YYYY-MM-DD');
        if (dateKey(start) < dateKey(today)) start = today;

        const candidates: { key: string; startAt: Date; endAt: Date; minute: number }[] = [];
        for (let i = 0; i < days; i++) {
            const d = addDays(start.year, start.month, start.day, i);
            for (const slot of this.candidatesForDate(service, d)) {
                candidates.push({ key: dateKey(d), ...slot });
            }
        }

        const earliest = Date.now() + this.minNoticeMinutes(service) * 60000;
        const buffer = this.bufferMinutes(service);
        const rangeStart = candidates.length ? candidates[0].startAt : new Date();
        const rangeEnd = candidates.length ? candidates[candidates.length - 1].endAt : new Date();
        const busy = await this.busyIntervals(service.providerUserId, rangeStart, rangeEnd, buffer);

        const byDate = new Map<string, { startAt: Date; endAt: Date; time: string }[]>();
        for (const c of candidates) {
            if (c.startAt.getTime() < earliest) continue;
            const s = c.startAt.getTime() - buffer * 60000;
            const e = c.endAt.getTime() + buffer * 60000;
            if (busy.some((b) => overlaps(s, e, b.start, b.end))) continue;
            const list = byDate.get(c.key) || [];
            list.push({ startAt: c.startAt, endAt: c.endAt, time: formatMinutesToClock(c.minute) });
            byDate.set(c.key, list);
        }

        const dates: { date: string; dayOfWeek: number; slots: { startAt: Date; endAt: Date; time: string }[] }[] = [];
        for (let i = 0; i < days; i++) {
            const d = addDays(start.year, start.month, start.day, i);
            const key = dateKey(d);
            const slots = byDate.get(key) || [];
            // Packages can hide empty days ("Automatically hide unavailable slots")
            if (!slots.length && service.packageDetail?.autoHideUnavailable) continue;
            dates.push({ date: key, dayOfWeek: dayOfWeek(d.year, d.month, d.day), slots });
        }

        return {
            serviceId: service.id,
            timezone: tz,
            durationMinutes: service.durationMinutes,
            from: dateKey(start),
            days,
            dates,
        };
    }

    /** Screen C5 for cohort-based mentorships: upcoming cohorts with seats left. */
    async getCohorts(serviceId: string) {
        const service = await this.prisma.proService.findUnique({
            where: { id: serviceId },
            select: { id: true, status: true, type: true, timezone: true },
        });
        if (!service || service.status !== 'ACTIVE') throw new NotFoundException('Service not found');
        if (service.type !== 'MENTORSHIP') throw new BadRequestException('Cohorts are only for mentorships');

        const cohorts = await this.prisma.mentorshipCohort.findMany({
            where: { serviceId, isActive: true, startAt: { gt: new Date() } },
            orderBy: { startAt: 'asc' },
        });
        return {
            serviceId,
            timezone: service.timezone || 'UTC',
            cohorts: cohorts.map((c) => ({
                id: c.id,
                startAt: c.startAt,
                seatsTotal: c.seatsTotal,
                seatsLeft: Math.max(0, c.seatsTotal - c.seatsTaken),
                isFull: c.seatsTaken >= c.seatsTotal,
            })),
        };
    }

    /**
     * Every session time for one booking: 1 for a single session, N for a program
     * (spaced by its frequency from the first session).
     */
    planSessions(service: SchedulableService, firstStart: Date): PlannedSession[] {
        const duration = service.durationMinutes || 60;
        const count = service.type === 'MENTORSHIP' ? Math.max(1, service.mentorship?.sessionsCount || 1) : 1;
        const tz = this.timezoneOf(service);
        const local = toLocalParts(firstStart, tz);
        const minuteOfDay = local.hour * 60 + local.minute;

        const sessions: PlannedSession[] = [];
        for (let k = 0; k < count; k++) {
            let d = { year: local.year, month: local.month, day: local.day };
            switch (service.mentorship?.frequency) {
                case 'BIWEEKLY':
                    d = addDays(local.year, local.month, local.day, 14 * k);
                    break;
                case 'MONTHLY':
                    d = addMonths(local.year, local.month, local.day, k);
                    break;
                default: // WEEKLY and CUSTOM: weekly; the provider can reschedule single sessions
                    d = addDays(local.year, local.month, local.day, 7 * k);
            }
            const startAt = k === 0 ? firstStart : zonedTimeToUtc(d.year, d.month, d.day, minuteOfDay, tz);
            sessions.push({ startAt, endAt: new Date(startAt.getTime() + duration * 60000) });
        }
        return sessions;
    }

    /** True when a start time is one of the slots the weekly availability produces. */
    isInsideAvailability(service: SchedulableService, startAt: Date): boolean {
        const tz = this.timezoneOf(service);
        const p = toLocalParts(startAt, tz);
        return this.candidatesForDate(service, { year: p.year, month: p.month, day: p.day }).some(
            (c) => c.startAt.getTime() === startAt.getTime(),
        );
    }

    /**
     * Provider's busy time between two instants: sessions of paid bookings, live holds and
     * package sessions, across all of their services. Each interval is widened by the buffer.
     */
    async busyIntervals(
        providerUserId: string,
        from: Date,
        to: Date,
        bufferMinutes: number,
        db: Db = this.prisma,
        excludeBookingId?: string,
    ): Promise<{ start: number; end: number }[]> {
        const pad = bufferMinutes * 60000;
        const sessions = await db.serviceSession.findMany({
            where: {
                providerUserId,
                status: { in: ['SCHEDULED', 'LIVE'] },
                startAt: { lt: new Date(to.getTime() + pad) },
                endAt: { gt: new Date(from.getTime() - pad) },
                ...(excludeBookingId ? { NOT: { bookingId: excludeBookingId } } : {}),
                OR: [
                    { bookingId: null },
                    { booking: { status: { in: ['CONFIRMED', 'IN_PROGRESS'] } } },
                    { booking: { status: 'PENDING_PAYMENT', holdExpiresAt: { gt: new Date() } } },
                ],
            },
            select: { startAt: true, endAt: true },
        });
        return sessions.map((s) => ({ start: s.startAt.getTime(), end: s.endAt.getTime() }));
    }

    /** Session times from a list that clash with the provider's busy time. */
    async findConflicts(
        db: Db,
        service: SchedulableService,
        planned: PlannedSession[],
        excludeBookingId?: string,
    ): Promise<PlannedSession[]> {
        if (!planned.length) return [];
        const buffer = this.bufferMinutes(service);
        const busy = await this.busyIntervals(
            service.providerUserId,
            planned[0].startAt,
            planned[planned.length - 1].endAt,
            buffer,
            db,
            excludeBookingId,
        );
        const pad = buffer * 60000;
        return planned.filter((p) =>
            busy.some((b) => overlaps(p.startAt.getTime() - pad, p.endAt.getTime() + pad, b.start, b.end)),
        );
    }

    /** Slot start times on one local date, before notice and busy-time filtering. */
    private candidatesForDate(
        service: SchedulableService,
        d: { year: number; month: number; day: number },
    ): { startAt: Date; endAt: Date; minute: number }[] {
        const duration = service.durationMinutes || 0;
        if (duration <= 0) return [];
        const tz = this.timezoneOf(service);
        const step = duration + this.bufferMinutes(service);
        const weekday = dayOfWeek(d.year, d.month, d.day);
        const key = dateKey(d);

        const exceptions = service.availabilityExceptions.filter((e) => e.date.toISOString().slice(0, 10) === key);
        if (exceptions.some((e) => e.startMinute === null || e.endMinute === null)) return [];

        const out: { startAt: Date; endAt: Date; minute: number }[] = [];
        for (const rule of service.availabilityRules) {
            if (rule.dayOfWeek !== weekday) continue;
            for (let m = rule.startMinute; m + duration <= rule.endMinute; m += step) {
                const blocked = exceptions.some((e) => overlaps(m, m + duration, e.startMinute as number, e.endMinute as number));
                if (blocked) continue;
                const startAt = zonedTimeToUtc(d.year, d.month, d.day, m, tz);
                // Skip wall-clock times that don't exist on a daylight-saving change day
                if (!isExactLocalTime(startAt, tz, d.year, d.month, d.day, m)) continue;
                out.push({ startAt, endAt: new Date(startAt.getTime() + duration * 60000), minute: m });
            }
        }
        return out.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
    }
}
