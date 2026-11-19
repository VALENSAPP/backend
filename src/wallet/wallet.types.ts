export type WalletProvider = 'STRIPE' | 'PAGBANK';

export type WalletLedgerEntryType =
    | 'PENDING_CREDIT'
    | 'AVAILABLE_CREDIT'
    | 'PENDING_TO_AVAILABLE'
    | 'PENDING_REVERSAL'
    | 'WITHDRAWAL'
    | 'WITHDRAWAL_REVERSAL';

export type WalletLedgerSource =
    | 'MARKETPLACE'
    | 'TIP'
    | 'EBOOK'
    | 'SHOP_EBOOK'
    | 'FOLLOWING'
    | 'FAN_SUBSCRIPTION'
    | 'MISSION_DONATION'
    | 'OTHER';

export type WalletLedgerRefType = 'ORDER' | 'PAYMENT' | 'WITHDRAWAL';

export interface WalletCreditParams {
    userId: string;
    amountMinor: number;
    currency?: string;
    provider?: WalletProvider;
    source: WalletLedgerSource;
    refType: WalletLedgerRefType;
    refId: string;
    note?: string;
    /** Original amount/currency before Stripe FX conversion (omit when not converted). */
    originalAmountMinor?: number;
    originalCurrency?: string;
    fxRate?: number;
    fxQuoteId?: string | null;
}
