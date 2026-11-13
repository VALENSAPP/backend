import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
  ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt-auth.guard';
import { MyclosetService } from './mycloset.service';
import { CreateMyclosetDto } from './dto/create-mycloset.dto';
import { UpdateMyclosetDto } from './dto/update-mycloset.dto';
import { CreateClosetItemDto } from './dto/create-closet-item.dto';
import { UpdateClosetItemDto } from './dto/update-closet-item.dto';
import { FindClosetByUserDto } from './dto/find-closet-by-user.dto';
import { ListShopsQueryDto } from './dto/list-shops-query.dto';
import { ListPriorityProductsQueryDto } from './dto/list-priority-products-query.dto';
import { ClosetItemCondition } from '@prisma/client';

@ApiTags('mycloset')
@Controller('mycloset')
export class MyclosetController {
  constructor(private readonly myclosetService: MyclosetService) { }

  @Post()
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @UseInterceptors(FileInterceptor('shopLogo'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Create Mycloset for the authenticated user' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['shopName', 'shopUsername', 'whoCanBuy', 'shippingOptions'],
      properties: {
        shopName: { type: 'string' },
        shopUsername: { type: 'string' },
        shopLogo: { type: 'string', format: 'binary' },
        description: { type: 'string' },
        shopCategory: { type: 'string' },
        location: { type: 'string' },
        whoCanBuy: { type: 'string', enum: ['Everyone', 'followers'] },
        paymentMethod: { type: 'string' },
        shippingOptions: { type: 'string', enum: ['ship_items', 'local_pick', 'both'] },
        returnPolicy: { type: 'string' },
      },
    },
  })
  async create(
    @Req() req: Request,
    @Body(new ValidationPipe({ whitelist: true, transform: true })) dto: CreateMyclosetDto,
    @UploadedFile() shopLogo?: Express.Multer.File,
  ) {
    const userId = (req.user as any)?.userId;
    return this.myclosetService.create(userId, dto, shopLogo);
  }

  @Get('me')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get authenticated user Mycloset' })
  async findMine(@Req() req: Request) {
    const userId = (req.user as any)?.userId;
    return this.myclosetService.findMine(userId);
  }

  @Get('shops')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List all shops (My Closets) with optional search filter',
    description:
      'Returns paginated shops for all active users except the authenticated user. Search matches shop name, username, category, location, description, and owner username/display name.',
  })
  @ApiQuery({ name: 'search', required: false, example: 'graziela' })
  @ApiQuery({ name: 'shopCategory', required: false, example: 'Fashion' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  async listAllShops(
    @Req() req: Request,
    @Query(new ValidationPipe({ whitelist: true, transform: true })) query: ListShopsQueryDto,
  ) {
    const userId = (req.user as any)?.userId;
    return this.myclosetService.listAllShops(query, userId);
  }

  @Post('items')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @UseInterceptors(FilesInterceptor('images', 20))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Create a closet item with multiple images' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['category', 'condition', 'price', 'shippingOption'],
      properties: {
        images: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
        },
        name: { type: 'string' },
        category: { type: 'string' },
        brand: { type: 'string' },
        condition: { type: 'string', enum: ['New', 'Used', 'Good_condition', 'Need_attention'] },
        description: { type: 'string' },
        price: { type: 'number' },
        quantity: { type: 'integer', default: 1 },
        shippingOption: { type: 'string', enum: ['ship_items', 'local_pick', 'both'] },
        ahippingOption: { type: 'string', enum: ['ship_items', 'local_pick', 'both'], description: 'Accepted for typo compatibility.' },
        shippingFee: { type: 'number', example: 5.99, description: 'Required for ship_items and both.' },
        estimateShippingTime: { type: 'string' },
        pickupAddress: { type: 'string', description: 'Required for local_pick and both.' },
        pickupAvailableHours: { type: 'string', description: 'Required for local_pick and both.' },
        pickUpCity: { type: 'string', description: 'Optional pickup city.' },
        residentNumber: { type: 'string', description: 'Optional resident/apartment number.' },
        buyerChatEnabled: { type: 'boolean', description: 'Required for local_pick and both.' },
        returnPolicy: { type: 'string' },
      },
    },
  })
  async createItem(
    @Req() req: Request,
    @Body(new ValidationPipe({ whitelist: true, transform: true })) dto: CreateClosetItemDto,
    @UploadedFiles() images?: Express.Multer.File[],
  ) {
    const userId = (req.user as any)?.userId;
    return this.myclosetService.createItem(userId, dto, images);
  }

  @Get('items/explore')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Explore all marketplace products with prioritized ranking',
    description:
      'Returns paginated products ordered by priority tier: 1) Pinned on Top (Battle Boost), 2) Free Shipping (Winner Promotion), 3) Percentage Off (Winner Discount), 4) Standard products.',
  })
  @ApiQuery({ name: 'search', required: false, example: 'vintage jacket' })
  @ApiQuery({ name: 'category', required: false, example: 'Fashion' })
  @ApiQuery({ name: 'condition', required: false, enum: ClosetItemCondition })
  @ApiQuery({ name: 'minPrice', required: false, example: 10 })
  @ApiQuery({ name: 'maxPrice', required: false, example: 500 })
  @ApiQuery({ name: 'sortBy', required: false, enum: ['priority', 'createdAt', 'price', 'boostedAt', 'promotedAt'] })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  async explorePriorityProducts(
    @Req() req: Request,
    @Query(new ValidationPipe({ whitelist: true, transform: true })) query: ListPriorityProductsQueryDto,
  ) {
    const viewerUserId = (req.user as any)?.userId;
    return this.myclosetService.listPriorityProducts(query, viewerUserId);
  }


  @Get('items')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get authenticated user closet items' })
  async findMyItems(@Req() req: Request) {
    const userId = (req.user as any)?.userId;
    return this.myclosetService.findMyItems(userId);
  }

  @Post(':closetId/view')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiParam({ name: 'closetId', type: 'string' })
  @ApiOperation({ summary: 'Track view for a closet by authenticated viewer' })
  async trackClosetView(@Req() req: Request, @Param('closetId') closetId: string) {
    const viewerId = (req.user as any)?.userId;
    return this.myclosetService.trackClosetView(viewerId, closetId);
  }

  @Get('me/views/unique')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get view count for authenticated seller closet' })
  async getMyUniqueViews(@Req() req: Request) {
    const userId = (req.user as any)?.userId;
    return this.myclosetService.getMyClosetUniqueViewCount(userId);
  }

  @Get(':closetId/views/unique')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiParam({ name: 'closetId', type: 'string' })
  @ApiOperation({ summary: 'Get view count for a closet' })
  async getUniqueViewsByClosetId(@Param('closetId') closetId: string) {
    return this.myclosetService.getClosetUniqueViewCount(closetId);
  }

  @Get('items/:itemId/details')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  @ApiParam({ name: 'itemId', type: 'string', description: 'Closet item ID' })
  @ApiOperation({
    summary: 'Get public details of a closet item (for other users / buyers)',
    description: 'Returns product details, specifications, shipping info, battle winner stats, and closet owner info.',
  })
  async getItemDetails(@Req() req: Request, @Param('itemId') itemId: string) {
    const viewerId = (req.user as any)?.userId;
    return this.myclosetService.getItemDetails(itemId, viewerId);
  }

  @Get('items/:itemId')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiParam({ name: 'itemId', type: 'string' })
  @ApiOperation({ summary: 'Get one authenticated user closet item' })
  async findItemById(@Req() req: Request, @Param('itemId') itemId: string) {
    const userId = (req.user as any)?.userId;
    return this.myclosetService.findItemById(userId, itemId);
  }

  @Patch('items/:itemId')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @UseInterceptors(FilesInterceptor('images', 20))
  @ApiConsumes('multipart/form-data')
  @ApiParam({ name: 'itemId', type: 'string' })
  @ApiOperation({ summary: 'Update authenticated user closet item' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        images: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
        },
        name: { type: 'string' },
        category: { type: 'string' },
        brand: { type: 'string' },
        condition: { type: 'string', enum: ['New', 'Used', 'Good_condition', 'Need_attention'] },
        description: { type: 'string' },
        price: { type: 'number' },
        quantity: { type: 'integer' },
        shippingOption: { type: 'string', enum: ['ship_items', 'local_pick', 'both'] },
        ahippingOption: { type: 'string', enum: ['ship_items', 'local_pick', 'both'], description: 'Accepted for typo compatibility.' },
        shippingFee: { type: 'number', example: 5.99 },
        estimateShippingTime: { type: 'string' },
        pickupAddress: { type: 'string' },
        pickupAvailableHours: { type: 'string' },
        pickUpCity: { type: 'string', description: 'Optional pickup city.' },
        residentNumber: { type: 'string', description: 'Optional resident/apartment number.' },
        buyerChatEnabled: { type: 'boolean' },
        returnPolicy: { type: 'string' },
      },
    },
  })
  async updateItem(
    @Req() req: Request,
    @Param('itemId') itemId: string,
    @Body(new ValidationPipe({ whitelist: true, transform: true })) dto: UpdateClosetItemDto,
    @UploadedFiles() images?: Express.Multer.File[],
  ) {
    if (!Object.keys(dto).length && !images?.length) {
      throw new BadRequestException('No data provided for update');
    }
    const userId = (req.user as any)?.userId;
    return this.myclosetService.updateItem(userId, itemId, dto, images);
  }

  @Delete('items/:itemId')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiParam({ name: 'itemId', type: 'string' })
  @ApiOperation({ summary: 'Delete authenticated user closet item' })
  async removeItem(@Req() req: Request, @Param('itemId') itemId: string) {
    const userId = (req.user as any)?.userId;
    return this.myclosetService.removeItem(userId, itemId);
  }

  @Post('items/:itemId/like')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiParam({ name: 'itemId', type: 'string' })
  @ApiOperation({ summary: 'Like or unlike closet item (toggle)' })
  async likeClosetItem(@Req() req: Request, @Param('itemId') itemId: string) {
    const userId = (req.user as any)?.userId;
    return this.myclosetService.likeClosetItemByUser(itemId, userId);
  }

  @Get(':closetId/items')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiParam({ name: 'closetId', type: 'string' })
  @ApiOperation({ summary: 'Get all closet items by Mycloset ID' })
  async findItemsByClosetId(@Param('closetId') closetId: string) {
    return this.myclosetService.findItemsByClosetId(closetId);
  }

  @Get(':id')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get Mycloset by ID' })
  async findById(@Param('id') id: string) {
    return this.myclosetService.findById(id);
  }

  @Post('by-user')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get Mycloset by user ID' })
  async findByUserId(
    @Body(new ValidationPipe({ whitelist: true, transform: true })) dto: FindClosetByUserDto,
  ) {
    return this.myclosetService.findByUserId(dto.userId);
  }

  @Patch()
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @UseInterceptors(FileInterceptor('shopLogo'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Update authenticated user Mycloset' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        shopName: { type: 'string' },
        shopUsername: { type: 'string' },
        shopLogo: { type: 'string', format: 'binary' },
        description: { type: 'string' },
        shopCategory: { type: 'string' },
        location: { type: 'string' },
        whoCanBuy: { type: 'string', enum: ['Everyone', 'followers'] },
        paymentMethod: { type: 'string' },
        shippingOptions: { type: 'string', enum: ['ship_items', 'local_pick', 'both'] },
        returnPolicy: { type: 'string' },
      },
    },
  })
  async update(
    @Req() req: Request,
    @Body(new ValidationPipe({ whitelist: true, transform: true })) dto: UpdateMyclosetDto,
    @UploadedFile() shopLogo?: Express.Multer.File,
  ) {
    if (!Object.keys(dto).length && !shopLogo) {
      throw new BadRequestException('No data provided for update');
    }
    const userId = (req.user as any)?.userId;
    return this.myclosetService.update(userId, dto, shopLogo);
  }

  @Delete()
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete authenticated user Mycloset' })
  async remove(@Req() req: Request) {
    const userId = (req.user as any)?.userId;
    return this.myclosetService.remove(userId);
  }
}
