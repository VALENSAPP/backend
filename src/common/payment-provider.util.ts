export type PaymentProvider = 'STRIPE' | 'PAGBANK';

const BRAZIL_ALIASES = new Set([
    'br',
    'bra',
    'brazil',
    'brasil',
    'brésil',
    'bresil',
]);

/**
 * Normalize free-form country / origin input to ISO-ish alpha-2 when possible.
 * Accepts: "BR", "Brazil", "Brasil", and location strings containing those.
 */
export function normalizeCountryCode(input?: string | null): string | null {
    if (!input) return null;
    const raw = input.trim();
    if (!raw) return null;

    const lower = raw.toLowerCase();

    // Exact / short codes
    if (BRAZIL_ALIASES.has(lower)) return 'BR';
    if (/^[a-z]{2}$/i.test(raw)) return raw.toUpperCase();
    if (/^[a-z]{3}$/i.test(raw)) return raw.toUpperCase();

    // Location-like: "São Paulo, Brazil" / "Brazil" / "BR, ..."
    const parts = lower.split(/[,|/]/).map((p) => p.trim()).filter(Boolean);
    for (const part of parts) {
        if (BRAZIL_ALIASES.has(part)) return 'BR';
        if (/^[a-z]{2}$/.test(part) && part === 'br') return 'BR';
    }

    if (/\bbrazil\b/.test(lower) || /\bbrasil\b/.test(lower)) return 'BR';

    // Last token as country name code guess (non-BR leave as uppercase 2-letter or 3-letter if present)
    const last = parts[parts.length - 1];
    if (last && (/^[a-z]{2}$/.test(last) || /^[a-z]{3}$/.test(last))) return last.toUpperCase();

    return null;
}

export function resolvePaymentProviderFromCountry(country?: string | null): PaymentProvider {
    const code = normalizeCountryCode(country);
    return code === 'BR' ? 'PAGBANK' : 'STRIPE';
}

/**
 * Resolve payment provider specifically from KYC verified document country.
 * Returns normalized country and provider ('PAGBANK' for Brazil, 'STRIPE' for others).
 */
export function resolveKycPaymentProvider(docCountry?: string | null): {
    normalizedCountry: string | null;
    paymentProvider: PaymentProvider;
} {
    const normalizedCountry = normalizeCountryCode(docCountry);
    const paymentProvider = resolvePaymentProviderFromCountry(normalizedCountry);
    return {
        normalizedCountry,
        paymentProvider,
    };
}

export function resolvePaymentProviderFromOrigin(params: {
    country?: string | null;
    location?: string | null;
}): { country: string | null; paymentProvider: PaymentProvider } {
    const fromCountry = normalizeCountryCode(params.country);
    const fromLocation = normalizeCountryCode(params.location);
    const country = fromCountry || fromLocation;
    return {
        country,
        paymentProvider: resolvePaymentProviderFromCountry(country),
    };
}
