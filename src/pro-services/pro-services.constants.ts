import { ProServiceType } from '@prisma/client';

/** S3 folders used by the Services module. */
export const PRO_SERVICES_S3_FOLDERS = {
    cover: 'pro-services/covers',
    attachments: 'pro-services/attachments',
} as const;

/**
 * Valens fee per service type (fraction of the price, taken from the provider's share).
 * Client spreadsheet: 15% for mentorships, consultations, appointments and monthly packages,
 * 6.99% per event ticket, 0 for free events. Each can be overridden from .env.
 */
export function getServiceFeePercent(type: ProServiceType): number {
    const read = (key: string, fallback: number) => {
        const raw = process.env[key];
        const value = raw === undefined || raw === '' ? NaN : Number(raw);
        return Number.isFinite(value) && value >= 0 && value < 1 ? value : fallback;
    };

    switch (type) {
        case 'MENTORSHIP':
            return read('SERVICES_FEE_PERCENT_MENTORSHIP', 0.15);
        case 'CONSULTATION':
            return read('SERVICES_FEE_PERCENT_CONSULTATION', 0.15);
        case 'APPOINTMENT':
            return read('SERVICES_FEE_PERCENT_APPOINTMENT', 0.15);
        case 'EVENT':
            return read('SERVICES_FEE_PERCENT_EVENT', 0.0699);
        case 'MONTHLY_PACKAGE':
            return read('SERVICES_FEE_PERCENT_MONTHLY_PACKAGE', 0.15);
        default:
            return 0.15;
    }
}

/** Categories shown in the create wizards. "Custom" lets the provider type their own. */
export const APPOINTMENT_CATEGORIES = [
    'Beauty & Aesthetics',
    'Hair & Styling',
    'Nails',
    'Makeup',
    'Wellness',
    'Custom Appointment',
] as const;

export const EVENT_CATEGORIES = [
    'Birthday Party',
    'Bachelorette Party',
    'Corporate Event',
    'Theater / Show',
    'Nightclub Entry',
    'Concert / Festival',
    'Workshop / Class',
    'Other Event',
] as const;

/** Goal chips on the mentorship Program Details screen; "Other (Custom)" lets the user type their own. */
export const MENTORSHIP_GOALS = [
    'Business Growth',
    'Leadership',
    'Career Growth',
    'Marketing',
    'Sales',
    'Finance',
    'Startup',
    'Personal Development',
    'Mindset',
    'Other (Custom)',
] as const;

export const MENTORSHIP_SESSION_DURATIONS = [30, 60, 90] as const;

/** Program lengths offered in the mentorship wizard, in weeks. */
export const MENTORSHIP_PROGRAM_LENGTHS = {
    SHORT_PROGRAM: [2, 4],
    LONG_PROGRAM: [12, 24, 52],
} as const;

/** Membership grace period before a lapsed provider's services are disabled. */
export const MEMBERSHIP_GRACE_DAYS = Number(process.env.SERVICES_MEMBERSHIP_GRACE_DAYS || 7);

export const SERVICE_TYPE_LABELS: Record<ProServiceType, string> = {
    MENTORSHIP: 'Mentorships',
    CONSULTATION: 'Consultations',
    APPOINTMENT: 'Appointments',
    EVENT: 'Events',
    MONTHLY_PACKAGE: 'Monthly Packages',
};

/** Limits that keep inputs sane. */
export const LIMITS = {
    titleMax: 120,
    includedItemsMax: 20,
    goalsMax: 10,
    ticketTypesMax: 10,
    cohortsMax: 20,
    attachmentsMax: 10,
    rulesPerDayMax: 12,
    exceptionsMax: 100,
    maxPriceMinor: 100_000_00, // 100,000.00 in any currency
} as const;
