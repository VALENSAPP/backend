import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PredictionCategory, PredictionProvider } from '@prisma/client';
import * as https from 'node:https';
import * as http from 'node:http';
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

  // Basketball
  NBA: ['nba', 'national basketball association'],
  WNBA: ['wnba'],
  EUROLEAGUE: ['euroleague'],

  // American Football
  NFL: ['nfl', 'national football league', 'super bowl', 'superbowl'],
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

const SPORTS_SUBCATEGORY_KEYWORDS: Record<string, string[]> = {
  CRICKET: ['cricket', 'ipl', 't20', 'odi', 'bcci', 'icc', 'test match', 'wpl'],
  FOOTBALL: [
    'soccer', 'football', 'premier league', 'epl', 'champions league', 'la liga',
    'serie a', 'bundesliga', 'fifa', 'uefa', 'mls', 'copa', 'messi', 'ronaldo',
    'real madrid', 'barcelona', 'arsenal', 'liverpool', 'manchester', 'chelsea',
    'bayern', 'psg', 'ballon dor', 'laliga',
  ],
  BASKETBALL: ['nba', 'basketball', 'wnba', 'euroleague', 'lakers', 'celtics', 'warriors', 'lebron', 'curry'],
  AMERICAN_FOOTBALL: ['nfl', 'super bowl', 'quarterback', 'touchdown', 'afc', 'nfc', 'chiefs', 'eagles', '49ers', 'mahomes'],
  TENNIS: ['tennis', 'atp', 'wta', 'wimbledon', 'us open', 'australian open', 'french open', 'roland garros', 'djokovic', 'alcaraz', 'sinner', 'nadal', 'federer'],
  BASEBALL: ['mlb', 'baseball', 'yankees', 'dodgers', 'world series', 'red sox', 'mets'],
  MMA_BOXING: ['ufc', 'mma', 'boxing', 'fight night', 'knockout', 'mcgregor', 'fury', 'joshua', 'tyson'],
  FORMULA1: ['f1', 'formula 1', 'formula-1', 'grand prix', 'nascar', 'verstappen', 'hamilton', 'ferrari', 'red bull', 'mclaren'],
  HOCKEY: ['nhl', 'hockey', 'stanley cup'],
  ESPORTS: ['esports', 'dota', 'cs:go', 'cs2', 'league of legends', 'lol', 'valorant', 'overwatch'],
};

@Injectable()
export class ManifoldPredictionProvider implements PredictionProviderClient {
  readonly provider = PredictionProvider.MANIFOLD;

  private readonly baseUrl: string;

  constructor(private readonly configService: ConfigService) {
    let url = (
      this.configService.get<string>('MANIFOLD_API_BASE_URL')
      || 'https://api.manifold.markets'
    ).trim().replace(/\/$/, '');

    if (url.includes('api.manifold.marketsx')) {
      url = url.replace('api.manifold.marketsx', 'api.manifold.markets');
    }

    this.baseUrl = url;
  }

  async listMarkets(category: PredictionCategory, subCategory?: string, league?: string): Promise<PredictionMarket[]> {
    const normalizedSubCategory = this.normalizeSubCategoryKey(subCategory);
    const normalizedLeague = this.normalizeLeagueKey(league);
    const params = new URLSearchParams({
      limit: '100',
      filter: 'open',
      sort: 'score',
      term: this.getSearchTerm(category, normalizedSubCategory, normalizedLeague),
    });

    const response = await this.fetchJson(`/v0/search-markets?${params.toString()}`);
    const markets = Array.isArray(response) ? response : [];

    return markets
      .map((market: any) => this.toPredictionMarket(market, category))
      .filter((market: PredictionMarket | null): market is PredictionMarket => !!market)
      .filter((market: PredictionMarket) => this.isOpenFutureMarket(market))
      .filter((market: PredictionMarket) => this.matchesCategory(market.raw, category))
      .filter((market: PredictionMarket) => this.matchesSubCategory(market, normalizedSubCategory))
      .filter((market: PredictionMarket) => this.matchesLeague(market, normalizedLeague));
  }

  async getMarket(externalMarketId: string, category?: PredictionCategory): Promise<PredictionMarket | null> {
    const response = await this.fetchJson(`/v0/market/${encodeURIComponent(externalMarketId)}`);
    return this.toPredictionMarket(response, category || this.inferCategory(response));
  }

  private async fetchJson(path: string): Promise<any> {
    const fullUrl = `${this.baseUrl}${path}`;
    return new Promise((resolve, reject) => {
      const isHttps = fullUrl.startsWith('https:');
      const client = isHttps ? https : http;

      const req = client.get(
        fullUrl,
        {
          family: 4,
          timeout: 8000,
          headers: {
            Accept: 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(data));
              } catch (e: any) {
                reject(new ServiceUnavailableException(`Failed to parse Manifold response: ${e.message}`));
              }
            } else {
              reject(new ServiceUnavailableException(`Manifold provider returned HTTP ${res.statusCode}`));
            }
          });
        },
      );

      req.on('error', (err: any) => {
        reject(new ServiceUnavailableException(`Manifold provider unavailable: ${err?.message || err}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new ServiceUnavailableException('Manifold provider request timed out'));
      });
    });
  }

  private toPredictionMarket(market: any, category: PredictionCategory): PredictionMarket | null {
    const externalMarketId = String(market?.id || '').trim();
    const question = String(market?.question || '').trim();
    if (!externalMarketId || !question) return null;

    const options = this.extractOptions(market);
    if (options.length < 2) return null;

    const closeTime = typeof market?.closeTime === 'number' ? new Date(market.closeTime) : null;
    const resultSide = this.extractResultSide(market, options);
    const subCategory = this.inferSubCategory(market, category);
    const league = this.inferLeague(market, category);

    return {
      provider: this.provider,
      externalMarketId,
      externalEventId: null,
      category,
      subCategory,
      league,
      question,
      options,
      closeTime: closeTime && !Number.isNaN(closeTime.getTime()) ? closeTime : null,
      status: this.normalizeStatus(market, resultSide),
      resultSide,
      raw: market,
    };
  }

  private extractOptions(market: any): string[] {
    if (Array.isArray(market?.answers) && market.answers.length >= 2) {
      return market.answers
        .map((answer: any) => String(answer?.text || answer?.name || '').trim())
        .filter(Boolean);
    }

    if (market?.outcomeType === 'BINARY' || market?.mechanism === 'cpmm-1') {
      return ['YES', 'NO'];
    }

    return [];
  }

  private extractResultSide(market: any, options: string[]): string | null {
    const resolution = String(market?.resolution || '').trim();
    if (!resolution) return null;

    if (resolution === 'YES') return options[0] || 'YES';
    if (resolution === 'NO') return options[1] || 'NO';

    if (Array.isArray(market?.answers)) {
      const answer = market.answers.find((entry: any) => String(entry?.id) === resolution);
      if (answer?.text) return String(answer.text).trim();
    }

    const numericIndex = Number(resolution);
    if (Number.isInteger(numericIndex) && options[numericIndex]) return options[numericIndex];

    return options.find((option) => option.toLowerCase() === resolution.toLowerCase()) || null;
  }

  private normalizeStatus(market: any, resultSide: string | null): PredictionMarketStatus {
    if (resultSide || market?.isResolved === true) return 'SETTLED';
    if (market?.isResolved === false && market?.closeTime && market.closeTime <= Date.now()) return 'CLOSED';
    if (market?.isResolved === false) return 'OPEN';
    return 'UNKNOWN';
  }

  private isOpenFutureMarket(market: PredictionMarket): boolean {
    return market.status === 'OPEN'
      && !!market.closeTime
      && market.closeTime.getTime() > Date.now();
  }

  private getSearchTerm(category: PredictionCategory, normalizedSubCategory?: string | null, normalizedLeague?: string | null): string {
    if (category === PredictionCategory.SPORTS) {
      if (normalizedLeague) {
        const leagueKeywords = SPORTS_LEAGUE_KEYWORDS[normalizedLeague];
        if (leagueKeywords && leagueKeywords.length > 0) return leagueKeywords[0];
        return normalizedLeague.toLowerCase();
      }
      if (normalizedSubCategory) {
        const keywords = SPORTS_SUBCATEGORY_KEYWORDS[normalizedSubCategory];
        return keywords && keywords.length > 0 ? keywords[0] : normalizedSubCategory.toLowerCase();
      }
    }

    const terms: Record<PredictionCategory, string> = {
      [PredictionCategory.SPORTS]: 'sports',
      [PredictionCategory.FINANCE]: 'finance economy',
      [PredictionCategory.ELECTIONS]: 'election politics',
      [PredictionCategory.POLITICS]: 'politics election',
      [PredictionCategory.CRYPTO]: 'crypto bitcoin',
      [PredictionCategory.TECH_AI]: 'ai tech',
      [PredictionCategory.POP_CULTURE]: 'celebrity pop culture',
      [PredictionCategory.SCIENCE]: 'science space',
      [PredictionCategory.GLOBAL_AFFAIRS]: 'world geopolitics',
      [PredictionCategory.ENTERTAINMENT]: 'entertainment gaming',
      [PredictionCategory.ECONOMY]: 'economy inflation',
    };
    return terms[category];
  }

  private getSearchableText(market: any): string {
    const parts: string[] = [];
    if (market?.question) parts.push(String(market.question));
    if (market?.description) {
      if (typeof market.description === 'string') parts.push(market.description);
      else if (typeof market.description === 'object') parts.push(JSON.stringify(market.description));
    }
    if (market?.groupSlugs && Array.isArray(market.groupSlugs)) {
      parts.push(market.groupSlugs.join(' ').replace(/[-_]/g, ' '));
    }
    if (Array.isArray(market?.tags)) {
      parts.push(market.tags.join(' '));
    }
    return parts.join(' ');
  }

  private matchesCategory(raw: unknown, category: PredictionCategory): boolean {
    const text = this.getSearchableText(raw);
    if (category === PredictionCategory.SPORTS) {
      for (const keywords of Object.values(SPORTS_SUBCATEGORY_KEYWORDS)) {
        if (textMatchesKeywords(text, keywords)) return true;
      }
    }

    const keywordsByCategory: Record<PredictionCategory, string[]> = {
      [PredictionCategory.SPORTS]: [
        'sport',
        'sports',
        'cricket',
        'ipl',
        'nba',
        'nfl',
        'mlb',
        'nhl',
        'soccer',
        'football',
        'tennis',
        'ufc',
        'fifa',
        'formula 1',
        'f1',
        'boxing',
        'mma',
        'basketball',
        'baseball',
        'la liga',
        'premier league',
        'champions league',
      ],
      [PredictionCategory.FINANCE]: [
        'finance',
        'economy',
        'economic',
        'fed',
        'inflation',
        'cpi',
        'interest rate',
        'rate cut',
        'stock',
        'nasdaq',
        's&p',
        'gdp',
        'fomc',
      ],
      [PredictionCategory.ELECTIONS]: [
        'election',
        'elections',
        'politics',
        'political',
        'president',
        'senate',
        'house',
        'congress',
        'governor',
        'mayor',
        'vote',
      ],
      [PredictionCategory.CRYPTO]: [
        'crypto',
        'cryptocurrency',
        'bitcoin',
        'btc',
        'ethereum',
        'eth',
        'solana',
        'sol',
        'xrp',
        'doge',
      ],
      [PredictionCategory.POLITICS]: [
        'politics',
        'political',
        'election',
        'president',
        'senate',
        'house',
        'congress',
        'governor',
        'vote',
        'trump',
        'biden',
      ],
      [PredictionCategory.TECH_AI]: [
        'ai',
        'artificial intelligence',
        'openai',
        'chatgpt',
        'gpt',
        'claude',
        'google',
        'meta',
        'apple',
        'nvidia',
        'tech',
      ],
      [PredictionCategory.POP_CULTURE]: [
        'pop culture',
        'celebrity',
        'music',
        'movie',
        'oscar',
        'grammy',
        'taylor swift',
        'netflix',
        'hollywood',
      ],
      [PredictionCategory.SCIENCE]: [
        'science',
        'space',
        'spacex',
        'nasa',
        'climate',
        'physics',
        'medicine',
        'fda',
      ],
      [PredictionCategory.GLOBAL_AFFAIRS]: [
        'geopolitics',
        'world',
        'international',
        'war',
        'nato',
        'un',
        'china',
        'russia',
        'ukraine',
      ],
      [PredictionCategory.ENTERTAINMENT]: [
        'entertainment',
        'gaming',
        'video games',
        'playstation',
        'xbox',
        'streaming',
        'youtube',
      ],
      [PredictionCategory.ECONOMY]: [
        'economy',
        'economic',
        'gdp',
        'inflation',
        'cpi',
        'fed',
        'interest rate',
        'recession',
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
    if (textMatchesKeywords(text, ['election', 'president', 'senate', 'house', 'politics', 'vote'])) {
      return PredictionCategory.ELECTIONS;
    }
    return PredictionCategory.FINANCE;
  }
}
