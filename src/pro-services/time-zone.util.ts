/**
 * Small time-zone helpers built on Intl (no extra library).
 * A "local" date/time means wall-clock time in an IANA zone, e.g. 10:00 in America/New_York.
 */

export interface LocalParts {
    year: number;
    month: number; // 1-12
    day: number;
    hour: number;
    minute: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
    let f = formatterCache.get(timeZone);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
        formatterCache.set(timeZone, f);
    }
    return f;
}

/** Wall-clock parts of a UTC instant in a zone. */
export function toLocalParts(instant: Date, timeZone: string): LocalParts {
    const parts = formatter(timeZone).formatToParts(instant);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value || 0);
    return {
        year: get('year'),
        month: get('month'),
        day: get('day'),
        hour: get('hour') % 24,
        minute: get('minute'),
    };
}

/** Offset of the zone from UTC at an instant, in minutes (e.g. -300 for New York in winter). */
function offsetMinutes(instant: Date, timeZone: string): number {
    const p = toLocalParts(instant, timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    return Math.round((asUtc - Math.floor(instant.getTime() / 60000) * 60000) / 60000);
}

/**
 * Wall-clock time in a zone -> UTC instant.
 * Handles daylight-saving changes. A wall-clock time that doesn't exist (spring forward) can't be
 * represented exactly; use isExactLocalTime() to detect and skip it.
 */
export function zonedTimeToUtc(year: number, month: number, day: number, minuteOfDay: number, timeZone: string): Date {
    const hour = Math.floor(minuteOfDay / 60);
    const minute = minuteOfDay % 60;
    const naive = Date.UTC(year, month - 1, day, hour, minute);
    let result = naive - offsetMinutes(new Date(naive), timeZone) * 60000;
    // Second pass corrects when the first guess crossed a DST boundary
    const corrected = naive - offsetMinutes(new Date(result), timeZone) * 60000;
    if (corrected !== result) result = corrected;
    return new Date(result);
}

/** True when the instant shows exactly this wall-clock date and time in the zone. */
export function isExactLocalTime(
    instant: Date,
    timeZone: string,
    year: number,
    month: number,
    day: number,
    minuteOfDay: number,
): boolean {
    const p = toLocalParts(instant, timeZone);
    return p.year === year && p.month === month && p.day === day && p.hour * 60 + p.minute === minuteOfDay;
}

/** "2026-12-24" in a zone for a UTC instant. */
export function localDateKey(instant: Date, timeZone: string): string {
    const p = toLocalParts(instant, timeZone);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Day of week (0 = Sunday) of a calendar date. */
export function dayOfWeek(year: number, month: number, day: number): number {
    return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Adds calendar days to a Y-M-D (no time zone involved). */
export function addDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
    const d = new Date(Date.UTC(year, month - 1, day + days));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Adds calendar months, clamping to the last day of the month (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(year: number, month: number, day: number, months: number): { year: number; month: number; day: number } {
    const first = new Date(Date.UTC(year, month - 1 + months, 1));
    const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    return { year: first.getUTCFullYear(), month: first.getUTCMonth() + 1, day: Math.min(day, lastDay) };
}

export function parseDateKey(key: string): { year: number; month: number; day: number } | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || '');
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
    return { year, month, day };
}

export function dateKey(d: { year: number; month: number; day: number }): string {
    return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

/** True when [aStart, aEnd) and [bStart, bEnd) overlap. */
export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
    return aStart < bEnd && bStart < aEnd;
}
