import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from '../notification/notification.service';
import {
  BattleType,
  BattleStatus,
  FollowStatus,
  MarketplaceBattleMode,
  MarketplaceBattleStatus,
  Prisma,
  PredictionCategory,
  PredictionProvider,
  WhoCanBuy,
} from '@prisma/client';
import { BattleChallengerPositionDto, BattleCommentDeleteDto, BattleCommentDto, BattleCommentEditDto, BattleCommentHighlightDto, BattleCommentLikeDto, BattleCommentPinDto, BattleCommentRemoveHighlightDto, BattleCommentUnpinDto, BattleCloseDto, BattleEditQuestionDto, BattleInviteDto, BattleJoinDto, BattleOpponentPositionDto, BattlePredictionDto, BattleResponseDto, BattleVoteDto } from './dto/battle-actions.dto';
import { CreateBattleDto } from './dto/create-battle.dto';
import { CreatePredictionBattleDto } from './dto/prediction-battle.dto';
import { uploadImageToS3 } from '../common/s3.util';
import { PolymarketPredictionProvider } from './prediction/polymarket-prediction.provider';
import { ManifoldPredictionProvider } from './prediction/manifold-prediction.provider';
import { ApiFootballPredictionProvider } from './prediction/api-football-prediction.provider';
import { PredictionMarket, PredictionProviderClient } from './prediction/prediction-provider.types';

const BASE_JOIN_POINTS = 5;
const ARGUMENT_POINTS = 10;
const ENGAGEMENT_POINT_PER_LIKE = 2;
const MAX_ENGAGEMENT_POINTS = 20;
const TIMING_BONUS_MAX = 10;
const UNDERDOG_BONUS = 8;
const OPINION_WIN_BONUS = 15;
const OPINION_LOSE_PENALTY = 5;
const PREDICTION_WIN_BONUS = 25;
const PREDICTION_LOSE_PENALTY = 10;
const ARGUMENT_MIN_LENGTH = 10;
const BATTLE_PUBLIC_USER_SELECT = {
  id: true,
  displayName: true,
  userName: true,
  image: true,
  profile: true,
} as const;

@Injectable()
export class BattleService {
  private readonly logger = new Logger(BattleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationService: NotificationService,
    private readonly polymarketPredictionProvider: PolymarketPredictionProvider,
    private readonly manifoldPredictionProvider: ManifoldPredictionProvider,
    private readonly apiFootballPredictionProvider: ApiFootballPredictionProvider,
  ) { }

  private getPredictionProvider(provider: PredictionProvider = PredictionProvider.POLYMARKET): PredictionProviderClient {
    if (provider === PredictionProvider.POLYMARKET) return this.polymarketPredictionProvider;
    if (provider === PredictionProvider.MANIFOLD) return this.manifoldPredictionProvider;
    if (provider === PredictionProvider.API_FOOTBALL) return this.apiFootballPredictionProvider;
    throw new BadRequestException('Unsupported prediction provider');
  }

  private normalizeBattleSide(side: string | undefined, options: string[] = []): string {
    const normalizedSide = (side || '').trim();
    if (!normalizedSide) throw new BadRequestException('Side required');

    const exactOption = options.find((option) => option.trim().toLowerCase() === normalizedSide.toLowerCase());
    if (exactOption) return exactOption;

    throw new BadRequestException('Side must match one of the battle options');
  }

  private normalizeOpeningComment(comment: string | undefined): string {
    const normalizedComment = (comment || '').trim();
    if (normalizedComment.length < ARGUMENT_MIN_LENGTH) {
      throw new BadRequestException(`Comment must be at least ${ARGUMENT_MIN_LENGTH} characters`);
    }
    return normalizedComment;
  }

  private getRemainingSide(options: string[], challengerSide: string): string {
    const remainingSide = options.find((option) => option.trim().toLowerCase() !== challengerSide.trim().toLowerCase());
    if (!remainingSide) throw new BadRequestException('No remaining side available for opponent');
    return remainingSide;
  }

  private ensureCanCommentOnBattle(
    battle: { status: string; format: string; creatorId: string },
    userId: string,
  ) {
    if (battle.status === BattleStatus.LIVE) return;

    const creatorCanCommentWhileInvitePending =
      battle.format === 'HEAD_TO_HEAD' &&
      battle.status === BattleStatus.PENDING_INVITE &&
      battle.creatorId === userId;

    if (!creatorCanCommentWhileInvitePending) {
      throw new BadRequestException('Battle is not live');
    }
  }

  private async ensureParentBattleComment(battleId: string, parentCommentId?: string) {
    if (!parentCommentId) return;

    const parent = await this.prisma.battleComment.findUnique({
      where: { id: parentCommentId },
      select: { battleId: true },
    });

    if (!parent || parent.battleId !== battleId) {
      throw new BadRequestException('Parent comment not found');
    }
  }

  private buildHeadToHeadSides(battle: {
    format: string;
    creatorId: string;
    options: string[];
    participants?: Array<{
      id?: string;
      userId: string;
      side?: string | null;
      openingArgument?: string | null;
      user?: any;
    }>;
    invites?: Array<{
      invitedUserId: string;
      status?: string;
      invited?: any;
    }>;
  }) {
    if (battle.format !== 'HEAD_TO_HEAD') return null;

    const participants = battle.participants || [];
    const invite = battle.invites?.[0] || null;
    const creatorParticipant = participants.find((participant) => participant.userId === battle.creatorId) || null;
    const invitedUserId =
      invite?.invitedUserId || participants.find((participant) => participant.userId !== battle.creatorId)?.userId || null;
    const invitedParticipant = invitedUserId
      ? participants.find((participant) => participant.userId === invitedUserId) || null
      : null;
    const creatorSide = creatorParticipant?.side || null;
    const invitedUserSide =
      invitedParticipant?.side ||
      (creatorSide && battle.options.length === 2 ? this.getRemainingSide(battle.options, creatorSide) : null);

    return {
      creatorSide,
      invitedUserSide,
      creator: {
        userId: battle.creatorId,
        side: creatorSide,
        openingArgument: creatorParticipant?.openingArgument || null,
        participantId: creatorParticipant?.id || null,
        user: creatorParticipant?.user || null,
      },
      invitedUser: {
        userId: invitedUserId,
        side: invitedUserSide,
        openingArgument: invitedParticipant?.openingArgument || null,
        participantId: invitedParticipant?.id || null,
        inviteStatus: invite?.status || null,
        user: invitedParticipant?.user || invite?.invited || null,
      },
    };
  }

  buildMatchResult(battle: any) {
    if (!battle) return null;

    const external = battle.externalPrediction;
    const raw: any = external?.resultRaw || external?.raw || null;

    const teams = raw?.teams;
    const goals = raw?.goals;
    const score = raw?.score;
    const fixtureStatus = raw?.fixture?.status;

    let homeTeam: string | null = null;
    let awayTeam: string | null = null;
    let homeLogo: string | null = null;
    let awayLogo: string | null = null;
    let homeScore: number | null = null;
    let awayScore: number | null = null;
    let matchStatus: string | null = null;
    const winnerSide = (battle.winningSide || battle.correctSide || external?.resultSide || '').trim() || null;

    if (teams?.home?.name && teams?.away?.name) {
      homeTeam = String(teams.home.name).trim();
      awayTeam = String(teams.away.name).trim();
      homeLogo = teams.home.logo ? String(teams.home.logo) : null;
      awayLogo = teams.away.logo ? String(teams.away.logo) : null;

      if (goals?.home !== undefined && goals?.home !== null && !Number.isNaN(Number(goals.home))) {
        homeScore = Number(goals.home);
      } else if (score?.fulltime?.home !== undefined && score?.fulltime?.home !== null && !Number.isNaN(Number(score.fulltime.home))) {
        homeScore = Number(score.fulltime.home);
      }

      if (goals?.away !== undefined && goals?.away !== null && !Number.isNaN(Number(goals.away))) {
        awayScore = Number(goals.away);
      } else if (score?.fulltime?.away !== undefined && score?.fulltime?.away !== null && !Number.isNaN(Number(score.fulltime.away))) {
        awayScore = Number(score.fulltime.away);
      }

      matchStatus = fixtureStatus?.long || fixtureStatus?.short || (battle.status === 'RESOLVED' ? 'Full-time' : null);
    } else if (Array.isArray(battle.options) && battle.options.length >= 2 && String(battle.question || '').includes(' vs ')) {
      homeTeam = String(battle.options[0]).trim();
      awayTeam = String(battle.options[1]).trim();
      matchStatus = battle.status === 'RESOLVED' ? 'Full-time' : null;
    }

    if (!homeTeam && !awayTeam) {
      return {
        isMatch: false,
        homeTeam: null,
        awayTeam: null,
        homeLogo: null,
        awayLogo: null,
        homeScore: null,
        awayScore: null,
        scoreSummary: null,
        matchStatus: null,
        winnerSide,
      };
    }

    let scoreSummary: string | null = null;
    if (homeScore !== null && awayScore !== null) {
      scoreSummary = `${homeTeam} ${homeScore} x ${awayScore} ${awayTeam}`;
    } else if (winnerSide) {
      scoreSummary = `Winner: ${winnerSide}`;
    }

    return {
      isMatch: true,
      homeTeam,
      awayTeam,
      homeLogo,
      awayLogo,
      homeScore,
      awayScore,
      scoreSummary,
      matchStatus,
      winnerSide,
    };
  }

  private async getBattleEngagedUserIds(battleId: string, creatorId?: string | null): Promise<string[]> {
    const [participants, votes, comments, predictions] = await Promise.all([
      this.prisma.battleParticipant.findMany({ where: { battleId }, select: { userId: true } }),
      this.prisma.battleVote.findMany({ where: { battleId }, select: { userId: true } }),
      this.prisma.battleComment.findMany({ where: { battleId }, select: { userId: true } }),
      this.prisma.battlePrediction.findMany({ where: { battleId }, select: { userId: true } }),
    ]);

    return Array.from(
      new Set(
        [
          creatorId || undefined,
          ...participants.map((p) => p.userId),
          ...votes.map((v) => v.userId),
          ...comments.map((c) => c.userId),
          ...predictions.map((p) => p.userId),
        ].filter(Boolean) as string[],
      ),
    );
  }

  async notifyBattlesClosingSoon(): Promise<{ processed: number }> {
    const now = new Date();
    const upper = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const lower = new Date(upper.getTime() - 60 * 1000);

    const battles = await this.prisma.battle.findMany({
      where: {
        status: 'LIVE',
        endTime: {
          gt: lower,
          lte: upper,
        },
      },
      select: { id: true, creatorId: true },
      take: 200,
    });

    for (const battle of battles) {
      try {
        const [participants, votes, comments, predictions] = await Promise.all([
          this.prisma.battleParticipant.findMany({ where: { battleId: battle.id }, select: { userId: true } }),
          this.prisma.battleVote.findMany({ where: { battleId: battle.id }, select: { userId: true } }),
          this.prisma.battleComment.findMany({ where: { battleId: battle.id }, select: { userId: true } }),
          this.prisma.battlePrediction.findMany({ where: { battleId: battle.id }, select: { userId: true } }),
        ]);

        const recipientUserIds = Array.from(
          new Set([
            battle.creatorId,
            ...participants.map((p) => p.userId),
            ...votes.map((v) => v.userId),
            ...comments.map((c) => c.userId),
            ...predictions.map((p) => p.userId),
          ].filter(Boolean)),
        );

        if (recipientUserIds.length === 0) continue;

        // De-dupe: skip users who already received this battle closing notification.
        const alreadySent = await this.prisma.notification.findMany({
          where: {
            userId: { in: recipientUserIds },
            AND: [
              { data: { path: ['type'], equals: 'battle_closing_soon' } as any },
              { data: { path: ['battleId'], equals: battle.id } as any },
            ],
          } as any,
          select: { userId: true },
          take: recipientUserIds.length,
        });

        const sentSet = new Set(alreadySent.map((n) => n.userId));
        const toSend = recipientUserIds.filter((id) => !sentSet.has(id));
        if (toSend.length === 0) continue;

        await this.notificationService.sendBattleClosingSoon(toSend, battle.id);
      } catch (error) {
        console.error('Failed to send battle closing soon notifications:', error);
      }
    }

    return { processed: battles.length };
  }

  async createBattle(
    userId: string,
    dto: CreateBattleDto,
    imageFile?: Express.Multer.File,
    optionImageFiles: Express.Multer.File[] = [],
  ) {
    if (!userId) throw new BadRequestException('User ID required');
    const isPredictionBattle = dto.battleType === BattleType.PREDICTION;
    if (!isPredictionBattle && (!dto?.question || dto.question.trim() === '')) {
      throw new BadRequestException('Question required');
    }
    if (!isPredictionBattle && !dto?.endTime) throw new BadRequestException('End time required');

    let providerMarket: PredictionMarket | null = null;
    const predictionProvider = dto.predictionProvider || PredictionProvider.POLYMARKET;
    if (isPredictionBattle) {
      if (dto.format !== 'POLL') throw new BadRequestException('Prediction battles must use POLL format');
      if (!dto.predictionCategory) throw new BadRequestException('Prediction category required');
      if (!dto.externalMarketId) throw new BadRequestException('External market ID required');
      if (!dto?.question || dto.question.trim() === '') throw new BadRequestException('Question required');
      if (!Array.isArray(dto.options) || dto.options.length < 2) {
        throw new BadRequestException('Prediction battles require at least two options');
      }

      const client = this.getPredictionProvider(predictionProvider);
      providerMarket = await client.getMarket(dto.externalMarketId.trim(), dto.predictionCategory);
      if (!providerMarket) throw new NotFoundException('Prediction question not found');
      if (providerMarket.status !== 'OPEN') throw new BadRequestException('Prediction question is not open');
      if (!providerMarket.closeTime) throw new BadRequestException('Prediction question close time is missing');
      if (providerMarket.closeTime <= new Date()) throw new BadRequestException('Prediction question is already closed');
    }

    const startTime = dto.startTime ? new Date(dto.startTime) : undefined;
    const endTime = providerMarket?.closeTime || new Date(dto.endTime);

    if (Number.isNaN(endTime.getTime())) throw new BadRequestException('Invalid end time');
    if (startTime && Number.isNaN(startTime.getTime())) throw new BadRequestException('Invalid start time');
    if (startTime && endTime <= startTime) throw new BadRequestException('End time must be after start time');

    const options = dto.options || providerMarket?.options || [];
    const isHeadToHead = dto.format === 'HEAD_TO_HEAD';
    const status = isHeadToHead ? 'DRAFT' : 'LIVE';
    const liveAt = status === 'LIVE' ? new Date() : null;
    const invitedUserId = dto.invitedUserId?.trim();

    if (isHeadToHead) {
      if (!invitedUserId) throw new BadRequestException('Invited user required for head-to-head');
      if (invitedUserId === userId) throw new BadRequestException('You cannot invite yourself to a battle');
      if (options.length !== 2) throw new BadRequestException('Head-to-head battles require exactly two sides');
    }

    const stakeAmount = dto.stake ?? 0;

    const imageUrl = imageFile ? await uploadImageToS3(imageFile, 'battle-images') : null;
    const uploadedOptionImages = optionImageFiles.length
      ? await Promise.all(optionImageFiles.map((file) => uploadImageToS3(file, 'battle-option-images')))
      : [];
    const optionImages = this.buildOptionImages(options, uploadedOptionImages, dto.optionImageIndexes, dto.optionImages);

    const battle = await this.prisma.$transaction(async (tx) => {
      if (stakeAmount > 0) {
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { id: true, totalPlatformPoints: true },
        });
        if (!user) throw new NotFoundException('User not found');
        if ((user.totalPlatformPoints ?? 0) < stakeAmount) {
          throw new BadRequestException('Insufficient platform points');
        }
        await tx.user.update({
          where: { id: userId },
          data: { totalPlatformPoints: { decrement: stakeAmount } },
        });
      }

      const created = await tx.battle.create({
        data: {
          creatorId: userId,
          format: dto.format,
          battleType: isPredictionBattle ? BattleType.PREDICTION : BattleType.NORMAL,
          status,
          question: dto.question.trim(),
          options,
          optionImages,
          startTime: startTime || null,
          endTime,
          resolutionMethod: providerMarket
            ? `${predictionProvider}:${providerMarket.externalMarketId}`
            : dto.resolutionMethod || null,
          isPublic: dto.isPublic !== undefined ? dto.isPublic : true,
          stakeAmount: dto.stake ?? null,
          liveAt,
          image: imageUrl,
          ...(providerMarket
            ? {
              externalPrediction: {
                create: {
                  provider: predictionProvider,
                  category: dto.predictionCategory!,
                  externalMarketId: providerMarket.externalMarketId,
                  externalEventId: dto.externalEventId || providerMarket.externalEventId || null,
                  question: dto.question.trim(),
                  options,
                  providerStatus: providerMarket.status,
                  resultSide: providerMarket.resultSide || null,
                  raw: (providerMarket.raw || {}) as Prisma.InputJsonValue,
                  closeTime: providerMarket.closeTime,
                  lastSyncedAt: new Date(),
                },
              },
            }
            : {}),
        },
      });

      if (isHeadToHead) {
        await tx.battleInvite.create({
          data: {
            battleId: created.id,
            inviterId: userId,
            invitedUserId: invitedUserId!,
            status: 'PENDING',
          },
        });
      }

      return created;
    });

    if (!isHeadToHead) {
      const followerIds = await this.getFollowerIds(userId);
      await this.notificationService.sendBattleCreatedToFollowers(
        followerIds,
        battle.id,
        battle.question,
      );
    }

    return battle;
  }

  getPredictionCategories() {
    return [
      PredictionCategory.SPORTS,
      PredictionCategory.POLITICS,
      PredictionCategory.CRYPTO,
      PredictionCategory.TECH_AI,
      PredictionCategory.POP_CULTURE,
      PredictionCategory.FINANCE,
      PredictionCategory.GLOBAL_AFFAIRS,
      PredictionCategory.SCIENCE,
      PredictionCategory.ENTERTAINMENT,
      PredictionCategory.ECONOMY,
      PredictionCategory.ELECTIONS,
    ];
  }

  getPredictionSportsCategories() {
    return [
      'ALL',
      'FOOTBALL',          // Soccer / CBF Brasil
      'AMERICAN_FOOTBALL', // NFL
      'BASKETBALL',        // NBA
      'CRICKET',           // IPL
      'BASEBALL',          // MLB
      'MMA_BOXING',        // UFC
      'FORMULA1',          // F1
      'TENNIS',
      'HOCKEY',            // NHL
      'ESPORTS',
      'OTHER',
    ];
  }

  private readonly activeLeaguesCache = new Map<string, { expiresAt: number; leagues: string[] }>();

  private isBrazilLeagueKey(clean: string): boolean {
    return (
      clean.includes('BRASIL') ||
      clean.includes('BRAZIL') ||
      clean.includes('BRASILEIRAO') ||
      clean.includes('PAULISTA') ||
      clean.includes('CARIOCA') ||
      clean.includes('MINEIRO') ||
      clean.includes('GAUCHO') ||
      clean.includes('BAIANO') ||
      clean.includes('CEARENSE') ||
      clean.includes('PARANAENSE') ||
      clean.includes('CATARINENSE') ||
      clean.includes('PERNAMBUCANO') ||
      clean.includes('GOIANO') ||
      clean.includes('COPA_DO_BRASIL') ||
      clean.includes('COPA_DO_NORDESTE') ||
      clean.includes('COPA_VERDE') ||
      clean.includes('FARES_LOPES')
    );
  }

  async getPredictionSportsLeagues(subCategory?: string): Promise<string[]> {
    const cleanSubCat = (subCategory || '').trim().toUpperCase().replace(/[\s-_]+/g, '_');
    const cacheKey = `active_leagues_${cleanSubCat || 'ALL'}`;
    const cached = this.activeLeaguesCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.leagues;
    }

    try {
      const activeLeaguesSet = new Set<string>();

      if (cleanSubCat === 'AMERICAN_FOOTBALL') {
        const nflMarkets = await this.getPredictionProvider(PredictionProvider.POLYMARKET).listMarkets(PredictionCategory.SPORTS, 'AMERICAN_FOOTBALL');
        for (const m of nflMarkets) {
          if (m?.league) activeLeaguesSet.add(m.league.toUpperCase());
        }
      } else if (cleanSubCat === 'FOOTBALL' || cleanSubCat === 'SOCCER') {
        const soccerMarkets = await this.getPredictionProvider(PredictionProvider.API_FOOTBALL).listMarkets(PredictionCategory.SPORTS, 'FOOTBALL');
        for (const m of soccerMarkets) {
          if (m?.league) activeLeaguesSet.add(m.league.toUpperCase());
        }
      } else {
        // General or ALL
        const results = await Promise.allSettled([
          this.getPredictionProvider(PredictionProvider.API_FOOTBALL).listMarkets(PredictionCategory.SPORTS, cleanSubCat !== 'ALL' ? cleanSubCat : undefined),
          this.getPredictionProvider(PredictionProvider.POLYMARKET).listMarkets(PredictionCategory.SPORTS, cleanSubCat !== 'ALL' ? cleanSubCat : undefined),
        ]);
        for (const res of results) {
          if (res.status === 'fulfilled' && Array.isArray(res.value)) {
            for (const m of res.value) {
              if (m?.league) activeLeaguesSet.add(m.league.toUpperCase());
            }
          }
        }
      }

      if (activeLeaguesSet.size > 0) {
        const activeLeagues = Array.from(activeLeaguesSet);
        activeLeagues.sort((a, b) => {
          const aBr = this.isBrazilLeagueKey(a) ? 1 : 0;
          const bBr = this.isBrazilLeagueKey(b) ? 1 : 0;
          if (aBr !== bBr) return bBr - aBr;
          return a.localeCompare(b);
        });

        const result = ['ALL', ...activeLeagues];
        this.activeLeaguesCache.set(cacheKey, { expiresAt: Date.now() + 5 * 60 * 1000, leagues: result });
        return result;
      }
    } catch (err: any) {
      this.logger.warn(`Failed dynamically fetching active leagues for ${subCategory}: ${err?.message}`);
    }

    // Static fallback only if third-party providers return 0
    const fallbackLeagues: Record<string, string[]> = {
      CRICKET: ['IPL', 'T20_WORLD_CUP', 'BBL', 'PSL', 'THE_HUNDRED', 'WPL'],
      FOOTBALL: ['BRASILEIRAO_SERIE_B', 'PREMIER_LEAGUE', 'CHAMPIONS_LEAGUE', 'LA_LIGA'],
      BASKETBALL: ['NBA', 'WNBA', 'EUROLEAGUE'],
      AMERICAN_FOOTBALL: ['NFL'],
      BASEBALL: ['MLB'],
      MMA_BOXING: ['UFC'],
      FORMULA1: ['FORMULA_1'],
      HOCKEY: ['NHL'],
      ESPORTS: ['DOTA_2', 'CS_GO', 'LEAGUE_OF_LEGENDS'],
    };

    if (cleanSubCat && cleanSubCat !== 'ALL' && fallbackLeagues[cleanSubCat]) {
      return ['ALL', ...fallbackLeagues[cleanSubCat]];
    }

    return ['ALL', 'BRASILEIRAO_SERIE_B', 'NFL', 'PREMIER_LEAGUE', 'CHAMPIONS_LEAGUE', 'NBA', 'UFC'];
  }

  async listPredictionQuestions(
    category: PredictionCategory,
    provider?: PredictionProvider,
    pageInput?: string | number,
    limitInput?: string | number,
    subCategory?: string,
    league?: string,
    search?: string,
  ) {
    if (!category) throw new BadRequestException('Prediction category required');
    const pagination = this.parsePredictionQuestionPagination(pageInput, limitInput);

    let rawMarkets: PredictionMarket[] = [];

    if (provider) {
      const client = this.getPredictionProvider(provider);
      rawMarkets = await client.listMarkets(category, subCategory, league);
    } else if (category === PredictionCategory.SPORTS) {
      // Query providers in parallel to aggregate Sports, NFL, and CBF Brasil soccer
      const results = await Promise.allSettled([
        this.getPredictionProvider(PredictionProvider.API_FOOTBALL).listMarkets(category, subCategory, league),
        this.getPredictionProvider(PredictionProvider.POLYMARKET).listMarkets(category, subCategory, league),
      ]);

      const seenIds = new Set<string>();
      for (const res of results) {
        if (res.status === 'fulfilled' && Array.isArray(res.value)) {
          for (const m of res.value) {
            const key = `${m.provider}_${m.externalMarketId}`;
            if (!seenIds.has(key)) {
              seenIds.add(key);
              rawMarkets.push(m);
            }
          }
        }
      }

      // If both API_FOOTBALL and POLYMARKET returned 0, fallback to MANIFOLD
      if (rawMarkets.length === 0) {
        try {
          const manifoldMarkets = await this.getPredictionProvider(PredictionProvider.MANIFOLD).listMarkets(category, subCategory, league);
          rawMarkets.push(...manifoldMarkets);
        } catch {
          // ignore manifold error
        }
      }
    } else {
      // Non-sports categories: Polymarket primary, Manifold fallback
      try {
        rawMarkets = await this.getPredictionProvider(PredictionProvider.POLYMARKET).listMarkets(category, subCategory, league);
      } catch (err: any) {
        this.logger.warn(`Polymarket query failed for ${category}: ${err?.message}`);
      }

      if (rawMarkets.length === 0) {
        try {
          rawMarkets = await this.getPredictionProvider(PredictionProvider.MANIFOLD).listMarkets(category, subCategory, league);
        } catch (err: any) {
          this.logger.warn(`Manifold fallback failed for ${category}: ${err?.message}`);
        }
      }
    }

    // Optional Search query filtering
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      rawMarkets = rawMarkets.filter((m) => {
        const text = `${m.question} ${(m.options || []).join(' ')} ${m.league || ''} ${m.subCategory || ''}`.toLowerCase();
        return text.includes(q);
      });
    }

    const sortedMarkets = this.sortPredictionMarkets(rawMarkets);
    return this.paginatePredictionMarkets(sortedMarkets, pagination.page, pagination.limit);
  }

  private isBrazilPredictionMarket(market: PredictionMarket): boolean {
    const raw = market.raw as any;
    const country = String(raw?.league?.country || '').trim().toLowerCase();
    if (country === 'brazil' || country === 'brasil') {
      return true;
    }

    const leagueKey = String(market.league || '').toUpperCase();
    const brazilLeagueKeys = new Set([
      'BRASILEIRAO_SERIE_A',
      'BRASILEIRAO_SERIE_B',
      'BRASILEIRAO_SERIE_C',
      'BRASILEIRAO_SERIE_D',
      'COPA_DO_BRASIL',
      'PAULISTA_A1',
      'PAULISTA_A2',
      'CARIOCA_A1',
      'CARIOCA_A2',
      'MINEIRO_1',
      'GAUCHO_1',
      'BAIANO_1',
      'CEARENSE_1',
      'PARANAENSE_1',
      'CATARINENSE_1',
      'PERNAMBUCANO_1',
      'GOIANO_1',
      'COPA_DO_NORDESTE',
      'SUPERCOPA_DO_BRASIL',
      'BRAZIL_FOOTBALL',
    ]);
    if (brazilLeagueKeys.has(leagueKey)) {
      return true;
    }

    const leagueName = String(raw?.league?.name || '').toLowerCase();
    if (
      leagueName.includes('brasil') ||
      leagueName.includes('brazil') ||
      leagueName.includes('brasileir') ||
      leagueName.includes('paulista') ||
      leagueName.includes('carioca') ||
      leagueName.includes('mineiro') ||
      leagueName.includes('gaúcho') ||
      leagueName.includes('gaucho') ||
      leagueName.includes('baiano') ||
      leagueName.includes('cearense') ||
      leagueName.includes('paranaense') ||
      leagueName.includes('catarinense') ||
      leagueName.includes('pernambucano') ||
      leagueName.includes('goiano') ||
      leagueName.includes('copa do brasil') ||
      leagueName.includes('copa do nordeste') ||
      leagueName.includes('supercopa do brasil')
    ) {
      return true;
    }

    const textToSearch = `${market.question} ${(market.options || []).join(' ')} ${leagueKey}`.toLowerCase();
    const brazilKeywords = [
      'brazil',
      'brasil',
      'brasileirao',
      'brasileirão',
      'copa do brasil',
      'flamengo',
      'palmeiras',
      'corinthians',
      'sao paulo',
      'santos fc',
      'fluminense',
      'botafogo',
      'vasco da gama',
      'gremio',
      'grêmio',
      'internacional',
      'cruzeiro',
      'atletico mineiro',
      'atlético mineiro',
      'athletico paranaense',
      'paulistao',
      'cariocao',
    ];

    return brazilKeywords.some((kw) => textToSearch.includes(kw));
  }

  private sortPredictionMarkets(markets: PredictionMarket[]): PredictionMarket[] {
    return [...markets].sort((a, b) => {
      const aIsBrazil = this.isBrazilPredictionMarket(a) ? 1 : 0;
      const bIsBrazil = this.isBrazilPredictionMarket(b) ? 1 : 0;

      // 1. Brazil local sports questions first
      if (aIsBrazil !== bIsBrazil) {
        return bIsBrazil - aIsBrazil;
      }

      // 2. Earliest close/start time first
      const aTime = a.closeTime ? new Date(a.closeTime).getTime() : Number.MAX_SAFE_INTEGER;
      const bTime = b.closeTime ? new Date(b.closeTime).getTime() : Number.MAX_SAFE_INTEGER;
      if (aTime !== bTime) {
        return aTime - bTime;
      }

      return 0;
    });
  }

  private parsePredictionQuestionPagination(pageInput?: string | number, limitInput?: string | number) {
    const page = Number(pageInput || 1);
    const limit = Number(limitInput || 20);

    if (!Number.isInteger(page) || page < 1) {
      throw new BadRequestException('Page must be a positive integer');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('Limit must be between 1 and 100');
    }

    return { page, limit };
  }

  private paginatePredictionMarkets(markets: PredictionMarket[], page: number, limit: number) {
    const total = markets.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const offset = (page - 1) * limit;

    return {
      data: markets.slice(offset, offset + limit),
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    };
  }

  async createPredictionBattle(userId: string, dto: CreatePredictionBattleDto) {
    if (!userId) throw new BadRequestException('User ID required');
    if (!dto?.externalMarketId) throw new BadRequestException('External market ID required');
    if (!dto?.selectedSide) throw new BadRequestException('Selected side required');

    const provider = dto.provider || PredictionProvider.POLYMARKET;
    const client = this.getPredictionProvider(provider);
    const market = await client.getMarket(dto.externalMarketId.trim(), dto.category);
    if (!market) throw new NotFoundException('Prediction question not found');
    if (market.status !== 'OPEN') throw new BadRequestException('Prediction question is not open');
    if (!market.closeTime) throw new BadRequestException('Prediction question close time is missing');
    const closeTime = market.closeTime;
    if (closeTime <= new Date()) throw new BadRequestException('Prediction question is already closed');

    const selectedSide = this.normalizeBattleSide(dto.selectedSide, market.options);
    const stakeAmount = dto.stake ?? 0;
    const justification = (dto.justification || selectedSide).trim();

    const battle = await this.prisma.$transaction(async (tx) => {
      if (stakeAmount > 0) {
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { id: true, totalPlatformPoints: true },
        });
        if (!user) throw new NotFoundException('User not found');
        if ((user.totalPlatformPoints ?? 0) < stakeAmount) {
          throw new BadRequestException('Insufficient platform points');
        }
        await tx.user.update({
          where: { id: userId },
          data: { totalPlatformPoints: { decrement: stakeAmount } },
        });
      }

      const created = await tx.battle.create({
        data: {
          creatorId: userId,
          format: 'POLL',
          battleType: BattleType.PREDICTION,
          status: 'LIVE',
          question: market.question,
          options: market.options,
          startTime: new Date(),
          endTime: closeTime,
          resolutionMethod: `${provider}:${market.externalMarketId}`,
          isPublic: dto.isPublic !== undefined ? dto.isPublic : true,
          stakeAmount: dto.stake ?? null,
          liveAt: new Date(),
          externalPrediction: {
            create: {
              provider,
              category: dto.category,
              externalMarketId: market.externalMarketId,
              externalEventId: market.externalEventId || null,
              question: market.question,
              options: market.options,
              providerStatus: market.status,
              resultSide: market.resultSide || null,
              raw: (market.raw || {}) as Prisma.InputJsonValue,
              closeTime,
              lastSyncedAt: new Date(),
            },
          },
        },
      });

      await tx.battlePrediction.create({
        data: {
          battleId: created.id,
          userId,
          side: selectedSide,
          justification,
          sourceUrl: dto.sourceUrl || null,
        },
      });

      await tx.battleParticipant.create({
        data: { battleId: created.id, userId, side: selectedSide },
      });

      await tx.battleComment.create({
        data: {
          battleId: created.id,
          userId,
          comment: justification,
        },
      });

      const externalPrediction = await tx.battleExternalPredictionMarket.findUniqueOrThrow({
        where: { battleId: created.id },
        select: { id: true },
      });

      await tx.battleExternalPredictionVote.create({
        data: {
          predictionId: externalPrediction.id,
          userId,
          selectedSide,
        },
      });

      return created;
    });

    const followerIds = await this.getFollowerIds(userId);
    await this.notificationService.sendBattleCreatedToFollowers(
      followerIds,
      battle.id,
      battle.question,
    );

    return battle;
  }

  private buildOptionImages(
    options: string[],
    uploadedOptionImages: string[],
    optionImageIndexes?: number[],
    existingOptionImages: string[] = [],
  ) {
    if (uploadedOptionImages.length === 0) {
      if (existingOptionImages.length > options.length) {
        throw new BadRequestException('Option images cannot be more than options');
      }
      return existingOptionImages;
    }

    if (optionImageIndexes?.length && optionImageIndexes.length !== uploadedOptionImages.length) {
      throw new BadRequestException('Option image indexes must match uploaded option images');
    }

    const optionImages = Array(options.length).fill('');

    uploadedOptionImages.forEach((url, fileIndex) => {
      const optionIndex = optionImageIndexes?.length ? optionImageIndexes[fileIndex] : fileIndex;
      if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= options.length) {
        throw new BadRequestException('Invalid option image index');
      }
      optionImages[optionIndex] = url;
    });

    return optionImages;
  }

  async inviteToBattle(userId: string, dto: BattleInviteDto) {
    if (!userId) throw new BadRequestException('User ID required');
    if (!dto?.battleId || !dto?.invitedUserId) throw new BadRequestException('Battle ID and invited user required');

    const battle = await this.prisma.battle.findUnique({ where: { id: dto.battleId } });
    if (!battle) throw new NotFoundException('Battle not found');
    if (battle.creatorId !== userId) throw new ForbiddenException('Only creator can invite');
    if (battle.format !== 'HEAD_TO_HEAD') throw new BadRequestException('Invite is only for head-to-head');
    if (battle.status !== 'DRAFT' && battle.status !== 'PENDING_INVITE') {
      throw new BadRequestException('Battle invite cannot be changed after it has started');
    }

    const invite = await this.prisma.battleInvite.upsert({
      where: { battleId_invitedUserId: { battleId: dto.battleId, invitedUserId: dto.invitedUserId } },
      update: { status: 'PENDING', respondedAt: null },
      create: {
        battleId: dto.battleId,
        inviterId: userId,
        invitedUserId: dto.invitedUserId,
        status: 'PENDING',
      },
    });

    return invite;
  }

  async editBattleQuestion(userId: string, dto: BattleEditQuestionDto) {
    if (!userId) throw new BadRequestException('User ID required');
    if (!dto?.battleId) throw new BadRequestException('Battle ID required');

    const normalizedQuestion = dto.question?.trim();
    const hasQuestionUpdate = typeof dto.question === 'string' && normalizedQuestion !== '';
    const hasOptionsUpdate = dto.options !== undefined;

    if (!hasQuestionUpdate && !hasOptionsUpdate) {
      throw new BadRequestException('Question or options required');
    }

    let normalizedOptions: string[] | undefined;
    if (hasOptionsUpdate) {
      if (!Array.isArray(dto.options) || dto.options.length === 0) {
        throw new BadRequestException('Options must be a non-empty array');
      }

      normalizedOptions = dto.options.map((option) => option.trim());
      if (normalizedOptions.some((option) => option === '')) {
        throw new BadRequestException('Each option must be non-empty');
      }

      const uniqueOptions = new Set(normalizedOptions.map((option) => option.toLowerCase()));
      if (uniqueOptions.size !== normalizedOptions.length) {
        throw new BadRequestException('Options must be unique');
      }
    }

    const battle = await this.prisma.battle.findUnique({
      where: { id: dto.battleId },
      select: {
        id: true,
        creatorId: true,
        format: true,
        status: true,
        createdAt: true,
        options: true,
        optionImages: true,
      },
    });

    if (!battle) throw new NotFoundException('Battle not found');
    if (battle.creatorId !== userId) throw new ForbiddenException('Only creator can edit battle question');
    if (battle.format === 'HEAD_TO_HEAD' && battle.status === 'LIVE') {
      throw new BadRequestException('Live head-to-head battles cannot be edited');
    }

    if (normalizedOptions) {
      if (battle.format === 'HEAD_TO_HEAD' && normalizedOptions.length !== 2) {
        throw new BadRequestException('Head-to-head battles require exactly two sides');
      }
      if (battle.format === 'POLL' && normalizedOptions.length < 2) {
        throw new BadRequestException('Poll battles require at least two options');
      }
    }

    const minutesSinceCreation = (Date.now() - battle.createdAt.getTime()) / (60 * 1000);
    if (minutesSinceCreation > 5) {
      throw new BadRequestException('Battle question can only be edited within 5 minutes of creation');
    }

    const updateData: { question?: string; options?: string[]; optionImages?: string[] } = {};

    if (hasQuestionUpdate) {
      updateData.question = normalizedQuestion;
    }
    if (normalizedOptions) {
      updateData.options = normalizedOptions;
      updateData.optionImages = normalizedOptions.map((_, index) => battle.optionImages[index] || '');
    }

    return this.prisma.$transaction(async (tx) => {
      const updatedBattle = await tx.battle.update({
        where: { id: dto.battleId },
        data: updateData,
      });

      if (!normalizedOptions) {
        return updatedBattle;
      }

      const sideRenames = battle.options
        .map((oldSide, index) => ({ oldSide, newSide: normalizedOptions[index] }))
        .filter(({ oldSide, newSide }) => !!newSide && oldSide !== newSide) as Array<{ oldSide: string; newSide: string }>;

      await Promise.all(
        sideRenames.flatMap(({ oldSide, newSide }) => [
          tx.battleParticipant.updateMany({
            where: { battleId: dto.battleId, side: oldSide },
            data: { side: newSide },
          }),
          tx.battleVote.updateMany({
            where: { battleId: dto.battleId, side: oldSide },
            data: { side: newSide },
          }),
          tx.battlePrediction.updateMany({
            where: { battleId: dto.battleId, side: oldSide },
            data: { side: newSide },
          }),
        ]),
      );

      return updatedBattle;
    });
  }

  async submitChallengerPosition(userId: string, dto: BattleChallengerPositionDto) {
    if (!userId) throw new BadRequestException('User ID required');
    if (!dto?.battleId) throw new BadRequestException('Battle ID required');

    const battle = await this.prisma.battle.findUnique({
      where: { id: dto.battleId },
      include: { invites: true },
    });
    if (!battle) throw new NotFoundException('Battle not found');
    if (battle.creatorId !== userId) throw new ForbiddenException('Only creator can choose challenger side');
    if (battle.format !== 'HEAD_TO_HEAD') throw new BadRequestException('Challenger side only applies to head-to-head');
    if (battle.status !== 'DRAFT') throw new BadRequestException('Challenger side can only be submitted while battle is draft');
    if (battle.options.length !== 2) throw new BadRequestException('Head-to-head battles require exactly two sides');

    const invite = battle.invites[0];
    if (!invite) throw new BadRequestException('Invite not found for this battle');

    const side = this.normalizeBattleSide(dto.side, battle.options);
    const comment = this.normalizeOpeningComment(dto.comment);

    const updatedBattle = await this.prisma.$transaction(async (tx) => {
      await tx.battleParticipant.upsert({
        where: { battleId_userId: { battleId: battle.id, userId } },
        update: {
          side,
          openingArgument: comment,
          argumentSubmitted: true,
        },
        create: {
          battleId: battle.id,
          userId,
          side,
          openingArgument: comment,
          argumentSubmitted: true,
        },
      });

      await tx.battleVote.upsert({
        where: { battleId_userId: { battleId: battle.id, userId } },
        update: { side },
        create: {
          battleId: battle.id,
          userId,
          side,
        },
      });

      await tx.battleComment.create({
        data: {
          battleId: battle.id,
          userId,
          comment,
          images: [],
        },
      });

      return tx.battle.update({
        where: { id: battle.id },
        data: { status: 'PENDING_INVITE' },
      });
    });

    await this.notificationService.sendBattleInvite(invite.invitedUserId, battle.id);

    return updatedBattle;
  }

  async acceptInvite(userId: string, dto: BattleResponseDto) {
    if (!userId) throw new BadRequestException('User ID required');
    if (!dto?.battleId) throw new BadRequestException('Battle ID required');

    const invite = await this.prisma.battleInvite.findFirst({
      where: { battleId: dto.battleId, invitedUserId: userId, status: 'PENDING' },
      include: { battle: true },
    });
    if (!invite) throw new NotFoundException('Invite not found');
    if (invite.battle.format !== 'HEAD_TO_HEAD') throw new BadRequestException('Invite only applies to head-to-head');
    if (invite.battle.status !== 'PENDING_INVITE') throw new BadRequestException('Battle is not ready to accept');

    const [updatedInvite, battle] = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.battleInvite.update({
        where: { id: invite.id },
        data: { status: 'ACCEPTED', respondedAt: new Date() },
      });

      const updatedBattle = await tx.battle.findUnique({
        where: { id: dto.battleId },
      });
      if (!updatedBattle) throw new NotFoundException('Battle not found');

      return [updated, updatedBattle] as const;
    });

    return { invite: updatedInvite, battle };
  }

  async submitOpponentPosition(userId: string, dto: BattleOpponentPositionDto) {
    if (!userId) throw new BadRequestException('User ID required');
    if (!dto?.battleId) throw new BadRequestException('Battle ID required');

    const invite = await this.prisma.battleInvite.findFirst({
      where: { battleId: dto.battleId, invitedUserId: userId, status: 'ACCEPTED' },
      include: {
        battle: {
          include: {
            participants: true,
          },
        },
      },
    });
    if (!invite) throw new NotFoundException('Accepted invite not found');
    if (invite.battle.format !== 'HEAD_TO_HEAD') throw new BadRequestException('Opponent side only applies to head-to-head');
    if (invite.battle.status !== 'PENDING_INVITE') throw new BadRequestException('Battle is not ready to go live');

    const challenger = invite.battle.participants.find((participant) => participant.userId === invite.battle.creatorId);
    if (!challenger?.side) throw new BadRequestException('Creator must choose a side before opponent can respond');

    const side = this.getRemainingSide(invite.battle.options, challenger.side);
    const comment = this.normalizeOpeningComment(dto.comment);

    const battle = await this.prisma.$transaction(async (tx) => {
      await tx.battleParticipant.upsert({
        where: { battleId_userId: { battleId: dto.battleId, userId } },
        update: {
          side,
          openingArgument: comment,
          argumentSubmitted: true,
        },
        create: {
          battleId: dto.battleId,
          userId,
          side,
          openingArgument: comment,
          argumentSubmitted: true,
        },
      });

      await tx.battleVote.upsert({
        where: { battleId_userId: { battleId: dto.battleId, userId } },
        update: { side },
        create: {
          battleId: dto.battleId,
          userId,
          side,
        },
      });

      await tx.battleComment.create({
        data: {
          battleId: dto.battleId,
          userId,
          comment,
          images: [],
        },
      });

      return tx.battle.update({
        where: { id: dto.battleId },
        data: { status: 'LIVE', liveAt: new Date() },
      });
    });

    await Promise.all([
      this.notificationService.sendBattleStarted(invite.battle.creatorId, dto.battleId),
      this.notificationService.sendBattleStarted(userId, dto.battleId),
    ]);

    return battle;
  }

  async declineInvite(userId: string, dto: BattleResponseDto) {
    if (!userId) throw new BadRequestException('User ID required');
    if (!dto?.battleId) throw new BadRequestException('Battle ID required');

    const invite = await this.prisma.battleInvite.findFirst({
      where: { battleId: dto.battleId, invitedUserId: userId, status: 'PENDING' },
      include: { battle: true },
    });
    if (!invite) throw new NotFoundException('Invite not found');

    const [updatedInvite] = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.battleInvite.update({
        where: { id: invite.id },
        data: { status: 'DECLINED', respondedAt: new Date() },
      });

      await tx.battle.update({
        where: { id: dto.battleId },
        data: { status: 'CANCELED' },
      });

      const stakeAmount = invite.battle.stakeAmount ?? 0;
      if (stakeAmount > 0) {
        await tx.user.update({
          where: { id: invite.battle.creatorId },
          data: { totalPlatformPoints: { increment: stakeAmount } },
        });
      }

      return [updated] as const;
    });

    await this.notificationService.sendBattleDeclined(invite.battle.creatorId, dto.battleId);

    return updatedInvite;
  }

  async joinBattle(userId: string, dto: BattleJoinDto) {
    if (!userId) throw new BadRequestException('User ID required');
    if (!dto?.battleId) throw new BadRequestException('Battle ID required');

    const battle = await this.prisma.battle.findUnique({ where: { id: dto.battleId } });
    if (!battle) throw new NotFoundException('Battle not found');
    if (battle.format !== 'POLL') throw new BadRequestException('Join only applies to poll battles');
    if (battle.status !== 'LIVE') throw new BadRequestException('Battle is not live');

    const existing = await this.prisma.battleParticipant.findUnique({
      where: { battleId_userId: { battleId: dto.battleId, userId } },
      select: { id: true },
    });

    const participant = await this.prisma.battleParticipant.upsert({
      where: { battleId_userId: { battleId: dto.battleId, userId } },
      update: { side: dto.side || null },
      create: { battleId: dto.battleId, userId, side: dto.side || null },
    });

    // Notify the battle creator when new participants join (batched by 5 to avoid spam).
    if (!existing) {
      const totalParticipants = await this.prisma.battleParticipant.count({
        where: { battleId: dto.battleId },
      });

      if (totalParticipants > 0 && totalParticipants % 5 === 0) {
        await this.notificationService.sendBattleNewParticipants([battle.creatorId], dto.battleId, 5);
      }
    }

    return participant;
  }

  async submitPrediction(userId: string, dto: BattlePredictionDto) {
    if (!userId) throw new BadRequestException('User ID required');
    if (!dto?.battleId || !dto?.side) {
      throw new BadRequestException('Battle ID and side required');
    }

    const battle = await this.prisma.battle.findUnique({
      where: { id: dto.battleId },
      include: { externalPrediction: true },
    });
    if (!battle) throw new NotFoundException('Battle not found');
    if (battle.format !== 'POLL') throw new BadRequestException('Prediction only applies to poll battles');
    if (battle.status !== 'LIVE') throw new BadRequestException('Battle is not live');
    if (battle.battleType !== BattleType.PREDICTION && !dto.justification) {
      throw new BadRequestException('Justification required');
    }
    const selectedSide = this.normalizeBattleSide(dto.side, battle.options);
    const justification = (dto.justification || selectedSide).trim();

    const prediction = await this.prisma.$transaction(async (tx) => {
      const upserted = await tx.battlePrediction.upsert({
        where: { battleId_userId: { battleId: dto.battleId, userId } },
        update: { side: selectedSide, justification, sourceUrl: dto.sourceUrl || null },
        create: {
          battleId: dto.battleId,
          userId,
          side: selectedSide,
          justification,
          sourceUrl: dto.sourceUrl || null,
        },
      });

      await tx.battleParticipant.upsert({
        where: { battleId_userId: { battleId: dto.battleId, userId } },
        update: { side: selectedSide },
        create: { battleId: dto.battleId, userId, side: selectedSide },
      });

      if (battle.battleType === BattleType.PREDICTION && battle.externalPrediction) {
        await tx.battleExternalPredictionVote.upsert({
          where: {
            predictionId_userId: {
              predictionId: battle.externalPrediction.id,
              userId,
            },
          },
          update: { selectedSide },
          create: {
            predictionId: battle.externalPrediction.id,
            userId,
            selectedSide,
          },
        });
      }

      await tx.battleComment.create({
        data: {
          battleId: dto.battleId,
          userId,
          comment: justification,
        },
      });

      return upserted;
    });

    return prediction;
  }

  async addComment(userId: string, dto: BattleCommentDto) {
    if (!userId) throw new BadRequestException('User ID required');
    if (!dto?.battleId || !dto?.comment) throw new BadRequestException('Battle ID and comment required');

    const battle = await this.prisma.battle.findUnique({ where: { id: dto.battleId } });
    if (!battle) throw new NotFoundException('Battle not found');
    this.ensureCanCommentOnBattle(battle, userId);
    await this.ensureParentBattleComment(dto.battleId, dto.parentCommentId);

    const existingParticipant = await this.prisma.battleParticipant.findUnique({
      where: { battleId_userId: { battleId: dto.battleId, userId } },
      select: { id: true },
    });

    const comment = await this.prisma.$transaction(async (tx) => {
      if (!existingParticipant) {
        await tx.battleParticipant.upsert({
          where: { battleId_userId: { battleId: dto.battleId, userId } },
          update: {},
          create: { battleId: dto.battleId, userId, side: null },
        });
      }

      return tx.battleComment.create({
        data: {
          battleId: dto.battleId,
          userId,
          comment: dto.comment,
          parentId: dto.parentCommentId || null,
          images: [],
        },
      });
    });

    // Treat first comment as "join" and notify in batches of 5 (best-effort).
    if (!existingParticipant) {
      try {
        if (battle.format === 'HEAD_TO_HEAD') {
          const mainParticipants = await this.prisma.battleParticipant.findMany({
            where: { battleId: dto.battleId, side: { in: ['A', 'B'] } },
            select: { userId: true },
          });
          const mainUserIds = Array.from(new Set(mainParticipants.map((p) => p.userId)));

          const communityCount = await this.prisma.battleParticipant.count({
            where: {
              battleId: dto.battleId,
              userId: mainUserIds.length ? { notIn: mainUserIds } : undefined,
            } as any,
          });

          if (mainUserIds.length > 0 && communityCount > 0 && communityCount % 5 === 0) {
            await this.notificationService.sendBattleNewParticipants(mainUserIds, dto.battleId, 5);
          }
        } else if (battle.format === 'POLL') {
          const communityCount = await this.prisma.battleParticipant.count({
            where: { battleId: dto.battleId, userId: { not: battle.creatorId } },
          });
          if (communityCount > 0 && communityCount % 5 === 0) {
            await this.notificationService.sendBattleNewParticipants([battle.creatorId], dto.battleId, 5);
          }
        }
      } catch (error) {
        // Best-effort: don't block comment flow if notification fails.
        console.error('Failed to send new participants notification (comment join):', error);
      }
    }

    try {
      await this.notificationService.sendBattleMentionNotifications(dto.battleId, comment.id, userId);
    } catch (error) {
      console.error('Failed to send battle mention notification:', error);
    }

    return comment;
  }

  async addCommentWithImages(userId: string, dto: BattleCommentDto, files?: Express.Multer.File[]) {
    if (!userId) throw new BadRequestException('User ID required');
    if (!dto?.battleId) throw new BadRequestException('Battle ID required');
    if (!dto?.comment && (!files || files.length === 0)) {
      throw new BadRequestException('Comment or images required');
    }

    const battle = await this.prisma.battle.findUnique({ where: { id: dto.battleId } });
    if (!battle) throw new NotFoundException('Battle not found');
    this.ensureCanCommentOnBattle(battle, userId);
    await this.ensureParentBattleComment(dto.battleId, dto.parentCommentId);

    const images = files && files.length > 0
      ? await Promise.all(files.map(file => uploadImageToS3(file, 'battle-comments')))
      : [];

    const existingParticipant = await this.prisma.battleParticipant.findUnique({
      where: { battleId_userId: { battleId: dto.battleId, userId } },
      select: { id: true },
    });

    const comment = await this.prisma.$transaction(async (tx) => {
      if (!existingParticipant) {
        await tx.battleParticipant.upsert({
          where: { battleId_userId: { battleId: dto.battleId, userId } },
          update: {},
          create: { battleId: dto.battleId, userId, side: null },
        });
      }

      return tx.battleComment.create({
        data: {
          battleId: dto.battleId,
          userId,
          comment: dto.comment || '',
          parentId: dto.parentCommentId || null,
          images,
        },
      });
    });

    // Treat first comment as "join" and notify in batches of 5 (best-effort).
    if (!existingParticipant) {
      try {
        if (battle.format === 'HEAD_TO_HEAD') {
          const mainParticipants = await this.prisma.battleParticipant.findMany({
            where: { battleId: dto.battleId, side: { in: ['A', 'B'] } },
            select: { userId: true },
          });
          const mainUserIds = Array.from(new Set(mainParticipants.map((p) => p.userId)));

          const communityCount = await this.prisma.battleParticipant.count({
            where: {
              battleId: dto.battleId,
              userId: mainUserIds.length ? { notIn: mainUserIds } : undefined,
            } as any,
          });

          if (mainUserIds.length > 0 && communityCount > 0 && communityCount % 5 === 0) {
            await this.notificationService.sendBattleNewParticipants(mainUserIds, dto.battleId, 5);
          }
        } else if (battle.format === 'POLL') {
          const communityCount = await this.prisma.battleParticipant.count({
            where: { battleId: dto.battleId, userId: { not: battle.creatorId } },
          });
          if (communityCount > 0 && communityCount % 5 === 0) {
            await this.notificationService.sendBattleNewParticipants([battle.creatorId], dto.battleId, 5);
          }
        }
      } catch (error) {
        // Best-effort: don't block comment flow if notification fails.
        console.error('Failed to send new participants notification (comment join with images):', error);
      }
    }

    try {
      await this.notificationService.sendBattleMentionNotifications(dto.battleId, comment.id, userId);
    } catch (error) {
      console.error('Failed to send battle mention notification:', error);
    }

    return comment;
  }

  async likeComment(userId: string, dto: BattleCommentLikeDto) {
    if (!userId) throw new BadRequestException('User ID required');
    if (!dto?.commentId) throw new BadRequestException('Comment ID required');

    const existing = await this.prisma.battleCommentLike.findFirst({
      where: { commentId: dto.commentId, userId },
    });

    if (existing) {
      await this.prisma.battleCommentLike.delete({ where: { id: existing.id } });
      return { message: 'Comment unliked', liked: false };
    }

    await this.prisma.battleCommentLike.create({ data: { commentId: dto.commentId, userId } });
    return { message: 'Comment liked', liked: true };
  }

  async pinComment(userId: string, dto: BattleCommentPinDto) {
    if (!userId) throw new BadRequestException('User ID required');
    if (!dto?.battleId || !dto?.commentId) {
      throw new BadRequestException('Battle ID and comment ID required');
    }

    const battle = await this.prisma.battle.findUnique({
      where: { id: dto.battleId },
      select: { id: true, creatorId: true },
    });
    if (!battle) throw new NotFoundException('Battle not found');
    if (battle.creatorId !== userId) {
      throw new ForbiddenException('Only battle creator can pin comments');
    }

    const comment = await this.prisma.battleComment.findUnique({
      where: { id: dto.commentId },
      select: { id: true, battleId: true },
    });
    if (!comment || comment.battleId !== dto.battleId) {
      throw new NotFoundException('Comment not found for this battle');
    }

    const alreadyPinnedRows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "BattleComment"
      WHERE "id" = ${dto.commentId}
        AND "isPin" = true
      LIMIT 1
    `;

    if (alreadyPinnedRows.length > 0) {
      return { message: 'Comment already pinned', commentId: comment.id, isPin: true };
    }

    const pinResult = await this.prisma.$transaction(async (tx) => {
      const pinnedCountRows = await tx.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS "count"
        FROM "BattleComment"
        WHERE "battleId" = ${dto.battleId}
          AND "isPin" = true
      `;

      const pinnedCount = Number(pinnedCountRows[0]?.count || 0);
      let unpinnedCommentId: string | null = null;

      if (pinnedCount >= 3) {
        const oldestPinnedRows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "BattleComment"
          WHERE "battleId" = ${dto.battleId}
            AND "isPin" = true
          ORDER BY COALESCE("pinnedAt", "createdAt") ASC
          LIMIT 1
        `;

        const oldestPinnedCommentId = oldestPinnedRows[0]?.id;
        if (oldestPinnedCommentId) {
          await tx.$executeRaw`
            UPDATE "BattleComment"
            SET "isPin" = false,
                "pinnedAt" = NULL
            WHERE "id" = ${oldestPinnedCommentId}
          `;
          unpinnedCommentId = oldestPinnedCommentId;
        }
      }

      await tx.$executeRaw`
        UPDATE "BattleComment"
        SET "isPin" = true,
            "pinnedAt" = NOW()
        WHERE "id" = ${dto.commentId}
      `;

      return { unpinnedCommentId };
    });

    return {
      message: pinResult.unpinnedCommentId
        ? 'Comment pinned successfully. Oldest pinned comment was unpinned.'
        : 'Comment pinned successfully',
      comment: {
        id: dto.commentId,
        battleId: dto.battleId,
        isPin: true,
      },
      unpinnedCommentId: pinResult.unpinnedCommentId,
    };
  }

  async unpinComment(userId: string, dto: BattleCommentUnpinDto) {
    if (!userId) throw new BadRequestException('User ID required');
    if (!dto?.battleId || !dto?.commentId) {
      throw new BadRequestException('Battle ID and comment ID required');
    }

    const battle = await this.prisma.battle.findUnique({
      where: { id: dto.battleId },
      select: { id: true, creatorId: true },
    });
    if (!battle) throw new NotFoundException('Battle not found');
    if (battle.creatorId !== userId) {
      throw new ForbiddenException('Only battle creator can unpin comments');
    }

    const comment = await this.prisma.battleComment.findUnique({
      where: { id: dto.commentId },
      select: { id: true, battleId: true },
    });
    if (!comment || comment.battleId !== dto.battleId) {
      throw new NotFoundException('Comment not found for this battle');
    }

    const alreadyPinnedRows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "BattleComment"
      WHERE "id" = ${dto.commentId}
        AND "isPin" = true
      LIMIT 1
    `;

    if (alreadyPinnedRows.length === 0) {
      return { message: 'Comment is already unpinned', commentId: comment.id, isPin: false };
    }

    await this.prisma.$executeRaw`
      UPDATE "BattleComment"
      SET "isPin" = false,
          "pinnedAt" = NULL
      WHERE "id" = ${dto.commentId}
    `;

    return {
      message: 'Comment unpinned successfully',
      comment: {
        id: dto.commentId,
        battleId: dto.battleId,
        isPin: false,
      },
    };
  }

  async highlightComment(userId: string, dto: BattleCommentHighlightDto) {
    if (!userId) throw new BadRequestException('User ID required');
    if (!dto?.battleId || !dto?.commentId) {
      throw new BadRequestException('Battle ID and comment ID required');
    }
    if (!Array.isArray(dto.highlights)) {
      throw new BadRequestException('Highlights must be an array');
    }

    const comment = await this.prisma.battleComment.findUnique({
      where: { id: dto.commentId },
      select: {
        id: true,
        battleId: true,
        userId: true,
        comment: true,
        battle: {
          select: {
            creatorId: true,
            format: true,
            invites: {
              select: {
                invitedUserId: true,
              },
            },
          },
        },
      },
    });

    if (!comment || comment.battleId !== dto.battleId) {
      throw new NotFoundException('Comment not found for this battle');
    }

    const isBattleCreator = comment.battle.creatorId === userId;
    const isCommentOwner = comment.userId === userId;
    const isInvitedUser = comment.battle.invites.some((invite) => invite.invitedUserId === userId);

    const canHighlight =
      comment.battle.format === 'POLL'
        ? (isBattleCreator || isCommentOwner)
        : comment.battle.format === 'HEAD_TO_HEAD'
          ? (isBattleCreator || isInvitedUser || isCommentOwner)
          : false;

    if (!canHighlight) {
      throw new ForbiddenException('You are not allowed to highlight this comment');
    }

    const normalizedHighlights = dto.highlights
      .map((range) => ({
        startIndex: Number(range.startIndex),
        endIndex: Number(range.endIndex),
      }))
      .sort((a, b) => a.startIndex - b.startIndex);

    const commentLength = comment.comment.length;

    for (let i = 0; i < normalizedHighlights.length; i += 1) {
      const range = normalizedHighlights[i];
      if (!Number.isInteger(range.startIndex) || !Number.isInteger(range.endIndex)) {
        throw new BadRequestException('Highlight indexes must be integers');
      }
      if (range.startIndex < 0 || range.endIndex <= range.startIndex) {
        throw new BadRequestException('Each highlight must satisfy startIndex >= 0 and endIndex > startIndex');
      }
      if (range.endIndex > commentLength) {
        throw new BadRequestException('Highlight range exceeds comment length');
      }
      if (i > 0 && range.startIndex < normalizedHighlights[i - 1].endIndex) {
        throw new BadRequestException('Highlight ranges cannot overlap');
      }
    }

    const updatedComment = await this.prisma.battleComment.update({
      where: { id: dto.commentId },
      data: {
        highlight: normalizedHighlights,
      },
      select: {
        id: true,
        battleId: true,
        highlight: true,
      },
    });

    return {
      message: 'Comment highlights updated successfully',
      comment: updatedComment,
    };
  }

  async removeCommentHighlight(userId: string, dto: BattleCommentRemoveHighlightDto) {
    if (!userId) throw new BadRequestException('User ID required');
    if (!dto?.battleId || !dto?.commentId) {
      throw new BadRequestException('Battle ID and comment ID required');
    }

    const comment = await this.prisma.battleComment.findUnique({
      where: { id: dto.commentId },
      select: {
        id: true,
        battleId: true,
        userId: true,
        battle: {
          select: {
            creatorId: true,
            format: true,
            invites: {
              select: {
                invitedUserId: true,
              },
            },
          },
        },
      },
    });

    if (!comment || comment.battleId !== dto.battleId) {
      throw new NotFoundException('Comment not found for this battle');
    }

    const isBattleCreator = comment.battle.creatorId === userId;
    const isCommentOwner = comment.userId === userId;
    const isInvitedUser = comment.battle.invites.some((invite) => invite.invitedUserId === userId);

    const canHighlight =
      comment.battle.format === 'POLL'
        ? (isBattleCreator || isCommentOwner)
        : comment.battle.format === 'HEAD_TO_HEAD'
          ? (isBattleCreator || isInvitedUser || isCommentOwner)
          : false;

    if (!canHighlight) {
      throw new ForbiddenException('You are not allowed to remove highlight from this comment');
    }

    const updatedComment = await this.prisma.battleComment.update({
      where: { id: dto.commentId },
      data: {
        highlight: Prisma.DbNull,
      },
      select: {
        id: true,
        battleId: true,
        highlight: true,
      },
    });

    return {
      message: 'Comment highlights removed successfully',
      comment: updatedComment,
    };
  }

  async editComment(userId: string, dto: BattleCommentEditDto) {
    if (!userId) throw new BadRequestException('User ID required');
    if (!dto?.commentId) throw new BadRequestException('Comment ID required');
    const newCommentText = (dto?.comment || '').trim();
    if (!newCommentText) throw new BadRequestException('Comment text required');

    const comment = await this.prisma.battleComment.findUnique({
      where: { id: dto.commentId },
      include: {
        battle: {
          select: {
            id: true,
            creatorId: true,
            format: true,
          },
        },
      },
    });

    if (!comment) throw new NotFoundException('Comment not found');
    if (dto.battleId && comment.battleId !== dto.battleId) {
      throw new BadRequestException('Comment does not belong to the specified battle');
    }
    if (comment.userId !== userId) {
      throw new ForbiddenException('Not allowed to edit this comment');
    }

    const minutesSinceCreation = (Date.now() - comment.createdAt.getTime()) / (60 * 1000);
    if (minutesSinceCreation > 3 || minutesSinceCreation < 0) {
      throw new BadRequestException('Comment can only be edited within 3 minutes of creation');
    }

    const updatedComment = await this.prisma.battleComment.update({
      where: { id: dto.commentId },
      data: {
        comment: newCommentText,
        highlight: Prisma.DbNull,
      },
      include: {
        user: {
          select: {
            id: true,
            displayName: true,
            userName: true,
            image: true,
          },
        },
        likes: true,
      },
    });

    try {
      await this.notificationService.sendBattleMentionNotifications(comment.battleId, comment.id, userId);
    } catch (error) {
      console.error('Failed to send battle mention notification on edit:', error);
    }

    return {
      message: 'Comment updated successfully',
      comment: updatedComment,
    };
  }

  async deleteComment(userId: string, dto: BattleCommentDeleteDto) {
    if (!userId) throw new BadRequestException('User ID required');
    if (!dto?.commentId) throw new BadRequestException('Comment ID required');

    const comment = await this.prisma.battleComment.findUnique({
      where: { id: dto.commentId },
      include: {
        battle: {
          select: {
            id: true,
            creatorId: true,
          },
        },
      },
    });

    if (!comment) throw new NotFoundException('Comment not found');
    if (dto.battleId && comment.battleId !== dto.battleId) {
      throw new BadRequestException('Comment does not belong to the specified battle');
    }

    const isCommentOwner = comment.userId === userId;
    const isBattleCreator = comment.battle?.creatorId === userId;

    if (!isCommentOwner && !isBattleCreator) {
      throw new ForbiddenException('You are not allowed to delete this comment');
    }

    if (!isBattleCreator) {
      const minutesSinceCreation = (Date.now() - comment.createdAt.getTime()) / (60 * 1000);
      if (minutesSinceCreation > 3 || minutesSinceCreation < 0) {
        throw new BadRequestException('Comment can only be deleted within 3 minutes of creation');
      }
    }

    await this.prisma.$transaction(async (tx) => {
      // Find all nested child replies
      const replies = await tx.battleComment.findMany({
        where: { parentId: dto.commentId },
        select: { id: true },
      });

      if (replies.length > 0) {
        const replyIds = replies.map((r) => r.id);
        await tx.battleCommentLike.deleteMany({
          where: { commentId: { in: replyIds } },
        });
        await tx.battleComment.deleteMany({
          where: { id: { in: replyIds } },
        });
      }

      await tx.battleCommentLike.deleteMany({
        where: { commentId: dto.commentId },
      });

      await tx.battleComment.delete({
        where: { id: dto.commentId },
      });
    });

    return {
      message: 'Comment deleted successfully',
      commentId: dto.commentId,
      battleId: comment.battleId,
    };
  }

  async voteOnDuel(userId: string, dto: BattleVoteDto) {
    if (!userId) throw new BadRequestException('User ID required');
    if (!dto?.battleId || !dto?.side) throw new BadRequestException('Battle ID and side required');

    const battle = await this.prisma.battle.findUnique({ where: { id: dto.battleId } });
    if (!battle) throw new NotFoundException('Battle not found');
    if (battle.format !== 'HEAD_TO_HEAD') throw new BadRequestException('Vote only applies to head-to-head');
    if (battle.status !== 'LIVE') throw new BadRequestException('Battle is not live');

    const normalizedComment = dto.comment?.trim();

    const result = await this.prisma.$transaction(async (tx) => {
      const existingVote = await tx.battleVote.findUnique({
        where: { battleId_userId: { battleId: dto.battleId, userId } },
      });
      if (existingVote) {
        throw new BadRequestException('You can vote only once in a battle');
      }

      const vote = await tx.battleVote.create({
        data: { battleId: dto.battleId, userId, side: dto.side },
      });

      let comment = null as any;
      if (normalizedComment) {
        comment = await tx.battleComment.create({
          data: {
            battleId: dto.battleId,
            userId,
            comment: normalizedComment,
            images: [],
          },
        });
      }

      return { vote, comment };
    });

    // Notify both head-to-head participants when the community joins (batched by 5 votes).
    try {
      const [participantUserIds, totalVotes] = await Promise.all([
        this.prisma.battleParticipant
          .findMany({ where: { battleId: dto.battleId }, select: { userId: true } })
          .then((rows) => rows.map((row) => row.userId)),
        this.prisma.battleVote.count({ where: { battleId: dto.battleId } }),
      ]);

      const uniqueParticipantUserIds = Array.from(new Set(participantUserIds));
      if (uniqueParticipantUserIds.length > 0 && totalVotes > 0 && totalVotes % 5 === 0) {
        await this.notificationService.sendBattleNewParticipants(uniqueParticipantUserIds, dto.battleId, 5);
      }
    } catch (error) {
      // Best-effort: don't block the vote flow if notification fails.
      console.error('Failed to send new participants notification (vote join):', error);
    }

    if (result.comment) {
      try {
        await this.notificationService.sendBattleMentionNotifications(dto.battleId, result.comment.id, userId);
      } catch (error) {
        console.error('Failed to send battle mention notification:', error);
      }
    }

    return result;
  }

  private async formatBattleListItems(battles: any[]) {
    const pollBattleIds = battles.filter((b) => b.format === 'POLL').map((b) => b.id);
    const headToHeadBattleIds = battles.filter((b) => b.format === 'HEAD_TO_HEAD').map((b) => b.id);

    const [pollCountsRaw, headToHeadVoteCountsRaw] = await Promise.all([
      pollBattleIds.length
        ? this.prisma.battlePrediction.groupBy({
          by: ['battleId', 'side'],
          where: { battleId: { in: pollBattleIds } },
          _count: { _all: true },
        })
        : Promise.resolve([] as Array<{ battleId: string; side: string; _count: { _all: number } }>),
      headToHeadBattleIds.length
        ? this.prisma.battleVote.groupBy({
          by: ['battleId', 'side'],
          where: { battleId: { in: headToHeadBattleIds } },
          _count: { _all: true },
        })
        : Promise.resolve([] as Array<{ battleId: string; side: string; _count: { _all: number } }>),
    ]);

    const pollCountsByBattle = pollCountsRaw.reduce<Map<string, Record<string, number>>>((acc, row) => {
      const existing = acc.get(row.battleId) || {};
      existing[row.side] = row._count._all;
      acc.set(row.battleId, existing);
      return acc;
    }, new Map());

    const headToHeadVoteCountsByBattle = headToHeadVoteCountsRaw.reduce<Map<string, Record<string, number>>>((acc, row) => {
      const existing = acc.get(row.battleId) || {};
      existing[row.side] = row._count._all;
      acc.set(row.battleId, existing);
      return acc;
    }, new Map());

    return battles.map((battle) => {
      const voteCounts =
        battle.format === 'HEAD_TO_HEAD'
          ? (headToHeadVoteCountsByBattle.get(battle.id) || {})
          : (pollCountsByBattle.get(battle.id) || {});

      const matchResult = this.buildMatchResult(battle);

      if (battle.format !== 'HEAD_TO_HEAD') {
        const { participants, invites, ...rest } = battle;
        return { ...rest, opponent: null, voteCounts, matchResult };
      }

      const headToHeadSides = this.buildHeadToHeadSides(battle);
      const participantOpponent = battle.participants
        .map((participant: any) => participant.user)
        .find((participantUser: any) => participantUser.id !== battle.creatorId);

      const invitedOpponent = battle.invites
        .map((invite: any) => invite.invited)
        .find((invitedUser: any) => invitedUser.id !== battle.creatorId);

      const opponent = participantOpponent || invitedOpponent || null;
      const { participants, invites, ...rest } = battle;
      return { ...rest, opponent, headToHeadSides, voteCounts, matchResult };
    });
  }

  async exploreBattles(userId: string, status?: string) {
    const now = new Date();
    const parsedStatus = this.parseBattleStatus(status) || BattleStatus.LIVE;
    const marketplaceStatus = this.mapBattleStatusToMarketplaceStatus(parsedStatus);

    const [normalItems, marketplaceItems] = await Promise.all([
      this.getExploreNormalBattles(parsedStatus),
      marketplaceStatus
        ? this.getExploreMarketplaceBattles(userId, marketplaceStatus, now)
        : Promise.resolve([]),
    ]);

    return [...normalItems, ...marketplaceItems].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  private mapBattleStatusToMarketplaceStatus(
    status: BattleStatus,
  ): MarketplaceBattleStatus | null {
    if (status === BattleStatus.LIVE) return MarketplaceBattleStatus.LIVE;
    if (status === BattleStatus.RESOLVED) return MarketplaceBattleStatus.COMPLETED;
    return null;
  }

  private getMarketplaceVisibilityWhere(
    viewerUserId?: string,
  ): Prisma.MarketplaceBattleWhereInput {
    if (!viewerUserId) {
      return { visibility: WhoCanBuy.Everyone };
    }

    return {
      OR: [
        { visibility: WhoCanBuy.Everyone },
        { sellerId: viewerUserId },
        {
          visibility: WhoCanBuy.followers,
          seller: {
            followers: {
              some: {
                followerId: viewerUserId,
                status: FollowStatus.ACCEPTED,
              },
            },
          },
        },
      ],
    };
  }

  private async getExploreNormalBattles(status: BattleStatus) {
    const battles = await this.prisma.battle.findMany({
      where: {
        status,
        isPublic: true,
      },
      include: {
        creator: true,
        externalPrediction: true,
        participants: {
          include: {
            user: { select: BATTLE_PUBLIC_USER_SELECT },
          },
        },
        invites: {
          include: {
            invited: { select: BATTLE_PUBLIC_USER_SELECT },
          },
          orderBy: { createdAt: 'desc' },
        },
        _count: { select: { participants: true, comments: true, votes: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return (await this.formatBattleListItems(battles)).map((battle) => ({
      ...battle,
      profileType: battle.creator?.profile ?? null,
      creator: battle.creator
        ? {
            ...battle.creator,
            profileType: battle.creator.profile ?? null,
          }
        : null,
      typeByBattle: 'normal' as const,
      feedItemType: 'normal_battle' as const,
    }));
  }

  private async getExploreMarketplaceBattles(
    viewerUserId: string,
    status: MarketplaceBattleStatus,
    now: Date,
  ) {
    const where: Prisma.MarketplaceBattleWhereInput = {
      status,
      AND: [this.getMarketplaceVisibilityWhere(viewerUserId)],
      ...(status === MarketplaceBattleStatus.LIVE
        ? {
          startAt: { lte: now },
          endAt: { gt: now },
          participants: {
            every: {
              product: {
                isActive: true,
                isDeleted: false,
              },
            },
            some: {
              product: {
                isActive: true,
                isDeleted: false,
              },
            },
          },
        }
        : {}),
    };

    const battles = await this.prisma.marketplaceBattle.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        sellerId: true,
        title: true,
        description: true,
        category: true,
        visibility: true,
        whoCanVote: true,
        shareToFeed: true,
        status: true,
        outcome: true,
        startAt: true,
        endAt: true,
        publishedAt: true,
        completedAt: true,
        winnerParticipantId: true,
        totalVotes: true,
        totalComments: true,
        mode: true,
        question: true,
        stakeAmount: true,
        opponentSellerId: true,
        opponentClosetId: true,
        inviteExpiresAt: true,
        createdAt: true,
        updatedAt: true,
        seller: {
          select: {
            id: true,
            displayName: true,
            userName: true,
            image: true,
            profile: true,
          },
        },
        closet: {
          select: {
            id: true,
            shopName: true,
            shopUsername: true,
            shopLogo: true,
          },
        },
        opponentCloset: {
          select: {
            id: true,
            shopName: true,
            shopUsername: true,
            shopLogo: true,
          },
        },
        participants: {
          orderBy: { position: 'asc' },
          select: {
            id: true,
            position: true,
            voteCount: true,
            isWinner: true,
            product: {
              select: {
                id: true,
                name: true,
                images: true,
                price: true,
                quantity: true,
                category: true,
                brand: true,
                condition: true,
                isActive: true,
                isDeleted: true,
              },
            },
          },
        },
        winnerParticipant: {
          select: {
            id: true,
            product: {
              select: {
                id: true,
                name: true,
                images: true,
                price: true,
                quantity: true,
                category: true,
                brand: true,
                condition: true,
                isActive: true,
                isDeleted: true,
              },
            },
          },
        },
      },
    });

    return battles
      .filter((battle) => {
        if (status === MarketplaceBattleStatus.LIVE) {
          return Boolean(
            battle.startAt &&
            battle.endAt &&
            battle.startAt <= now &&
            battle.endAt > now,
          );
        }
        return true;
      })
      .filter((battle) => {
        if (status === MarketplaceBattleStatus.COMPLETED) return true;
        return battle.participants.every(
          (participant) =>
            participant.product &&
            participant.product.isActive &&
            !participant.product.isDeleted,
        );
      })
      .map((battle) => this.mapExploreMarketplaceBattle(battle, now));
  }

  private mapExploreMarketplaceBattle(
    battle: {
      id: string;
      sellerId: string;
      title: string;
      description: string | null;
      category: string | null;
      visibility: WhoCanBuy;
      whoCanVote: WhoCanBuy;
      shareToFeed: boolean;
      status: string;
      outcome: string;
      startAt: Date | null;
      endAt: Date | null;
      publishedAt: Date | null;
      completedAt: Date | null;
      totalVotes: number;
      totalComments: number;
      mode: MarketplaceBattleMode;
      question: string | null;
      stakeAmount: number | null;
      opponentSellerId: string | null;
      inviteExpiresAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
      seller: {
        id: string;
        displayName: string | null;
        userName: string | null;
        image: string | null;
        profile?: string | null;
      };
      closet: {
        id: string;
        shopName: string;
        shopUsername: string;
        shopLogo: string | null;
      };
      opponentCloset: {
        id: string;
        shopName: string;
        shopUsername: string;
        shopLogo: string | null;
      } | null;
      participants: Array<{
        id: string;
        position: number;
        voteCount: number;
        isWinner: boolean;
        product: {
          id: string;
          name: string;
          images: string[];
          price: number;
          quantity: number;
          category: string;
          brand: string | null;
          condition: string;
          isActive: boolean;
          isDeleted: boolean;
        } | null;
      }>;
      winnerParticipant: {
        id: string;
        product: {
          id: string;
          name: string;
          images: string[];
          price: number;
          quantity: number;
          category: string;
          brand: string | null;
          condition: string;
          isActive: boolean;
          isDeleted: boolean;
        } | null;
      } | null;
    },
    now: Date,
  ) {
    const totalVotes = battle.totalVotes || 0;
    const participants = battle.participants
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((participant) => {
        const votePercentage =
          totalVotes > 0
            ? Math.round((participant.voteCount / totalVotes) * 10000) / 100
            : 0;

        return {
          id: participant.id,
          position: participant.position,
          voteCount: participant.voteCount,
          isWinner: participant.isWinner,
          votePercentage,
          product: participant.product
            ? {
              id: participant.product.id,
              name: participant.product.name,
              images: participant.product.images,
              price: participant.product.price,
              quantity: participant.product.quantity,
              category: participant.product.category,
              brand: participant.product.brand,
              condition: participant.product.condition,
            }
            : null,
        };
      });

    const remainingSeconds =
      battle.status === 'LIVE' && battle.endAt
        ? Math.max(0, Math.floor((battle.endAt.getTime() - now.getTime()) / 1000))
        : battle.status === 'COMPLETED'
          ? 0
          : null;

    const winner =
      battle.status === 'COMPLETED' &&
        battle.outcome === 'WINNER' &&
        battle.winnerParticipant
        ? {
          participantId: battle.winnerParticipant.id,
          product: battle.winnerParticipant.product
            ? {
              id: battle.winnerParticipant.product.id,
              name: battle.winnerParticipant.product.name,
              images: battle.winnerParticipant.product.images,
              price: battle.winnerParticipant.product.price,
              quantity: battle.winnerParticipant.product.quantity,
              category: battle.winnerParticipant.product.category,
              brand: battle.winnerParticipant.product.brand,
              condition: battle.winnerParticipant.product.condition,
            }
            : null,
        }
        : null;

    return {
      id: battle.id,
      title: battle.title,
      description: battle.description,
      category: battle.category,
      visibility: battle.visibility,
      whoCanVote: battle.whoCanVote,
      shareToFeed: battle.shareToFeed,
      status: battle.status,
      outcome: battle.outcome,
      startAt: battle.startAt,
      endAt: battle.endAt,
      publishedAt: battle.publishedAt,
      completedAt: battle.completedAt,
      totalVotes: battle.totalVotes,
      totalComments: battle.totalComments,
      mode: battle.mode ?? MarketplaceBattleMode.SAME_CLOSET,
      question: battle.question ?? null,
      stakeAmount: battle.stakeAmount ?? null,
      opponentSellerId: battle.opponentSellerId ?? null,
      inviteExpiresAt: battle.inviteExpiresAt ?? null,
      createdAt: battle.createdAt,
      updatedAt: battle.updatedAt,
      remainingSeconds,
      startsInSeconds: null,
      seller: {
        id: battle.seller.id,
        name: battle.seller.displayName || battle.seller.userName || 'Unknown Seller',
        profileImage: battle.seller.image,
        profile: (battle.seller as any)?.profile ?? null,
        profileType: (battle.seller as any)?.profile ?? null,
      },
      profileType: (battle.seller as any)?.profile ?? null,
      closet: {
        id: battle.closet.id,
        shopName: battle.closet.shopName,
        shopUsername: battle.closet.shopUsername,
        shopLogo: battle.closet.shopLogo,
      },
      opponentCloset: battle.opponentCloset
        ? {
          id: battle.opponentCloset.id,
          shopName: battle.opponentCloset.shopName,
          shopUsername: battle.opponentCloset.shopUsername,
          shopLogo: battle.opponentCloset.shopLogo,
        }
        : null,
      participants,
      winnerProductId: winner?.product?.id ?? null,
      winner,
      format: 'marketPlace' as const,
      typeByBattle: 'marketplace' as const,
      feedItemType: 'marketplace_battle' as const,
    };
  }

  async myBattleTracking(userId: string, filter: string) {
    if (!userId) throw new BadRequestException('User ID required');

    const normalizedFilter = (filter || '').trim();
    const allowedFilters = ['battle_live', 'battle_arena', 'battle_past'];
    if (!allowedFilters.includes(normalizedFilter)) {
      throw new BadRequestException('Invalid filter. Use battle_live, battle_arena, or battle_past');
    }

    const myBattleEngagementWhere = {
      OR: [
        { participants: { some: { userId } } },
        { comments: { some: { userId } } },
        { votes: { some: { userId } } },
        { predictions: { some: { userId } } },
      ],
    };

    const where =
      normalizedFilter === 'battle_live'
        ? {
          creatorId: userId,
          status: {
            in: [
              BattleStatus.LIVE,
              BattleStatus.PENDING_INVITE,
            ],
          },
        }
        : normalizedFilter === 'battle_arena'
          ? {
            status: BattleStatus.LIVE,
            creatorId: { not: userId },
            ...myBattleEngagementWhere,
          }
          : {
            status: BattleStatus.RESOLVED,
            OR: [
              { creatorId: userId },
              { participants: { some: { userId } } },
              { comments: { some: { userId } } },
              { votes: { some: { userId } } },
              { predictions: { some: { userId } } },
            ],
          };

    const battles = await this.prisma.battle.findMany({
      where,
      include: {
        creator: { select: BATTLE_PUBLIC_USER_SELECT },
        winner: { select: BATTLE_PUBLIC_USER_SELECT },
        externalPrediction: true,
        participants: {
          include: {
            user: { select: BATTLE_PUBLIC_USER_SELECT },
          },
        },
        invites: {
          include: {
            invited: { select: BATTLE_PUBLIC_USER_SELECT },
          },
          orderBy: { createdAt: 'desc' },
        },
        _count: { select: { participants: true, comments: true, votes: true } },
      },
      orderBy: normalizedFilter === 'battle_past'
        ? [{ resolvedAt: 'desc' }, { createdAt: 'desc' }]
        : [{ endTime: 'asc' }, { createdAt: 'desc' }],
      take: 100,
    });

    const items = await this.formatBattleListItems(battles);

    return {
      filter: normalizedFilter,
      count: items.length,
      items,
    };
  }

  async getBattlesByUser(targetUserId: string, status?: string) {
    if (!targetUserId) throw new BadRequestException('User ID required');
    const parsedStatus = this.parseBattleStatus(status);
    const battles = await this.prisma.battle.findMany({
      where: {
        ...(parsedStatus ? { status: parsedStatus } : {}),
        OR: [
          { creatorId: targetUserId },
          { participants: { some: { userId: targetUserId } } },
        ],
      },
      include: {
        creator: true,
        externalPrediction: true,
        _count: { select: { participants: true, comments: true, votes: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return battles.map((battle) => ({
      ...battle,
      profileType: battle.creator?.profile ?? null,
      creator: battle.creator
        ? {
            ...battle.creator,
            profileType: battle.creator.profile ?? null,
          }
        : null,
      matchResult: this.buildMatchResult(battle),
    }));
  }

  async getBattlePointsByUser(userId: string, status?: string) {
    if (!userId) throw new BadRequestException('User ID required');

    const parsedStatus = this.parseBattleStatus(status);

    const [participants, stats] = await Promise.all([
      this.prisma.battleParticipant.findMany({
        where: {
          userId,
          ...(parsedStatus ? { battle: { status: parsedStatus } } : {}),
        },
        include: {
          battle: {
            include: {
              externalPrediction: true,
            },
          },
        },
        orderBy: { joinedAt: 'desc' },
      }),
      this.prisma.userBattleStats.findUnique({ where: { userId } }),
    ]);

    const items = participants.map((p) => ({
      battleId: p.battleId,
      format: p.battle.format,
      status: p.battle.status,
      question: p.battle.question,
      side: p.side,
      score: p.score,
      baseJoinPoints: p.baseJoinPoints,
      argumentPoints: p.argumentPoints,
      engagementPoints: p.engagementPoints,
      timingBonus: p.timingBonus,
      underdogBonus: p.underdogBonus,
      winnerBonus: p.winnerBonus,
      loserPenalty: p.loserPenalty,
      argumentSubmitted: p.argumentSubmitted,
      likesCount: p.likesCount,
      votePoints: p.votePoints,
      isWinner: p.isWinner,
      resolvedAt: p.battle.resolvedAt,
      winningSide: p.battle.winningSide,
      correctSide: p.battle.correctSide,
      matchResult: this.buildMatchResult(p.battle),
    }));

    const totals = stats || {
      totalBattlePoints: 0,
      totalBattlesJoined: 0,
      totalBattlesWon: 0,
      totalPredictionsCorrect: 0,
      totalPredictionsWrong: 0,
      totalArgumentsSubmitted: 0,
      totalArgumentLikes: 0,
    };

    const predictionTotal = totals.totalPredictionsCorrect + totals.totalPredictionsWrong;
    const predictionAccuracyPercent = predictionTotal > 0
      ? Math.round((totals.totalPredictionsCorrect / predictionTotal) * 100)
      : 0;

    const argumentQualityScore = totals.totalArgumentsSubmitted > 0
      ? Math.min(100, Math.round((totals.totalArgumentLikes / totals.totalArgumentsSubmitted) * 10))
      : 0;

    const credibilityScore = Math.round(
      totals.totalBattlePoints * 0.4
      + predictionAccuracyPercent * 0.4
      + argumentQualityScore * 0.2,
    );

    const level = this.getBattleLevel(totals.totalBattlePoints);

    return {
      userId,
      totals,
      predictionAccuracyPercent,
      argumentQualityScore,
      credibilityScore,
      level,
      items,
    };
  }

  async getBattleWinnerPoints(battleId: string) {
    if (!battleId) throw new BadRequestException('Battle ID required');

    const battle = await this.prisma.battle.findUnique({
      where: { id: battleId },
      include: { externalPrediction: true },
    });
    if (!battle) throw new NotFoundException('Battle not found');

    const matchResult = this.buildMatchResult(battle);
    const isPrediction = battle.battleType === BattleType.PREDICTION || Boolean(battle.externalPrediction);
    const category = battle.externalPrediction?.category || (matchResult?.isMatch ? 'SPORTS' : null);

    if (!battle.winnerUserId) {
      return {
        battleId: battle.id,
        winnerUserId: null,
        points: null,
        status: battle.status,
        battleType: battle.battleType,
        isPrediction,
        category,
        resolvedAt: battle.resolvedAt,
        winningSide: battle.winningSide || battle.correctSide || null,
        matchResult,
      };
    }

    const participant = await this.prisma.battleParticipant.findUnique({
      where: { battleId_userId: { battleId: battle.id, userId: battle.winnerUserId } },
      select: { score: true },
    });

    return {
      battleId: battle.id,
      winnerUserId: battle.winnerUserId,
      points: participant?.score ?? null,
      status: battle.status,
      battleType: battle.battleType,
      isPrediction,
      category,
      resolvedAt: battle.resolvedAt,
      winningSide: battle.winningSide || battle.correctSide || null,
      matchResult,
    };
  }

  private parseBattleStatus(status?: string): BattleStatus | undefined {
    if (!status) return undefined;
    const normalized = status.trim().toUpperCase();
    const values = Object.values(BattleStatus) as string[];
    if (!values.includes(normalized)) return undefined;
    return normalized as BattleStatus;
  }

  async getBattle(battleId: string) {
    if (!battleId) throw new BadRequestException('Battle ID required');
    const battle = await this.prisma.battle.findUnique({
      where: { id: battleId },
      include: {
        creator: true,
        externalPrediction: true,
        participants: {
          include: {
            user: { select: BATTLE_PUBLIC_USER_SELECT },
          },
        },
        invites: {
          include: {
            inviter: { select: BATTLE_PUBLIC_USER_SELECT },
            invited: { select: BATTLE_PUBLIC_USER_SELECT },
          },
        },
        predictions: true,
        comments: {
          include: {
            user: true,
            likes: true,
          },
          orderBy: { createdAt: 'desc' },
        },
        votes: true,
      },
    });
    if (!battle) throw new NotFoundException('Battle not found');

    const [predictionCountsRaw, voteCountsRaw] = await Promise.all([
      battle.format === 'POLL'
        ? this.prisma.battlePrediction.groupBy({
          by: ['side'],
          where: { battleId },
          _count: { _all: true },
        })
        : Promise.resolve([] as Array<{ side: string; _count: { _all: number } }>),
      battle.format === 'HEAD_TO_HEAD'
        ? this.prisma.battleVote.groupBy({
          by: ['side'],
          where: { battleId },
          _count: { _all: true },
        })
        : Promise.resolve([] as Array<{ side: string; _count: { _all: number } }>),
    ]);

    const predictionCounts = predictionCountsRaw.reduce<Record<string, number>>((acc, row) => {
      acc[row.side] = row._count._all;
      return acc;
    }, {});

    const voteCounts = voteCountsRaw.reduce<Record<string, number>>((acc, row) => {
      acc[row.side] = row._count._all;
      return acc;
    }, {});

    // Keep backward compatibility for clients already reading predictionCounts.
    // For head-to-head battles, mirror vote counts into predictionCounts.
    const effectivePredictionCounts =
      battle.format === 'HEAD_TO_HEAD' ? voteCounts : predictionCounts;

    const pinnedCommentRows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "BattleComment"
      WHERE "battleId" = ${battleId}
        AND "isPin" = true
    `;
    const pinnedCommentIdSet = new Set(pinnedCommentRows.map((row) => row.id));

    const commentById = new Map<string, any>();
    battle.comments.forEach((comment) => {
      commentById.set(comment.id, { ...comment, isPin: pinnedCommentIdSet.has(comment.id), replies: [] });
    });

    const nestedComments: any[] = [];
    commentById.forEach((comment) => {
      if (comment.parentId && commentById.has(comment.parentId)) {
        commentById.get(comment.parentId).replies.push(comment);
      } else {
        nestedComments.push(comment);
      }
    });

    const sortRepliesPinnedThenCreatedAtDesc = (items: any[]) => {
      items.sort((a, b) => {
        const pinDelta = Number(!!b.isPin) - Number(!!a.isPin);
        if (pinDelta !== 0) return pinDelta;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
      items.forEach((item) => {
        if (Array.isArray(item.replies) && item.replies.length) {
          sortRepliesPinnedThenCreatedAtDesc(item.replies);
        }
      });
    };

    sortRepliesPinnedThenCreatedAtDesc(nestedComments);

    const topLevelByCreatedAtAsc = [...nestedComments].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );

    const topLevelPinnedByCreatedAtDesc = [...nestedComments]
      .filter((comment) => !!comment.isPin)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const topLevelOthersByCreatedAtDesc = [...nestedComments]
      .filter((comment) => !comment.isPin)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const usedCommentIds = new Set<string>();
    const orderedComments: any[] = [];
    const pushIfUnused = (comment: any | null | undefined) => {
      if (!comment) return;
      if (usedCommentIds.has(comment.id)) return;
      usedCommentIds.add(comment.id);
      orderedComments.push(comment);
    };

    if (battle.format === 'HEAD_TO_HEAD') {
      const invitedUserId =
        battle.invites?.[0]?.invitedUserId
        || battle.participants.find((participant) => participant.userId !== battle.creatorId)?.userId
        || null;

      const creatorFirstComment =
        topLevelByCreatedAtAsc.find((comment) => comment.userId === battle.creatorId) || null;
      const invitedUserFirstComment = invitedUserId
        ? topLevelByCreatedAtAsc.find((comment) => comment.userId === invitedUserId) || null
        : null;

      pushIfUnused(creatorFirstComment);
      pushIfUnused(invitedUserFirstComment);
      topLevelPinnedByCreatedAtDesc.forEach((comment) => pushIfUnused(comment));
      topLevelOthersByCreatedAtDesc.forEach((comment) => pushIfUnused(comment));
    } else if (battle.format === 'POLL') {
      const creatorFirstComment =
        topLevelByCreatedAtAsc.find((comment) => comment.userId === battle.creatorId) || null;

      pushIfUnused(creatorFirstComment);
      topLevelPinnedByCreatedAtDesc.forEach((comment) => pushIfUnused(comment));
      topLevelOthersByCreatedAtDesc.forEach((comment) => pushIfUnused(comment));
    } else {
      topLevelPinnedByCreatedAtDesc.forEach((comment) => pushIfUnused(comment));
      topLevelOthersByCreatedAtDesc.forEach((comment) => pushIfUnused(comment));
    }

    return {
      ...battle,
      headToHeadSides: this.buildHeadToHeadSides(battle),
      predictionCounts: effectivePredictionCounts,
      voteCounts,
      comments: orderedComments,
      matchResult: this.buildMatchResult(battle),
    };

  }

  async getInviteDetail(userId: string, battleId: string) {
    if (!userId) throw new BadRequestException('User ID required');
    if (!battleId) throw new BadRequestException('Battle ID required');

    const battle = await this.prisma.battle.findUnique({
      where: { id: battleId },
      include: {
        creator: { select: BATTLE_PUBLIC_USER_SELECT },
        participants: {
          include: {
            user: { select: BATTLE_PUBLIC_USER_SELECT },
          },
        },
        invites: {
          include: {
            inviter: { select: BATTLE_PUBLIC_USER_SELECT },
            invited: { select: BATTLE_PUBLIC_USER_SELECT },
          },
        },
      },
    });

    if (!battle) throw new NotFoundException('Battle not found');
    if (battle.format !== 'HEAD_TO_HEAD') throw new BadRequestException('Invite detail only applies to head-to-head');

    const invite = battle.invites.find((entry) => entry.invitedUserId === userId || entry.inviterId === userId);
    const isCreator = battle.creatorId === userId;
    if (!invite && !isCreator) throw new ForbiddenException('Not allowed to view this battle invite');

    const challenger = battle.participants.find((participant) => participant.userId === battle.creatorId) || null;
    const opponent = battle.participants.find((participant) => participant.userId !== battle.creatorId) || null;
    const headToHeadSides = this.buildHeadToHeadSides(battle);

    return {
      id: battle.id,
      battleId: battle.id,
      format: battle.format,
      status: battle.status,
      question: battle.question,
      options: battle.options,
      optionImages: battle.optionImages,
      image: battle.image,
      endTime: battle.endTime,
      invite,
      challenger,
      opponent,
      headToHeadSides,
      opponentSideToAssign: challenger?.side ? this.getRemainingSide(battle.options, challenger.side) : null,
      canAccept: !!invite && invite.invitedUserId === userId && invite.status === 'PENDING' && battle.status === 'PENDING_INVITE',
      canDecline: !!invite && invite.invitedUserId === userId && invite.status === 'PENDING' && battle.status === 'PENDING_INVITE',
      canSubmitOpponentPosition: !!invite && invite.invitedUserId === userId && invite.status === 'ACCEPTED' && battle.status === 'PENDING_INVITE',
    };
  }

  async closeBattle(dto: BattleCloseDto) {
    if (!dto?.battleId) throw new BadRequestException('Battle ID required');

    const battle = await this.prisma.battle.findUnique({ where: { id: dto.battleId } });
    if (!battle) throw new NotFoundException('Battle not found');
    if (battle.status !== 'LIVE') throw new BadRequestException('Battle is not live');

    return this.prisma.battle.update({
      where: { id: dto.battleId },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
  }

  async resolveBattle(dto: BattleCloseDto) {
    if (!dto?.battleId) throw new BadRequestException('Battle ID required');

    const battle = await this.prisma.battle.findUnique({
      where: { id: dto.battleId },
      include: {
        participants: true,
        predictions: true,
      },
    });
    if (!battle) throw new NotFoundException('Battle not found');

    if (battle.format === 'POLL' && battle.battleType === BattleType.PREDICTION && !dto.correctSide) {
      const resultSide = await this.syncPredictionBattleResult(battle.id);
      if (!resultSide) {
        throw new BadRequestException('Third-party result is not available yet');
      }
      return this.resolvePollBattle(battle.id, resultSide);
    }

    if (battle.format === 'POLL') {
      return this.resolvePollBattle(battle.id, dto.correctSide || null);
    }

    return this.resolveDuelBattle(battle.id);
  }

  async cancelExpiredPendingInvites() {
    const now = new Date();
    const battles = await this.prisma.battle.findMany({
      where: {
        format: 'HEAD_TO_HEAD',
        status: 'PENDING_INVITE',
        endTime: { lte: now },
        invites: { some: { status: 'PENDING' } },
      },
      select: {
        id: true,
        creatorId: true,
        stakeAmount: true,
        invites: {
          where: { status: 'PENDING' },
          select: {
            id: true,
            invited: { select: { userName: true, displayName: true } },
          },
          take: 1,
        },
      },
    });

    if (battles.length === 0) return { canceled: 0 };

    for (const battle of battles) {
      const invite = battle.invites[0];
      const invitedUserName = invite?.invited?.userName || invite?.invited?.displayName || 'the invited user';

      await this.prisma.$transaction(async (tx) => {
        await tx.battleInvite.updateMany({
          where: { battleId: battle.id, status: 'PENDING' },
          data: { status: 'CANCELED', respondedAt: now },
        });

        await tx.battle.updateMany({
          where: { id: battle.id, status: 'PENDING_INVITE' },
          data: { status: 'CANCELED' },
        });

        const stakeAmount = battle.stakeAmount ?? 0;
        if (stakeAmount > 0) {
          await tx.user.update({
            where: { id: battle.creatorId },
            data: { totalPlatformPoints: { increment: stakeAmount } },
          });
        }
      });

      await this.notificationService.sendBattleInviteExpired(battle.creatorId, battle.id, invitedUserName);
    }

    return { canceled: battles.length };
  }

  async closeExpiredBattles() {
    const now = new Date();
    const battles = await this.prisma.battle.findMany({
      where: {
        status: 'LIVE',
        endTime: { lte: now },
      },
      select: { id: true },
    });

    if (battles.length === 0) return { closed: 0 };

    const result = await this.prisma.battle.updateMany({
      where: {
        id: { in: battles.map((b) => b.id) },
        status: 'LIVE',
      },
      data: { status: 'CLOSED', closedAt: now },
    });

    return { closed: result.count };
  }

  async resolveClosedHeadToHeadBattles() {
    const battles = await this.prisma.battle.findMany({
      where: {
        status: 'CLOSED',
        format: 'HEAD_TO_HEAD',
        resolvedAt: null,
      },
      select: { id: true },
    });

    if (battles.length === 0) return { resolved: 0 };

    for (const battle of battles) {
      await this.resolveDuelBattle(battle.id);
    }

    return { resolved: battles.length };
  }

  async resolveClosedPollBattles() {
    const battles = await this.prisma.battle.findMany({
      where: {
        status: 'CLOSED',
        format: 'POLL',
        battleType: BattleType.NORMAL,
        resolvedAt: null,
      },
      select: { id: true },
    });

    if (battles.length === 0) return { resolved: 0 };

    let resolvedCount = 0;
    for (const battle of battles) {
      const predictions = await this.prisma.battlePrediction.findMany({
        where: { battleId: battle.id },
      });

      if (predictions.length === 0) continue;

      const sideCounts = new Map<string, number>();
      predictions.forEach((p) => sideCounts.set(p.side, (sideCounts.get(p.side) || 0) + 1));

      const maxCount = Math.max(...Array.from(sideCounts.values()));
      let candidateSides = Array.from(sideCounts.entries())
        .filter(([_, count]) => count === maxCount)
        .map(([side]) => side);

      let correctSide = candidateSides[0];

      if (candidateSides.length > 1) {
        const commentLikes = await this.prisma.battleCommentLike.findMany({
          where: { comment: { battleId: battle.id } },
          include: { comment: true },
        });

        const likesByUser = new Map<string, number>();
        commentLikes.forEach((like) => {
          const ownerId = like.comment.userId;
          likesByUser.set(ownerId, (likesByUser.get(ownerId) || 0) + 1);
        });

        const likesBySide = new Map<string, number>();
        predictions.forEach((p) => {
          const likes = likesByUser.get(p.userId) || 0;
          likesBySide.set(p.side, (likesBySide.get(p.side) || 0) + likes);
        });

        const maxLikes = Math.max(...candidateSides.map((side) => likesBySide.get(side) || 0));
        candidateSides = candidateSides.filter((side) => (likesBySide.get(side) || 0) === maxLikes);

        correctSide = candidateSides.sort()[0];
      }

      await this.resolvePollBattle(battle.id, correctSide);
      resolvedCount += 1;
    }

    return { resolved: resolvedCount };
  }

  async resolveClosedPredictionBattles() {
    const battles = await this.prisma.battle.findMany({
      where: {
        status: 'CLOSED',
        format: 'POLL',
        battleType: BattleType.PREDICTION,
        resolvedAt: null,
        externalPrediction: { isNot: null },
      },
      select: { id: true },
      take: 50,
    });

    if (battles.length === 0) return { resolved: 0, pending: 0 };

    let resolvedCount = 0;
    let pendingCount = 0;

    for (const battle of battles) {
      const resultSide = await this.syncPredictionBattleResult(battle.id);
      if (!resultSide) {
        pendingCount += 1;
        continue;
      }

      await this.resolvePollBattle(battle.id, resultSide);
      resolvedCount += 1;
    }

    return { resolved: resolvedCount, pending: pendingCount };
  }

  private async syncPredictionBattleResult(battleId: string): Promise<string | null> {
    const externalPrediction = await this.prisma.battleExternalPredictionMarket.findUnique({
      where: { battleId },
    });
    if (!externalPrediction) throw new BadRequestException('Prediction provider metadata not found');

    const client = this.getPredictionProvider(externalPrediction.provider);
    const market = await client.getMarket(externalPrediction.externalMarketId, externalPrediction.category);
    if (!market) return externalPrediction.resultSide || null;

    const resultSide = market.resultSide
      ? this.normalizeBattleSide(market.resultSide, externalPrediction.options)
      : null;

    await this.prisma.battleExternalPredictionMarket.update({
      where: { id: externalPrediction.id },
      data: {
        providerStatus: market.status,
        resultSide,
        resultRaw: resultSide ? ((market.raw || {}) as Prisma.InputJsonValue) : Prisma.DbNull,
        raw: (market.raw || {}) as Prisma.InputJsonValue,
        closeTime: market.closeTime || externalPrediction.closeTime,
        lastSyncedAt: new Date(),
      },
    });

    return resultSide;
  }

  private async resolvePollBattle(battleId: string, correctSide: string | null) {
    if (!correctSide) throw new BadRequestException('Correct side required to resolve poll');

    const [battle, predictions, commentLikes, comments, participants] = await Promise.all([
      this.prisma.battle.findUnique({ where: { id: battleId } }),
      this.prisma.battlePrediction.findMany({ where: { battleId } }),
      this.prisma.battleCommentLike.findMany({
        where: { comment: { battleId } },
        include: { comment: true },
      }),
      this.prisma.battleComment.findMany({
        where: { battleId },
        select: { userId: true, comment: true },
      }),
      this.prisma.battleParticipant.findMany({ where: { battleId } }),
    ]);

    if (!battle) throw new NotFoundException('Battle not found');
    if (battle.resolvedAt) {
      return { battleId, winnerUserId: battle.winnerUserId || null };
    }

    const sideCounts = new Map<string, number>();
    predictions.forEach((p) => sideCounts.set(p.side, (sideCounts.get(p.side) || 0) + 1));

    const underdogSide = this.getUnderdogSide(sideCounts);

    const likesByUser = new Map<string, number>();
    commentLikes.forEach((like) => {
      const ownerId = like.comment.userId;
      likesByUser.set(ownerId, (likesByUser.get(ownerId) || 0) + 1);
    });

    const argumentByUser = new Map<string, boolean>();
    comments.forEach((comment) => {
      const isValid = comment.comment.trim().length >= ARGUMENT_MIN_LENGTH;
      if (!isValid) return;
      argumentByUser.set(comment.userId, true);
    });

    const joinedAtByUser = new Map<string, Date>();
    const existingParticipantByUser = new Map<string, typeof participants[number]>();
    participants.forEach((p) => {
      joinedAtByUser.set(p.userId, p.joinedAt);
      existingParticipantByUser.set(p.userId, p);
    });

    const startTime = battle.startTime || battle.liveAt || battle.createdAt;
    const endTime = battle.endTime || battle.closedAt || new Date();

    const scored = predictions.map((prediction) => {
      const likes = likesByUser.get(prediction.userId) || 0;
      const argumentSubmitted = argumentByUser.get(prediction.userId) || false;
      const argumentPoints = argumentSubmitted ? ARGUMENT_POINTS : 0;
      const engagementPoints = Math.min(MAX_ENGAGEMENT_POINTS, likes * ENGAGEMENT_POINT_PER_LIKE);
      const joinedAt = joinedAtByUser.get(prediction.userId) || prediction.createdAt;
      const timingBonus = this.getTimingBonus(joinedAt, startTime, endTime);
      const userWon = prediction.side === correctSide;
      const underdogBonus = underdogSide && prediction.side === underdogSide && userWon ? UNDERDOG_BONUS : 0;
      const winnerBonus = userWon ? PREDICTION_WIN_BONUS : 0;
      const loserPenalty = userWon ? 0 : PREDICTION_LOSE_PENALTY;
      const score = Math.max(
        0,
        BASE_JOIN_POINTS
        + argumentPoints
        + engagementPoints
        + timingBonus
        + underdogBonus
        + winnerBonus
        - loserPenalty,
      );

      return {
        userId: prediction.userId,
        side: prediction.side,
        score,
        likes,
        argumentSubmitted,
        argumentPoints,
        engagementPoints,
        timingBonus,
        underdogBonus,
        winnerBonus,
        loserPenalty,
        userWon,
      };
    });

    scored.sort((a, b) => b.score - a.score || b.engagementPoints - a.engagementPoints || b.likes - a.likes);

    const winningEntries = scored.filter((entry) => entry.userWon);
    const winner = winningEntries[0] || null;
    let didResolve = false;
    const stakeAmount = battle.stakeAmount ?? 0;
    const leaderboardClimbedUserIds = new Set<string>();

    await this.prisma.$transaction(async (tx) => {
      const resolved = await tx.battle.updateMany({
        where: { id: battleId, resolvedAt: null },
        data: {
          status: 'RESOLVED',
          resolvedAt: new Date(),
          closedAt: new Date(),
          correctSide,
          winningSide: correctSide,
          winnerUserId: winner?.userId || null,
        },
      });

      if (resolved.count === 0) return;
      didResolve = true;

      for (const entry of scored) {
        const existing = existingParticipantByUser.get(entry.userId);
        const stakeWon = winner?.userId === entry.userId ? stakeAmount : 0;
        await tx.battleParticipant.upsert({
          where: { battleId_userId: { battleId, userId: entry.userId } },
          update: {
            score: entry.score,
            baseJoinPoints: BASE_JOIN_POINTS,
            argumentPoints: entry.argumentPoints,
            engagementPoints: entry.engagementPoints,
            timingBonus: entry.timingBonus,
            underdogBonus: entry.underdogBonus,
            winnerBonus: entry.winnerBonus,
            loserPenalty: entry.loserPenalty,
            argumentSubmitted: entry.argumentSubmitted,
            likesCount: entry.likes,
            votePoints: 0,
            isWinner: Boolean(winner?.userId && winner.userId === entry.userId),
            awardedAt: new Date(),
          },
          create: {
            battleId,
            userId: entry.userId,
            score: entry.score,
            baseJoinPoints: BASE_JOIN_POINTS,
            argumentPoints: entry.argumentPoints,
            engagementPoints: entry.engagementPoints,
            timingBonus: entry.timingBonus,
            underdogBonus: entry.underdogBonus,
            winnerBonus: entry.winnerBonus,
            loserPenalty: entry.loserPenalty,
            argumentSubmitted: entry.argumentSubmitted,
            likesCount: entry.likes,
            votePoints: 0,
            isWinner: Boolean(winner?.userId && winner.userId === entry.userId),
            awardedAt: new Date(),
          },
        });

        if (!existing?.awardedAt) {
          const totalBattleIncrement = entry.score + stakeWon;
          const previousStats = await tx.userBattleStats.findUnique({
            where: { userId: entry.userId },
            select: { totalBattlePoints: true },
          });
          const previousBattlePoints = previousStats?.totalBattlePoints ?? 0;
          const nextBattlePoints = previousBattlePoints + totalBattleIncrement;
          if (this.didBattleLevelIncrease(previousBattlePoints, nextBattlePoints)) {
            leaderboardClimbedUserIds.add(entry.userId);
          }

          await tx.userBattleStats.upsert({
            where: { userId: entry.userId },
            update: {
              totalBattlePoints: { increment: totalBattleIncrement },
              totalBattlesJoined: { increment: 1 },
              totalBattlesWon: { increment: entry.userWon ? 1 : 0 },
              totalPredictionsCorrect: { increment: entry.userWon ? 1 : 0 },
              totalPredictionsWrong: { increment: entry.userWon ? 0 : 1 },
              totalArgumentsSubmitted: { increment: entry.argumentSubmitted ? 1 : 0 },
              totalArgumentLikes: { increment: entry.likes },
            },
            create: {
              userId: entry.userId,
              totalBattlePoints: totalBattleIncrement,
              totalBattlesJoined: 1,
              totalBattlesWon: entry.userWon ? 1 : 0,
              totalPredictionsCorrect: entry.userWon ? 1 : 0,
              totalPredictionsWrong: entry.userWon ? 0 : 1,
              totalArgumentsSubmitted: entry.argumentSubmitted ? 1 : 0,
              totalArgumentLikes: entry.likes,
            },
          });
          await tx.user.update({
            where: { id: entry.userId },
            data: { totalPlatformPoints: { increment: entry.score } },
          });
        }
      }

      if (stakeAmount > 0 && winner?.userId) {
        await tx.user.update({
          where: { id: winner.userId },
          data: { totalPlatformPoints: { increment: stakeAmount } },
        });
      }

      await tx.battleReward.deleteMany({ where: { battleId } });
      const topWinners = winningEntries.slice(0, 3);
      for (let i = 0; i < topWinners.length; i += 1) {
        await tx.battleReward.create({
          data: {
            battleId,
            userId: topWinners[i].userId,
            rank: i + 1,
            rewardPoints: null,
            rewardType: 'CRED',
          },
        });
      }
    });

    if (!didResolve) {
      return { battleId, winnerUserId: battle.winnerUserId || null };
    }

    await this.notificationService.sendBattleLeaderboardClimbed(Array.from(leaderboardClimbedUserIds), battleId);

    const participantIds = scored.map((s) => s.userId);
    if (participantIds.length) {
      await this.notificationService.sendBattleResult(participantIds, battleId);
    }

    const victoryUserIds = Array.from(new Set(winningEntries.map((s) => s.userId)));
    if (victoryUserIds.length > 0) {
      await this.notificationService.sendBattleVictory(victoryUserIds, battleId);
    }

    const victoryUserIdSet = new Set(victoryUserIds);
    const forecastMissedUserIds = Array.from(new Set(scored.filter((s) => !victoryUserIdSet.has(s.userId)).map((s) => s.userId)));
    if (forecastMissedUserIds.length > 0) {
      await this.notificationService.sendBattleForecastMissed(forecastMissedUserIds, battleId);
    }

    const followerIds = await this.getFollowerIds(battle.creatorId);
    await this.notificationService.sendBattleClosedToFollowers(followerIds, battleId);

    const engagedUserIds = await this.getBattleEngagedUserIds(battleId, battle.creatorId);
    // Disabled by request: do not send battle-completed notification.
    // await this.notificationService.sendBattleCompleted(engagedUserIds, battleId);

    return { battleId, winnerUserId: winner?.userId || null };
  }

  private async resolveDuelBattle(battleId: string) {
    const [battle, participants, votes, commentLikes, comments] = await Promise.all([
      this.prisma.battle.findUnique({ where: { id: battleId } }),
      this.prisma.battleParticipant.findMany({ where: { battleId } }),
      this.prisma.battleVote.findMany({ where: { battleId } }),
      this.prisma.battleCommentLike.findMany({
        where: { comment: { battleId } },
        include: { comment: true },
      }),
      this.prisma.battleComment.findMany({
        where: { battleId },
        select: { userId: true, comment: true },
      }),
    ]);

    if (!battle) throw new NotFoundException('Battle not found');
    if (battle.resolvedAt) {
      return { battleId, winnerUserId: battle.winnerUserId || null };
    }

    const voteCounts = new Map<string, number>();
    participants.forEach((p) => {
      if (!voteCounts.has(p.side || '')) voteCounts.set(p.side || '', 0);
    });
    votes.forEach((v) => voteCounts.set(v.side, (voteCounts.get(v.side) || 0) + 1));

    const likesByUser = new Map<string, number>();
    commentLikes.forEach((like) => {
      const ownerId = like.comment.userId;
      likesByUser.set(ownerId, (likesByUser.get(ownerId) || 0) + 1);
    });

    const argumentByUser = new Map<string, boolean>();
    comments.forEach((comment) => {
      const isValid = comment.comment.trim().length >= ARGUMENT_MIN_LENGTH;
      if (!isValid) return;
      argumentByUser.set(comment.userId, true);
    });

    const underdogSide = this.getUnderdogSide(voteCounts);

    const likesBySide = new Map<string, number>();
    participants.forEach((p) => {
      const likes = likesByUser.get(p.userId) || 0;
      likesBySide.set(p.side || '', (likesBySide.get(p.side || '') || 0) + likes);
    });

    let winningSide: string | null = null;
    if (voteCounts.size > 0) {
      const sides = Array.from(voteCounts.keys()).sort();
      const maxVotes = Math.max(...Array.from(voteCounts.values()));
      let candidates = sides.filter((side) => (voteCounts.get(side) || 0) === maxVotes);

      if (candidates.length > 1) {
        const maxLikes = Math.max(...candidates.map((side) => likesBySide.get(side) || 0));
        candidates = candidates.filter((side) => (likesBySide.get(side) || 0) === maxLikes);
      }

      winningSide = candidates.sort()[0] || null;
    } else if (likesBySide.size > 0) {
      const sides = Array.from(likesBySide.keys()).sort();
      const maxLikes = Math.max(...Array.from(likesBySide.values()));
      const candidates = sides.filter((side) => (likesBySide.get(side) || 0) === maxLikes);
      winningSide = candidates.sort()[0] || null;
    } else if (participants.length > 0) {
      winningSide = participants[0].side || null;
    }

    const startTime = battle.startTime || battle.liveAt || battle.createdAt;
    const endTime = battle.endTime || battle.closedAt || new Date();

    const scored = participants.map((p) => {
      const likes = likesByUser.get(p.userId) || 0;
      const argumentSubmitted = argumentByUser.get(p.userId) || false;
      const argumentPoints = argumentSubmitted ? ARGUMENT_POINTS : 0;
      const engagementPoints = Math.min(MAX_ENGAGEMENT_POINTS, likes * ENGAGEMENT_POINT_PER_LIKE);
      const timingBonus = this.getTimingBonus(p.joinedAt, startTime, endTime);
      const userWon = !!winningSide && p.side === winningSide;
      const underdogBonus = underdogSide && p.side === underdogSide && userWon ? UNDERDOG_BONUS : 0;
      const winnerBonus = userWon ? OPINION_WIN_BONUS : 0;
      const loserPenalty = userWon ? 0 : OPINION_LOSE_PENALTY;
      const votePoints = voteCounts.get(p.side || '') || 0;
      const score = Math.max(
        0,
        BASE_JOIN_POINTS
        + argumentPoints
        + engagementPoints
        + timingBonus
        + underdogBonus
        + winnerBonus
        - loserPenalty,
      );

      return {
        userId: p.userId,
        side: p.side || '',
        score,
        likes,
        votePoints,
        argumentSubmitted,
        argumentPoints,
        engagementPoints,
        timingBonus,
        underdogBonus,
        winnerBonus,
        loserPenalty,
        userWon,
      };
    });

    scored.sort((a, b) => b.score - a.score || b.engagementPoints - a.engagementPoints || b.likes - a.likes);

    const winner = scored.find((entry) => entry.side === winningSide) || scored[0];
    const winnerSide = winningSide || winner?.side || null;
    let didResolve = false;
    const stakeAmount = battle.stakeAmount ?? 0;
    const leaderboardClimbedUserIds = new Set<string>();

    await this.prisma.$transaction(async (tx) => {
      const resolved = await tx.battle.updateMany({
        where: { id: battleId, resolvedAt: null },
        data: {
          status: 'RESOLVED',
          resolvedAt: new Date(),
          closedAt: new Date(),
          winningSide: winnerSide,
          winnerUserId: winner?.userId || null,
        },
      });

      if (resolved.count === 0) return;
      didResolve = true;

      for (const entry of scored) {
        const existing = participants.find((p) => p.userId === entry.userId);
        const stakeWon = winner?.userId === entry.userId ? stakeAmount : 0;
        await tx.battleParticipant.upsert({
          where: { battleId_userId: { battleId, userId: entry.userId } },
          update: {
            score: entry.score,
            baseJoinPoints: BASE_JOIN_POINTS,
            argumentPoints: entry.argumentPoints,
            engagementPoints: entry.engagementPoints,
            timingBonus: entry.timingBonus,
            underdogBonus: entry.underdogBonus,
            winnerBonus: entry.winnerBonus,
            loserPenalty: entry.loserPenalty,
            argumentSubmitted: entry.argumentSubmitted,
            likesCount: entry.likes,
            votePoints: entry.votePoints,
            isWinner: winner?.userId === entry.userId,
            awardedAt: new Date(),
          },
          create: {
            battleId,
            userId: entry.userId,
            side: entry.side,
            score: entry.score,
            baseJoinPoints: BASE_JOIN_POINTS,
            argumentPoints: entry.argumentPoints,
            engagementPoints: entry.engagementPoints,
            timingBonus: entry.timingBonus,
            underdogBonus: entry.underdogBonus,
            winnerBonus: entry.winnerBonus,
            loserPenalty: entry.loserPenalty,
            argumentSubmitted: entry.argumentSubmitted,
            likesCount: entry.likes,
            votePoints: entry.votePoints,
            isWinner: winner?.userId === entry.userId,
            awardedAt: new Date(),
          },
        });

        if (!existing?.awardedAt) {
          const totalBattleIncrement = entry.score + stakeWon;
          const previousStats = await tx.userBattleStats.findUnique({
            where: { userId: entry.userId },
            select: { totalBattlePoints: true },
          });
          const previousBattlePoints = previousStats?.totalBattlePoints ?? 0;
          const nextBattlePoints = previousBattlePoints + totalBattleIncrement;
          if (this.didBattleLevelIncrease(previousBattlePoints, nextBattlePoints)) {
            leaderboardClimbedUserIds.add(entry.userId);
          }

          await tx.userBattleStats.upsert({
            where: { userId: entry.userId },
            update: {
              totalBattlePoints: { increment: totalBattleIncrement },
              totalBattlesJoined: { increment: 1 },
              totalBattlesWon: { increment: entry.userWon ? 1 : 0 },
              totalArgumentsSubmitted: { increment: entry.argumentSubmitted ? 1 : 0 },
              totalArgumentLikes: { increment: entry.likes },
            },
            create: {
              userId: entry.userId,
              totalBattlePoints: totalBattleIncrement,
              totalBattlesJoined: 1,
              totalBattlesWon: entry.userWon ? 1 : 0,
              totalPredictionsCorrect: 0,
              totalPredictionsWrong: 0,
              totalArgumentsSubmitted: entry.argumentSubmitted ? 1 : 0,
              totalArgumentLikes: entry.likes,
            },
          });
          await tx.user.update({
            where: { id: entry.userId },
            data: { totalPlatformPoints: { increment: entry.score } },
          });
        }
      }

      if (stakeAmount > 0 && winner?.userId) {
        await tx.user.update({
          where: { id: winner.userId },
          data: { totalPlatformPoints: { increment: stakeAmount } },
        });
      }

      await tx.battleReward.deleteMany({ where: { battleId } });
      if (winner?.userId) {
        await tx.battleReward.create({
          data: {
            battleId,
            userId: winner.userId,
            rank: 1,
            rewardPoints: null,
            rewardType: 'CRED',
          },
        });
      }
    });

    if (!didResolve) {
      return { battleId, winnerUserId: battle.winnerUserId || null };
    }

    await this.notificationService.sendBattleLeaderboardClimbed(Array.from(leaderboardClimbedUserIds), battleId);

    const participantIds = scored.map((s) => s.userId);
    if (participantIds.length) {
      await this.notificationService.sendBattleResult(participantIds, battleId);
    }

    const victoryUserIds = Array.from(new Set(scored.filter((s) => s.userWon).map((s) => s.userId)));
    if (victoryUserIds.length === 0 && winner?.userId) {
      victoryUserIds.push(winner.userId);
    }
    await this.notificationService.sendBattleVictory(victoryUserIds, battleId);

    const victoryUserIdSet = new Set(victoryUserIds);
    const forecastMissedUserIds = Array.from(new Set(scored.filter((s) => !victoryUserIdSet.has(s.userId)).map((s) => s.userId)));
    await this.notificationService.sendBattleForecastMissed(forecastMissedUserIds, battleId);

    const followerIds = await this.getFollowerIds(battle.creatorId);
    await this.notificationService.sendBattleClosedToFollowers(followerIds, battleId);

    const engagedUserIds = await this.getBattleEngagedUserIds(battleId, battle.creatorId);
    // Disabled by request: do not send battle-completed notification.
    // await this.notificationService.sendBattleCompleted(engagedUserIds, battleId);

    return { battleId, winnerUserId: winner?.userId || null };
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  private getTimingBonus(joinedAt: Date, startTime?: Date | null, endTime?: Date | null): number {
    if (!startTime || !endTime) return 0;
    const totalDuration = endTime.getTime() - startTime.getTime();
    if (totalDuration <= 0) return 0;
    const elapsed = joinedAt.getTime() - startTime.getTime();
    const ratio = this.clamp(elapsed / totalDuration, 0, 1);
    return Math.round(TIMING_BONUS_MAX * (1 - ratio));
  }

  private getUnderdogSide(counts: Map<string, number>): string | null {
    if (counts.size === 0) return null;
    const values = Array.from(counts.values());
    const minCount = Math.min(...values);
    const maxCount = Math.max(...values);
    if (minCount === maxCount) return null;
    const candidates = Array.from(counts.entries())
      .filter(([_, count]) => count === minCount)
      .map(([side]) => side)
      .sort();
    return candidates[0] || null;
  }

  private getBattleLevel(points: number): string {
    if (points >= 150000) return 'VALENS CHAMPION';
    if (points >= 75000) return 'IMMORTAL';
    if (points >= 32000) return 'PHANTOM';
    if (points >= 15000) return 'ORACLE';
    if (points >= 7500) return 'TITAN';
    if (points >= 3500) return 'DOMINATOR';
    if (points >= 1500) return 'STRATEGIST';
    if (points >= 600) return 'CONTENDER';
    if (points >= 200) return 'CHALLENGER';
    return 'ENTRY';
  }

  private getBattleLevelRank(points: number): number {
    const level = this.getBattleLevel(points);
    return [
      'ENTRY',
      'CHALLENGER',
      'CONTENDER',
      'STRATEGIST',
      'DOMINATOR',
      'TITAN',
      'ORACLE',
      'PHANTOM',
      'IMMORTAL',
      'VALENS CHAMPION',
    ].indexOf(level);
  }

  private didBattleLevelIncrease(previousPoints: number, nextPoints: number): boolean {
    return this.getBattleLevelRank(nextPoints) > this.getBattleLevelRank(previousPoints);
  }

  async rebuildBattleStats(userId?: string) {
    const participants = await this.prisma.battleParticipant.findMany({
      where: {
        awardedAt: { not: null },
        ...(userId ? { userId } : {}),
        battle: { status: 'RESOLVED' },
      },
      include: {
        battle: true,
      },
    });

    if (participants.length === 0) {
      return { rebuiltUsers: 0 };
    }

    const byUser = new Map<string, {
      totalBattlePoints: number;
      totalBattlesJoined: number;
      totalBattlesWon: number;
      totalPredictionsCorrect: number;
      totalPredictionsWrong: number;
      totalArgumentsSubmitted: number;
      totalArgumentLikes: number;
    }>();

    participants.forEach((p) => {
      const stats = byUser.get(p.userId) || {
        totalBattlePoints: 0,
        totalBattlesJoined: 0,
        totalBattlesWon: 0,
        totalPredictionsCorrect: 0,
        totalPredictionsWrong: 0,
        totalArgumentsSubmitted: 0,
        totalArgumentLikes: 0,
      };

      const stakeWon = p.isWinner ? (p.battle.stakeAmount ?? 0) : 0;
      stats.totalBattlePoints += (p.score || 0) + stakeWon;
      stats.totalBattlesJoined += 1;
      stats.totalBattlesWon += p.isWinner ? 1 : 0;
      if (p.battle.format === 'POLL') {
        if (p.isWinner) stats.totalPredictionsCorrect += 1;
        else stats.totalPredictionsWrong += 1;
      }
      if (p.argumentSubmitted) stats.totalArgumentsSubmitted += 1;
      stats.totalArgumentLikes += p.likesCount || 0;

      byUser.set(p.userId, stats);
    });

    await this.prisma.$transaction(async (tx) => {
      const userIds = Array.from(byUser.keys());
      const users = await tx.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, referPoints: true, marketplaceBattlePoints: true, shopPlatformPoints: true },
      });
      const referPointsByUser = new Map(users.map((u) => [u.id, u.referPoints ?? 0]));
      const marketplacePointsByUser = new Map(
        users.map((u) => [u.id, u.marketplaceBattlePoints ?? 0]),
      );
      const shopPointsByUser = new Map(
        users.map((u) => [u.id, u.shopPlatformPoints ?? 0]),
      );

      for (const [uid, stats] of byUser.entries()) {
        await tx.userBattleStats.upsert({
          where: { userId: uid },
          update: {
            totalBattlePoints: stats.totalBattlePoints,
            totalBattlesJoined: stats.totalBattlesJoined,
            totalBattlesWon: stats.totalBattlesWon,
            totalPredictionsCorrect: stats.totalPredictionsCorrect,
            totalPredictionsWrong: stats.totalPredictionsWrong,
            totalArgumentsSubmitted: stats.totalArgumentsSubmitted,
            totalArgumentLikes: stats.totalArgumentLikes,
          },
          create: {
            userId: uid,
            totalBattlePoints: stats.totalBattlePoints,
            totalBattlesJoined: stats.totalBattlesJoined,
            totalBattlesWon: stats.totalBattlesWon,
            totalPredictionsCorrect: stats.totalPredictionsCorrect,
            totalPredictionsWrong: stats.totalPredictionsWrong,
            totalArgumentsSubmitted: stats.totalArgumentsSubmitted,
            totalArgumentLikes: stats.totalArgumentLikes,
          },
        });
        const referPoints = referPointsByUser.get(uid) ?? 0;
        const marketplaceBattlePoints = marketplacePointsByUser.get(uid) ?? 0;
        const shopPlatformPoints = shopPointsByUser.get(uid) ?? 0;
        await tx.user.update({
          where: { id: uid },
          data: {
            totalPlatformPoints: referPoints + stats.totalBattlePoints + marketplaceBattlePoints + shopPlatformPoints,
          },
        });
      }
    });

    return { rebuiltUsers: byUser.size };
  }

  private async getFollowerIds(userId: string): Promise<string[]> {
    const followers = await this.prisma.followerAndFollowing.findMany({
      where: { followingId: userId, status: 'ACCEPTED' },
      select: { followerId: true },
    });
    return followers.map((f) => f.followerId);
  }
}
