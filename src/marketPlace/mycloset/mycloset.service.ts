import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ClosetItemCondition,
  MarketplaceBattleBoostStatus,
  MarketplaceWinnerPromotionStatus,
  MarketplaceWinnerPromotionType,
  Prisma,
  ShippingOptions,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { uploadImageToS3 } from '../../common/s3.util';
import { CreateMyclosetDto } from './dto/create-mycloset.dto';
import { UpdateMyclosetDto } from './dto/update-mycloset.dto';
import { CreateClosetItemDto } from './dto/create-closet-item.dto';
import { UpdateClosetItemDto } from './dto/update-closet-item.dto';
import { ListShopsQueryDto } from './dto/list-shops-query.dto';
import { ListPriorityProductsQueryDto } from './dto/list-priority-products-query.dto';
import { ModerationService } from '../../moderation/moderation.service';
import { getUserCurrency } from '../../common/payment-provider.util';

const MYCLOSET_LOGOS_FOLDER = 'mycloset-logos';
const CLOSET_ITEMS_FOLDER = 'closet-items';

@Injectable()
export class MyclosetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly moderationService: ModerationService,
  ) { }

  private async uploadLogoIfProvided(file?: Express.Multer.File): Promise<string | undefined> {
    if (!file) return undefined;
    if (!file.mimetype?.startsWith('image/')) {
      throw new BadRequestException('shopLogo must be an image file');
    }
    return uploadImageToS3(file, MYCLOSET_LOGOS_FOLDER);
  }

  private async uploadItemImages(files?: Express.Multer.File[]): Promise<string[] | undefined> {
    if (!files?.length) return undefined;

    const invalidFile = files.find((file) => !file.mimetype?.startsWith('image/'));
    if (invalidFile) {
      throw new BadRequestException('images must contain only image files');
    }

    return Promise.all(files.map((file) => uploadImageToS3(file, CLOSET_ITEMS_FOLDER)));
  }

  private resolveShippingOption(dto: Pick<CreateClosetItemDto, 'shippingOption' | 'ahippingOption'>) {
    return dto.shippingOption || dto.ahippingOption;
  }

  private getItemName(dto: Pick<CreateClosetItemDto, 'name' | 'category'>) {
    return dto.name || dto.category;
  }

  private validateItemDeliveryDetails(
    shippingOption: ShippingOptions,
    values: Pick<CreateClosetItemDto, 'shippingFee' | 'estimateShippingTime' | 'pickupAddress' | 'pickupAvailableHours' | 'buyerChatEnabled'>,
  ) {
    if (shippingOption === ShippingOptions.ship_items || shippingOption === ShippingOptions.both) {
      if (values.shippingFee === undefined) {
        throw new BadRequestException('shippingFee is required for ship_items and both');
      }
      if (!values.estimateShippingTime) {
        throw new BadRequestException('estimateShippingTime is required for ship_items and both');
      }
    }

    if (shippingOption === ShippingOptions.local_pick || shippingOption === ShippingOptions.both) {
      if (!values.pickupAddress) {
        throw new BadRequestException('pickupAddress is required for local_pick and both');
      }
      if (!values.pickupAvailableHours) {
        throw new BadRequestException('pickupAvailableHours is required for local_pick and both');
      }
      if (values.buyerChatEnabled === undefined) {
        throw new BadRequestException('buyerChatEnabled is required for local_pick and both');
      }
    }
  }

  private async findMineOrThrow(userId: string) {
    const closet = await this.prisma.mycloset.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!closet) throw new NotFoundException('Mycloset not found');
    return closet;
  }

  private handleUniqueError(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const target = Array.isArray(error.meta?.target) ? error.meta?.target.join(', ') : String(error.meta?.target || '');
      if (target.includes('shopUsername')) {
        throw new BadRequestException('shopUsername already exists');
      }
      if (target.includes('userId')) {
        throw new BadRequestException('Mycloset already exists for this user');
      }
      throw new BadRequestException('Unique constraint failed');
    }
    throw error;
  }

  async create(userId: string, dto: CreateMyclosetDto, logoFile?: Express.Multer.File) {
    if (!userId) throw new BadRequestException('User ID required');

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const shopLogo = await this.uploadLogoIfProvided(logoFile);

    try {
      return await this.prisma.mycloset.create({
        data: {
          userId,
          shopName: dto.shopName,
          shopUsername: dto.shopUsername,
          shopLogo,
          description: dto.description,
          shopCategory: dto.shopCategory,
          location: dto.location,
          whoCanBuy: dto.whoCanBuy,
          paymentMethod: dto.paymentMethod,
          shippingOptions: dto.shippingOptions,
          returnPolicy: dto.returnPolicy,
        },
      });
    } catch (error) {
      this.handleUniqueError(error);
    }
  }

  async findMine(userId: string) {
    if (!userId) throw new BadRequestException('User ID required');
    const closet = await this.prisma.mycloset.findUnique({
      where: { userId },
    });
    if (!closet) throw new NotFoundException('Mycloset not found');
    return closet;
  }

  async listAllShops(query: ListShopsQueryDto, userId?: string) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;
    const search = query.search?.trim();
    const shopCategory = query.shopCategory?.trim();

    const where: Prisma.MyclosetWhereInput = {
      ...(userId ? { userId: { not: userId } } : {}),
      user: {
        isDeleted: 0,
        deletedAt: null,
      },
      ...(shopCategory
        ? {
            shopCategory: {
              equals: shopCategory,
              mode: 'insensitive',
            },
          }
        : {}),
      ...(search
        ? {
            OR: [
              { shopName: { contains: search, mode: 'insensitive' } },
              { shopUsername: { contains: search, mode: 'insensitive' } },
              { shopCategory: { contains: search, mode: 'insensitive' } },
              { location: { contains: search, mode: 'insensitive' } },
              { description: { contains: search, mode: 'insensitive' } },
              {
                user: {
                  OR: [
                    { userName: { contains: search, mode: 'insensitive' } },
                    { displayName: { contains: search, mode: 'insensitive' } },
                  ],
                },
              },
            ],
          }
        : {}),
    };

    const [total, shops] = await this.prisma.$transaction([
      this.prisma.mycloset.count({ where }),
      this.prisma.mycloset.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          userId: true,
          shopName: true,
          shopUsername: true,
          shopLogo: true,
          description: true,
          shopCategory: true,
          location: true,
          whoCanBuy: true,
          shippingOptions: true,
          createdAt: true,
          updatedAt: true,
          user: {
            select: {
              id: true,
              userName: true,
              displayName: true,
              image: true,
              profile: true,
            },
          },
          _count: {
            select: {
              closetItems: {
                where: {
                  isActive: true,
                  isDeleted: false,
                  moderationStatus: 'APPROVED' as any,
                },
              },
            },
          },
        },
      }),
    ]);

    return {
      shops: shops.map((shop) => ({
        id: shop.id,
        userId: shop.userId,
        shopName: shop.shopName,
        shopUsername: shop.shopUsername,
        shopLogo: shop.shopLogo,
        description: shop.description,
        shopCategory: shop.shopCategory,
        location: shop.location,
        whoCanBuy: shop.whoCanBuy,
        shippingOptions: shop.shippingOptions,
        createdAt: shop.createdAt,
        updatedAt: shop.updatedAt,
        activeItemCount: shop._count.closetItems,
        owner: {
          id: shop.user.id,
          userName: shop.user.userName,
          displayName: shop.user.displayName,
          image: shop.user.image,
          profile: shop.user.profile,
        },
      })),
      total,
      page,
      limit,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  async findById(id: string) {
    if (!id) throw new BadRequestException('Mycloset ID required');
    const closet = await this.prisma.mycloset.findUnique({
      where: { id },
    });
    if (!closet) throw new NotFoundException('Mycloset not found');
    return closet;
  }

  async trackClosetView(viewerId: string, closetId: string) {
    if (!viewerId) throw new BadRequestException('Viewer user ID required');
    if (!closetId) throw new BadRequestException('Mycloset ID required');

    const closet = await this.prisma.mycloset.findUnique({
      where: { id: closetId },
      select: { id: true, userId: true },
    });

    if (!closet) throw new NotFoundException('Mycloset not found');

    // Do not count owner visiting own closet.
    if (closet.userId === viewerId) {
      const views = await this.prisma.closetView.count({ where: { closetId } });
      return {
        tracked: false,
        reason: 'SELF_VIEW_IGNORED',
        closetId,
        views,
        uniqueViewers: views,
      };
    }

    await this.prisma.closetView.create({
      data: {
        closetId,
        viewerId,
      },
    });

    const views = await this.prisma.closetView.count({ where: { closetId } });

    return {
      tracked: true,
      closetId,
      views,
      uniqueViewers: views,
    };
  }

  async getClosetUniqueViewCount(closetId: string) {
    if (!closetId) throw new BadRequestException('Mycloset ID required');

    const closet = await this.prisma.mycloset.findUnique({
      where: { id: closetId },
      select: { id: true },
    });
    if (!closet) throw new NotFoundException('Mycloset not found');

    const views = await this.prisma.closetView.count({ where: { closetId } });
    return {
      closetId,
      views,
      uniqueViewers: views,
    };
  }

  async getMyClosetUniqueViewCount(userId: string) {
    if (!userId) throw new BadRequestException('User ID required');

    const closet = await this.prisma.mycloset.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!closet) throw new NotFoundException('Mycloset not found');

    const views = await this.prisma.closetView.count({ where: { closetId: closet.id } });
    return {
      closetId: closet.id,
      views,
      uniqueViewers: views,
    };
  }

  async findByUserId(userId: string) {
    if (!userId) throw new BadRequestException('User ID required');

    const closet = await this.prisma.mycloset.findUnique({
      where: { userId },
    });

    if (!closet) throw new NotFoundException('Mycloset not found');

    return {
      closetId: closet.id,
      closetDetails: closet,
    };
  }



  async update(userId: string, dto: UpdateMyclosetDto, logoFile?: Express.Multer.File) {
    if (!userId) throw new BadRequestException('User ID required');

    const existing = await this.prisma.mycloset.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Mycloset not found');

    const shopLogo = await this.uploadLogoIfProvided(logoFile);

    try {
      return await this.prisma.mycloset.update({
        where: { userId },
        data: {
          ...(dto.shopName !== undefined && { shopName: dto.shopName }),
          ...(dto.shopUsername !== undefined && { shopUsername: dto.shopUsername }),
          ...(shopLogo !== undefined && { shopLogo }),
          ...(dto.description !== undefined && { description: dto.description }),
          ...(dto.shopCategory !== undefined && { shopCategory: dto.shopCategory }),
          ...(dto.location !== undefined && { location: dto.location }),
          ...(dto.whoCanBuy !== undefined && { whoCanBuy: dto.whoCanBuy }),
          ...(dto.paymentMethod !== undefined && { paymentMethod: dto.paymentMethod }),
          ...(dto.shippingOptions !== undefined && { shippingOptions: dto.shippingOptions }),
          ...(dto.returnPolicy !== undefined && { returnPolicy: dto.returnPolicy }),
        },
      });
    } catch (error) {
      this.handleUniqueError(error);
    }
  }

  async remove(userId: string) {
    if (!userId) throw new BadRequestException('User ID required');
    const existing = await this.prisma.mycloset.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Mycloset not found');
    await this.prisma.mycloset.delete({
      where: { userId },
    });
    return { message: 'Mycloset deleted successfully' };
  }

  async createItem(userId: string, dto: CreateClosetItemDto, imageFiles?: Express.Multer.File[]) {
    if (!userId) throw new BadRequestException('User ID required');

    const shippingOption = this.resolveShippingOption(dto);
    if (!shippingOption) throw new BadRequestException('shippingOption is required');

    this.validateItemDeliveryDetails(shippingOption, dto);

    const closet = await this.findMineOrThrow(userId);
    const images = (await this.uploadItemImages(imageFiles)) || [];
    const itemName = this.getItemName(dto);

    const moderation = await this.moderationService.evaluateProduct({
      name: itemName,
      category: dto.category,
      description: dto.description,
      brand: dto.brand,
      images,
      price: dto.price,
    });

    const item = await this.prisma.closetItems.create({
      data: {
        closetId: closet.id,
        userId,
        images,
        name: itemName,
        category: dto.category,
        brand: dto.brand,
        condition: dto.condition,
        description: dto.description,
        price: dto.price,
        quantity: dto.quantity ?? 1,
        shippingOption,
        shippingFee: dto.shippingFee,
        estimateShippingTime: dto.estimateShippingTime,
        pickupAddress: dto.pickupAddress,
        pickupAvailableHours: dto.pickupAvailableHours,
        pickUpCity: dto.pickUpCity,
        residentNumber: dto.residentNumber,
        buyerChatEnabled: dto.buyerChatEnabled,
        returnPolicy: dto.returnPolicy,
        moderationStatus: moderation.status,
        moderationReason: moderation.reason,
        moderationScore: moderation.score,
        moderatedBy: moderation.moderatedBy,
        moderatedAt: new Date(),
      } as any,
    });

    if (moderation.status === 'PENDING_APPROVAL') {
      await (this.prisma as any).moderationAuditLog.create({
        data: {
          contentType: 'PRODUCT',
          contentId: item.id,
          authorId: userId,
          aiVerdict: 'PENDING_APPROVAL',
          aiReason: moderation.reason,
          aiConfidence: moderation.score,
          flaggedLabels: moderation.flaggedLabels || [],
        },
      });
    }

    return item;
  }

  async findMyItems(userId: string) {
    if (!userId) throw new BadRequestException('User ID required');
    await this.findMineOrThrow(userId);

    return this.prisma.closetItems.findMany({
      where: { userId, isDeleted: false },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findItemsByClosetId(closetId: string) {
    if (!closetId) throw new BadRequestException('Mycloset ID required');

    const closet = await this.prisma.mycloset.findUnique({
      where: { id: closetId },
      select: { id: true },
    });
    if (!closet) throw new NotFoundException('Mycloset not found');

    return this.prisma.closetItems.findMany({
      where: { closetId, moderationStatus: 'APPROVED' as any, isDeleted: false },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getItemDetails(itemId: string, viewerUserId?: string) {
    if (!itemId) throw new BadRequestException('Closet item ID required');

    const item = await this.prisma.closetItems.findUnique({
      where: { id: itemId },
      include: {
        closet: {
          select: {
            id: true,
            shopName: true,
            shopUsername: true,
            shopLogo: true,
            location: true,
          },
        },
        user: {
          select: {
            id: true,
            userName: true,
            displayName: true,
            image: true,
            profile: true,
            country: true,
          },
        },
      },
    });

    if (!item || item.isDeleted) {
      throw new NotFoundException('Closet item not found');
    }

    const isOwner = Boolean(viewerUserId && item.userId === viewerUserId);
    if (!isOwner) {
      if (!item.isActive || (item.moderationStatus as string) === 'REJECTED') {
        throw new NotFoundException('Closet item not found');
      }
    }

    const winningParticipant = await this.prisma.marketplaceBattleParticipant.findFirst({
      where: {
        productId: itemId,
        isWinner: true,
        battle: {
          status: 'COMPLETED',
          outcome: 'WINNER',
        },
      },
      include: {
        battle: {
          select: {
            id: true,
            title: true,
            totalVotes: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    let isWinner = false;
    let winnerPct: number | null = null;
    let totalVotes = 0;
    let battleId: string | null = null;
    let battleTitle: string | null = null;

    if (winningParticipant && winningParticipant.battle) {
      isWinner = true;
      totalVotes = winningParticipant.battle.totalVotes || 0;
      const participantVotes = winningParticipant.voteCount || 0;
      winnerPct = totalVotes > 0 ? Math.round((participantVotes / totalVotes) * 100) : 0;
      battleId = winningParticipant.battle.id;
      battleTitle = winningParticipant.battle.title;
    }

    const conditionMap: Record<string, string> = {
      New: 'New',
      Used: 'Used',
      Good_condition: 'Good condition',
      Need_attention: 'Need attention',
    };
    const formattedCondition = conditionMap[item.condition] || item.condition || 'New';

    const shippingOptionMap: Record<string, string> = {
      ship_items: 'Ship items',
      local_pick: 'Local pickup',
      both: 'both',
    };
    const formattedShippingOption = shippingOptionMap[item.shippingOption] || item.shippingOption || 'Ship items';

    let shippingDescription = "We'll deliver it to your door";
    if (item.shippingOption === 'local_pick') {
      shippingDescription = 'Available for local pickup';
    } else if (item.shippingOption === 'both') {
      shippingDescription = 'Available for home delivery or local pickup';
    }

    let estimatedShippingDays: number | null = null;
    if (item.estimateShippingTime) {
      const match = String(item.estimateShippingTime).match(/\d+/);
      if (match) {
        estimatedShippingDays = parseInt(match[0], 10);
      }
    }

    let pickupLocation: string | null = null;
    if (item.shippingOption === 'local_pick' || item.shippingOption === 'both') {
      pickupLocation = [item.pickupAddress, item.pickUpCity].filter(Boolean).join(', ') || item.pickupAddress || null;
    }

    const currency = getUserCurrency(item.user?.country, item.closet?.location);

    return {
      id: item.id,
      name: item.name,
      price: item.price,
      currency,
      images: item.images || [],
      description: item.description || '',
      condition: formattedCondition,
      brand: item.brand ?? null,
      category: item.category,
      quantityAvailable: item.quantity,
      shippingOption: formattedShippingOption,
      shippingDescription,
      shippingFee: item.shippingFee ?? 0,
      estimatedShippingDays,
      pickupLocation,
      isWinner,
      winnerPct,
      totalVotes,
      battleId,
      battleTitle,
      closet: {
        id: item.closet?.id ?? item.closetId,
        displayName: item.user?.displayName || item.user?.userName || '',
        shopName: item.closet?.shopName ?? '',
        userName: item.user?.userName ?? '',
        avatarUrl: item.user?.image || item.user?.profile || item.closet?.shopLogo || null,
      },
    };
  }

  async findItemById(userId: string, itemId: string) {
    if (!userId) throw new BadRequestException('User ID required');
    if (!itemId) throw new BadRequestException('Closet item ID required');

    const item = await this.prisma.closetItems.findFirst({
      where: { id: itemId, userId, isDeleted: false },
    });
    if (!item) throw new NotFoundException('Closet item not found');
    return item;
  }

  async updateItem(userId: string, itemId: string, dto: UpdateClosetItemDto, imageFiles?: Express.Multer.File[]) {
    if (!userId) throw new BadRequestException('User ID required');
    if (!itemId) throw new BadRequestException('Closet item ID required');

    const existingItem = await this.findItemById(userId, itemId);
    const images = await this.uploadItemImages(imageFiles);
    const shippingOption = this.resolveShippingOption(dto);
    const effectiveShippingOption = shippingOption ?? existingItem.shippingOption;

    this.validateItemDeliveryDetails(effectiveShippingOption, {
      shippingFee: dto.shippingFee ?? existingItem.shippingFee ?? undefined,
      estimateShippingTime: dto.estimateShippingTime ?? existingItem.estimateShippingTime ?? undefined,
      pickupAddress: dto.pickupAddress ?? existingItem.pickupAddress ?? undefined,
      pickupAvailableHours: dto.pickupAvailableHours ?? existingItem.pickupAvailableHours ?? undefined,
      buyerChatEnabled: dto.buyerChatEnabled ?? existingItem.buyerChatEnabled ?? undefined,
    });

    return this.prisma.closetItems.update({
      where: { id: itemId },
      data: {
        ...(images !== undefined && { images }),
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.category !== undefined && { category: dto.category }),
        ...(dto.name === undefined && dto.category !== undefined && { name: this.getItemName(dto as CreateClosetItemDto) }),
        ...(dto.brand !== undefined && { brand: dto.brand }),
        ...(dto.condition !== undefined && { condition: dto.condition }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.price !== undefined && { price: dto.price }),
        ...(dto.quantity !== undefined && { quantity: dto.quantity }),
        ...(shippingOption !== undefined && { shippingOption }),
        ...(dto.shippingFee !== undefined && { shippingFee: dto.shippingFee }),
        ...(dto.estimateShippingTime !== undefined && { estimateShippingTime: dto.estimateShippingTime }),
        ...(dto.pickupAddress !== undefined && { pickupAddress: dto.pickupAddress }),
        ...(dto.pickupAvailableHours !== undefined && { pickupAvailableHours: dto.pickupAvailableHours }),
        ...(dto.pickUpCity !== undefined && { pickUpCity: dto.pickUpCity }),
        ...(dto.residentNumber !== undefined && { residentNumber: dto.residentNumber }),
        ...(dto.buyerChatEnabled !== undefined && { buyerChatEnabled: dto.buyerChatEnabled }),
        ...(dto.returnPolicy !== undefined && { returnPolicy: dto.returnPolicy }),
      },
    });
  }

  async removeItem(userId: string, itemId: string) {
    if (!userId) throw new BadRequestException('User ID required');
    if (!itemId) throw new BadRequestException('Closet item ID required');

    await this.findItemById(userId, itemId);
    await this.prisma.closetItems.update({
      where: { id: itemId },
      data: {
        isDeleted: true,
        isActive: false,
      },
    });
    return { message: 'Closet item deleted successfully' };
  }

  async likeClosetItemByUser(itemId: string, userId: string) {
    if (!itemId) throw new BadRequestException('Closet item ID required');
    if (!userId) throw new BadRequestException('User ID required');

    const item = await this.prisma.closetItems.findUnique({
      where: { id: itemId },
      select: {
        id: true,
        isActive: true,
        isDeleted: true,
      },
    });

    if (!item || !item.isActive || item.isDeleted) {
      throw new NotFoundException('Closet item not found');
    }

    const existingLike = await this.prisma.closetItemLike.findUnique({
      where: {
        closetItemId_userId: {
          closetItemId: itemId,
          userId,
        },
      },
      select: { id: true },
    });

    if (existingLike) {
      await this.prisma.closetItemLike.delete({
        where: {
          closetItemId_userId: {
            closetItemId: itemId,
            userId,
          },
        },
      });

      const totalLikes = await this.prisma.closetItemLike.count({ where: { closetItemId: itemId } });

      return {
        message: 'Closet item unliked successfully',
        liked: false,
        totalLikes,
      };
    }

    await this.prisma.closetItemLike.create({
      data: {
        closetItemId: itemId,
        userId,
      },
    });

    const totalLikes = await this.prisma.closetItemLike.count({ where: { closetItemId: itemId } });

    return {
      message: 'Closet item liked successfully',
      liked: true,
      totalLikes,
    };
  }

  async listPriorityProducts(query: ListPriorityProductsQueryDto, viewerUserId?: string) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;
    const search = query.search?.trim();
    const category = query.category?.trim();
    const condition = query.condition;
    const minPrice = query.minPrice;
    const maxPrice = query.maxPrice;
    const sortBy = query.sortBy ?? 'priority';
    const sortOrder = query.sortOrder ?? 'desc';

    const now = new Date();

    // 1. Fetch active battle boosts with pinOnTop enabled
    const activeBoosts = await this.prisma.marketplaceBattleBoost.findMany({
      where: {
        status: MarketplaceBattleBoostStatus.ACTIVE,
        pinOnTop: true,
        endAt: { gt: now },
        OR: [
          {
            pinStartAt: { lte: now },
            pinEndAt: { gt: now },
          },
          {
            pinStartAt: null,
            startAt: { lte: now },
          },
        ],
      },
      select: {
        id: true,
        battleId: true,
        pinStartAt: true,
        activatedAt: true,
        startAt: true,
        endAt: true,
        createdAt: true,
      },
    });

    const pinnedBattleMap = new Map<string, { boostedAt: Date; endAt: Date }>();
    for (const boost of activeBoosts) {
      const boostedAt = boost.pinStartAt ?? boost.activatedAt ?? boost.startAt ?? boost.createdAt;
      const current = pinnedBattleMap.get(boost.battleId);
      if (!current || boostedAt.getTime() > current.boostedAt.getTime()) {
        pinnedBattleMap.set(boost.battleId, { boostedAt, endAt: boost.endAt! });
      }
    }

    const pinnedBattleIds = Array.from(pinnedBattleMap.keys());
    const pinnedParticipants =
      pinnedBattleIds.length > 0
        ? await this.prisma.marketplaceBattleParticipant.findMany({
            where: { battleId: { in: pinnedBattleIds } },
            select: { productId: true, battleId: true },
          })
        : [];

    const pinnedProductMap = new Map<string, { battleId: string; boostedAt: Date; endAt: Date }>();
    for (const p of pinnedParticipants) {
      if (p.productId) {
        const battleBoost = pinnedBattleMap.get(p.battleId);
        if (battleBoost) {
          const current = pinnedProductMap.get(p.productId);
          if (!current || battleBoost.boostedAt.getTime() > current.boostedAt.getTime()) {
            pinnedProductMap.set(p.productId, {
              battleId: p.battleId,
              boostedAt: battleBoost.boostedAt,
              endAt: battleBoost.endAt,
            });
          }
        }
      }
    }

    // 2. Fetch active winner promotions (Free Shipping & Percentage Off)
    const activePromotions = await this.prisma.marketplaceWinnerPromotion.findMany({
      where: {
        status: MarketplaceWinnerPromotionStatus.ACTIVE,
        endAt: { gt: now },
        OR: [{ startAt: null }, { startAt: { lte: now } }],
      },
      select: {
        id: true,
        battleId: true,
        productId: true,
        promoType: true,
        message: true,
        discountPercent: true,
        freeShipping: true,
        originalPrice: true,
        promoPrice: true,
        originalShippingFee: true,
        promoShippingFee: true,
        startAt: true,
        endAt: true,
        activatedAt: true,
        createdAt: true,
      },
    });

    const promotionMap = new Map<
      string,
      (typeof activePromotions)[0] & { promotedAt: Date }
    >();
    for (const promo of activePromotions) {
      if (promo.productId) {
        const promotedAt = promo.activatedAt ?? promo.startAt ?? promo.createdAt;
        const current = promotionMap.get(promo.productId);
        if (!current || promotedAt.getTime() > current.promotedAt.getTime()) {
          promotionMap.set(promo.productId, { ...promo, promotedAt });
        }
      }
    }

    // 3. Build product filters
    const where: Prisma.ClosetItemsWhereInput = {
      isActive: true,
      isDeleted: false,
      moderationStatus: 'APPROVED' as any,
      user: {
        isDeleted: 0,
        deletedAt: null,
      },
      ...(category ? { category: { equals: category, mode: 'insensitive' } } : {}),
      ...(condition ? { condition } : {}),
      ...(minPrice !== undefined || maxPrice !== undefined
        ? {
            price: {
              ...(minPrice !== undefined ? { gte: minPrice } : {}),
              ...(maxPrice !== undefined ? { lte: maxPrice } : {}),
            },
          }
        : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { category: { contains: search, mode: 'insensitive' } },
              { brand: { contains: search, mode: 'insensitive' } },
              { description: { contains: search, mode: 'insensitive' } },
              {
                closet: {
                  OR: [
                    { shopName: { contains: search, mode: 'insensitive' } },
                    { shopUsername: { contains: search, mode: 'insensitive' } },
                  ],
                },
              },
            ],
          }
        : {}),
    };

    // 4. Fetch candidate product IDs to rank
    const candidateItems = await this.prisma.closetItems.findMany({
      where,
      select: {
        id: true,
        createdAt: true,
        price: true,
      },
    });

    const total = candidateItems.length;

    // Helper to calculate Priority Tier:
    // Tier 1: Pinned on top
    // Tier 2: Free Shipping
    // Tier 3: Percentage Off
    // Tier 4: Regular product
    const getTier = (productId: string): number => {
      if (pinnedProductMap.has(productId)) {
        return 1;
      }
      const promo = promotionMap.get(productId);
      if (
        promo &&
        (promo.promoType === MarketplaceWinnerPromotionType.FREE_SHIPPING || promo.freeShipping)
      ) {
        return 2;
      }
      if (
        promo &&
        (promo.promoType === MarketplaceWinnerPromotionType.DISCOUNT_10_PERCENT_24H ||
          (promo.discountPercent && promo.discountPercent > 0))
      ) {
        return 3;
      }
      return 4;
    };

    // 5. Multi-level Priority Tier sorting
    // Tier 1: Active Pinned -> ordered by boostedAt DESC (latest boosted first)
    // Tier 2: Active Free Shipping -> ordered by promotedAt DESC (latest promoted first)
    // Tier 3: Active Percentage Off -> ordered by promotedAt DESC (latest promoted first)
    // Tier 4: Standard Products (including expired boosts/promotions) -> treated as normal posts
    candidateItems.sort((a, b) => {
      // Explicit global sort requests
      if (sortBy === 'boostedAt') {
        const boostedAtA = pinnedProductMap.get(a.id)?.boostedAt?.getTime() ?? 0;
        const boostedAtB = pinnedProductMap.get(b.id)?.boostedAt?.getTime() ?? 0;
        if (boostedAtA !== boostedAtB) {
          return sortOrder === 'asc' ? boostedAtA - boostedAtB : boostedAtB - boostedAtA;
        }
      } else if (sortBy === 'promotedAt') {
        const promotedAtA = promotionMap.get(a.id)?.promotedAt?.getTime() ?? 0;
        const promotedAtB = promotionMap.get(b.id)?.promotedAt?.getTime() ?? 0;
        if (promotedAtA !== promotedAtB) {
          return sortOrder === 'asc' ? promotedAtA - promotedAtB : promotedAtB - promotedAtA;
        }
      }

      const rankA = getTier(a.id);
      const rankB = getTier(b.id);

      // Higher priority tier comes first
      if (rankA !== rankB) {
        return rankA - rankB; // 1 (Pin) -> 2 (Free Shipping) -> 3 (Percentage Off) -> 4 (Standard/Expired)
      }

      // Tie-breakers within the same tier:
      if (rankA === 1) {
        // Tier 1: Which boosted last comes on top (boostedAt DESC)
        const boostedAtA = pinnedProductMap.get(a.id)?.boostedAt?.getTime() ?? 0;
        const boostedAtB = pinnedProductMap.get(b.id)?.boostedAt?.getTime() ?? 0;
        if (boostedAtA !== boostedAtB) {
          return boostedAtB - boostedAtA;
        }
      } else if (rankA === 2 || rankA === 3) {
        // Tier 2 & 3: Which promoted last comes on top (promotedAt DESC)
        const promotedAtA = promotionMap.get(a.id)?.promotedAt?.getTime() ?? 0;
        const promotedAtB = promotionMap.get(b.id)?.promotedAt?.getTime() ?? 0;
        if (promotedAtA !== promotedAtB) {
          return promotedAtB - promotedAtA;
        }
      }

      // Tier 4 (Normal posts and expired boosts/promos):
      if (sortBy === 'price') {
        return sortOrder === 'asc' ? a.price - b.price : b.price - a.price;
      }

      // Default: newest post first (createdAt DESC)
      const timeDiff = b.createdAt.getTime() - a.createdAt.getTime();
      return sortOrder === 'asc' ? -timeDiff : timeDiff;
    });

    // 6. Slice requested page IDs
    const pageIds = candidateItems.slice(skip, skip + limit).map((i) => i.id);

    if (pageIds.length === 0) {
      return {
        products: [],
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
        hasMore: false,
      };
    }

    // 7. Hydrate the paginated items with full relations
    const products = await this.prisma.closetItems.findMany({
      where: { id: { in: pageIds } },
      include: {
        closet: {
          select: {
            id: true,
            shopName: true,
            shopUsername: true,
            shopLogo: true,
            location: true,
          },
        },
        user: {
          select: {
            id: true,
            userName: true,
            displayName: true,
            image: true,
            profile: true,
            country: true,
          },
        },
      },
    });

    const productMap = new Map(products.map((p) => [p.id, p]));

    // 8. Map in exact prioritized order and decorate with promotion metadata
    const items = pageIds
      .map((id) => productMap.get(id))
      .filter((p): p is NonNullable<typeof p> => Boolean(p))
      .map((item) => {
        const isPinned = pinnedProductMap.has(item.id);
        const promo = promotionMap.get(item.id);
        const hasFreeShipping = Boolean(
          promo &&
            (promo.promoType === MarketplaceWinnerPromotionType.FREE_SHIPPING || promo.freeShipping),
        );
        const hasPercentageOff = Boolean(
          promo &&
            (promo.promoType === MarketplaceWinnerPromotionType.DISCOUNT_10_PERCENT_24H ||
              (promo.discountPercent && promo.discountPercent > 0)),
        );

        let priorityTier = 4;
        let primaryBadge: 'PINNED' | 'FREE_SHIPPING' | 'PERCENTAGE_OFF' | null = null;

        if (isPinned) {
          priorityTier = 1;
          primaryBadge = 'PINNED';
        } else if (hasFreeShipping) {
          priorityTier = 2;
          primaryBadge = 'FREE_SHIPPING';
        } else if (hasPercentageOff) {
          priorityTier = 3;
          primaryBadge = 'PERCENTAGE_OFF';
        }

        const discountPercent = promo?.discountPercent ?? (hasPercentageOff ? 10 : null);
        const calculatedPromoPrice =
          promo?.promoPrice ??
          (hasPercentageOff && discountPercent
            ? Number((item.price * (1 - discountPercent / 100)).toFixed(2))
            : null);
        const currentPrice = calculatedPromoPrice ?? item.price;

        const originalShippingFee = promo?.originalShippingFee ?? item.shippingFee ?? 0;
        const promoShippingFee = hasFreeShipping ? 0 : (promo?.promoShippingFee ?? item.shippingFee ?? 0);
        const currentShippingFee = hasFreeShipping ? 0 : promoShippingFee;

        const boostedAt = isPinned ? (pinnedProductMap.get(item.id)?.boostedAt ?? null) : null;
        const promotedAt = promo ? (promo.promotedAt ?? null) : null;
        const effectiveEndAt = (isPinned ? pinnedProductMap.get(item.id)?.endAt : null) ?? promo?.endAt ?? null;
        const remainingSeconds = effectiveEndAt
          ? Math.max(0, Math.floor((effectiveEndAt.getTime() - now.getTime()) / 1000))
          : null;

        return {
          id: item.id,
          closetId: item.closetId,
          userId: item.userId,
          name: item.name,
          category: item.category,
          brand: item.brand,
          condition: item.condition,
          description: item.description,
          price: item.price,
          quantity: item.quantity,
          images: item.images,
          soldCount: item.soldCount,
          shippingOption: item.shippingOption,
          shippingFee: item.shippingFee,
          estimateShippingTime: item.estimateShippingTime,
          pickupAddress: item.pickupAddress,
          pickupAvailableHours: item.pickupAvailableHours,
          pickUpCity: item.pickUpCity,
          residentNumber: item.residentNumber,
          buyerChatEnabled: item.buyerChatEnabled,
          returnPolicy: item.returnPolicy,
          moderationStatus: item.moderationStatus,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          boostedAt,
          promotedAt,
          closet: item.closet,
          user: item.user,
          pricing: {
            originalPrice: promo?.originalPrice ?? item.price,
            promoPrice: calculatedPromoPrice,
            currentPrice,
            originalShippingFee,
            promoShippingFee,
            currentShippingFee,
          },
          promotion: {
            priorityTier,
            primaryBadge,
            isPinnedOnTop: isPinned,
            hasFreeShipping,
            hasPercentageOff,
            discountPercent,
            promotionType: promo?.promoType ?? null,
            promotionMessage: promo?.message ?? null,
            battleId: pinnedProductMap.get(item.id)?.battleId ?? promo?.battleId ?? null,
            boostedAt,
            promotedAt,
            promotionEndAt: effectiveEndAt,
            remainingSeconds,
          },
        };
      });

    return {
      products: items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
      hasMore: skip + items.length < total,
    };
  }
}
