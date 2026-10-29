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
import { MarketplaceWinnerPromotionService } from './marketplace-winner-promotion.service';
import { CreateMarketplaceWinnerPromotionDto } from './dto/create-marketplace-winner-promotion.dto';
import { MarketplaceWinnerPromotionListQueryDto } from './dto/marketplace-winner-promotion-list-query.dto';
import { MarketplaceWinnerPromotionActiveQueryDto } from './dto/marketplace-winner-promotion-active-query.dto';
import { MarketplaceWinnerPromotionByBattleDto } from './dto/marketplace-winner-promotion-by-battle.dto';

@ApiTags('marketplace-winner-promotions')
@Controller()
export class MarketplaceWinnerPromotionController {
    constructor(
        private readonly marketplaceWinnerPromotionService: MarketplaceWinnerPromotionService,
    ) { }

    @Post('marketplace-winner-promotions/by-battle')
    @ApiOperation({ summary: 'Check whether a marketplace battle has a winner promotion and return promotion id if present' })
    @ApiBody({ type: MarketplaceWinnerPromotionByBattleDto })
    async getPromotionByBattleId(
        @Body(
            new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
        )
        dto: MarketplaceWinnerPromotionByBattleDto,
    ) {
        return this.marketplaceWinnerPromotionService.getPromotionByBattleId(dto.battleId);
    }

    @Get('marketplace-winner-promotions/packages')
    @ApiOperation({ summary: 'List active marketplace winner promotion packages' })
    async getPromotionPackages() {
        return this.marketplaceWinnerPromotionService.getActivePromotionPackages();
    }

    @Post('marketplace-battles/:battleId/winner-promotion')
    @UseGuards(AuthGuard('jwt'), KycGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Create marketplace winner promotion intent (PENDING_PAYMENT)' })
    @ApiParam({ name: 'battleId', description: 'Marketplace battle id' })
    @ApiUnauthorizedResponse({ description: 'Unauthorized' })
    @ApiForbiddenResponse({ description: 'Forbidden: battle not owned by seller' })
    @ApiNotFoundResponse({ description: 'Marketplace battle not found' })
    @ApiBadRequestResponse({ description: 'Battle/product not eligible for promotion' })
    @ApiConflictResponse({ description: 'already promoted' })
    async createPromotionIntent(
        @Req() req: Request,
        @Param('battleId', new ParseUUIDPipe({ version: '4' })) battleId: string,
        @Body(
            new ValidationPipe({
                whitelist: true,
                forbidNonWhitelisted: true,
                transform: true,
            }),
        )
        dto: CreateMarketplaceWinnerPromotionDto,
    ) {
        const userId = (req.user as any)?.userId;
        return this.marketplaceWinnerPromotionService.createPromotionIntent(userId, battleId, dto);
    }

    @Post('marketplace-winner-promotions/:promotionId/payment')
    @UseGuards(AuthGuard('jwt'), KycGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Create or reuse payment session for pending marketplace winner promotion' })
    @ApiParam({ name: 'promotionId', description: 'Marketplace winner promotion id' })
    @ApiUnauthorizedResponse({ description: 'Unauthorized' })
    @ApiForbiddenResponse({ description: 'Forbidden: promotion not owned by seller' })
    @ApiNotFoundResponse({ description: 'Promotion not found' })
    @ApiBadRequestResponse({ description: 'Promotion status not PENDING_PAYMENT' })
    async createPromotionPayment(
        @Req() req: Request,
        @Param('promotionId', new ParseUUIDPipe({ version: '4' })) promotionId: string,
    ) {
        const userId = (req.user as any)?.userId;
        return this.marketplaceWinnerPromotionService.createOrReusePromotionPayment(userId, promotionId);
    }

    @Get('marketplace-winner-promotions/me')
    @UseGuards(AuthGuard('jwt'))
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get authenticated seller marketplace winner promotion history' })
    @ApiQuery({ name: 'page', required: false, example: 1 })
    @ApiQuery({ name: 'limit', required: false, example: 10 })
    @ApiQuery({ name: 'status', required: false, enum: ['PENDING_PAYMENT', 'ACTIVE', 'EXPIRED', 'CANCELLED', 'FAILED'] })
    @ApiQuery({ name: 'battleId', required: false })
    @ApiQuery({ name: 'sortBy', required: false, enum: ['createdAt', 'startAt', 'endAt', 'activatedAt'] })
    @ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'] })
    async getMyPromotions(
        @Req() req: Request,
        @Query(
            new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
        )
        query: MarketplaceWinnerPromotionListQueryDto,
    ) {
        const userId = (req.user as any)?.userId;
        return this.marketplaceWinnerPromotionService.getMyPromotions(userId, query);
    }

    @Get('marketplace-winner-promotions/:promotionId')
    @UseGuards(AuthGuard('jwt'))
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get one marketplace winner promotion owned by authenticated seller' })
    @ApiParam({ name: 'promotionId', description: 'Marketplace winner promotion id' })
    async getMyPromotionById(
        @Req() req: Request,
        @Param('promotionId', new ParseUUIDPipe({ version: '4' })) promotionId: string,
    ) {
        const userId = (req.user as any)?.userId;
        return this.marketplaceWinnerPromotionService.getMyPromotionById(userId, promotionId);
    }

    // @Get('marketplace-winner-promotions/active')
    // @ApiOperation({ summary: 'Get active public marketplace winner promotions' })
    // @ApiQuery({ name: 'page', required: false, example: 1 })
    // @ApiQuery({ name: 'limit', required: false, example: 10 })
    // async getPublicActivePromotions(
    //     @Query(
    //         new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    //     )
    //     query: MarketplaceWinnerPromotionActiveQueryDto,
    // ) {
    //     return this.marketplaceWinnerPromotionService.getActivePromotionsPublic(query);
    // }
}
