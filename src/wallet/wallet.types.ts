export type WalletProvider = 'STRIPE' | 'PAGBANK';

export type WalletLedgerEntryType =
    | 'PENDING_CREDIT'
    | 'AVAILABLE_CREDIT'
    | 'PENDING_TO_AVAILABLE'
    | 'PENDING_REVERSAL'
    | 'WITHDRAWAL'
    | 'WITHDRAWAL_REVERSAL'
    | 'PURCHASE_DEBIT';

export type WalletLedgerSource =
    | 'MARKETPLACE'
    | 'TIP'
    | 'EBOOK'
    | 'SHOP_EBOOK'
    | 'FOLLOWING'
    | 'FAN_SUBSCRIPTION'
    | 'MISSION_DONATION'
    | 'SERVICES'
    | 'OTHER';

export type WalletLedgerRefType = 'ORDER' | 'PAYMENT' | 'WITHDRAWAL' | 'SERVICE_BOOKING' | 'SERVICE_SESSION' | 'SERVICE_REFUND';

export interface WalletCreditParams {
    userId: string;
    amountMinor: number;
    currency?: string;
    provider?: WalletProvider;
    source: WalletLedgerSource;
    refType: WalletLedgerRefType;
    refId: string;
    note?: string;
}
