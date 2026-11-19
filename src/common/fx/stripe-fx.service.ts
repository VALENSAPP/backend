import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

/**
 * Currency conversion using Stripe's own exchange rate (Stripe FX Quotes API).
 *
 * Why: wallet credits must use the rate Stripe uses, never a third-party or hard-coded rate.
 * If Stripe cannot give a rate, this service throws FxUnavailableError — callers must defer the
 * credit (see EarningsCreditService) instead of guessing.
 *
 * Stripe docs: https://docs.stripe.com/payments/currencies/localize-prices/fx-quotes-api
 * - lock_duration=none is free (informational live rate).
 * - rates[from].exchange_rate includes Stripe's FX fee; rates[from].rate_details.base_rate does not.
 * - amount_in_to_currency = amount_in_from_currency * rate.
 * - The endpoint is a preview API: it needs a preview Stripe-Version header (STRIPE_FX_API_VERSION).
 */

export type FxRateType = 'base' | 'exchange';

export interface FxRate {
    from: string;
    to: string;
    /** Rate actually applied (base or exchange depending on rateType). */
    rate: number;
    baseRate: number;
    exchangeRate: number;
    rateType: FxRateType;
    quoteId: string | null;
    source: 'same_currency' | 'stripe_fx_quote';
    fetchedAt: Date;
}

export interface FxConversion extends FxRate {
    fromAmountMinor: number;
    toAmountMinor: number;
}

export class FxUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FxUnavailableError';
    }
}

/** Currencies without decimals in Stripe (amount is already in whole units). */
const ZERO_DECIMAL = new Set([
    'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);

function minorExponent(currency: string): number {
    return ZERO_DECIMAL.has(currency.toLowerCase()) ? 0 : 2;
}

@Injectable()
export class StripeFxService {
    private readonly logger = new Logger(StripeFxService.name);
    private readonly cache = new Map<string, { value: FxRate; expiresAt: number }>();

    private get apiVersion(): string {
        return process.env.STRIPE_FX_API_VERSION || '2026-09-30.preview';
    }

    private get cacheTtlMs(): number {
        const seconds = Number(process.env.STRIPE_FX_CACHE_SECONDS || 60);
        return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 60_000;
    }

    /**
     * Get Stripe's current rate to convert `from` → `to`.
     * @throws FxUnavailableError when Stripe does not return a usable rate.
     */
    async getRate(
        fromCurrency: string,
        toCurrency: string,
        options?: { rateType?: FxRateType; timeoutMs?: number; attempts?: number; useCache?: boolean },
    ): Promise<FxRate> {
        const from = (fromCurrency || '').trim().toLowerCase();
        const to = (toCurrency || '').trim().toLowerCase();
        const rateType: FxRateType = options?.rateType || 'exchange';

        if (!from || !to) {
            throw new FxUnavailableError(`Invalid currency pair ${fromCurrency}->${toCurrency}`);
        }

        if (from === to) {
            return {
                from,
                to,
                rate: 1,
                baseRate: 1,
                exchangeRate: 1,
                rateType,
                quoteId: null,
                source: 'same_currency',
                fetchedAt: new Date(),
            };
        }

        const cacheKey = `${from}:${to}`;
        if (options?.useCache !== false) {
            const cached = this.cache.get(cacheKey);
            if (cached && cached.expiresAt > Date.now()) {
                return this.withRateType(cached.value, rateType);
            }
        }

        const secretKey = process.env.STRIPE_SECRET_KEY;
        if (!secretKey) {
            throw new FxUnavailableError('STRIPE_SECRET_KEY is not configured');
        }

        const attempts = Math.max(1, options?.attempts ?? 2);
        const timeoutMs = options?.timeoutMs ?? 5000;
        let lastError: any;

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
                const body = new URLSearchParams();
                body.append('to_currency', to);
                body.append('from_currencies[]', from);
                body.append('lock_duration', 'none');

                const response = await axios.post('https://api.stripe.com/v1/fx_quotes', body.toString(), {
                    timeout: timeoutMs,
                    headers: {
                        Authorization: `Bearer ${secretKey}`,
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Stripe-Version': this.apiVersion,
                    },
                });

                const quote = response.data || {};
                const entry = quote?.rates?.[from];
                const exchangeRate = Number(entry?.exchange_rate);
                const baseRate = Number(entry?.rate_details?.base_rate ?? entry?.exchange_rate);

                if (!Number.isFinite(exchangeRate) || exchangeRate <= 0 || !Number.isFinite(baseRate) || baseRate <= 0) {
                    throw new FxUnavailableError(`Stripe FX quote returned no usable rate for ${from}->${to}`);
                }

                const value: FxRate = {
                    from,
                    to,
                    rate: exchangeRate,
                    baseRate,
                    exchangeRate,
                    rateType: 'exchange',
                    quoteId: typeof quote?.id === 'string' ? quote.id : null,
                    source: 'stripe_fx_quote',
                    fetchedAt: new Date(),
                };
                this.cache.set(cacheKey, { value, expiresAt: Date.now() + this.cacheTtlMs });
                return this.withRateType(value, rateType);
            } catch (error: any) {
                lastError = error;
                const stripeMessage = error?.response?.data?.error?.message;
                this.logger.warn(
                    `[StripeFx] ${from}->${to} attempt ${attempt}/${attempts} failed: ${stripeMessage || error?.message || error}`,
                );
            }
        }

        const message =
            lastError?.response?.data?.error?.message || lastError?.message || 'Stripe FX quote unavailable';
        throw new FxUnavailableError(`Stripe FX ${from}->${to} unavailable: ${message}`);
    }

    /**
     * Convert an amount in minor units using Stripe's rate.
     * @throws FxUnavailableError
     */
    async convertMinor(
        amountMinor: number,
        fromCurrency: string,
        toCurrency: string,
        options?: { rateType?: FxRateType; timeoutMs?: number; attempts?: number; useCache?: boolean },
    ): Promise<FxConversion> {
        const rate = await this.getRate(fromCurrency, toCurrency, options);
        const fromExp = minorExponent(rate.from);
        const toExp = minorExponent(rate.to);
        const fromMajor = Math.trunc(amountMinor) / 10 ** fromExp;
        const toAmountMinor = Math.round(fromMajor * rate.rate * 10 ** toExp);
        return {
            ...rate,
            fromAmountMinor: Math.trunc(amountMinor),
            toAmountMinor,
        };
    }

    private withRateType(value: FxRate, rateType: FxRateType): FxRate {
        return {
            ...value,
            rateType,
            rate: rateType === 'base' ? value.baseRate : value.exchangeRate,
        };
    }
}
