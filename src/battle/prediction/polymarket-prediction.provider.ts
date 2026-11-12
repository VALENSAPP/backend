import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PredictionCategory, PredictionProvider } from '@prisma/client';
import { PredictionMarket, PredictionMarketStatus, PredictionProviderClient } from './prediction-provider.types';

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function textMatchesKeywords(text: string, keywords: string[]): boolean {
  if (!text) return false;
  return keywords.some((keyword) => {
    const escaped = escapeRegExp(keyword.trim());
    if (!escaped) return false;
    const regex = new RegExp(`(^|[^a-zA-Z0-9])${escaped}([^a-zA-Z0-9]|$)`, 'i');
    return regex.test(text);
  });
}

const SPORTS_SUBCATEGORY_KEYWORDS: Record<string, string[]> = {
  CRICKET: ['cricket', 'ipl', 't20', 'odi', 'bcci', 'icc', 'test match', 'wpl'],
  FOOTBALL: [
    'soccer', 'football', 'premier league', 'epl', 'champions league', 'la liga',
    'serie a', 'bundesliga', 'fifa', 'uefa', 'mls', 'copa', 'messi', 'ronaldo',
    'real madrid', 'barcelona', 'arsenal', 'liverpool', 'manchester', 'chelsea',
    'bayern', 'psg', 'ballon dor', 'laliga', 'cbf', 'brasileirao', 'flamengo', 'palmeiras',
  ],
  BASKETBALL: ['nba', 'basketball', 'wnba', 'euroleague', 'lakers', 'celtics', 'warriors', 'lebron', 'curry'],
  AMERICAN_FOOTBALL: [
    'nfl', 'super bowl', 'superbowl', 'quarterback', 'touchdown', 'afc', 'nfc',
    'chiefs', 'eagles', '49ers', 'mahomes', 'kelce', 'bills', 'ravens', 'cowboys',
    'packers', 'lions', 'bengals', 'pro football',
  ],
  TENNIS: ['tennis', 'atp', 'wta', 'wimbledon', 'us open', 'australian open', 'french open', 'roland garros', 'djokovic', 'alcaraz', 'sinner', 'nadal', 'federer'],
  BASEBALL: ['mlb', 'baseball', 'yankees', 'dodgers', 'world series', 'red sox', 'mets'],
  MMA_BOXING: ['ufc', 'mma', 'boxing', 'fight night', 'knockout', 'mcgregor', 'fury', 'joshua', 'tyson'],
  FORMULA1: ['f1', 'formula 1', 'formula-1', 'grand prix', 'nascar', 'verstappen', 'hamilton', 'ferrari', 'red bull', 'mclaren'],
  HOCKEY: ['nhl', 'hockey', 'stanley cup'],
  ESPORTS: ['esports', 'dota', 'cs:go', 'cs2', 'league of legends', 'lol', 'valorant', 'overwatch'],
};

const SPORTS_LEAGUE_KEYWORDS: Record<string, string[]> = {
  // Cricket
  IPL: ['ipl', 'indian premier league', 'chennai super kings', 'csk', 'royal challengers', 'rcb', 'mumbai indians', 'kolkata knight riders', 'kkr', 'rajasthan royals', 'sunrisers hyderabad', 'delhi capitals', 'punjab kings', 'gujarat titans', 'lucknow super giants'],
  T20_WORLD_CUP: ['t20 world cup', 'icc men t20', 'icc t20'],
  BBL: ['bbl', 'big bash league', 'big bash'],
  PSL: ['psl', 'pakistan super league'],
  THE_HUNDRED: ['the hundred', 'hundred cricket'],
  WPL: ['wpl', 'womens premier league', 'women premier league'],

  // Football / Soccer
  PREMIER_LEAGUE: ['premier league', 'epl', 'english premier league', 'premier-league'],
  CHAMPIONS_LEAGUE: ['champions league', 'ucl', 'uefa champions league'],
  LA_LIGA: ['la liga', 'laliga', 'la-liga', 'primera division'],
  SERIE_A: ['serie a', 'seriea', 'serie-a'],
  BUNDESLIGA: ['bundesliga'],
  MLS: ['mls', 'major league soccer'],
  FIFA_WORLD_CUP: ['fifa world cup', 'world cup 2026', 'world cup 2030'],
  EUROPA_LEAGUE: ['europa league', 'uel'],
  COPA_LIBERTADORES: ['copa libertadores', 'libertadores'],
  COPA_SUDAMERICANA: ['copa sudamericana', 'sudamericana'],
  BRASILEIRAO_SERIE_A: ['brasileirao', 'serie a brasil', 'cbf', 'brasileiro'],

  // Basketball
  NBA: ['nba', 'national basketball association'],
  WNBA: ['wnba'],
  EUROLEAGUE: ['euroleague'],

  // American Football
  NFL: ['nfl', 'national football league', 'super bowl', 'superbowl', 'pro football'],
  NCAA_FOOTBALL: ['ncaa football', 'college football', 'cfb'],

  // Baseball
  MLB: ['mlb', 'major league baseball', 'world series'],

  // Combat
  UFC: ['ufc', 'ultimate fighting championship'],
  ONE_CHAMPIONSHIP: ['one championship', 'one fc'],

  // Motorsport
  FORMULA_1: ['f1', 'formula 1', 'formula-1', 'grand prix'],
  NASCAR: ['nascar'],

  // Hockey
  NHL: ['nhl', 'national hockey league', 'stanley cup'],
};

const SPORTS_LEAGUE_TAG_SLUGS: Record<string, string> = {
  IPL: 'ipl',
  PREMIER_LEAGUE: 'premier-league',
  LA_LIGA: 'la-liga',
  CHAMPIONS_LEAGUE: 'champions-league',
  SERIE_A: 'serie-a',
  BUNDESLIGA: 'bundesliga',
  MLS: 'mls',
  NBA: 'nba',
  WNBA: 'wnba',
  NFL: 'nfl',
  MLB: 'mlb',
  UFC: 'ufc',
  FORMULA_1: 'formula-1',
  NHL: 'nhl',
};

const SPORTS_TAG_SLUGS: Record<string, string> = {
  CRICKET: 'cricket',
  FOOTBALL: 'soccer',
  BASKETBALL: 'nba',
  AMERICAN_FOOTBALL: 'nfl',
  TENNIS: 'tennis',
  BASEBALL: 'mlb',
  MMA_BOXING: 'ufc',
  FORMULA1: 'formula-1',
  HOCKEY: 'nhl',
  ESPORTS: 'esports',
};

interface CacheEntry {
  expiresAt: number;
  data: any;
}

@Injectable()
export class PolymarketPredictionProvider implements PredictionProviderClient {
  readonly provider = PredictionProvider.POLYMARKET;
  private readonly logger = new Logger(PolymarketPredictionProvider.name);

  private readonly baseUrl: string;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs = 3 * 60 * 1000; // 3 minutes cache

  constructor(private readonly configService: ConfigService) {
    this.baseUrl = (
      this.configService.get<string>('POLYMARKET_GAMMA_API_BASE_URL')
      || 'https://gamma-api.polymarket.com'
    ).replace(/\/$/, '');
  }

  async listMarkets(category: PredictionCategory, subCategory?: string, league?: string): Promise<PredictionMarket[]> {
    const normalizedSubCategory = this.normalizeSubCategoryKey(subCategory);
    const normalizedLeague = this.normalizeLeagueKey(league);
    const cacheKey = `list_${category}_${normalizedSubCategory || 'none'}_${normalizedLeague || 'none'}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    const tagSlug = this.getTagSlug(category, normalizedSubCategory, normalizedLeague);
    const rawMarkets: any[] = [];
    const seenIds = new Set<string>();

    const appendItems = (items: any[]) => {
      for (const item of items) {
        const id = String(item?.id || item?.conditionId || item?.slug || '').trim();
        if (id && !seenIds.has(id)) {
          seenIds.add(id);
          rawMarkets.push(item);
        }
      }
    };

    // 1. Fetch from /markets
    try {
      const marketParams = new URLSearchParams({
        active: 'true',
        closed: 'false',
        limit: '100',
        order: 'volume24hr',
        ascending: 'false',
      });
      if (tagSlug && tagSlug !== 'all') {
        marketParams.set('tag_slug', tagSlug);
      }

      const marketsJson = await this.fetchWithRetry(`/markets?${marketParams.toString()}`);
      if (Array.isArray(marketsJson)) {
        appendItems(marketsJson);
      }
    } catch (err: any) {
      this.logger.debug(`Polymarket markets query with tag ${tagSlug} failed: ${err?.message}`);
    }

    // 2. Also fetch from /events for rich event groups (especially sports, awards, politics)
    try {
      const eventParams = new URLSearchParams({
        active: 'true',
        closed: 'false',
        limit: '50',
        order: 'volume24hr',
        ascending: 'false',
      });
      if (tagSlug && tagSlug !== 'all') {
        eventParams.set('tag_slug', tagSlug);
      }

      const eventsJson = await this.fetchWithRetry(`/events?${eventParams.toString()}`);
      if (Array.isArray(eventsJson)) {
        for (const event of eventsJson) {
          if (Array.isArray(event.markets)) {
            for (const childMarket of event.markets) {
              const enhanced = {
                ...childMarket,
                eventTitle: event.title,
                eventSlug: event.slug,
                image: childMarket.image || event.image,
                icon: childMarket.icon || event.icon,
                tags: childMarket.tags || event.tags,
              };
              appendItems([enhanced]);
            }
          }
        }
      }
    } catch (err: any) {
      this.logger.debug(`Polymarket events fetch skipped or failed: ${err?.message}`);
    }

    // 3. Fallback: If 0 items, query global markets without tag_slug
    if (rawMarkets.length === 0) {
      try {
        const fallbackParams = new URLSearchParams({
          active: 'true',
          closed: 'false',
          limit: '100',
          order: 'volume24hr',
          ascending: 'false',
        });
        const fallbackJson = await this.fetchWithRetry(`/markets?${fallbackParams.toString()}`);
        if (Array.isArray(fallbackJson)) appendItems(fallbackJson);
      } catch (err: any) {
        this.logger.warn(`Polymarket fallback query failed: ${err?.message}`);
      }
    }

    const mapped = rawMarkets
      .map((market: any) => this.toPredictionMarket(market, category))
      .filter((market: PredictionMarket | null): market is PredictionMarket => !!market)
      .filter((market: PredictionMarket) => this.isOpenFutureMarket(market))
      .filter((market: PredictionMarket) => this.matchesCategory(market.raw, category))
      .filter((market: PredictionMarket) => this.matchesSubCategory(market, normalizedSubCategory))
      .filter((market: PredictionMarket) => this.matchesLeague(market, normalizedLeague));

    // Sort by volume descending, then closeTime
    mapped.sort((a, b) => {
      const volA = a.volume || 0;
      const volB = b.volume || 0;
      if (volA !== volB) return volB - volA;
      const timeA = a.closeTime ? a.closeTime.getTime() : Number.MAX_SAFE_INTEGER;
      const timeB = b.closeTime ? b.closeTime.getTime() : Number.MAX_SAFE_INTEGER;
      return timeA - timeB;
    });

    this.setInCache(cacheKey, mapped, this.cacheTtlMs);
    return mapped;
  }

  async getMarket(externalMarketId: string, category?: PredictionCategory): Promise<PredictionMarket | null> {
    const cleanId = String(externalMarketId || '').trim();
    if (!cleanId) return null;

    try {
      const params = new URLSearchParams({ id: cleanId });
      const response = await this.fetchWithRetry(`/markets?${params.toString()}`);
      const market = Array.isArray(response) ? response[0] : response;
      if (market) {
        return this.toPredictionMarket(market, category || this.inferCategory(market));
      }

      // Try slug lookup
      const slugParams = new URLSearchParams({ slug: cleanId });
      const slugResponse = await this.fetchWithRetry(`/markets?${slugParams.toString()}`);
      const slugMarket = Array.isArray(slugResponse) ? slugResponse[0] : slugResponse;
      if (slugMarket) {
        return this.toPredictionMarket(slugMarket, category || this.inferCategory(slugMarket));
      }
    } catch (e: any) {
      this.logger.error(`Failed to get Polymarket market ${cleanId}: ${e.message}`);
    }

    return null;
  }

  private async fetchWithRetry(path: string, retries = 3): Promise<any> {
    const fullUrl = `${this.baseUrl}${path}`;

    for (let attempt = 0; attempt < retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);

      try {
        const response = await fetch(fullUrl, {
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
        });

        clearTimeout(timer);

        if (response.ok) {
          return await response.json();
        }

        if (attempt === retries - 1) {
          throw new ServiceUnavailableException(`Polymarket provider returned HTTP ${response.status}`);
        }
      } catch (err: any) {
        clearTimeout(timer);
        if (attempt === retries - 1) {
          throw new ServiceUnavailableException(`Polymarket provider unavailable: ${err?.message || err}`);
        }
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
  }

  private toPredictionMarket(market: any, category: PredictionCategory): PredictionMarket | null {
    const externalMarketId = String(market?.id || market?.conditionId || market?.slug || '').trim();
    let question = String(market?.question || market?.title || '').trim();
    if (!externalMarketId || !question) return null;

    // If question is just "Yes" or short child item, prepend eventTitle
    if (market?.eventTitle && (question.length < 10 || question.toLowerCase() === 'yes' || question.toLowerCase() === 'no')) {
      question = `${market.eventTitle}: ${market.groupItemTitle || question}`;
    }

    const options = this.parseJsonArray(market?.outcomes);
    if (options.length < 2) return null;

    const closeTimeValue = market?.endDate || market?.end_date || market?.closedTime;
    const closeTime = closeTimeValue ? new Date(closeTimeValue) : null;
    const resultSide = this.extractResultSide(market, options);
    const subCategory = this.inferSubCategory(market, category);
    const league = this.inferLeague(market, category);

    const volume = Number(market?.volume24hr || market?.volume || 0);
    const outcomePrices = this.parseOutcomePrices(market?.outcomePrices);
    const icon = market?.icon || market?.image || null;
    const image = market?.image || null;

    return {
      provider: this.provider,
      externalMarketId,
      externalEventId: market?.eventId || market?.event_id || market?.conditionId || null,
      category,
      subCategory,
      league,
      question,
      options,
      closeTime: closeTime && !Number.isNaN(closeTime.getTime()) ? closeTime : null,
      status: this.normalizeStatus(market, resultSide),
      resultSide,
      volume: Number.isFinite(volume) ? volume : null,
      outcomePrices: outcomePrices.length ? outcomePrices : null,
      icon,
      image,
      raw: market,
    };
  }

  private parseOutcomePrices(pricesRaw: unknown): number[] {
    const prices = this.parseJsonArray(pricesRaw);
    return prices.map((p) => {
      const num = Number(p);
      return Number.isFinite(num) ? Math.round(num * 100) / 100 : 0;
    });
  }

  private parseJsonArray(value: unknown): string[] {
    if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
    if (typeof value !== 'string') return [];

    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((entry) => String(entry).trim()).filter(Boolean);
    } catch {
      return value.split(',').map((entry) => entry.trim()).filter(Boolean);
    }
  }

  private extractResultSide(market: any, options: string[]): string | null {
    const directResult = [
      market?.winner,
      market?.winningOutcome,
      market?.winning_outcome,
      market?.resolvedOutcome,
      market?.resolved_outcome,
    ]
      .map((value) => String(value || '').trim())
      .find(Boolean);

    if (directResult) {
      return options.find((option) => option.toLowerCase() === directResult.toLowerCase()) || directResult;
    }

    const outcomePrices = this.parseJsonArray(market?.outcomePrices)
      .map((price) => Number(price))
      .map((price) => (Number.isFinite(price) ? price : 0));

    const isClosed = market?.closed === true || String(market?.closed || '').toLowerCase() === 'true';
    if (!isClosed || outcomePrices.length !== options.length) return null;

    const maxPrice = Math.max(...outcomePrices);
    if (maxPrice < 0.99) return null;
    const winnerIndex = outcomePrices.findIndex((price) => price === maxPrice);
    return options[winnerIndex] || null;
  }

  private normalizeStatus(market: any, resultSide: string | null): PredictionMarketStatus {
    if (resultSide) return 'SETTLED';
    const closed = market?.closed === true || String(market?.closed || '').toLowerCase() === 'true';
    if (closed) return 'CLOSED';
    const active = market?.active === true || String(market?.active || '').toLowerCase() === 'true';
    if (active) return 'OPEN';
    return 'UNKNOWN';
  }

  private isOpenFutureMarket(market: PredictionMarket): boolean {
    return market.status === 'OPEN'
      && !!market.closeTime
      && market.closeTime.getTime() > Date.now();
  }

  private getTagSlug(category: PredictionCategory, normalizedSubCategory?: string | null, normalizedLeague?: string | null): string {
    if (category === PredictionCategory.SPORTS) {
      if (normalizedLeague && SPORTS_LEAGUE_TAG_SLUGS[normalizedLeague]) {
        return SPORTS_LEAGUE_TAG_SLUGS[normalizedLeague];
      }
      if (normalizedSubCategory && SPORTS_TAG_SLUGS[normalizedSubCategory]) {
        return SPORTS_TAG_SLUGS[normalizedSubCategory];
      }
      return 'sports';
    }

    const tags: Record<PredictionCategory, string> = {
      [PredictionCategory.SPORTS]: 'sports',
      [PredictionCategory.FINANCE]: 'finance',
      [PredictionCategory.ELECTIONS]: 'politics',
      [PredictionCategory.POLITICS]: 'politics',
      [PredictionCategory.CRYPTO]: 'crypto',
      [PredictionCategory.TECH_AI]: 'ai',
      [PredictionCategory.POP_CULTURE]: 'pop-culture',
      [PredictionCategory.SCIENCE]: 'science',
      [PredictionCategory.GLOBAL_AFFAIRS]: 'world',
      [PredictionCategory.ENTERTAINMENT]: 'entertainment',
      [PredictionCategory.ECONOMY]: 'economy',
    };
    return tags[category] || 'all';
  }

  private getSearchableText(market: any): string {
    const parts: string[] = [];
    if (market?.question) parts.push(String(market.question));
    if (market?.title) parts.push(String(market.title));
    if (market?.description) parts.push(String(market.description));
    if (market?.slug) parts.push(String(market.slug).replace(/[-_]/g, ' '));
    if (market?.eventTitle) parts.push(String(market.eventTitle));
    if (market?.category) parts.push(String(market.category));
    if (Array.isArray(market?.tags)) {
      for (const tag of market.tags) {
        if (typeof tag === 'string') parts.push(tag);
        else if (tag?.label || tag?.slug || tag?.name) parts.push(String(tag.label || tag.slug || tag.name));
      }
    }
    if (Array.isArray(market?.events)) {
      for (const event of market.events) {
        if (event?.title) parts.push(String(event.title));
        if (event?.description) parts.push(String(event.description));
        if (event?.slug) parts.push(String(event.slug).replace(/[-_]/g, ' '));
        if (event?.seriesSlug) parts.push(String(event.seriesSlug).replace(/[-_]/g, ' '));
      }
    }
    return parts.join(' ');
  }

  private matchesCategory(raw: unknown, category: PredictionCategory): boolean {
    const text = this.getSearchableText(raw);

    const keywordsByCategory: Record<PredictionCategory, string[]> = {
      [PredictionCategory.SPORTS]: [
        'sport', 'sports', 'cricket', 'ipl', 'nba', 'nfl', 'mlb', 'nhl',
        'soccer', 'football', 'tennis', 'ufc', 'fifa', 'formula 1', 'f1',
        'boxing', 'mma', 'basketball', 'baseball', 'la liga', 'premier league',
        'champions league', 'super bowl', 'touchdown', 'quarterback', 'cbf',
        'brasileirao', 'copa',
      ],
      [PredictionCategory.FINANCE]: [
        'finance', 'economy', 'economic', 'fed', 'inflation', 'cpi', 'interest rate',
        'rate cut', 'stock', 'nasdaq', 's&p', 'gdp', 'fomc', 'market cap', 'ipo',
        'revenue', 'earnings',
      ],
      [PredictionCategory.ELECTIONS]: [
        'election', 'elections', 'politics', 'political', 'president', 'senate',
        'house', 'congress', 'governor', 'mayor', 'vote', 'ballot', 'poll',
      ],
      [PredictionCategory.POLITICS]: [
        'politics', 'political', 'election', 'elections', 'president', 'presidential',
        'senate', 'house of representatives', 'congress', 'governor', 'mayor',
        'prime minister', 'parliament', 'democrat', 'republican', 'trump', 'biden',
        'white house', 'supreme court', 'vote', 'policy', 'legislation',
      ],
      [PredictionCategory.CRYPTO]: [
        'crypto', 'cryptocurrency', 'bitcoin', 'btc', 'ethereum', 'eth',
        'solana', 'sol', 'xrp', 'doge', 'binance', 'coinbase', 'token',
        'altcoin', 'defi', 'blockchain',
      ],
      [PredictionCategory.TECH_AI]: [
        'ai', 'artificial intelligence', 'openai', 'chatgpt', 'gpt', 'claude',
        'anthropic', 'google', 'gemini', 'meta', 'apple', 'microsoft',
        'nvidia', 'semiconductor', 'quantum', 'robotics', 'tesla', 'musk',
        'software', 'tech', 'startup',
      ],
      [PredictionCategory.POP_CULTURE]: [
        'pop culture', 'celebrity', 'music', 'movie', 'film', 'box office',
        'oscar', 'oscars', 'grammy', 'grammys', 'emmy', 'hollywood',
        'taylor swift', 'travis kelce', 'kanye', 'drake', 'netflix', 'spotify',
        'billboard', 'actor', 'actress', 'concert', 'album',
      ],
      [PredictionCategory.SCIENCE]: [
        'science', 'space', 'spacex', 'nasa', 'mars', 'moon', 'starship',
        'climate', 'temperature', 'physics', 'biology', 'medicine', 'fda',
        'vaccine', 'energy', 'fusion', 'astronomy',
      ],
      [PredictionCategory.GLOBAL_AFFAIRS]: [
        'geopolitics', 'world', 'international', 'war', 'peace', 'treaty',
        'nato', 'un', 'united nations', 'china', 'russia', 'ukraine',
        'israel', 'gaza', 'iran', 'taiwan', 'sanctions', 'diplomacy',
      ],
      [PredictionCategory.ENTERTAINMENT]: [
        'entertainment', 'gaming', 'video games', 'gta', 'playstation',
        'xbox', 'nintendo', 'tv show', 'series', 'anime', 'streaming',
        'disney', 'marvel', 'dc', 'youtube', 'tiktok',
      ],
      [PredictionCategory.ECONOMY]: [
        'economy', 'economic', 'gdp', 'inflation', 'cpi', 'interest rate',
        'fed', 'federal reserve', 'rate cut', 'rate hike', 'recession',
        'unemployment', 'jobs report', 'central bank',
      ],
    };

    return textMatchesKeywords(text, keywordsByCategory[category]);
  }

  private normalizeSubCategoryKey(subCategory?: string | null): string | null {
    if (!subCategory) return null;
    const clean = subCategory.trim().toUpperCase().replace(/[\s-_]+/g, '_');
    if (clean === 'ALL') return null;

    if (clean === 'SOCCER') return 'FOOTBALL';
    if (clean === 'BOXING' || clean === 'UFC' || clean === 'MMA') return 'MMA_BOXING';
    if (clean === 'F1' || clean === 'FORMULA_1' || clean === 'MOTORSPORT') return 'FORMULA1';

    for (const key of Object.keys(SPORTS_SUBCATEGORY_KEYWORDS)) {
      if (key === clean) return key;
    }

    for (const [key, keywords] of Object.entries(SPORTS_SUBCATEGORY_KEYWORDS)) {
      if (keywords.some((k) => k.toUpperCase().replace(/\s+/g, '_') === clean)) {
        return key;
      }
    }

    return clean;
  }

  private normalizeLeagueKey(league?: string | null): string | null {
    if (!league) return null;
    const clean = league.trim().toUpperCase().replace(/[\s-_]+/g, '_');
    if (clean === 'ALL') return null;

    if (clean === 'EPL') return 'PREMIER_LEAGUE';
    if (clean === 'UCL') return 'CHAMPIONS_LEAGUE';
    if (clean === 'UEL') return 'EUROPA_LEAGUE';
    if (clean === 'F1' || clean === 'FORMULA1') return 'FORMULA_1';

    for (const key of Object.keys(SPORTS_LEAGUE_KEYWORDS)) {
      if (key === clean) return key;
    }

    for (const [key, keywords] of Object.entries(SPORTS_LEAGUE_KEYWORDS)) {
      if (keywords.some((k) => k.toUpperCase().replace(/[\s-_]+/g, '_') === clean)) {
        return key;
      }
    }

    return clean;
  }

  private inferSubCategory(market: any, category: PredictionCategory): string | null {
    if (category !== PredictionCategory.SPORTS) return null;

    const text = this.getSearchableText(market);
    for (const [subCat, keywords] of Object.entries(SPORTS_SUBCATEGORY_KEYWORDS)) {
      if (textMatchesKeywords(text, keywords)) {
        return subCat;
      }
    }

    return 'OTHER';
  }

  private inferLeague(market: any, category: PredictionCategory): string | null {
    if (category !== PredictionCategory.SPORTS) return null;

    const text = this.getSearchableText(market);
    for (const [leagueKey, keywords] of Object.entries(SPORTS_LEAGUE_KEYWORDS)) {
      if (textMatchesKeywords(text, keywords)) {
        return leagueKey;
      }
    }

    return null;
  }

  private matchesSubCategory(market: PredictionMarket, normalizedSubCategory?: string | null): boolean {
    if (!normalizedSubCategory) return true;
    if (market.subCategory && market.subCategory === normalizedSubCategory) return true;

    const keywords = SPORTS_SUBCATEGORY_KEYWORDS[normalizedSubCategory] || [normalizedSubCategory.toLowerCase()];
    const text = this.getSearchableText(market.raw);
    return textMatchesKeywords(text, keywords);
  }

  private matchesLeague(market: PredictionMarket, normalizedLeague?: string | null): boolean {
    if (!normalizedLeague) return true;
    if (market.league && market.league === normalizedLeague) return true;

    const keywords = SPORTS_LEAGUE_KEYWORDS[normalizedLeague] || [normalizedLeague.toLowerCase()];
    const text = this.getSearchableText(market.raw);
    return textMatchesKeywords(text, keywords);
  }

  private inferCategory(market: any): PredictionCategory {
    const text = this.getSearchableText(market);
    if (textMatchesKeywords(text, ['sport', 'cricket', 'ipl', 'nba', 'nfl', 'mlb', 'nhl', 'soccer', 'football', 'tennis', 'ufc', 'f1', 'basketball', 'baseball'])) {
      return PredictionCategory.SPORTS;
    }
    if (textMatchesKeywords(text, ['crypto', 'bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'xrp'])) {
      return PredictionCategory.CRYPTO;
    }
    if (textMatchesKeywords(text, ['ai', 'artificial intelligence', 'openai', 'chatgpt', 'nvidia'])) {
      return PredictionCategory.TECH_AI;
    }
    if (textMatchesKeywords(text, ['celebrity', 'oscar', 'grammy', 'taylor swift', 'music', 'movie', 'box office'])) {
      return PredictionCategory.POP_CULTURE;
    }
    if (textMatchesKeywords(text, ['election', 'president', 'senate', 'house', 'politics', 'vote'])) {
      return PredictionCategory.POLITICS;
    }
    return PredictionCategory.FINANCE;
  }

  private getFromCache(key: string): any | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  private setInCache(key: string, data: any, ttlMs: number): void {
    this.cache.set(key, {
      expiresAt: Date.now() + ttlMs,
      data,
    });
  }
}
