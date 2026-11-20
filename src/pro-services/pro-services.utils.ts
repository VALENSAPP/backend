import { BadRequestException } from '@nestjs/common';
import { normalizeCountryCode } from '../common/payment-provider.util';

/** 19.99 -> 1999 */
export function toMinor(major: number): number {
    return Math.round(Number(Number(major).toFixed(2)) * 100);
}

/** 1999 -> 19.99 */
export function toMajor(minor: number | null | undefined): number {
    return Number(((minor || 0) / 100).toFixed(2));
}

/** Services are priced in BRL for Brazilian users and USD for everyone else. */
export function resolveServiceCurrency(country?: string | null): 'brl' | 'usd' {
    return normalizeCountryCode(country) === 'BR' ? 'brl' : 'usd';
}

/** "09:30" -> 570 */
export function parseClockToMinutes(value: string, field = 'time'): number {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec((value || '').trim());
    if (!match) {
        throw new BadRequestException(`${field} must be in HH:mm format (00:00 to 23:59)`);
    }
    return Number(match[1]) * 60 + Number(match[2]);
}

/** 570 -> "09:30" */
export function formatMinutesToClock(minutes: number): string {
    const safe = Math.max(0, Math.min(24 * 60, Math.trunc(minutes)));
    const h = Math.floor(safe / 60);
    const m = safe % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function isValidTimeZone(tz?: string | null): boolean {
    if (!tz) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

export function assertTimeZone(tz?: string | null): string {
    if (!isValidTimeZone(tz)) {
        throw new BadRequestException('timezone must be a valid IANA time zone, e.g. "America/Sao_Paulo"');
    }
    return tz as string;
}

/** Same Persona / Business rule the billing module uses. */
export function isBusinessAccount(profile?: string | null, hasCompanyProfile = false): boolean {
    const normalized = (profile || '').trim().toLowerCase();
    return hasCompanyProfile || normalized === 'company' || normalized === 'business';
}

/** Strips empty strings and trims each entry; de-duplicates while keeping order. */
export function cleanStringList(values: string[] | undefined | null, max: number): string[] {
    if (!values) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of values) {
        const value = String(raw ?? '').trim();
        if (!value || seen.has(value.toLowerCase())) continue;
        seen.add(value.toLowerCase());
        out.push(value);
        if (out.length >= max) break;
    }
    return out;
}

export function getUserId(req: { user?: unknown }): string {
    const user = (req.user || {}) as { userId?: string; sub?: string; id?: string };
    return user.userId || user.sub || user.id || '';
}
