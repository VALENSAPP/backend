import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ShippingOptions } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { uploadImageToS3 } from '../../common/s3.util';
import { CreateMyclosetDto } from './dto/create-mycloset.dto';
import { UpdateMyclosetDto } from './dto/update-mycloset.dto';
import { CreateClosetItemDto } from './dto/create-closet-item.dto';
import { UpdateClosetItemDto } from './dto/update-closet-item.dto';
import { ListShopsQueryDto } from './dto/list-shops-query.dto';
import { ModerationService } from '../../moderation/moderation.service';

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
}
