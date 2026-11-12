import { Body, Controller, Delete, Get, Post, Query, Req, UseGuards, UseInterceptors, UploadedFile, UploadedFiles } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { FileFieldsInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { Request } from 'express';
import { BattleService } from './battle.service';
import { BattleChallengerPositionDto, BattleCloseDto, BattleCommentDeleteDto, BattleCommentDto, BattleCommentEditDto, BattleCommentHighlightDto, BattleCommentLikeDto, BattleCommentPinDto, BattleCommentRemoveHighlightDto, BattleCommentUnpinDto, BattleEditQuestionDto, BattleInviteDto, BattleJoinDto, BattleOpponentPositionDto, BattlePredictionDto, BattleRebuildStatsDto, BattleResponseDto, BattleVoteDto } from './dto/battle-actions.dto';
import { CreateBattleDto } from './dto/create-battle.dto';
import { CreatePredictionBattleDto } from './dto/prediction-battle.dto';
import { PredictionCategory, PredictionProvider } from '@prisma/client';

@ApiTags('battle')
@Controller('battle')
export class BattleController {
  constructor(private readonly battleService: BattleService) { }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('create')
  @UseInterceptors(FileFieldsInterceptor([
    { name: 'image', maxCount: 1 },
    { name: 'optionImages', maxCount: 20 },
  ]))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['POLL', 'HEAD_TO_HEAD'] },
        battleType: { type: 'string', enum: ['NORMAL', 'PREDICTION'] },
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' } },
        startTime: { type: 'string' },
        endTime: { type: 'string' },
        stake: { type: 'number' },
        isPublic: { type: 'boolean' },
        invitedUserId: { type: 'string' },
        resolutionMethod: { type: 'string' },
        predictionCategory: { type: 'string', enum: ['SPORTS', 'FINANCE', 'ELECTIONS', 'CRYPTO'] },
        predictionProvider: { type: 'string', enum: ['POLYMARKET', 'MANIFOLD', 'API_FOOTBALL'] },
        externalMarketId: { type: 'string' },
        externalEventId: { type: 'string' },
        image: { type: 'string', format: 'binary' },
        optionImages: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
          description: 'Option image files. By default, file order maps to option order.',
        },
        optionImageIndexes: {
          type: 'array',
          items: { type: 'number' },
          description: 'Optional indexes for optionImages files, for sparse option images.',
        },
      },
      required: ['format', 'question', 'endTime'],
    },
  })
  @ApiOperation({ summary: 'Create a new battle (poll or head-to-head)' })
  async createBattle(
    @Req() req: Request,
    @Body() dto: CreateBattleDto,
    @UploadedFiles() files?: {
      image?: Express.Multer.File[];
      optionImages?: Express.Multer.File[];
    },
  ) {
    const userId = (req.user as any)?.userId;
    const normalizedDto: any = { ...dto };
    if (typeof normalizedDto.options === 'string') {
      try {
        const parsed = JSON.parse(normalizedDto.options);
        normalizedDto.options = Array.isArray(parsed) ? parsed : [String(parsed)];
      } catch {
        normalizedDto.options = normalizedDto.options
          .split(',')
          .map((value: string) => value.trim())
          .filter(Boolean);
      }
    }
    if (typeof normalizedDto.optionImageIndexes === 'string') {
      try {
        const parsed = JSON.parse(normalizedDto.optionImageIndexes);
        normalizedDto.optionImageIndexes = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        normalizedDto.optionImageIndexes = normalizedDto.optionImageIndexes
          .split(',')
          .filter((value: string) => value.trim() !== '')
          .map((value: string) => Number(value.trim()))
          .filter((value: number) => Number.isInteger(value));
      }
    }
    if (Array.isArray(normalizedDto.optionImageIndexes)) {
      normalizedDto.optionImageIndexes = normalizedDto.optionImageIndexes
        .filter((value: string | number) => String(value).trim() !== '')
        .map((value: string | number) => Number(value))
        .filter((value: number) => Number.isInteger(value));
    }
    if (typeof normalizedDto.optionImages === 'string') {
      try {
        const parsed = JSON.parse(normalizedDto.optionImages);
        normalizedDto.optionImages = Array.isArray(parsed) ? parsed : [String(parsed)];
      } catch {
        normalizedDto.optionImages = normalizedDto.optionImages
          .split(',')
          .map((value: string) => value.trim())
          .filter(Boolean);
      }
    }
    if (typeof normalizedDto.stake === 'string') {
      const parsedStake = Number(normalizedDto.stake);
      normalizedDto.stake = Number.isFinite(parsedStake) ? parsedStake : normalizedDto.stake;
    }
    if (typeof normalizedDto.isPublic === 'string') {
      normalizedDto.isPublic = normalizedDto.isPublic.toLowerCase() === 'true';
    }
    return this.battleService.createBattle(
      userId,
      normalizedDto,
      files?.image?.[0],
      files?.optionImages || [],
    );
  }

  @Get('prediction/categories')
  @ApiOperation({ summary: 'Get supported prediction battle categories' })
  async getPredictionCategories() {
    return this.battleService.getPredictionCategories();
  }

  @Get('prediction/sports-categories')
  @ApiOperation({ summary: 'Get supported sports subcategories for prediction battles' })
  async getPredictionSportsCategories() {
    return this.battleService.getPredictionSportsCategories();
  }

  @Get('prediction/sports-leagues')
  @ApiQuery({ name: 'subCategory', required: false, type: String, description: 'Optional sports subcategory filter (e.g. cricket, football, basketball)' })
  @ApiOperation({ summary: 'Get supported sports leagues/tournaments for prediction battles' })
  async getPredictionSportsLeagues(@Query('subCategory') subCategory?: string) {
    return this.battleService.getPredictionSportsLeagues(subCategory);
  }

  @Get('prediction/questions')
  @ApiQuery({ name: 'category', required: true, enum: PredictionCategory })
  @ApiQuery({ name: 'subCategory', required: false, type: String, description: 'Sport type or subcategory (e.g. cricket, football, basketball, tennis, american_football)' })
  @ApiQuery({ name: 'league', required: false, type: String, description: 'League or tournament (e.g. nfl, brasileirao_serie_a, copa_do_brasil, premier-league, champions-league)' })
  @ApiQuery({ name: 'provider', required: false, enum: PredictionProvider })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Optional keyword search (e.g. Flamengo, Chiefs, Trump)' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiOperation({ summary: 'Get third-party prediction questions by category, sports subcategory, league, or search' })
  async getPredictionQuestions(
    @Query('category') category: PredictionCategory,
    @Query('subCategory') subCategory?: string,
    @Query('league') league?: string,
    @Query('provider') provider?: PredictionProvider,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.battleService.listPredictionQuestions(category, provider, page, limit, subCategory, league, search);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('prediction/create')
  @ApiOperation({ summary: 'Create a provider-backed prediction battle' })
  async createPredictionBattle(@Req() req: Request, @Body() dto: CreatePredictionBattleDto) {
    const userId = (req.user as any)?.userId;
    return this.battleService.createPredictionBattle(userId, dto);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('invite')
  @ApiOperation({ summary: 'Invite a user to a head-to-head battle' })
  async inviteToBattle(@Req() req: Request, @Body() dto: BattleInviteDto) {
    const userId = (req.user as any)?.userId;
    return this.battleService.inviteToBattle(userId, dto);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('edit-question')
  @ApiOperation({ summary: 'Edit battle question' })
  async editBattleQuestion(@Req() req: Request, @Body() dto: BattleEditQuestionDto) {
    const userId = (req.user as any)?.userId;
    return this.battleService.editBattleQuestion(userId, dto);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('challenger-position')
  @ApiOperation({ summary: 'Creator chooses side and opening comment for a head-to-head battle, then sends invite notification' })
  async submitChallengerPosition(@Req() req: Request, @Body() dto: BattleChallengerPositionDto) {
    const userId = (req.user as any)?.userId;
    return this.battleService.submitChallengerPosition(userId, dto);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('accept')
  @ApiOperation({ summary: 'Accept a battle invite' })
  async acceptInvite(@Req() req: Request, @Body() dto: BattleResponseDto) {
    const userId = (req.user as any)?.userId;
    return this.battleService.acceptInvite(userId, dto);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('opponent-position')
  @ApiOperation({ summary: 'Invited user adds opening comment, receives remaining side automatically, and makes battle live' })
  async submitOpponentPosition(@Req() req: Request, @Body() dto: BattleOpponentPositionDto) {
    const userId = (req.user as any)?.userId;
    return this.battleService.submitOpponentPosition(userId, dto);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('decline')
  @ApiOperation({ summary: 'Decline a battle invite' })
  async declineInvite(@Req() req: Request, @Body() dto: BattleResponseDto) {
    const userId = (req.user as any)?.userId;
    return this.battleService.declineInvite(userId, dto);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('join')
  @ApiOperation({ summary: 'Join a poll battle' })
  async joinBattle(@Req() req: Request, @Body() dto: BattleJoinDto) {
    const userId = (req.user as any)?.userId;
    return this.battleService.joinBattle(userId, dto);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('predict')
  @ApiOperation({ summary: 'Submit prediction with justification' })
  async submitPrediction(@Req() req: Request, @Body() dto: BattlePredictionDto) {
    const userId = (req.user as any)?.userId;
    return this.battleService.submitPrediction(userId, dto);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('comment')
  @ApiOperation({ summary: 'Add a comment/justification' })
  async addComment(@Req() req: Request, @Body() dto: BattleCommentDto) {
    const userId = (req.user as any)?.userId;
    return this.battleService.addComment(userId, dto);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('comment/upload')
  @UseInterceptors(FilesInterceptor('images'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        battleId: { type: 'string' },
        comment: { type: 'string' },
        parentCommentId: { type: 'string' },
        images: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
        },
      },
      required: ['battleId'],
    },
  })
  @ApiOperation({ summary: 'Add a comment with images' })
  async addCommentWithImages(
    @Req() req: Request,
    @Body() dto: BattleCommentDto,
    @UploadedFiles() files?: Express.Multer.File[],
  ) {
    const userId = (req.user as any)?.userId;
    return this.battleService.addCommentWithImages(userId, dto, files);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('comment/like')
  @ApiOperation({ summary: 'Like a battle comment' })
  async likeComment(@Req() req: Request, @Body() dto: BattleCommentLikeDto) {
    const userId = (req.user as any)?.userId;
    return this.battleService.likeComment(userId, dto);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('comment/pin')
  @ApiOperation({ summary: 'Pin a battle comment (creator only, max 3 pinned comments per battle)' })
  async pinComment(@Req() req: Request, @Body() dto: BattleCommentPinDto) {
    const userId = (req.user as any)?.userId;
    return this.battleService.pinComment(userId, dto);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('comment/unpin')
  @ApiOperation({ summary: 'Unpin a battle comment (creator only)' })
  async unpinComment(@Req() req: Request, @Body() dto: BattleCommentUnpinDto) {
    const userId = (req.user as any)?.userId;
    return this.battleService.unpinComment(userId, dto);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('comment/highlight')
  @ApiOperation({ summary: 'Highlight text ranges in a battle comment' })
  async highlightComment(@Req() req: Request, @Body() dto: BattleCommentHighlightDto) {
    const userId = (req.user as any)?.userId;
    return this.battleService.highlightComment(userId, dto);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('comment/highlight/remove')
  @ApiOperation({ summary: 'Remove all text highlights from a battle comment' })
  async removeCommentHighlight(@Req() req: Request, @Body() dto: BattleCommentRemoveHighlightDto) {
    const userId = (req.user as any)?.userId;
    return this.battleService.removeCommentHighlight(userId, dto);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('comment/edit')
  @ApiOperation({ summary: 'Edit a battle comment (author only, within 3 minutes of creation)' })
  async editComment(@Req() req: Request, @Body() dto: BattleCommentEditDto) {
    const userId = (req.user as any)?.userId;
    return this.battleService.editComment(userId, dto);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('comment/delete')
  @ApiOperation({ summary: 'Delete a battle comment (author within 3 minutes of creation, or battle creator anytime)' })
  async deleteComment(@Req() req: Request, @Body() dto: BattleCommentDeleteDto) {
    const userId = (req.user as any)?.userId;
    return this.battleService.deleteComment(userId, dto);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Delete('comment')
  @ApiQuery({ name: 'commentId', required: true, type: String })
  @ApiQuery({ name: 'battleId', required: false, type: String })
  @ApiOperation({ summary: 'Delete a battle comment via DELETE HTTP method (author within 3 minutes, or battle creator anytime)' })
  async deleteCommentViaDelete(
    @Req() req: Request,
    @Query('commentId') commentId: string,
    @Query('battleId') battleId?: string,
  ) {
    const userId = (req.user as any)?.userId;
    return this.battleService.deleteComment(userId, { commentId, battleId });
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('vote')
  @ApiOperation({ summary: 'Vote in a head-to-head battle' })
  async voteOnDuel(@Req() req: Request, @Body() dto: BattleVoteDto) {
    const userId = (req.user as any)?.userId;
    return this.battleService.voteOnDuel(userId, dto);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Get('myBattleTracking')
  @ApiQuery({ name: 'filter', required: true, enum: ['battle_live', 'battle_arena', 'battle_past'] })
  @ApiOperation({ summary: 'Track authenticated user battles by live, arena, or past filter' })
  async myBattleTracking(@Req() req: Request, @Query('filter') filter: string) {
    const userId = (req.user as any)?.userId;
    return this.battleService.myBattleTracking(userId, filter);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Get('explore')
  @ApiQuery({ name: 'status', required: false, type: 'string' })
  @ApiOperation({
    summary:
      'Explore battles (normal + marketplace by status, default LIVE) sorted by createdAt',
  })
  async exploreBattles(@Req() req: Request, @Query('status') status?: string) {
    const userId = (req.user as any)?.userId;
    return this.battleService.exploreBattles(userId, status);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Get('by-user')
  @ApiQuery({ name: 'userId', required: true, type: 'string' })
  @ApiQuery({ name: 'status', required: false, type: 'string' })
  @ApiOperation({ summary: 'Get battles for a user profile' })
  async getBattlesByUser(@Query('userId') userId: string, @Query('status') status?: string) {
    return this.battleService.getBattlesByUser(userId, status);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Get('points')
  @ApiQuery({ name: 'userId', required: true, type: 'string' })
  @ApiQuery({ name: 'status', required: false, type: 'string' })
  @ApiOperation({ summary: 'Get battle points for a user' })
  async getBattlePointsByUser(@Query('userId') userId: string, @Query('status') status?: string) {
    return this.battleService.getBattlePointsByUser(userId, status);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Get('get')
  @ApiQuery({ name: 'battleId', required: true, type: 'string' })
  @ApiOperation({ summary: 'Get battle details' })
  async getBattle(@Query('battleId') battleId: string) {
    return this.battleService.getBattle(battleId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Get('invite-detail')
  @ApiQuery({ name: 'battleId', required: true, type: 'string' })
  @ApiOperation({ summary: 'Get head-to-head invite detail for accept/decline screen' })
  async getInviteDetail(@Req() req: Request, @Query('battleId') battleId: string) {
    const userId = (req.user as any)?.userId;
    return this.battleService.getInviteDetail(userId, battleId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Get('winner')
  @ApiQuery({ name: 'battleId', required: true, type: 'string' })
  @ApiOperation({ summary: 'Get battle winner and points' })
  async getBattleWinner(@Query('battleId') battleId: string) {
    return this.battleService.getBattleWinnerPoints(battleId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('close')
  @ApiOperation({ summary: 'Close battle (internal/cron)' })
  async closeBattle(@Body() dto: BattleCloseDto) {
    return this.battleService.closeBattle(dto);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('resolve')
  @ApiOperation({ summary: 'Resolve battle (internal/cron)' })
  async resolveBattle(@Body() dto: BattleCloseDto) {
    return this.battleService.resolveBattle(dto);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('rebuild-stats')
  @ApiOperation({ summary: 'Rebuild battle stats from participation (internal)' })
  async rebuildStats(@Body() dto: BattleRebuildStatsDto) {
    return this.battleService.rebuildBattleStats(dto?.userId);
  }
}
