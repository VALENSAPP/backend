import {
    Body,
    Controller,
    Get,
    ParseUUIDPipe,
    Param,
    Post,
    Query,
    Req,
    UseGuards,
    ValidationPipe,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { KycGuard } from '../../common/guards/kyc.guard';
import {
    ApiBody,
    ApiBadRequestResponse,
    ApiBearerAuth,
    ApiConflictResponse,
    ApiForbiddenResponse,
    ApiNotFoundResponse,
    ApiOperation,
    ApiParam,
    ApiQuery,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Request } from 'express';
import { MarketplaceBattleBoostService } from './marketplace-battle-boost.service';
import { CreateMarketplaceBattleBoostDto } from './dto/create-marketplace-battle-boost.dto';
import { MarketplaceBattleBoostListQueryDto } from './dto/marketplace-battle-boost-list-query.dto';
import { MarketplaceBattleBoostActiveQueryDto } from './dto/marketplace-battle-boost-active-query.dto';
import { MarketplaceBattleBoostByBattleDto } from './dto/marketplace-battle-boost-by-battle.dto';

@ApiTags('marketplace-battle-boosts')
@Controller()
export class MarketplaceBattleBoostController {
    constructor(private readonly marketplaceBattleBoostService: MarketplaceBattleBoostService) { }

    @Post('marketplace-battle-boosts/by-battle')
    @ApiOperation({ summary: 'Check whether a marketplace battle has a boost and return boost id if present' })
    @ApiBody({ type: MarketplaceBattleBoostByBattleDto })
    async getBoostByBattleId(
        @Body(
            new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
        )
        dto: MarketplaceBattleBoostByBattleDto,
    ) {
        return this.marketplaceBattleBoostService.getBoostByBattleId(dto.battleId);
    }

    @Get('marketplace-battle-boosts/packages')
    @ApiOperation({ summary: 'List active marketplace battle boost packages' })
    async getBoostPackages() {
        return this.marketplaceBattleBoostService.getActiveBoostPackages();
    }

    @Post('marketplace-battles/:battleId/boosts')
    @UseGuards(AuthGuard('jwt'), KycGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Create marketplace battle boost intent (PENDING_PAYMENT)' })
    @ApiParam({ name: 'battleId', description: 'Marketplace battle id' })
    @ApiUnauthorizedResponse({ description: 'Unauthorized' })
    @ApiForbiddenResponse({ description: 'Forbidden: battle not owned by seller' })
    @ApiNotFoundResponse({ description: 'Marketplace battle not found' })
    @ApiBadRequestResponse({ description: 'Battle/package not eligible for boost' })
    @ApiConflictResponse({ description: 'already boosted' })
    async createBoostIntent(
        @Req() req: Request,
        @Param('battleId', new ParseUUIDPipe({ version: '4' })) battleId: string,
        @Body(
            new ValidationPipe({
                whitelist: true,
                forbidNonWhitelisted: true,
                transform: true,
            }),
        )
        dto: CreateMarketplaceBattleBoostDto,
    ) {
        const userId = (req.user as any)?.userId;
        return this.marketplaceBattleBoostService.createBoostIntent(userId, battleId, dto);
    }

    @Post('marketplace-battle-boosts/:boostId/payment')
    @UseGuards(AuthGuard('jwt'), KycGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Create or reuse payment session for pending marketplace battle boost' })
    @ApiParam({ name: 'boostId', description: 'Marketplace battle boost id' })
    @ApiUnauthorizedResponse({ description: 'Unauthorized' })
    @ApiForbiddenResponse({ description: 'Forbidden: boost not owned by seller' })
    @ApiNotFoundResponse({ description: 'Boost not found' })
    @ApiBadRequestResponse({ description: 'Boost status not PENDING_PAYMENT' })
    async createBoostPayment(
        @Req() req: Request,
        @Param('boostId', new ParseUUIDPipe({ version: '4' })) boostId: string,
    ) {
        const userId = (req.user as any)?.userId;
        return this.marketplaceBattleBoostService.createOrReuseBoostPayment(userId, boostId);
    }

    @Get('marketplace-battle-boosts/me')
    @UseGuards(AuthGuard('jwt'))
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get authenticated seller marketplace battle boost history' })
    @ApiQuery({ name: 'page', required: false, example: 1 })
    @ApiQuery({ name: 'limit', required: false, example: 10 })
    @ApiQuery({ name: 'status', required: false, enum: ['PENDING_PAYMENT', 'ACTIVE', 'EXPIRED', 'CANCELLED', 'FAILED'] })
    @ApiQuery({ name: 'battleId', required: false })
    @ApiQuery({ name: 'sortBy', required: false, enum: ['createdAt', 'startAt', 'endAt', 'activatedAt'] })
    @ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'] })
    async getMyBoosts(
        @Req() req: Request,
        @Query(
            new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
        )
        query: MarketplaceBattleBoostListQueryDto,
    ) {
        const userId = (req.user as any)?.userId;
        return this.marketplaceBattleBoostService.getMyBoosts(userId, query);
    }

    @Get('marketplace-battle-boosts/:boostId')
    @UseGuards(AuthGuard('jwt'))
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get one marketplace battle boost owned by authenticated seller' })
    @ApiParam({ name: 'boostId', description: 'Marketplace battle boost id' })
    async getMyBoostById(
        @Req() req: Request,
        @Param('boostId', new ParseUUIDPipe({ version: '4' })) boostId: string,
    ) {
        const userId = (req.user as any)?.userId;
        return this.marketplaceBattleBoostService.getMyBoostById(userId, boostId);
    }

    @Get('marketplace-battle-boosts/active')
    @ApiOperation({ summary: 'Get active public marketplace battle boosts for boosted placement' })
    @ApiQuery({ name: 'page', required: false, example: 1 })
    @ApiQuery({ name: 'limit', required: false, example: 10 })
    async getPublicActiveBoosts(
        @Query(
            new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
        )
        query: MarketplaceBattleBoostActiveQueryDto,
    ) {
        return this.marketplaceBattleBoostService.getActiveBoostsPublic(query);
    }
}
