import { PredictionCategory, PredictionProvider } from '@prisma/client';

export type PredictionMarketStatus = 'OPEN' | 'CLOSED' | 'SETTLED' | 'UNKNOWN';

export interface PredictionMarket {
  provider: PredictionProvider;
  externalMarketId: string;
  externalEventId?: string | null;
  category: PredictionCategory;
  subCategory?: string | null;
  league?: string | null;
  question: string;
  options: string[];
  closeTime?: Date | null;
  status: PredictionMarketStatus;
  resultSide?: string | null;
  volume?: number | null;
  outcomePrices?: number[] | null;
  icon?: string | null;
  image?: string | null;
  raw?: unknown;
}

export interface PredictionProviderClient {
  readonly provider: PredictionProvider;
  listMarkets(category: PredictionCategory, subCategory?: string, league?: string): Promise<PredictionMarket[]>;
  getMarket(externalMarketId: string, category?: PredictionCategory): Promise<PredictionMarket | null>;
}
