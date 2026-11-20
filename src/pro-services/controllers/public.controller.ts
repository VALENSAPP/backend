import {
    Controller,
    Delete,
    Get,
    Param,
    ParseUUIDPipe,
    Post,
    Query,
    Req,
    UseGuards,
    ValidationPipe,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt-auth.guard';
import { PageQueryDto, UserServicesQueryDto } from '../dto/query.dto';
import { getUserId } from '../pro-services.utils';
import { PublicService } from '../services/public.service';

const pipe = new ValidationPipe({ whitelist: true, transform: true });

/**
 * Buyer-side browsing (screens C1-C4, E1-E2, M1).
 * Registered after ProviderController and ManageController so their fixed paths win over ':id'.
 */
@ApiTags('pro-services: browse')
@Controller('pro-services')
export class PublicController {
    constructor(private readonly publicService: PublicService) { }

    @Get('users/:userId')
    @UseGuards(OptionalJwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'C1/E1 - A provider Services page: header, filter counts, list (login optional)' })
    getProviderPage(
        @Req() req: Request,
        @Param('userId', ParseUUIDPipe) userId: string,
        @Query(pipe) query: UserServicesQueryDto,
    ) {
        return this.publicService.getProviderPage(userId, getUserId(req) || null, query);
    }

    @Get('me/favorites')
    @UseGuards(AuthGuard('jwt'))
    @ApiBearerAuth()
    @ApiOperation({ summary: 'C2 - My bookmarked services' })
    listFavorites(@Req() req: Request, @Query(pipe) query: PageQueryDto) {
        return this.publicService.listFavorites(getUserId(req), query);
    }

    @Get(':id')
    @UseGuards(OptionalJwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({
        summary: 'C3/E2/M1 - Service details (login optional)',
        description: 'Address, phone and attachment links are only returned to buyers who paid, and to the owner.',
    })
    getDetails(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
        return this.publicService.getDetails(id, getUserId(req) || null);
    }

    @Get(':id/reviews')
    @ApiOperation({ summary: 'C4 - Reviews of a service, with star distribution' })
    getReviews(@Param('id', ParseUUIDPipe) id: string, @Query(pipe) query: PageQueryDto) {
        return this.publicService.getReviews(id, query);
    }

    @Post(':id/favorite')
    @UseGuards(AuthGuard('jwt'))
    @ApiBearerAuth()
    @ApiOperation({ summary: 'C2 - Bookmark a service' })
    addFavorite(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
        return this.publicService.addFavorite(getUserId(req), id);
    }

    @Delete(':id/favorite')
    @UseGuards(AuthGuard('jwt'))
    @ApiBearerAuth()
    @ApiOperation({ summary: 'C2 - Remove a bookmark' })
    removeFavorite(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
        return this.publicService.removeFavorite(getUserId(req), id);
    }
}
