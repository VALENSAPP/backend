import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PredictionCategory, PredictionProvider } from '@prisma/client';
import { PredictionMarket, PredictionMarketStatus, PredictionProviderClient } from './prediction-provider.types';

export interface LeagueConfig {
  id: number;
  name: string;
  country: string;
}

export const BRAZIL_LEAGUE_MAP: Record<string, LeagueConfig> = {
  // CBF National Divisions
  BRASILEIRAO_SERIE_A: { id: 71, name: 'Serie A', country: 'Brazil' },
  BRASILEIRAO_SERIE_B: { id: 72, name: 'Serie B', country: 'Brazil' },
  BRASILEIRAO_SERIE_C: { id: 75, name: 'Serie C', country: 'Brazil' },
  BRASILEIRAO_SERIE_D: { id: 76, name: 'Serie D', country: 'Brazil' },

  // CBF National Knockouts & Supercups
  COPA_DO_BRASIL: { id: 73, name: 'Copa Do Brasil', country: 'Brazil' },
  SUPERCOPA_DO_BRASIL: { id: 632, name: 'Supercopa do Brasil', country: 'Brazil' },
  COPA_DO_NORDESTE: { id: 612, name: 'Copa do Nordeste', country: 'Brazil' },
  COPA_VERDE: { id: 635, name: 'Copa Verde', country: 'Brazil' },

  // State Championships (Estaduais)
  PAULISTA_A1: { id: 475, name: 'Paulista - A1', country: 'Brazil' },
  PAULISTA_A2: { id: 476, name: 'Paulista - A2', country: 'Brazil' },
  CARIOCA_A1: { id: 624, name: 'Carioca - 1', country: 'Brazil' },
  CARIOCA_A2: { id: 851, name: 'Carioca A2', country: 'Brazil' },
  MINEIRO_1: { id: 629, name: 'Mineiro - 1', country: 'Brazil' },
  GAUCHO_1: { id: 477, name: 'Gaúcho - 1', country: 'Brazil' },
  BAIANO_1: { id: 602, name: 'Baiano - 1', country: 'Brazil' },
  CEARENSE_1: { id: 609, name: 'Cearense - 1', country: 'Brazil' },
  PARANAENSE_1: { id: 606, name: 'Paranaense - 1', country: 'Brazil' },
  CATARINENSE_1: { id: 604, name: 'Catarinense - 1', country: 'Brazil' },
  PERNAMBUCANO_1: { id: 622, name: 'Pernambucano - 1', country: 'Brazil' },
  GOIANO_1: { id: 628, name: 'Goiano - 1', country: 'Brazil' },
};

export const GLOBAL_LEAGUE_MAP: Record<string, LeagueConfig> = {
  ...BRAZIL_LEAGUE_MAP,

  // South American Continental Competitions
  COPA_LIBERTADORES: { id: 13, name: 'Copa Libertadores', country: 'South America' },
  COPA_SUDAMERICANA: { id: 11, name: 'Copa Sudamericana', country: 'South America' },
  RECOPA_SUDAMERICANA: { id: 541, name: 'Recopa Sudamericana', country: 'South America' },

  // International Tournaments & National Teams
  WORLD_CUP_QUALIFIERS_CONMEBOL: { id: 32, name: 'World Cup - Qualification South America', country: 'World' },
  WORLD_CUP_QUALIFIERS_UEFA: { id: 34, name: 'World Cup - Qualification Europe', country: 'World' },
  COPA_AMERICA: { id: 9, name: 'Copa America', country: 'World' },
  UEFA_NATIONS_LEAGUE: { id: 5, name: 'UEFA Nations League', country: 'World' },
  INTERNATIONAL_FRIENDLIES: { id: 10, name: 'Friendlies', country: 'World' },
  FIFA_CLUB_WORLD_CUP: { id: 15, name: 'FIFA Club World Cup', country: 'World' },

  // European & Global Club Competitions
  CHAMPIONS_LEAGUE: { id: 2, name: 'UEFA Champions League', country: 'World' },
  EUROPA_LEAGUE: { id: 3, name: 'UEFA Europa League', country: 'World' },
  CONFERENCE_LEAGUE: { id: 848, name: 'UEFA Europa Conference League', country: 'World' },
  PREMIER_LEAGUE: { id: 39, name: 'Premier League', country: 'England' },
  LA_LIGA: { id: 140, name: 'La Liga', country: 'Spain' },
  SERIE_A: { id: 135, name: 'Serie A', country: 'Italy' },
  BUNDESLIGA: { id: 78, name: 'Bundesliga', country: 'Germany' },
  LIGUE_1: { id: 61, name: 'Ligue 1', country: 'France' },
  MLS: { id: 253, name: 'Major League Soccer', country: 'USA' },
};

interface CacheEntry {
  expiresAt: number;
  data: any;
}

@Injectable()
export class ApiFootballPredictionProvider implements PredictionProviderClient {
  readonly provider = PredictionProvider.API_FOOTBALL;
  private readonly logger = new Logger(ApiFootballPredictionProvider.name);

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly nflBaseUrl = 'https://v1.american-football.api-sports.io';
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs = 15 * 60 * 1000; // 15 minutes cache to preserve 100 requests/day quota

  constructor(private readonly configService: ConfigService) {
    this.apiKey = (
      this.configService.get<string>('SPORTS_API_KEY')
      || this.configService.get<string>('API_FOOTBALL_KEY')
      || this.configService.get<string>('API_SPORTS_KEY')
      || ''
    ).trim();

    this.baseUrl = (
      this.configService.get<string>('SPORTS_API_BASE_URL')
      || 'https://v3.football.api-sports.io'
    ).trim().replace(/\/$/, '');
  }

  async listMarkets(
    category: PredictionCategory,
    subCategory?: string,
    league?: string,
  ): Promise<PredictionMarket[]> {
    if (category !== PredictionCategory.SPORTS) {
      return [];
    }

    if (!this.apiKey) {
      this.logger.warn('API-Football API key is missing (SPORTS_API_KEY). Returning empty list.');
      return [];
    }

    const cleanSubCat = (subCategory || '').trim().toUpperCase();
    const cleanLeague = (league || '').trim().toUpperCase();

    // 1. If user explicitly requested American Football or NFL, query API-Sports NFL
    if (cleanSubCat === 'AMERICAN_FOOTBALL' || cleanLeague === 'NFL') {
      return this.listNflMarkets();
    }

    const normalizedLeague = this.normalizeLeagueKey(league);
    const fixtures: any[] = [];

    // 2. Fetch date-based upcoming fixtures across next 2 days (today and tomorrow, guaranteed on all API-Sports plans)
    const dateStrings = this.getUpcomingDateStrings(2);
    for (const dateStr of dateStrings) {
      const dayFixtures = await this.fetchFixturesByDate(dateStr);
      fixtures.push(...dayFixtures);
    }

    // Deduplicate fixtures by fixture.id
    const seenIds = new Set<number>();
    const uniqueFixtures = fixtures.filter((f) => {
      if (!f?.fixture?.id || seenIds.has(f.fixture.id)) return false;
      seenIds.add(f.fixture.id);
      return true;
    });

    const markets = uniqueFixtures
      .map((fixture) => this.toPredictionMarket(fixture))
      .filter((m): m is PredictionMarket => !!m)
      .filter((m) => this.isOpenFutureMarket(m))
      .filter((m) => this.matchesLeagueFilter(m, normalizedLeague));

    return this.sortMarkets(markets);
  }

  private async listNflMarkets(): Promise<PredictionMarket[]> {
    const cacheKey = 'nfl_upcoming_games';
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    try {
      const currentYear = new Date().getFullYear();
      const seasons = [currentYear, currentYear - 1];
      let games: any[] = [];

      for (const season of seasons) {
        const url = `${this.nflBaseUrl}/games?league=1&season=${season}`;
        const resp = await this.fetchJson(url);
        if (Array.isArray(resp?.response) && resp.response.length > 0) {
          games = resp.response;
          break;
        }
      }

      if (games.length === 0) {
        return [];
      }

      const now = Date.now();
      // Filter for future games or recent games
      const markets = games
        .map((g) => this.nflGameToPredictionMarket(g))
        .filter((m): m is PredictionMarket => !!m)
        .filter((m) => {
          if (m.status === 'OPEN' && m.closeTime && m.closeTime.getTime() > now) return true;
          return false;
        });

      markets.sort((a, b) => {
        const timeA = a.closeTime ? a.closeTime.getTime() : Number.MAX_SAFE_INTEGER;
        const timeB = b.closeTime ? b.closeTime.getTime() : Number.MAX_SAFE_INTEGER;
        return timeA - timeB;
      });

      this.setInCache(cacheKey, markets, 30 * 60 * 1000);
      return markets;
    } catch (e: any) {
      this.logger.error(`Error fetching NFL games: ${e.message}`);
      return [];
    }
  }

  private nflGameToPredictionMarket(gameData: any): PredictionMarket | null {
    const game = gameData?.game;
    const teams = gameData?.teams;
    if (!game?.id || !teams?.home?.name || !teams?.away?.name) {
      return null;
    }

    const homeTeam = String(teams.home.name).trim();
    const awayTeam = String(teams.away.name).trim();
    const question = `${homeTeam} vs ${awayTeam} - Game Winner`;
    const options = [homeTeam, awayTeam];

    let closeTime: Date | null = null;
    if (game.date?.timestamp) {
      closeTime = new Date(game.date.timestamp * 1000);
    } else if (game.date?.date) {
      const timeStr = game.date?.time || '00:00';
      closeTime = new Date(`${game.date.date}T${timeStr}:00Z`);
    }

    const statusShort = String(game.status?.short || '').toUpperCase();
    let status: PredictionMarketStatus = 'UNKNOWN';
    let resultSide: string | null = null;

    if (['FT', 'AOT'].includes(statusShort)) {
      status = 'SETTLED';
      const homeScore = Number(gameData?.scores?.home?.total ?? 0);
      const awayScore = Number(gameData?.scores?.away?.total ?? 0);
      if (homeScore > awayScore) resultSide = homeTeam;
      else if (awayScore > homeScore) resultSide = awayTeam;
      else resultSide = 'Draw';
    } else if (['NS', 'TBD'].includes(statusShort)) {
      status = 'OPEN';
    } else {
      status = 'CLOSED';
    }

    const icon = gameData?.league?.logo || null;
    const image = gameData?.teams?.home?.logo || null;

    return {
      provider: this.provider,
      externalMarketId: `nfl:${game.id}`,
      externalEventId: `nfl:${game.id}`,
      category: PredictionCategory.SPORTS,
      subCategory: 'AMERICAN_FOOTBALL',
      league: 'NFL',
      question,
      options,
      closeTime: closeTime && !Number.isNaN(closeTime.getTime()) ? closeTime : null,
      status,
      resultSide,
      icon,
      image,
      raw: gameData,
    };
  }

  isBrazilMarket(market: PredictionMarket): boolean {
    if (market.league && BRAZIL_LEAGUE_MAP[market.league]) {
      return true;
    }
    const raw = market.raw as any;
    const country = String(raw?.league?.country || '').trim().toLowerCase();
    if (country === 'brazil' || country === 'brasil') {
      return true;
    }
    const leagueName = String(raw?.league?.name || '').toLowerCase();
    if (
      leagueName.includes('brasil')
      || leagueName.includes('brazil')
      || leagueName.includes('brasileir')
      || leagueName.includes('paulista')
      || leagueName.includes('carioca')
      || leagueName.includes('mineiro')
      || leagueName.includes('gaúcho')
      || leagueName.includes('gaucho')
      || leagueName.includes('baiano')
      || leagueName.includes('cearense')
      || leagueName.includes('paranaense')
      || leagueName.includes('catarinense')
      || leagueName.includes('pernambucano')
      || leagueName.includes('goiano')
      || leagueName.includes('copa do brasil')
      || leagueName.includes('copa do nordeste')
      || leagueName.includes('supercopa do brasil')
      || leagueName.includes('copa verde')
    ) {
      return true;
    }
    return false;
  }

  private sortMarkets(markets: PredictionMarket[]): PredictionMarket[] {
    return [...markets].sort((a, b) => {
      const aIsBrazil = this.isBrazilMarket(a) ? 1 : 0;
      const bIsBrazil = this.isBrazilMarket(b) ? 1 : 0;

      // 1. Brazil local fixtures first
      if (aIsBrazil !== bIsBrazil) {
        return bIsBrazil - aIsBrazil;
      }

      // 2. Earliest match kickoff first
      const aTime = a.closeTime ? new Date(a.closeTime).getTime() : Number.MAX_SAFE_INTEGER;
      const bTime = b.closeTime ? new Date(b.closeTime).getTime() : Number.MAX_SAFE_INTEGER;
      if (aTime !== bTime) {
        return aTime - bTime;
      }

      return 0;
    });
  }

  async getMarket(externalMarketId: string, _category?: PredictionCategory): Promise<PredictionMarket | null> {
    if (!this.apiKey) {
      this.logger.warn('API-Football API key is missing. Unable to getMarket.');
      return null;
    }

    const cleanId = String(externalMarketId || '').trim();
    if (!cleanId) return null;

    // Handle NFL games
    if (cleanId.startsWith('nfl:')) {
      const gameId = cleanId.replace(/^nfl:/, '');
      const cacheKey = `nfl_game_${gameId}`;
      let gameData = this.getFromCache(cacheKey);

      if (!gameData) {
        const url = `${this.nflBaseUrl}/games?id=${encodeURIComponent(gameId)}`;
        const resp = await this.fetchJson(url);
        gameData = Array.isArray(resp?.response) ? resp.response[0] : null;
        if (gameData) {
          const isFinished = ['FT', 'AOT'].includes(gameData?.game?.status?.short);
          this.setInCache(cacheKey, gameData, isFinished ? 60 * 60 * 1000 : 2 * 60 * 1000);
        }
      }

      if (!gameData) return null;
      return this.nflGameToPredictionMarket(gameData);
    }

    // Handle Soccer fixtures
    const fixtureId = cleanId.replace(/^[a-zA-Z_-]+:/, '').trim();
    try {
      const cacheKey = `fixture_${fixtureId}`;
      let fixtureData = this.getFromCache(cacheKey);

      if (!fixtureData) {
        const url = `${this.baseUrl}/fixtures?id=${encodeURIComponent(fixtureId)}`;
        const response = await this.fetchJson(url);
        fixtureData = Array.isArray(response?.response) ? response.response[0] : null;
        if (fixtureData) {
          const isFinished = ['FT', 'AET', 'PEN'].includes(fixtureData?.fixture?.status?.short);
          this.setInCache(cacheKey, fixtureData, isFinished ? 60 * 60 * 1000 : 60 * 1000);
        }
      }

      if (!fixtureData) return null;
      return this.toPredictionMarket(fixtureData);
    } catch (error: any) {
      this.logger.error(`Failed to get fixture ${fixtureId}: ${error.message}`);
      return null;
    }
  }

  private async fetchFixturesByDate(dateStr: string): Promise<any[]> {
    const cacheKey = `fixtures_date_${dateStr}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    try {
      const url = `${this.baseUrl}/fixtures?date=${dateStr}`;
      const response = await this.fetchJson(url);
      const rawList: any[] = Array.isArray(response?.response) ? response.response : [];

      // Prioritize Brazilian fixtures, continental cups, and top global matches
      const filtered = rawList.filter((item) => {
        const country = String(item?.league?.country || '').toLowerCase();
        const leagueName = String(item?.league?.name || '').toLowerCase();
        return (
          country === 'brazil'
          || country === 'brasil'
          || country === 'world'
          || country === 'south america'
          || country === 'england'
          || country === 'spain'
          || country === 'italy'
          || country === 'germany'
          || country === 'france'
          || leagueName.includes('serie a')
          || leagueName.includes('serie b')
          || leagueName.includes('copa')
          || leagueName.includes('paulista')
          || leagueName.includes('carioca')
          || leagueName.includes('mineiro')
          || leagueName.includes('gaúcho')
          || leagueName.includes('gaucho')
          || leagueName.includes('libertadores')
          || leagueName.includes('sudamericana')
          || leagueName.includes('champions league')
          || leagueName.includes('premier league')
        );
      });

      this.setInCache(cacheKey, filtered, this.cacheTtlMs);
      return filtered;
    } catch (e: any) {
      this.logger.error(`Error fetching fixtures for date ${dateStr}: ${e.message}`);
      return [];
    }
  }

  private toPredictionMarket(fixtureData: any): PredictionMarket | null {
    const fixture = fixtureData?.fixture;
    const league = fixtureData?.league;
    const teams = fixtureData?.teams;

    if (!fixture?.id || !teams?.home?.name || !teams?.away?.name) {
      return null;
    }

    const homeTeam = String(teams.home.name).trim();
    const awayTeam = String(teams.away.name).trim();
    const question = `${homeTeam} vs ${awayTeam} - Match Winner`;
    const options = [homeTeam, awayTeam, 'Draw'];

    const closeTimeValue = fixture.date;
    const closeTime = closeTimeValue ? new Date(closeTimeValue) : null;
    const statusShort = String(fixture.status?.short || '').toUpperCase();

    const { status, resultSide } = this.resolveStatusAndWinner(statusShort, teams, fixtureData?.goals);
    const leagueKey = this.inferLeagueKey(league);

    const icon = league?.logo || null;
    const image = teams?.home?.logo || null;

    return {
      provider: this.provider,
      externalMarketId: String(fixture.id),
      externalEventId: String(fixture.id),
      category: PredictionCategory.SPORTS,
      subCategory: 'FOOTBALL',
      league: leagueKey,
      question,
      options,
      closeTime: closeTime && !Number.isNaN(closeTime.getTime()) ? closeTime : null,
      status,
      resultSide,
      icon,
      image,
      raw: fixtureData,
    };
  }

  private resolveStatusAndWinner(
    statusShort: string,
    teams: any,
    goals: any,
  ): { status: PredictionMarketStatus; resultSide: string | null } {
    const homeTeam = teams?.home?.name;
    const awayTeam = teams?.away?.name;

    // Settled statuses: FT (Full Time), AET (After Extra Time), PEN (After Penalty Shootout)
    if (['FT', 'AET', 'PEN'].includes(statusShort)) {
      if (teams?.home?.winner === true) {
        return { status: 'SETTLED', resultSide: homeTeam };
      }
      if (teams?.away?.winner === true) {
        return { status: 'SETTLED', resultSide: awayTeam };
      }
      if (goals?.home !== null && goals?.away !== null && goals?.home === goals?.away) {
        return { status: 'SETTLED', resultSide: 'Draw' };
      }
      if (goals?.home > goals?.away) {
        return { status: 'SETTLED', resultSide: homeTeam };
      }
      if (goals?.away > goals?.home) {
        return { status: 'SETTLED', resultSide: awayTeam };
      }
      return { status: 'SETTLED', resultSide: 'Draw' };
    }

    // Cancelled / Postponed
    if (['PST', 'CANC', 'ABD', 'WO', 'INT'].includes(statusShort)) {
      return { status: 'CLOSED', resultSide: null };
    }

    // Live / In Play
    if (['1H', 'HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'LIVE'].includes(statusShort)) {
      return { status: 'CLOSED', resultSide: null };
    }

    // Not Started (Open for predictions if in future)
    if (['NS', 'TBD'].includes(statusShort)) {
      return { status: 'OPEN', resultSide: null };
    }

    return { status: 'UNKNOWN', resultSide: null };
  }

  private inferLeagueKey(league: any): string {
    const leagueId = Number(league?.id);
    for (const [key, config] of Object.entries(GLOBAL_LEAGUE_MAP)) {
      if (config.id === leagueId) return key;
    }

    const leagueName = String(league?.name || '').toUpperCase().replace(/[\s-_]+/g, '_');
    return leagueName || 'BRAZIL_FOOTBALL';
  }

  private normalizeLeagueKey(league?: string | null): string | null {
    if (!league) return null;
    const clean = league.trim().toUpperCase().replace(/[\s-_]+/g, '_');
    if (clean === 'ALL') return null;

    if (GLOBAL_LEAGUE_MAP[clean]) return clean;

    // Keyword mapping
    if (clean.includes('BRASIL') || clean.includes('BRAZIL') || clean.includes('SERIE_A_BR')) {
      return 'BRASILEIRAO_SERIE_A';
    }
    if (clean.includes('COPA_DO_BRASIL') || clean.includes('COPA_BRASIL')) {
      return 'COPA_DO_BRASIL';
    }
    if (clean.includes('PAULISTA')) return 'PAULISTA_A1';
    if (clean.includes('CARIOCA')) return 'CARIOCA_A1';
    if (clean.includes('PREMIER')) return 'PREMIER_LEAGUE';
    if (clean.includes('CHAMPIONS')) return 'CHAMPIONS_LEAGUE';
    if (clean.includes('LA_LIGA')) return 'LA_LIGA';
    if (clean.includes('LIBERTADORES')) return 'COPA_LIBERTADORES';
    if (clean.includes('SUDAMERICANA')) return 'COPA_SUDAMERICANA';

    return clean;
  }

  private matchesLeagueFilter(market: PredictionMarket, normalizedLeague?: string | null): boolean {
    if (!normalizedLeague) return true;
    if (market.league === normalizedLeague) return true;

    const raw = market.raw as any;
    const leagueName = String(raw?.league?.name || '').toLowerCase();
    const cleanSearch = normalizedLeague.toLowerCase().replace(/_/g, ' ');
    return leagueName.includes(cleanSearch);
  }

  private isOpenFutureMarket(market: PredictionMarket): boolean {
    return market.status === 'OPEN'
      && !!market.closeTime
      && market.closeTime.getTime() > Date.now();
  }

  private getUpcomingDateStrings(count: number): string[] {
    const dates: string[] = [];
    const now = new Date();
    for (let i = 0; i < count; i++) {
      const d = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
      dates.push(d.toISOString().split('T')[0]);
    }
    return dates;
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

  private async fetchJson(url: string): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'x-apisports-key': this.apiKey,
          'User-Agent': 'Valens-App/1.0',
        },
      });

      clearTimeout(timer);

      if (response.ok) {
        const parsed = await response.json();
        if (parsed?.errors && Object.keys(parsed.errors).length > 0 && !Array.isArray(parsed.errors)) {
          this.logger.warn(`API-Sports returned errors: ${JSON.stringify(parsed.errors)}`);
        }
        return parsed;
      }

      throw new ServiceUnavailableException(`API-Sports returned HTTP ${response.status}`);
    } catch (err: any) {
      clearTimeout(timer);
      throw new ServiceUnavailableException(`API-Sports request failed: ${err?.message || err}`);
    }
  }
}
