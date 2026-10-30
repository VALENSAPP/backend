import { Injectable, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { uploadBufferToS3, uploadFileToS3, uploadImageToS3 } from '../common/s3.util';
import {
  FollowStatus,
  MarketplaceBattleBoostStatus,
  MarketplaceBattleOutcome,
  MarketplaceBattleStatus,
  MarketplaceWinnerPromotionStatus,
  Prisma,
  WhoCanBuy,
} from '@prisma/client';
import { generateThumbnailForMedia } from '../common/media-thumbnail.util';
import { applyVideoTextOverlays, VideoTextOverlayItem } from '../common/video-text-overlay.util';
import { profile } from 'console';
import { start } from 'repl';
import { endWith } from 'rxjs';
import { NotificationService } from '../notification/notification.service';
import { ModerationService } from '../moderation/moderation.service';
import { format } from 'path';

type PostFormat = 'image' | 'video' | 'reel' | 'ebook';

@Injectable()
export class PostService {
  private static readonly HASHTAG_REGEX = /(^|[^A-Za-z0-9_])#([A-Za-z0-9_]{1,50})/g;
  private static readonly MAX_HASHTAGS_PER_POST = 10;

  private readonly privateCircleVisibilityValues = [
    'PRIVATE_CIRCLE',
    'private_circle',
    'private-circle',
    'private circle',
    'Private Circle',
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationService: NotificationService,
    private readonly moderationService: ModerationService,
  ) { }

  private isPrivateCircleVisibility(visibleTo?: string | null): boolean {
    const normalized = (visibleTo || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    return normalized === 'private_circle';
  }

  private normalizeHashtagTag(raw: unknown): string | null {
    if (raw === null || raw === undefined) return null;
    const value = String(raw).trim();
    if (!value) return null;

    const withoutHash = value.replace(/^#+/, '');
    const normalized = withoutHash.toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!normalized) return null;

    return normalized.slice(0, 50);
  }

  private extractHashtagsFromText(input?: string | null): string[] {
    if (!input || typeof input !== 'string') return [];
    const tags: string[] = [];

    for (const match of input.matchAll(PostService.HASHTAG_REGEX)) {
      const normalized = this.normalizeHashtagTag(match[2]);
      if (normalized) tags.push(normalized);
    }

    return tags;
  }

  private buildNormalizedPostHashtags(hashtag?: string[], text?: string, caption?: string): string[] {
    const sourceTags: string[] = [
      ...(Array.isArray(hashtag) ? hashtag.map((item) => String(item)) : []),
      ...this.extractHashtagsFromText(text),
      ...this.extractHashtagsFromText(caption),
    ];

    const uniqueTags: string[] = [];
    const seen = new Set<string>();

    for (const rawTag of sourceTags) {
      const normalized = this.normalizeHashtagTag(rawTag);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      uniqueTags.push(normalized);

      if (uniqueTags.length >= PostService.MAX_HASHTAGS_PER_POST) {
        break;
      }
    }

    return uniqueTags;
  }

  private async recalculateHashtagCounters(tx: Prisma.TransactionClient, hashtagId: string) {
    const [postCount, lastLink] = await Promise.all([
      tx.postHashtag.count({ where: { hashtagId } }),
      tx.postHashtag.findFirst({
        where: { hashtagId },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
    ]);

    if (postCount === 0) {
      await tx.hashtag.delete({ where: { id: hashtagId } }).catch(() => undefined);
      return;
    }

    await tx.hashtag.update({
      where: { id: hashtagId },
      data: {
        usageCount: postCount,
        postCount,
        lastUsedAt: lastLink?.createdAt || new Date(),
      },
    });
  }

  private async syncPostHashtags(tx: Prisma.TransactionClient, postId: string, targetTags: string[]) {
    const normalizedTarget = Array.from(new Set(targetTags.map((t) => t.trim()).filter(Boolean)));

    const existingLinks = await tx.postHashtag.findMany({
      where: { postId },
      select: {
        hashtagId: true,
        hashtag: { select: { tag: true } },
      },
    });

    const existingTagToId = new Map(existingLinks.map((link) => [link.hashtag.tag, link.hashtagId]));
    const existingTagSet = new Set(existingTagToId.keys());

    const toAddTags = normalizedTarget.filter((tag) => !existingTagSet.has(tag));
    const toRemoveTags = Array.from(existingTagSet).filter((tag) => !normalizedTarget.includes(tag));
    const affectedHashtagIds = new Set<string>();

    if (toAddTags.length > 0) {
      const upsertedHashtags = await Promise.all(
        toAddTags.map((tag) =>
          tx.hashtag.upsert({
            where: { tag },
            update: { lastUsedAt: new Date() },
            create: { tag, lastUsedAt: new Date() },
            select: { id: true, tag: true },
          }),
        ),
      );

      await tx.postHashtag.createMany({
        data: upsertedHashtags.map((item) => ({
          postId,
          hashtagId: item.id,
        })),
        skipDuplicates: true,
      });

      upsertedHashtags.forEach((item) => affectedHashtagIds.add(item.id));
    }

    if (toRemoveTags.length > 0) {
      const removeHashtagIds = toRemoveTags
        .map((tag) => existingTagToId.get(tag))
        .filter((id): id is string => Boolean(id));

      if (removeHashtagIds.length > 0) {
        await tx.postHashtag.deleteMany({
          where: {
            postId,
            hashtagId: { in: removeHashtagIds },
          },
        });
        removeHashtagIds.forEach((id) => affectedHashtagIds.add(id));
      }
    }

    if (affectedHashtagIds.size > 0) {
      await Promise.all(Array.from(affectedHashtagIds).map((id) => this.recalculateHashtagCounters(tx, id)));
    }
  }

  // private buildSubscriptionContentAccessWhere(viewerUserId?: string): Prisma.PostWhereInput {
  //   if (!viewerUserId) {
  //     return {
  //       OR: [
  //         { type: null },
  //         { type: { not: 'subscription_content' } },
  //       ],
  //     };
  //   }

  //   return {
  //     OR: [
  //       { type: null },
  //       { type: { not: 'subscription_content' } },
  //       { userId: viewerUserId },
  //       {
  //         type: 'subscription_content',
  //         user: {
  //           receivedPayments: {
  //             some: {
  //               userId: viewerUserId,
  //               forPayment: 'following',
  //               status: 'succeeded',
  //               periodEnd: { gt: new Date() },
  //             },
  //           },
  //         },
  //       },
  //     ],
  //   };
  // }
  private buildSubscriptionContentAccessWhere(
    viewerUserId?: string,
  ): Prisma.PostWhereInput {
    if (!viewerUserId) {
      return {
        OR: [
          { type: null },
          { type: { not: 'private' } },
        ],
      };
    }

    return {
      OR: [
        // Public / non-private posts
        { type: null },
        { type: { not: 'private' } },

        // User can always see their own posts
        { userId: viewerUserId },

        // Subscription posts
        {
          AND: [
            { type: 'private' },
            {
              OR: [
                { visibleTo: null },
                { visibleTo: '' },
              ],
            },
            {
              user: {
                receivedPayments: {
                  some: {
                    userId: viewerUserId,
                    forPayment: 'following',
                    status: 'succeeded',
                    periodEnd: {
                      gt: new Date(),
                    },
                  },
                },
              },
            },
          ],
        },
      ],
    };
  }
  private buildPostVisibilityWhere(viewerUserId?: string): Prisma.PostWhereInput {
    const publicVisibility: Prisma.PostWhereInput[] = [
      { visibleTo: null },
      { visibleTo: { notIn: this.privateCircleVisibilityValues } },
    ];

    const subscriptionContentAccess = this.buildSubscriptionContentAccessWhere(viewerUserId);

    const moderationVisibility: Prisma.PostWhereInput = viewerUserId
      ? {
          OR: [
            { moderationStatus: 'APPROVED' as any },
            { userId: viewerUserId },
          ],
        }
      : { moderationStatus: 'APPROVED' as any };

    if (!viewerUserId) {
      return {
        AND: [
          { OR: publicVisibility },
          subscriptionContentAccess,
          moderationVisibility,
        ],
      };
    }

    return {
      AND: [
        {
          OR: [
            ...publicVisibility,
            {
              visibleTo: { in: this.privateCircleVisibilityValues },
              userId: viewerUserId,
            },
            {
              visibleTo: { in: this.privateCircleVisibilityValues },
              privateCircle: {
                members: {
                  some: {
                    userId: viewerUserId,
                    status: 'ACTIVE',
                  },
                },
              },
            },
          ],
        },
        subscriptionContentAccess,
        moderationVisibility,
      ],
    };
  }

  private async ensureCanViewPost(post: { userId: string; type?: string | null; visibleTo?: string | null; privateCircleId?: string | null; moderationStatus?: any }, viewerUserId?: string) {
    if (post.moderationStatus && post.moderationStatus !== 'APPROVED') {
      if (!viewerUserId || post.userId !== viewerUserId) {
        throw new BadRequestException('Post is pending moderation review');
      }
    }

    await this.ensureCanViewSubscriptionContent(post, viewerUserId);

    if (!this.isPrivateCircleVisibility(post.visibleTo)) return;
    if (viewerUserId && post.userId === viewerUserId) return;
    if (!viewerUserId || !post.privateCircleId) {
      throw new BadRequestException('Post not found');
    }

    const member = await this.prisma.privateCircleMember.findFirst({
      where: {
        privateCircleId: post.privateCircleId,
        userId: viewerUserId,
        status: 'ACTIVE',
      },
      select: { id: true },
    });

    if (!member) throw new BadRequestException('Post not found');
  }

  // private async ensureCanViewSubscriptionContent(post: { userId: string; type?: string | null }, viewerUserId?: string) {
  //   if (post.type !== 'subscription_content') return;
  //   if (viewerUserId && post.userId === viewerUserId) return;
  //   if (!viewerUserId) throw new BadRequestException('Post not found');

  //   const activePayment = await this.prisma.payment.findFirst({
  //     where: {
  //       userId: viewerUserId,
  //       receiverId: post.userId,
  //       forPayment: 'following',
  //       status: 'succeeded',
  //       periodEnd: { gt: new Date() },
  //     },
  //     select: { id: true },
  //   });

  //   if (!activePayment) throw new BadRequestException('Post not found');
  // }
  private async ensureCanViewSubscriptionContent(
    post: {
      userId: string;
      type?: string | null;
      visibleTo?: string | null;
    },
    viewerUserId?: string,
  ) {
    const isSubscriptionPost =
      post.type === 'private' &&
      (post.visibleTo === null || post.visibleTo === '');

    // Not a subscription post
    if (!isSubscriptionPost) {
      return;
    }

    // Owner can always view their own subscription posts
    if (viewerUserId && post.userId === viewerUserId) {
      return;
    }

    // Guest users cannot view subscription posts
    if (!viewerUserId) {
      throw new BadRequestException('Post not found');
    }

    const activePayment = await this.prisma.payment.findFirst({
      where: {
        userId: viewerUserId,
        receiverId: post.userId,
        forPayment: 'following',
        status: 'succeeded',
        periodEnd: {
          gt: new Date(),
        },
      },
      select: {
        id: true,
      },
    });

    if (!activePayment) {
      throw new BadRequestException('Post not found');
    }
  }

  async createPost(
    userId: string,
    text?: string,
    images?: string[],
    caption?: string,
    hashtag?: string[],
    location?: string,
    music?: string,
    youtubeMusicMeta?: any,
    link?: string,
    visibleTo?: string,
    taggedPeople?: string[],
    type?: string,
    format?: string,
    allowDownload?: boolean,
    tableContents?: string[],
    amount?: number | null,
    promoCode?: string | null,
    ebookpdfFile?: Express.Multer.File,
    raiseAmount?: number,
    start_time?: Date,
    end_time?: Date,
    isTrustPost: boolean = false,
    videoText: boolean = false,
    videoTextItems?: VideoTextOverlayItem[],
    rawBody?: Record<string, any>,
    files?: Express.Multer.File[],
  ) {
    try {
      if (!userId) throw new BadRequestException('User ID required');

      // Check if user is blocked or has an active 24-hour posting ban
      const author = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, isBlocked: true, standingUntil: true, standingReason: true },
      });
      if (author?.isBlocked) {
        throw new ForbiddenException('Your account has been banned from posting.');
      }
      if (author?.standingUntil && new Date(author.standingUntil) > new Date()) {
        const remainingMs = new Date(author.standingUntil).getTime() - Date.now();
        const remainingHours = Math.max(1, Math.ceil(remainingMs / (1000 * 60 * 60)));
        throw new ForbiddenException(
          `You are temporarily banned from adding posts for 24 hours (${remainingHours}h remaining). Reason: ${author.standingReason || 'Policy violation'}.`,
        );
      }

      const normalizedPostType = (type || '').trim().toLowerCase();
      const isMissionPost = ['mission-post', 'crowdfunding', 'support'].includes(normalizedPostType);
      const resolvedIsTrustPost = isMissionPost ? true : isTrustPost === true;

      // Log incoming data for debugging
      // console.log('Creating post with data:', {
      //   userId,
      //   text,
      //   imagesCount: images?.length,
      //   filesCount: files?.length,
      //   caption,
      //   hashtag,
      //   type,
      //   format,
      //   raiseAmount,
      //   isTrustPost,
      //   videoText,
      //   videoTextItemsCount: videoTextItems?.length,
      //   rawBodyKeys: rawBody ? Object.keys(rawBody).length : 0,
      // });

      // For crowdfunding posts, check hits and validate required fields
      if (type === 'crowdfunding' || type === 'support') {
        if (!raiseAmount || !start_time || !end_time) {
          throw new BadRequestException('raiseAmount, start_time, and end_time are required for crowdfunding posts');
        }

        const postHit = await this.prisma.postHit.findFirst({
          where: { userId },
        });

        const now = new Date();
        const hasValidSubHits = !!(
          postHit &&
          postHit.subscriptionHitsLeft > 0 &&
          postHit.subscriptionHitsExpiresAt &&
          postHit.subscriptionHitsExpiresAt > now
        );
        const hasPurchasedHits = !!(postHit && postHit.purchasedHitsLeft > 0);
        const hasLegacyHits = !!(
          postHit &&
          postHit.hitLeft > 0 &&
          !postHit.subscriptionHitsLeft &&
          !postHit.purchasedHitsLeft
        );

        if (!postHit || (!hasValidSubHits && !hasPurchasedHits && !hasLegacyHits)) {
          throw new BadRequestException('No hits left to create a post. Please subscribe or purchase hits.');
        }
      }

      let imageUrls: string[] = images || [];
      let thumbnailUrls: string[] = [];
      const normalizeKey = (key: string) => key.replace(/[^a-z]/gi, '').toLowerCase();

      const collectVideoTextItems = (input: any, bucket: Record<string, any>[]) => {
        if (input === null || input === undefined) return;

        if (Array.isArray(input)) {
          input.forEach((entry) => collectVideoTextItems(entry, bucket));
          return;
        }

        if (typeof input === 'string') {
          try {
            const parsed = JSON.parse(input);
            collectVideoTextItems(parsed, bucket);
          } catch {
            // Ignore non-JSON string values.
          }
          return;
        }

        if (typeof input !== 'object') return;

        if (typeof (input as any).text !== 'undefined') {
          bucket.push(input as Record<string, any>);
          return;
        }

        // Handle objects where keys are encoded like videoTextItems[0][text]
        const objectEntries = Object.entries(input as Record<string, any>);
        const directCandidate: Record<string, any> = {};
        for (const [rawKey, rawValue] of objectEntries) {
          const key = normalizeKey(rawKey);
          if (key.includes('text')) directCandidate.text = rawValue;
          if (key.includes('xpercent')) directCandidate.xPercent = rawValue;
          if (key.includes('ypercent')) directCandidate.yPercent = rawValue;
          if (key.includes('fontsize')) directCandidate.fontSize = rawValue;
          if (key.includes('color')) directCandidate.color = rawValue;
        }
        if (typeof directCandidate.text !== 'undefined') {
          bucket.push(directCandidate);
          return;
        }

        const values = Object.values(input as Record<string, any>);
        values.forEach((value) => collectVideoTextItems(value, bucket));

        // Some serializers place JSON payload in object keys.
        Object.keys(input as Record<string, any>).forEach((key) => {
          const trimmed = key.trim();
          if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
              const parsed = JSON.parse(trimmed);
              collectVideoTextItems(parsed, bucket);
            } catch {
              // Ignore malformed key payloads.
            }
          }
        });
      };

      const extractedVideoTextItems: Record<string, any>[] = [];
      collectVideoTextItems(videoTextItems, extractedVideoTextItems);

      if (extractedVideoTextItems.length === 0 && rawBody && typeof rawBody === 'object') {
        const directRawVideoTextItems = (rawBody as any).videoTextItems;
        if (typeof directRawVideoTextItems === 'string' && directRawVideoTextItems.trim() !== '') {
          try {
            const parsed = JSON.parse(directRawVideoTextItems);
            if (Array.isArray(parsed)) {
              parsed.forEach((entry) => {
                if (entry && typeof entry === 'object') extractedVideoTextItems.push(entry as Record<string, any>);
              });
            } else if (parsed && typeof parsed === 'object') {
              extractedVideoTextItems.push(parsed as Record<string, any>);
            }
          } catch {
            // Keep fallback chain going.
          }
        }

        const groupedByIndex: Record<string, Record<string, any>> = {};
        const bracketPattern = /^videoTextItems\[(\d+)\]\[(\w+)\]$/;

        for (const [key, value] of Object.entries(rawBody)) {
          const match = key.match(bracketPattern);
          if (!match) continue;
          const [, index, prop] = match;
          groupedByIndex[index] = groupedByIndex[index] || {};
          groupedByIndex[index][prop] = value;
        }

        Object.keys(groupedByIndex)
          .sort((a, b) => Number(a) - Number(b))
          .forEach((index) => {
            extractedVideoTextItems.push(groupedByIndex[index]);
          });
      }

      const normalizedVideoTextItems = extractedVideoTextItems
        .map((item) => ({
          text: String(item.text || '').trim(),
          xPercent: Number(item.xPercent),
          yPercent: Number(item.yPercent),
          fontSize: Number(item.fontSize),
          color: String(item.color || 'white').trim() || 'white',
        }))
        .filter((item) => item.text.length > 0);
      const shouldApplyVideoText = videoText === true;
      const normalizedFormat = format?.trim().toLowerCase();
      const postFormat: PostFormat | undefined =
        normalizedFormat === 'image' || normalizedFormat === 'video' || normalizedFormat === 'reel' || normalizedFormat === 'ebook'
          ? (normalizedFormat as PostFormat)
          : undefined;

      const tableContent = (tableContents || [])
        .map((item) => String(item).trim())
        .filter(Boolean);

      const resolvedAllowDownload = allowDownload === undefined || allowDownload === null ? true : Boolean(allowDownload);
      const resolvedAmount = amount === undefined || amount === null ? null : Number(amount);
      if (resolvedAmount !== null && (Number.isNaN(resolvedAmount) || resolvedAmount < 0)) {
        throw new BadRequestException('Invalid amount');
      }
      const resolvedPromoCode = promoCode ? String(promoCode).trim() : null;

      let ebookpdfUrl: string | null = null;
      if (postFormat === 'ebook') {
        if (!ebookpdfFile) {
          throw new BadRequestException('ebookpdf file is required when format=ebook');
        }
        const isPdfByMime = ebookpdfFile.mimetype === 'application/pdf';
        const isPdfByName = ebookpdfFile.originalname?.toLowerCase().endsWith('.pdf');
        if (!isPdfByMime && !isPdfByName) {
          throw new BadRequestException('Only PDF files are allowed for ebookpdf');
        }
        ebookpdfUrl = await uploadFileToS3(ebookpdfFile, 'post-ebooks');
      } else if (ebookpdfFile) {
        throw new BadRequestException('ebookpdf is only allowed when format=ebook');
      }

      let mediaFiles = files;
      if (shouldApplyVideoText) {
        if (!mediaFiles || mediaFiles.length === 0) {
          throw new BadRequestException('Video file is required when videoText=true');
        }

        if (normalizedVideoTextItems.length === 0) {
          // console.log('videoTextItems normalization failed', {
          //   rawType: typeof videoTextItems,
          //   isArray: Array.isArray(videoTextItems),
          //   rawValue: videoTextItems,
          //   rawBody,
          //   extractedCount: extractedVideoTextItems.length,
          //   extractedPreview: extractedVideoTextItems.slice(0, 2),
          // });
          throw new BadRequestException('videoTextItems is required when videoText=true');
        }

        const hasVideoFile = mediaFiles.some((file) => file.mimetype?.startsWith('video/'));
        if (!hasVideoFile) {
          throw new BadRequestException('At least one video file is required when videoText=true');
        }

        mediaFiles = await Promise.all(
          mediaFiles.map(async (file) => {
            if (!file.mimetype?.startsWith('video/')) return file;
            return applyVideoTextOverlays(file, normalizedVideoTextItems);
          }),
        );
      }

      // Upload files to S3 and collect URLs
      if (mediaFiles && mediaFiles.length > 0) {
        try {
          const uploadedResults = await Promise.all(
            mediaFiles.map(async (file) => {
              const mediaUrl = await uploadImageToS3(file, 'post-images');
              let thumbnailUrl: string;

              try {
                const thumbnailFile = await generateThumbnailForMedia(file);
                thumbnailUrl = await uploadBufferToS3(
                  thumbnailFile.buffer,
                  thumbnailFile.originalname,
                  thumbnailFile.mimetype,
                  'post-thumbnails',
                );
              } catch (thumbnailError) {
                if (file.mimetype?.startsWith('video/')) {
                  // Fallback: keep post creation successful even if ffmpeg is unavailable.
                  // Frontend can still use video URL when dedicated thumbnail is missing.
                  console.warn('Video thumbnail generation failed, using media URL as fallback:', thumbnailError);
                  thumbnailUrl = mediaUrl;
                } else {
                  throw thumbnailError;
                }
              }

              return { mediaUrl, thumbnailUrl };
            }),
          );
          imageUrls = imageUrls.concat(uploadedResults.map((result) => result.mediaUrl));
          thumbnailUrls = thumbnailUrls.concat(uploadedResults.map((result) => result.thumbnailUrl));
        } catch (uploadError) {
          console.error('Media upload/thumbnail generation error:', uploadError);
          throw new BadRequestException('Failed to upload media or generate thumbnails');
        }
      }

      // Process input data
      const processedData = {
        text: text?.trim() || null,
        caption: caption?.trim() || null,
        location: location?.trim() || null,
        music: music?.trim() || null,
        youtubeMusicMeta: youtubeMusicMeta ?? null,
        link: link?.trim() || null,
        format: postFormat,
        ebookpdf: ebookpdfUrl,
        tableContent,
        allowDownload: resolvedAllowDownload,
        amount: resolvedAmount,
        promoCode: resolvedPromoCode,
        visibleTo: visibleTo?.trim() || null,
        hashtag: this.buildNormalizedPostHashtags(hashtag, text, caption),
        taggedPeople: taggedPeople?.filter(Boolean) || [],
        raiseAmount: raiseAmount ? Number(raiseAmount) : null,
        start_time: start_time ? new Date(start_time) : null,
        end_time: end_time ? new Date(end_time) : null
      };

      // Validate processed data
      if (processedData.raiseAmount && isNaN(processedData.raiseAmount)) {
        throw new BadRequestException('Invalid raiseAmount');
      }
      if (processedData.start_time && isNaN(processedData.start_time.getTime())) {
        throw new BadRequestException('Invalid start_time');
      }
      if (processedData.end_time && isNaN(processedData.end_time.getTime())) {
        throw new BadRequestException('Invalid end_time');
      }

      let privateCircleId: string | null = null;
      if (this.isPrivateCircleVisibility(processedData.visibleTo)) {
        const privateCircle = await this.prisma.privateCircle.findUnique({
          where: { ownerId: userId },
          select: { id: true, isActive: true },
        });

        if (!privateCircle || !privateCircle.isActive) {
          throw new BadRequestException('Set up your private circle before creating a private circle post');
        }

        privateCircleId = privateCircle.id;
        processedData.visibleTo = 'PRIVATE_CIRCLE';
      }

      let remainingHitsAfterCreate: number | null = null;

      // Run AI Content Moderation
      const moderation = await this.moderationService.evaluatePost({
        text: processedData.text,
        caption: processedData.caption,
        hashtag: processedData.hashtag,
        images: imageUrls,
        type,
        format: postFormat,
      });

      const createdPost = await this.prisma.$transaction(async (tx) => {
        // For crowdfunding, decrement hit with priority: subscription hits first, then purchased hits
        if (type === 'crowdfunding' || type === 'support') {
          const postHit = await tx.postHit.findFirst({ where: { userId } });
          if (!postHit) throw new BadRequestException('PostHit record not found');

          const now = new Date();
          const hasValidSubHits =
            postHit.subscriptionHitsLeft > 0 &&
            postHit.subscriptionHitsExpiresAt &&
            postHit.subscriptionHitsExpiresAt > now;

          let updatedPostHit;
          if (hasValidSubHits) {
            const newSubHits = postHit.subscriptionHitsLeft - 1;
            const newPurchasedHits = postHit.purchasedHitsLeft || 0;
            updatedPostHit = await tx.postHit.update({
              where: { id: postHit.id },
              data: {
                subscriptionHitsLeft: { decrement: 1 },
                hitLeft: newSubHits + newPurchasedHits,
              },
            });
          } else if (postHit.purchasedHitsLeft > 0) {
            const isSubActive =
              postHit.subscriptionHitsExpiresAt &&
              postHit.subscriptionHitsExpiresAt > now;
            const activeSubHits = isSubActive ? postHit.subscriptionHitsLeft : 0;
            const newPurchasedHits = postHit.purchasedHitsLeft - 1;
            updatedPostHit = await tx.postHit.update({
              where: { id: postHit.id },
              data: {
                purchasedHitsLeft: { decrement: 1 },
                hitLeft: activeSubHits + newPurchasedHits,
              },
            });
          } else if (postHit.hitLeft > 0) {
            // Legacy fallback
            updatedPostHit = await tx.postHit.update({
              where: { id: postHit.id },
              data: { hitLeft: { decrement: 1 } },
            });
          } else {
            throw new BadRequestException('No hits left to create a post. Please subscribe or purchase hits.');
          }

          remainingHitsAfterCreate = updatedPostHit.hitLeft;
        }

        // Create the post with moderation status
        const post = await tx.post.create({
          data: {
            userId,
            ...processedData,
            images: imageUrls,
            thumbnails: thumbnailUrls,
            type,
            privateCircleId,
            isTrustPost: resolvedIsTrustPost,
            videoText: shouldApplyVideoText,
            videoTextItems: shouldApplyVideoText ? (normalizedVideoTextItems as any) : null,
            moderationStatus: moderation.status,
            moderationReason: moderation.reason,
            moderationScore: moderation.score,
            moderatedBy: moderation.moderatedBy,
            moderatedAt: new Date(),
          } as any,
        });

        await this.syncPostHashtags(tx, post.id, processedData.hashtag);

        if ((moderation.status as any) === 'PENDING_APPROVAL') {
          await (tx as any).moderationAuditLog.create({
            data: {
              contentType: 'POST',
              contentId: post.id,
              authorId: userId,
              aiVerdict: 'PENDING_APPROVAL',
              aiReason: moderation.reason,
              aiConfidence: moderation.score,
              flaggedLabels: moderation.flaggedLabels || [],
            },
          });
        }

        return post;
      }, {
        timeout: 15000 // Increased timeout
      });

      if (remainingHitsAfterCreate === 1) {
        try {
          await this.notificationService.sendPostCreditLowAlert(userId, remainingHitsAfterCreate);
        } catch (notificationError) {
          console.error('Failed to send post credit low notification:', notificationError);
        }
      }

      if (isMissionPost && createdPost.moderationStatus === 'APPROVED') {
        try {
          await this.notificationService.sendMissionPostLaunchedToFollowers(createdPost.id);
        } catch (notificationError) {
          console.error('Failed to send mission post launch notification:', notificationError);
        }
      }

      if (this.isPrivateCircleVisibility(createdPost.visibleTo) && createdPost.privateCircleId && createdPost.moderationStatus === 'APPROVED') {
        try {
          await this.notificationService.sendPrivateCircleExclusivePostPublished(createdPost.id);
        } catch (notificationError) {
          console.error('Failed to send private circle exclusive post notification:', notificationError);
        }
      }

      const taggedIds = Array.from(
        new Set((processedData.taggedPeople || []).map((id) => String(id).trim()).filter(Boolean)),
      ).filter((id) => id !== userId);

      if (taggedIds.length > 0) {
        const [author, taggedUsers] = await Promise.all([
          this.prisma.user.findUnique({
            where: { id: userId },
            select: { displayName: true, userName: true },
          }),
          this.prisma.user.findMany({
            where: { id: { in: taggedIds } },
            select: { id: true },
          }),
        ]);

        const authorName = author?.displayName || author?.userName || 'Someone';
        const validTaggedUserIds = taggedUsers.map((u) => u.id);
        const isPrivateCirclePost =
          (createdPost.type || '').trim().toLowerCase() === 'private' &&
          this.isPrivateCircleVisibility(createdPost.visibleTo);
        const tagNotificationTitle = isPrivateCirclePost ? 'Tagged in a private circle post' : 'Tagged in a post';
        const tagNotificationBody = isPrivateCirclePost
          ? `${authorName} tagged you in a private circle post.`
          : `${authorName} tagged you in a post.`;

        await Promise.all(
          validTaggedUserIds.map((taggedUserId) =>
            this.notificationService.sendNotificationToUser(
              taggedUserId,
              tagNotificationTitle,
              tagNotificationBody,
              {
                type: 'post_tag',
                postId: createdPost.id,
                taggerId: userId,
                post_type: createdPost.type || '',
                visibleTo: createdPost.visibleTo || '',
                isTrustPost: Boolean(
                  createdPost.isTrustPost ||
                  ['mission-post', 'crowdfunding', 'support'].includes(createdPost.type || ''),
                ),
              },
            ),
          ),
        );
      }

      return {
        ...createdPost,
        private_circle: this.isPrivateCircleVisibility(createdPost.visibleTo),
        videoText: shouldApplyVideoText,
        videoTextItems: shouldApplyVideoText ? normalizedVideoTextItems : [],
      };

    } catch (error) {
      console.error('Create post error:', error);
      // console.log('Error message:', error.message);
      // console.log('Error stack:', error.stack);
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(error.message || 'Failed to create post');
    }
  }

  async savePost(postId: string, userId: string) {
    if (!postId) throw new BadRequestException('Post ID required');
    if (!userId) throw new BadRequestException('User ID required');

    const post = await this.prisma.post.findUnique({ where: { id: postId, deletedAt: null } });
    if (!post) throw new BadRequestException('Post not found');

    // Upsert-like behavior: if already saved, do nothing; else create
    try {
      await this.prisma.savePost.create({ data: { postId, userId } });
    } catch (error) {
      // If unique constraint violation, treat as already saved
      const isUniqueViolation = (error as Prisma.PrismaClientKnownRequestError)?.code === 'P2002';
      if (!isUniqueViolation) throw error;
    }
    return { message: 'Post saved successfully' };
  }

  async unsavePost(postId: string, userId: string) {
    if (!postId) throw new BadRequestException('Post ID required');
    if (!userId) throw new BadRequestException('User ID required');

    // Delete if exists; if not, return idempotent success
    await this.prisma.savePost.delete({
      where: { postId_userId: { postId, userId } },
    }).catch(() => undefined);

    return { message: 'Post unsaved successfully' };
  }

  async pinPost(postId: string, userId: string) {
    if (!postId) throw new BadRequestException('Post ID required');
    if (!userId) throw new BadRequestException('User ID required');

    const post = await this.prisma.post.findUnique({ where: { id: postId, deletedAt: null } });
    if (!post) throw new BadRequestException('Post not found');
    await this.ensureCanViewPost(post, userId);

    const now = new Date();
    const MAX_PINNED_POSTS = 3;

    await this.prisma.$transaction(async (tx) => {
      // If already pinned, just bump pinnedAt so it appears first.
      const existingPin = await tx.pinnedPost.findUnique({
        where: { postId_userId: { postId, userId } },
        select: { id: true },
      });

      if (existingPin) {
        await tx.pinnedPost.update({
          where: { postId_userId: { postId, userId } },
          data: { pinnedAt: now },
        });
        return;
      }

      // Enforce max pins: if pinning a 4th, remove the oldest pin first.
      const pinnedCount = await tx.pinnedPost.count({ where: { userId } });
      if (pinnedCount >= MAX_PINNED_POSTS) {
        const oldestPin = await tx.pinnedPost.findFirst({
          where: { userId },
          orderBy: { pinnedAt: 'asc' },
          select: { id: true },
        });
        if (oldestPin) {
          await tx.pinnedPost.delete({ where: { id: oldestPin.id } });
        }
      }

      await tx.pinnedPost.create({
        data: { postId, userId, pinnedAt: now },
      });
    });

    return { message: 'Post pinned successfully' };
  }

  async unpinPost(postId: string, userId: string) {
    if (!postId) throw new BadRequestException('Post ID required');
    if (!userId) throw new BadRequestException('User ID required');

    await this.prisma.pinnedPost.delete({
      where: { postId_userId: { postId, userId } },
    }).catch(() => undefined);

    return { message: 'Post unpinned successfully' };
  }

  async getPostByUserId(userId: string, viewerUserId?: string, page: number = 1, limit: number = 20, type: 'normal' | 'private' | 'private_circle' = 'normal') {
    if (!userId) throw new BadRequestException('User ID required');
    const take = Math.min(Math.max(1, limit), 50);
    const skip = (Math.max(1, page) - 1) * take;
    const whereClause: any = { userId, deletedAt: null, postHide: 'no', isDelete: 'no' };
    if (type === 'private_circle') {
      if (!viewerUserId) {
        throw new BadRequestException('User not authorized to view private circle posts');
      }

      const isOwner = viewerUserId === userId;
      if (!isOwner) {
        const membership = await this.prisma.privateCircleMember.findFirst({
          where: {
            userId: viewerUserId,
            status: 'ACTIVE',
            privateCircle: {
              is: {
                ownerId: userId,
              },
            },
          },
          select: { id: true },
        });

        if (!membership) {
          throw new BadRequestException('You are not a member of this private circle');
        }
      }

      whereClause.type = 'private';
      whereClause.visibleTo = { in: this.privateCircleVisibilityValues };
      whereClause.AND = [
        {
          OR: [
            { userId: viewerUserId },
            {
              privateCircle: {
                members: {
                  some: {
                    userId: viewerUserId,
                    status: 'ACTIVE',
                  },
                },
              },
            },
          ],
        },
      ];
    } else if (type === 'private') {
      whereClause.type = 'private';
      whereClause.OR = [
        { visibleTo: null },
        { visibleTo: '' },
        { visibleTo: { notIn: this.privateCircleVisibilityValues } },
      ];
      whereClause.AND = [this.buildPostVisibilityWhere(viewerUserId)];
    } else {
      whereClause.type = { not: 'private' };
      whereClause.AND = [this.buildPostVisibilityWhere(viewerUserId)];
    }

    const postInclude = {
      user: {
        select: {
          displayName: true,
          image: true,
          profileStatus: true,
          profile: true,
          tokenBalance: true,
        },
      },
      _count: {
        select: {
          likes: true,      // from Post model
          comments: true,   // from Post model
          shares: true,
        },
      },
    } as const;

    // Pinned posts first (newer pins appear at the top), then other posts.
    // To keep old pagination behavior, only prepend pinned posts on page 1.
    const pinnedIdSet = new Set<string>();
    let pinnedPosts: any[] = [];

    if (page === 1) {
      const pinned = await this.prisma.pinnedPost.findMany({
        where: { userId, post: whereClause },
        orderBy: { pinnedAt: 'desc' },
        select: { postId: true, post: { include: postInclude } },
      });

      pinnedPosts = pinned.map((p) => p.post).filter(Boolean);
      pinnedPosts.forEach((p: any) => pinnedIdSet.add(p.id));
    }

    const otherPosts = await this.prisma.post.findMany({
      where: {
        ...whereClause,
        ...(pinnedIdSet.size ? { id: { notIn: Array.from(pinnedIdSet) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take,
      skip,
      include: postInclude,
    });

    const posts = [...pinnedPosts, ...otherPosts];
    // Fetch saved flags for the viewer
    let savedSet: Set<string> = new Set();
    let likedSet: Set<string> = new Set();

    if (viewerUserId) {
      const saved = await this.prisma.savePost.findMany({
        where: { userId: viewerUserId, postId: { in: posts.map(p => p.id) } },
        select: { postId: true },
      });
      savedSet = new Set(saved.map(s => s.postId));
    }

    if (viewerUserId) {
      // Fetch saved posts for viewer
      const saved = await this.prisma.savePost.findMany({
        where: { userId: viewerUserId, postId: { in: posts.map(p => p.id) } },
        select: { postId: true },
      });
      savedSet = new Set(saved.map(s => s.postId));

      // Fetch liked posts for viewer
      const liked = await this.prisma.postLike.findMany({
        where: { userId: viewerUserId, postId: { in: posts.map(p => p.id) } },
        select: { postId: true },
      });
      likedSet = new Set(liked.map(l => l.postId));
    }

    // Build follow map for viewer vs authors
    let followMap: Record<string, boolean> = {};
    if (viewerUserId) {
      const authorIds = Array.from(new Set(posts.map(p => p.userId)));
      if (authorIds.length > 0) {
        const follows = await this.prisma.followerAndFollowing.findMany({
          where: { followerId: viewerUserId, followingId: { in: authorIds }, status: 'ACCEPTED' },
          select: { followingId: true },
        });
        followMap = follows.reduce((acc, f) => { acc[f.followingId] = true; return acc; }, {} as Record<string, boolean>);
      }
    }

    return posts.map(post => ({
      id: post.id,
      text: post.text,
      images: post.images,
      isTrustPost: post.isTrustPost,
      thumbnails: post.thumbnails,
      caption: post.caption,
      hashtag: post.hashtag,
      location: post.location,
      music: post.music,
      youtubeMusicMeta: post.youtubeMusicMeta,
      taggedPeople: post.taggedPeople,
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
      deletedAt: post.deletedAt,
      userId: post.userId,
      userName: post.user?.displayName || null,
      userImage: post.user?.image || null,
      tokenBalance: post.user?.tokenBalance || 0,
      profileStatus: post.user?.profileStatus || null,
      profile: post.user?.profile || null,
      likeCount: post._count.likes,
      commentCount: post._count.comments,
      isSaved: savedSet.has(post.id),
      isLike: likedSet.has(post.id), // ✅ true if viewer liked
      shareCount: post._count.shares,
      isFollow: !!followMap[post.userId],
      pinned: pinnedIdSet.has(post.id),
      type: post.type,
      link: post.link,
      visibleTo: (post as any).visibleTo,
      private_circle: this.isPrivateCircleVisibility((post as any).visibleTo),
      start_time: post.start_time,
      end_time: post.end_time,
      raiseAmount: post.raiseAmount,
      format: post.format,
      ebookpdf: post.ebookpdf,
      tableContent: post.tableContent,
      allowDownload: post.allowDownload,
    }));
  }

  async getMissionpost(userId: string, status: 'active' | 'completed' | 'all' = 'all') {
    if (!userId) throw new BadRequestException('User ID required');

    const now = new Date();
    const whereClause: Prisma.PostWhereInput = {
      userId,
      deletedAt: null,
      // isDelete: 'no' as any,
      type: { in: ['mission-post', 'crowdfunding', 'support'] },
    };

    // "active" means mission window not ended yet (end_time > now).
    // "completed" means ended (end_time <= now).
    if (status === 'active') {
      whereClause.end_time = { gt: now };
    } else if (status === 'completed') {
      whereClause.end_time = { lte: now };
    }

    const posts = await this.prisma.post.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: {
            displayName: true,
            image: true,
            profileStatus: true,
            profile: true,
            tokenBalance: true,
          },
        },
        _count: {
          select: {
            likes: true,
            comments: true,
            shares: true,
          },
        },
      },
    });

    const postIds = posts.map((p) => p.id);
    const [saved, liked, donations, donationUniqueUsers] = await Promise.all([
      postIds.length
        ? this.prisma.savePost.findMany({
          where: { userId, postId: { in: postIds } },
          select: { postId: true },
        })
        : Promise.resolve([] as Array<{ postId: string }>),
      postIds.length
        ? this.prisma.postLike.findMany({
          where: { userId, postId: { in: postIds } },
          select: { postId: true },
        })
        : Promise.resolve([] as Array<{ postId: string }>),
      postIds.length
        ? this.prisma.donationData.findMany({
          where: {
            postId: { in: postIds },
            action: { in: ['missionDonation', 'donate'] },
            status: 'completed',
          },
          select: {
            postId: true,
            amount: true,
            totalAmount: true,
            platformFees: true,
          },
        })
        : Promise.resolve([] as Array<{ postId: string | null; amount: number; totalAmount: number | null; platformFees: number | null }>),
      postIds.length
        ? this.prisma.donationData.groupBy({
          by: ['postId', 'userId'],
          where: {
            postId: { in: postIds },
            action: { in: ['missionDonation', 'donate'] },
            status: 'completed',
          },
        })
        : Promise.resolve([] as Array<{ postId: string | null; userId: string }>),
    ]);

    const savedSet = new Set(saved.map((s) => s.postId));
    const likedSet = new Set(liked.map((l) => l.postId));
    const earningByPostId = new Map<string, { total: number; platformFees: number; userEarning: number }>();
    for (const donation of donations) {
      if (!donation.postId) continue;
      const existing = earningByPostId.get(donation.postId) ?? { total: 0, platformFees: 0, userEarning: 0 };
      existing.total += Number(donation.totalAmount ?? donation.amount ?? 0);
      existing.platformFees += Number(donation.platformFees ?? 0);
      existing.userEarning += Number(donation.amount ?? 0);
      earningByPostId.set(donation.postId, existing);
    }
    const requestUsersByPostId = new Map<string, number>();
    for (const row of donationUniqueUsers) {
      if (!row.postId) continue;
      requestUsersByPostId.set(row.postId, (requestUsersByPostId.get(row.postId) ?? 0) + 1);
    }

    return posts.map((post) => ({
      id: post.id,
      text: post.text,
      images: post.images,
      thumbnails: post.thumbnails,
      caption: post.caption,
      hashtag: post.hashtag,
      location: post.location,
      music: post.music,
      youtubeMusicMeta: post.youtubeMusicMeta,
      taggedPeople: post.taggedPeople,
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
      deletedAt: post.deletedAt,
      userId: post.userId,
      userName: post.user?.displayName || null,
      userImage: post.user?.image || null,
      tokenBalance: post.user?.tokenBalance || 0,
      profileStatus: post.user?.profileStatus || null,
      profile: post.user?.profile || null,
      likeCount: post._count.likes,
      commentCount: post._count.comments,
      shareCount: post._count.shares,
      isSaved: savedSet.has(post.id),
      isLike: likedSet.has(post.id),
      isFollow: false,
      type: post.type,
      link: post.link,
      visibleTo: (post as any).visibleTo,
      private_circle: this.isPrivateCircleVisibility((post as any).visibleTo),
      start_time: post.start_time,
      end_time: post.end_time,
      raiseAmount: post.raiseAmount,
      isTrustPost: (post as any).isTrustPost ?? true,
      earning: (() => {
        const earning = earningByPostId.get(post.id);
        const total = earning?.total ?? 0;
        const platformFees = earning?.platformFees ?? 0;
        const userEarning = earning?.userEarning ?? 0;
        const requestusers = requestUsersByPostId.get(post.id) ?? 0;
        return {
          total,
          platformFees,
          userEarning,
          requestusers,
        };
      })(),
    }));
  }

  async getPostById(postId: string, viewerId: string) {
    if (!postId) throw new BadRequestException('Post ID required');

    // ✅ Find single post
    const post = await this.prisma.post.findUnique({
      where: {
        id: postId,
        deletedAt: null,
      },
      include: {
        user: {
          select: {
            displayName: true,
            image: true,
            profile: true,
            profileStatus: true,
            tokenBalance: true,
          },
        },
        _count: {
          select: {
            likes: true,
            comments: true,
            shares: true,
          },
        },
      },
    });

    if (!post) {
      throw new BadRequestException('Post not found');
    }

    await this.ensureCanViewPost(post, viewerId);

    // ✅ Fetch saved state for this viewer
    const saved = await this.prisma.savePost.findFirst({
      where: { userId: viewerId, postId },
    });

    // ✅ Fetch like state for this viewer
    const liked = await this.prisma.postLike.findFirst({
      where: { userId: viewerId, postId },
    });

    // ✅ Fetch hide state for this viewer
    const hidden = viewerId
      ? await this.prisma.hidePost.findFirst({ where: { userId: viewerId, postId } })
      : null;

    const purchased = viewerId
      ? await (this.prisma as any).ebookPayments.findFirst({
        where: {
          buyerId: viewerId,
          postId,
          status: { in: ['SUCCEEDED', 'succeeded'] },
        },
        select: { id: true },
      })
      : null;

    // ✅ Follow status (does viewer follow the post's author?)
    let isFollow = false;
    if (viewerId) {
      const follow = await this.prisma.followerAndFollowing.findFirst({
        where: { followerId: viewerId, followingId: post.userId, status: 'ACCEPTED' },
        select: { id: true },
      });
      isFollow = !!follow;
    }

    // ✅ Return single structured response
    return {
      id: post.id,
      text: post.text,
      images: post.images,
      thumbnails: post.thumbnails,
      caption: post.caption,
      hashtag: post.hashtag,
      location: post.location,
      music: post.music,
      youtubeMusicMeta: post.youtubeMusicMeta,
      taggedPeople: post.taggedPeople,
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
      deletedAt: post.deletedAt,
      userId: post.userId,
      userName: post.user?.displayName || null,
      userImage: post.user?.image || null,
      tokenBalance: post.user?.tokenBalance || 0,
      profile: post.user?.profile || null,
      profileStatus: post.user?.profileStatus || null,
      likeCount: post._count.likes,
      commentCount: post._count.comments,
      shareCount: post._count.shares,
      isSaved: !!saved,   // ✅ true if viewer saved
      isLike: !!liked,    // ✅ true if viewer liked
      isFollow,
      isHide: !!hidden,
      type: post.type,
      link: post.link,
      visibleTo: (post as any).visibleTo,
      private_circle: this.isPrivateCircleVisibility((post as any).visibleTo),
      start_time: post.start_time,
      end_time: post.end_time,
      raiseAmount: post.raiseAmount,
      isPurchased: !!purchased,
    };
  }


  async getAllPost(viewerUserId?: string, page: number = 1, limit: number = 20) {
    const take = Math.min(Math.max(1, limit), 50);
    const skip = (Math.max(1, page) - 1) * take;

    const postWhere: Prisma.PostWhereInput = {
      deletedAt: null,
      isDelete: 'no',
      postHide: 'no',
      type: { not: 'private' },
      AND: [this.buildPostVisibilityWhere(viewerUserId)],
    };
    const postInclude = {
      user: {
        select: {
          displayName: true,
          image: true,
          profile: true,
          profileStatus: true,
          tokenBalance: true,
        },
      },
      _count: {
        select: {
          likes: true,      // from Post model
          comments: true,   // from Post model
          shares: true,
        },
      },
    } as const;

    // Pinned posts first (newer pins appear at the top), then other posts.
    const pinnedIdSet = new Set<string>();
    let pinnedPosts: any[] = [];

    if (viewerUserId) {
      const pinned = await this.prisma.pinnedPost.findMany({
        where: { userId: viewerUserId, post: postWhere },
        orderBy: { pinnedAt: 'desc' },
        select: { postId: true, post: { include: postInclude } },
      });

      pinnedPosts = pinned.map((p) => p.post).filter(Boolean);
      pinnedPosts.forEach((p: any) => pinnedIdSet.add(p.id));
    }

    const otherPosts = await this.prisma.post.findMany({
      where: {
        ...postWhere,
        ...(pinnedIdSet.size ? { id: { notIn: Array.from(pinnedIdSet) } } : {}),
      },
      take,
      skip,
      orderBy: { createdAt: 'desc' },
      include: postInclude,
    });

    // Keep existing mixed ordering for non-pinned posts, but never shuffle pinned posts.
    otherPosts.sort(() => Math.random() - 0.5);
    const posts = [...pinnedPosts, ...otherPosts];

    let savedSet: Set<string> = new Set();
    let likedSet: Set<string> = new Set();
    let followMap: Record<string, boolean> = {};
    let hiddenSet: Set<string> = new Set();

    if (viewerUserId) {
      // Fetch saved posts for viewer
      const saved = await this.prisma.savePost.findMany({
        where: { userId: viewerUserId, postId: { in: posts.map(p => p.id) } },
        select: { postId: true },
      });
      savedSet = new Set(saved.map(s => s.postId));

      // Fetch liked posts for viewer
      const liked = await this.prisma.postLike.findMany({
        where: { userId: viewerUserId, postId: { in: posts.map(p => p.id) } },
        select: { postId: true },
      });
      likedSet = new Set(liked.map(l => l.postId));

      // ✅ Fetch follow status for each post's author
      const authorIds = Array.from(new Set(posts.map(p => p.userId)));
      if (authorIds.length > 0) {
        const follows = await this.prisma.followerAndFollowing.findMany({
          where: { followerId: viewerUserId, followingId: { in: authorIds }, status: 'ACCEPTED' },
          select: { followingId: true },
        });
        followMap = follows.reduce((acc, f) => { acc[f.followingId] = true; return acc; }, {} as Record<string, boolean>);
      }

      // ✅ Fetch hidden posts for viewer
      if (posts.length > 0) {
        const hidden = await this.prisma.hidePost.findMany({
          where: { userId: viewerUserId, postId: { in: posts.map(p => p.id) } },
          select: { postId: true },
        });
        hiddenSet = new Set(hidden.map(h => h.postId));
      }
    }

    const taggedPeopleIds = Array.from(
      new Set(
        posts
          .flatMap((post) => post.taggedPeople || [])
          .map((taggedPerson) => String(taggedPerson).trim())
          .filter(Boolean),
      ),
    );
    const taggedUsers = taggedPeopleIds.length
      ? await this.prisma.user.findMany({
        where: { id: { in: taggedPeopleIds } },
        select: { id: true, userName: true, displayName: true },
      })
      : [];
    const taggedUserNameMap = new Map(
      taggedUsers.map((user) => [user.id, user.userName || user.displayName || user.id]),
    );

    // Note: We do not shuffle the combined array so pinned posts stay on top.

    const mappedPosts = posts.map(post => ({
      id: post.id,
      text: post.text,
      images: post.images,
      thumbnails: post.thumbnails,
      caption: post.caption,
      hashtag: post.hashtag,
      location: post.location,
      music: post.music,
      youtubeMusicMeta: post.youtubeMusicMeta,
      taggedPeople: post.taggedPeople.map((taggedPerson: string) => taggedUserNameMap.get(taggedPerson) || taggedPerson),
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
      deletedAt: post.deletedAt,
      isTrustPost: post.isTrustPost,
      userId: post.userId,
      userName: post.user?.displayName || null,
      userImage: post.user?.image || null,
      tokenBalance: post.user?.tokenBalance || 0,
      profile: post.user?.profile || null,
      profileStatus: post.user?.profileStatus || null,
      likeCount: post._count.likes,
      commentCount: post._count.comments,
      shareCount: post._count.shares,
      isSaved: savedSet.has(post.id),
      isLike: likedSet.has(post.id), // ✅ true if viewer liked
      isFollow: !!followMap[post.userId],
      isHide: hiddenSet.has(post.id),
      isPinned: pinnedIdSet.has(post.id),
      type: post.type,
      link: post.link,
      visibleTo: (post as any).visibleTo,
      private_circle: this.isPrivateCircleVisibility((post as any).visibleTo),
      start_time: post.start_time,
      end_time: post.end_time,
      raiseAmount: post.raiseAmount,
    }));

    return mappedPosts;
  }


  async getAllPostSearchPage(viewerUserId?: string, page: number = 1, limit: number = 20) {
    const take = Math.min(Math.max(1, limit), 50);
    const skip = (Math.max(1, page) - 1) * take;
    const currentPage = Math.max(1, page);

    const postWhere: Prisma.PostWhereInput = {
      deletedAt: null,
      isDelete: 'no',
      postHide: 'no',
      type: { not: 'private' },
      AND: [this.buildPostVisibilityWhere(viewerUserId)],
    };
    const postInclude = {
      user: {
        select: {
          displayName: true,
          image: true,
          profile: true,
          profileStatus: true,
          tokenBalance: true,
        },
      },
      _count: {
        select: {
          likes: true,      // from Post model
          comments: true,   // from Post model
          shares: true,
        },
      },
    } as const;

    // Pinned posts first (newer pins appear at the top), then other posts.
    const pinnedIdSet = new Set<string>();
    let pinnedPosts: any[] = [];

    if (viewerUserId) {
      const pinned = await this.prisma.pinnedPost.findMany({
        where: { userId: viewerUserId, post: postWhere },
        orderBy: { pinnedAt: 'desc' },
        select: { postId: true, post: { include: postInclude } },
      });

      pinnedPosts = pinned.map((p) => p.post).filter(Boolean);
      pinnedPosts.forEach((p: any) => pinnedIdSet.add(p.id));
    }

    const otherPosts = await this.prisma.post.findMany({
      where: {
        ...postWhere,
        ...(pinnedIdSet.size ? { id: { notIn: Array.from(pinnedIdSet) } } : {}),
      },
      take,
      skip,
      orderBy: { createdAt: 'desc' },
      include: postInclude,
    });

    // Keep existing mixed ordering for non-pinned posts, but never shuffle pinned posts.
    otherPosts.sort(() => Math.random() - 0.5);
    const posts = [...pinnedPosts, ...otherPosts];

    let savedSet: Set<string> = new Set();
    let likedSet: Set<string> = new Set();
    let followMap: Record<string, boolean> = {};
    let hiddenSet: Set<string> = new Set();

    if (viewerUserId) {
      // Fetch saved posts for viewer
      const saved = await this.prisma.savePost.findMany({
        where: { userId: viewerUserId, postId: { in: posts.map(p => p.id) } },
        select: { postId: true },
      });
      savedSet = new Set(saved.map(s => s.postId));

      // Fetch liked posts for viewer
      const liked = await this.prisma.postLike.findMany({
        where: { userId: viewerUserId, postId: { in: posts.map(p => p.id) } },
        select: { postId: true },
      });
      likedSet = new Set(liked.map(l => l.postId));

      // ✅ Fetch follow status for each post's author
      const authorIds = Array.from(new Set(posts.map(p => p.userId)));
      if (authorIds.length > 0) {
        const follows = await this.prisma.followerAndFollowing.findMany({
          where: { followerId: viewerUserId, followingId: { in: authorIds }, status: 'ACCEPTED' },
          select: { followingId: true },
        });
        followMap = follows.reduce((acc, f) => { acc[f.followingId] = true; return acc; }, {} as Record<string, boolean>);
      }

      // ✅ Fetch hidden posts for viewer
      if (posts.length > 0) {
        const hidden = await this.prisma.hidePost.findMany({
          where: { userId: viewerUserId, postId: { in: posts.map(p => p.id) } },
          select: { postId: true },
        });
        hiddenSet = new Set(hidden.map(h => h.postId));
      }
    }

    const taggedPeopleIds = Array.from(
      new Set(
        posts
          .flatMap((post) => post.taggedPeople || [])
          .map((taggedPerson) => String(taggedPerson).trim())
          .filter(Boolean),
      ),
    );
    const taggedUsers = taggedPeopleIds.length
      ? await this.prisma.user.findMany({
        where: { id: { in: taggedPeopleIds } },
        select: { id: true, userName: true, displayName: true },
      })
      : [];
    const taggedUserNameMap = new Map(
      taggedUsers.map((user) => [user.id, user.userName || user.displayName || user.id]),
    );

    // Note: We do not shuffle the combined array so pinned posts stay on top.

    const mappedPosts = posts.map(post => ({
      id: post.id,
      text: post.text,
      images: post.images,
      thumbnails: post.thumbnails,
      caption: post.caption,
      hashtag: post.hashtag,
      location: post.location,
      music: post.music,
      youtubeMusicMeta: post.youtubeMusicMeta,
      taggedPeople: post.taggedPeople.map((taggedPerson: string) => taggedUserNameMap.get(taggedPerson) || taggedPerson),
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
      deletedAt: post.deletedAt,
      isTrustPost: post.isTrustPost,
      userId: post.userId,
      userName: post.user?.displayName || null,
      userImage: post.user?.image || null,
      tokenBalance: post.user?.tokenBalance || 0,
      profile: post.user?.profile || null,
      profileStatus: post.user?.profileStatus || null,
      likeCount: post._count.likes,
      commentCount: post._count.comments,
      shareCount: post._count.shares,
      isSaved: savedSet.has(post.id),
      isLike: likedSet.has(post.id), // ✅ true if viewer liked
      isFollow: !!followMap[post.userId],
      isHide: hiddenSet.has(post.id),
      isPinned: pinnedIdSet.has(post.id),
      type: post.type,
      link: post.link,
      visibleTo: (post as any).visibleTo,
      private_circle: this.isPrivateCircleVisibility((post as any).visibleTo),
      start_time: post.start_time,
      end_time: post.end_time,
      raiseAmount: post.raiseAmount,
      feedItemType: 'post' as const,
      battleWinnerProduct: null,
    }));

    // Boosted battle winners are bonus items on page 1 only (do not affect post pagination).
    if (currentPage !== 1) {
      return mappedPosts;
    }

    const battleWinnerItems = await this.getSearchPageBoostedProducts(viewerUserId);
    if (!battleWinnerItems.length) {
      return mappedPosts;
    }

    const pinnedMapped = mappedPosts.filter((item) => item.isPinned);
    const otherMapped = mappedPosts.filter((item) => !item.isPinned);
    const pinOnTopWinners = battleWinnerItems.filter(
      (item) => item.battleWinnerProduct.boost.isPinnedOnTop,
    );
    const badgeOnlyWinners = battleWinnerItems.filter(
      (item) => !item.battleWinnerProduct.boost.isPinnedOnTop,
    );

    return [...pinnedMapped, ...pinOnTopWinners, ...badgeOnlyWinners, ...otherMapped];
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

  private isMarketplaceBoostPinActive(
    boost: {
      pinOnTop: boolean;
      pinStartAt: Date | null;
      pinEndAt: Date | null;
      startAt: Date | null;
      endAt: Date | null;
    },
    now: Date,
  ): boolean {
    return Boolean(
      boost.pinOnTop &&
      ((boost.pinStartAt &&
        boost.pinEndAt &&
        boost.pinStartAt <= now &&
        boost.pinEndAt > now) ||
        (!boost.pinStartAt &&
          !!boost.startAt &&
          !!boost.endAt &&
          boost.startAt <= now &&
          boost.endAt > now)),
    );
  }

  private isMarketplaceBoostBadgeActive(
    boost: {
      winnerBadge: boolean;
      badgeStartAt: Date | null;
      badgeEndAt: Date | null;
      startAt: Date | null;
      endAt: Date | null;
    },
    now: Date,
  ): boolean {
    return Boolean(
      boost.winnerBadge &&
      ((boost.badgeStartAt &&
        boost.badgeEndAt &&
        boost.badgeStartAt <= now &&
        boost.badgeEndAt > now) ||
        (!boost.badgeStartAt &&
          !!boost.startAt &&
          !!boost.endAt &&
          boost.startAt <= now &&
          boost.endAt > now)),
    );
  }

  private async getSearchPageBoostedProducts(viewerUserId?: string, now: Date = new Date()) {
    const boosts = await this.prisma.marketplaceBattleBoost.findMany({
      where: {
        status: MarketplaceBattleBoostStatus.ACTIVE,
        endAt: { gt: now },
        OR: [{ pinOnTop: true }, { winnerBadge: true }],
        battle: {
          status: MarketplaceBattleStatus.COMPLETED,
          outcome: MarketplaceBattleOutcome.WINNER,
          winnerParticipantId: { not: null },
          AND: [this.getMarketplaceVisibilityWhere(viewerUserId)],
        },
      },
      orderBy: [{ activatedAt: 'desc' }, { createdAt: 'desc' }],
      take: 50,
      select: {
        id: true,
        battleId: true,
        pinOnTop: true,
        winnerBadge: true,
        startAt: true,
        endAt: true,
        pinStartAt: true,
        pinEndAt: true,
        badgeStartAt: true,
        badgeEndAt: true,
        battle: {
          select: {
            id: true,
            sellerId: true,
            title: true,
            description: true,
            outcome: true,
            completedAt: true,
            totalVotes: true,
            totalComments: true,
            createdAt: true,
            updatedAt: true,
            seller: {
              select: {
                id: true,
                displayName: true,
                userName: true,
                image: true,
                profile: true,
                profileStatus: true,
                tokenBalance: true,
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
            winnerParticipant: {
              select: {
                id: true,
                product: {
                  select: {
                    id: true,
                    name: true,
                    description: true,
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
        },
      },
    });

    const deduped = new Map<string, (typeof boosts)[number]>();
    for (const boost of boosts) {
      if (!deduped.has(boost.battleId)) {
        deduped.set(boost.battleId, boost);
      }
    }

    const eligible = Array.from(deduped.values()).filter((boost) => {
      const product = boost.battle.winnerParticipant?.product;
      if (!product || product.isDeleted || !product.isActive) return false;
      return (
        this.isMarketplaceBoostPinActive(boost, now) ||
        this.isMarketplaceBoostBadgeActive(boost, now)
      );
    });

    if (!eligible.length) return [];

    const battleIds = eligible.map((boost) => boost.battleId);
    const promotions = await this.prisma.marketplaceWinnerPromotion.findMany({
      where: {
        battleId: { in: battleIds },
        status: MarketplaceWinnerPromotionStatus.ACTIVE,
        startAt: { lte: now },
        endAt: { gt: now },
      },
      orderBy: [{ createdAt: 'desc' }],
      select: {
        id: true,
        battleId: true,
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
      },
    });

    const promotionByBattleId = new Map<string, (typeof promotions)[number]>();
    for (const promotion of promotions) {
      if (!promotionByBattleId.has(promotion.battleId)) {
        promotionByBattleId.set(promotion.battleId, promotion);
      }
    }

    let followMap: Record<string, boolean> = {};
    if (viewerUserId) {
      const sellerIds = Array.from(new Set(eligible.map((boost) => boost.battle.sellerId)));
      if (sellerIds.length > 0) {
        const follows = await this.prisma.followerAndFollowing.findMany({
          where: {
            followerId: viewerUserId,
            followingId: { in: sellerIds },
            status: FollowStatus.ACCEPTED,
          },
          select: { followingId: true },
        });
        followMap = follows.reduce((acc, f) => {
          acc[f.followingId] = true;
          return acc;
        }, {} as Record<string, boolean>);
      }
    }

    return eligible.map((boost) => {
      const battle = boost.battle;
      const product = battle.winnerParticipant!.product!;
      const pinActive = this.isMarketplaceBoostPinActive(boost, now);
      const badgeActive = this.isMarketplaceBoostBadgeActive(boost, now);
      const promotion = promotionByBattleId.get(battle.id);
      const images = product.images || [];

      return {
        id: battle.id,
        text: product.description || product.name,
        images,
        thumbnails: images.length ? [images[0]] : [],
        caption: product.name,
        hashtag: [] as string[],
        location: null,
        music: null,
        youtubeMusicMeta: null,
        taggedPeople: [] as string[],
        createdAt: battle.createdAt,
        updatedAt: battle.updatedAt,
        deletedAt: null,
        isTrustPost: false,
        userId: battle.sellerId,
        userName: battle.seller?.displayName || null,
        userImage: battle.seller?.image || null,
        tokenBalance: battle.seller?.tokenBalance || 0,
        profile: battle.seller?.profile || null,
        profileStatus: battle.seller?.profileStatus || null,
        likeCount: 0,
        commentCount: battle.totalComments || 0,
        shareCount: 0,
        isSaved: false,
        isLike: false,
        isFollow: !!followMap[battle.sellerId],
        isHide: false,
        isPinned: pinActive,
        type: 'battle_winner_product',
        link: null,
        visibleTo: null,
        private_circle: false,
        start_time: null,
        end_time: null,
        raiseAmount: null,
        feedItemType: 'boosted_product' as const,
        format: 'boosted' as const,
        battleWinnerProduct: {
          product: {
            id: product.id,
            name: product.name,
            description: product.description,
            images: product.images,
            price: product.price,
            quantity: product.quantity,
            category: product.category,
            brand: product.brand,
            condition: product.condition,
          },
          battle: {
            id: battle.id,
            title: battle.title,
            description: battle.description,
            totalVotes: battle.totalVotes,
            totalComments: battle.totalComments,
            completedAt: battle.completedAt,
            outcome: battle.outcome,
            createdAt: battle.createdAt,
          },
          closet: {
            id: battle.closet.id,
            shopName: battle.closet.shopName,
            shopUsername: battle.closet.shopUsername,
            shopLogo: battle.closet.shopLogo,
          },
          seller: {
            id: battle.seller.id,
            name: battle.seller.displayName || battle.seller.userName || 'Unknown Seller',
            userName: battle.seller.userName,
            profileImage: battle.seller.image,
          },
          boost: {
            boostId: boost.id,
            pinOnTop: boost.pinOnTop,
            winnerBadge: boost.winnerBadge,
            isPinnedOnTop: pinActive,
            hasWinnerBadge: badgeActive,
            boostEndAt: boost.endAt,
            remainingBoostSeconds: Math.max(
              0,
              Math.floor(((boost.endAt as Date).getTime() - now.getTime()) / 1000),
            ),
          },
          winnerPromotion: promotion
            ? {
              id: promotion.id,
              promoType: promotion.promoType,
              message: promotion.message,
              discountPercent: promotion.discountPercent,
              freeShipping: promotion.freeShipping,
              originalPrice: promotion.originalPrice,
              promoPrice: promotion.promoPrice,
              originalShippingFee: promotion.originalShippingFee,
              promoShippingFee: promotion.promoShippingFee,
              startAt: promotion.startAt,
              endAt: promotion.endAt,
            }
            : null,
        },
      };
    });
  }

  async searchAllPost(viewerUserId?: string, search?: string) {
    const trimmedSearch = (search || '').trim();
    if (trimmedSearch.startsWith('#')) {
      return this.getPostsByHashtag(trimmedSearch, viewerUserId, 1, 20);
    }

    if (search && search.trim()) {
      // First, search for users by userName or displayName
      const users = await this.prisma.user.findMany({
        where: {
          OR: [
            { userName: { contains: search.trim(), mode: 'insensitive' } },
            { displayName: { contains: search.trim(), mode: 'insensitive' } },
          ],
          isDeleted: 0,
        },
        select: {
          id: true,
          displayName: true,
          userName: true,
          image: true,
          profile: true,
          profileStatus: true,
          bio: true,
          email: true,
        },
      });

      if (users.length > 0) {
        // If users found, return user details
        return { type: 'users', data: users };
      } else {
        // If no users found, search posts by text field
        const posts = await this.prisma.post.findMany({
          where: {
            text: { contains: search.trim(), mode: 'insensitive' },
            deletedAt: null,
            AND: [this.buildPostVisibilityWhere(viewerUserId)],
          },
          include: {
            user: {
              select: {
                displayName: true,
                image: true,
                profile: true,
                profileStatus: true,
              },
            },
            _count: {
              select: {
                likes: true,
                comments: true,
                shares: true,
              },
            },
          },
        });

        if (!posts || posts.length === 0) {
          return { message: 'No data found' };
        }

        // Shuffle the posts randomly
        const shuffledPosts = posts.sort(() => Math.random() - 0.5);

        // Get additional metadata for posts
        let savedSet: Set<string> = new Set();
        let likedSet: Set<string> = new Set();
        let followMap: Record<string, boolean> = {};
        let hiddenSet: Set<string> = new Set();

        if (viewerUserId) {
          // Fetch saved posts for viewer
          const saved = await this.prisma.savePost.findMany({
            where: { userId: viewerUserId, postId: { in: shuffledPosts.map(p => p.id) } },
            select: { postId: true },
          });
          savedSet = new Set(saved.map(s => s.postId));

          // Fetch liked posts for viewer
          const liked = await this.prisma.postLike.findMany({
            where: { userId: viewerUserId, postId: { in: shuffledPosts.map(p => p.id) } },
            select: { postId: true },
          });
          likedSet = new Set(liked.map(l => l.postId));

          // Fetch follow status for each post's author
          const authorIds = Array.from(new Set(shuffledPosts.map(p => p.userId)));
          if (authorIds.length > 0) {
            const follows = await this.prisma.followerAndFollowing.findMany({
              where: { followerId: viewerUserId, followingId: { in: authorIds }, status: 'ACCEPTED' },
              select: { followingId: true },
            });
            followMap = follows.reduce((acc, f) => { acc[f.followingId] = true; return acc; }, {} as Record<string, boolean>);
          }

          // Fetch hidden posts for viewer
          if (shuffledPosts.length > 0) {
            const hidden = await this.prisma.hidePost.findMany({
              where: { userId: viewerUserId, postId: { in: shuffledPosts.map(p => p.id) } },
              select: { postId: true },
            });
            hiddenSet = new Set(hidden.map(h => h.postId));
          }
        }

        const formattedPosts = shuffledPosts.map(post => ({
          id: post.id,
          text: post.text,
          images: post.images,
          thumbnails: post.thumbnails,
          caption: post.caption,
          hashtag: post.hashtag,
          location: post.location,
          music: post.music,
          youtubeMusicMeta: post.youtubeMusicMeta,
          taggedPeople: post.taggedPeople,
          createdAt: post.createdAt,
          updatedAt: post.updatedAt,
          deletedAt: post.deletedAt,
          userId: post.userId,
          userName: post.user?.displayName || null,
          userImage: post.user?.image || null,
          profile: post.user?.profile || null,
          profileStatus: post.user?.profileStatus || null,
          likeCount: post._count.likes,
          commentCount: post._count.comments,
          shareCount: post._count.shares,
          isSaved: savedSet.has(post.id),
          isLike: likedSet.has(post.id),
          isFollow: !!followMap[post.userId],
          isHide: hiddenSet.has(post.id),
          type: post.type,
          link: post.link,
          visibleTo: (post as any).visibleTo,
          private_circle: this.isPrivateCircleVisibility((post as any).visibleTo),
          start_time: post.start_time,
          end_time: post.end_time,
          raiseAmount: post.raiseAmount,
        }));

        return { type: 'posts', data: formattedPosts };
      }
    } else {
      // No search query, get all posts
      const posts = await this.prisma.post.findMany({
        where: { deletedAt: null, AND: [this.buildPostVisibilityWhere(viewerUserId)] },
        include: {
          user: {
            select: {
              displayName: true,
              image: true,
              profile: true,
              profileStatus: true,
            },
          },
          _count: {
            select: {
              likes: true,
              comments: true,
              shares: true,
            },
          },
        },
      });

      // Shuffle the posts randomly
      const shuffledPosts = posts.sort(() => Math.random() - 0.5);

      let savedSet: Set<string> = new Set();
      let likedSet: Set<string> = new Set();
      let followMap: Record<string, boolean> = {};
      let hiddenSet: Set<string> = new Set();

      if (viewerUserId) {
        // Fetch saved posts for viewer
        const saved = await this.prisma.savePost.findMany({
          where: { userId: viewerUserId, postId: { in: shuffledPosts.map(p => p.id) } },
          select: { postId: true },
        });
        savedSet = new Set(saved.map(s => s.postId));

        // Fetch liked posts for viewer
        const liked = await this.prisma.postLike.findMany({
          where: { userId: viewerUserId, postId: { in: shuffledPosts.map(p => p.id) } },
          select: { postId: true },
        });
        likedSet = new Set(liked.map(l => l.postId));

        // Fetch follow status for each post's author
        const authorIds = Array.from(new Set(shuffledPosts.map(p => p.userId)));
        if (authorIds.length > 0) {
          const follows = await this.prisma.followerAndFollowing.findMany({
            where: { followerId: viewerUserId, followingId: { in: authorIds }, status: 'ACCEPTED' },
            select: { followingId: true },
          });
          followMap = follows.reduce((acc, f) => { acc[f.followingId] = true; return acc; }, {} as Record<string, boolean>);
        }

        // Fetch hidden posts for viewer
        if (shuffledPosts.length > 0) {
          const hidden = await this.prisma.hidePost.findMany({
            where: { userId: viewerUserId, postId: { in: shuffledPosts.map(p => p.id) } },
            select: { postId: true },
          });
          hiddenSet = new Set(hidden.map(h => h.postId));
        }
      }

      return shuffledPosts.map(post => ({
        id: post.id,
        text: post.text,
        images: post.images,
        thumbnails: post.thumbnails,
        caption: post.caption,
        hashtag: post.hashtag,
        location: post.location,
        music: post.music,
        youtubeMusicMeta: post.youtubeMusicMeta,
        taggedPeople: post.taggedPeople,
        createdAt: post.createdAt,
        updatedAt: post.updatedAt,
        deletedAt: post.deletedAt,
        userId: post.userId,
        userName: post.user?.displayName || null,
        userImage: post.user?.image || null,
        profile: post.user?.profile || null,
        profileStatus: post.user?.profileStatus || null,
        likeCount: post._count.likes,
        commentCount: post._count.comments,
        shareCount: post._count.shares,
        isSaved: savedSet.has(post.id),
        isLike: likedSet.has(post.id),
        isFollow: !!followMap[post.userId],
        isHide: hiddenSet.has(post.id),
        type: post.type,
        link: post.link,
        visibleTo: (post as any).visibleTo,
        private_circle: this.isPrivateCircleVisibility((post as any).visibleTo),
        start_time: post.start_time,
        end_time: post.end_time,
        raiseAmount: post.raiseAmount,
      }));
    }
  }

  async getAllReel(viewerUserId?: string) {
    const posts = await this.prisma.post.findMany({
      where: {
        isDelete: 'no',
        deletedAt: null,
        type: 'reel',
        AND: [this.buildPostVisibilityWhere(viewerUserId)],
      },
      include: {
        user: {
          select: {
            displayName: true,
            image: true,
            profile: true,
            profileStatus: true,
          },
        },
        _count: {
          select: {
            likes: true,
            comments: true,
            shares: true,
          },
        },
      },
    });

    // Shuffle the reel posts randomly
    const shuffledPosts = posts.sort(() => Math.random() - 0.5);

    let savedSet: Set<string> = new Set();
    let likedSet: Set<string> = new Set();
    let followMap: Record<string, boolean> = {};
    let hiddenSet: Set<string> = new Set();

    if (viewerUserId) {
      // Fetch saved posts for viewer
      const saved = await this.prisma.savePost.findMany({
        where: { userId: viewerUserId, postId: { in: shuffledPosts.map(p => p.id) } },
        select: { postId: true },
      });
      savedSet = new Set(saved.map(s => s.postId));

      // Fetch liked posts for viewer
      const liked = await this.prisma.postLike.findMany({
        where: { userId: viewerUserId, postId: { in: shuffledPosts.map(p => p.id) } },
        select: { postId: true },
      });
      likedSet = new Set(liked.map(l => l.postId));

      // Fetch follow status for each post's author
      const authorIds = Array.from(new Set(shuffledPosts.map(p => p.userId)));
      if (authorIds.length > 0) {
        const follows = await this.prisma.followerAndFollowing.findMany({
          where: { followerId: viewerUserId, followingId: { in: authorIds }, status: 'ACCEPTED' },
          select: { followingId: true },
        });
        followMap = follows.reduce((acc, f) => { acc[f.followingId] = true; return acc; }, {} as Record<string, boolean>);
      }

      // Fetch hidden posts for viewer
      if (shuffledPosts.length > 0) {
        const hidden = await this.prisma.hidePost.findMany({
          where: { userId: viewerUserId, postId: { in: shuffledPosts.map(p => p.id) } },
          select: { postId: true },
        });
        hiddenSet = new Set(hidden.map(h => h.postId));
      }
    }

    return shuffledPosts.map(post => ({
      id: post.id,
      text: post.text,
      images: post.images,
      thumbnails: post.thumbnails,
      caption: post.caption,
      hashtag: post.hashtag,
      location: post.location,
      music: post.music,
      youtubeMusicMeta: post.youtubeMusicMeta,
      taggedPeople: post.taggedPeople,
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
      deletedAt: post.deletedAt,
      userId: post.userId,
      userName: post.user?.displayName || null,
      userImage: post.user?.image || null,
      profile: post.user?.profile || null,
      profileStatus: post.user?.profileStatus || null,
      likeCount: post._count.likes,
      commentCount: post._count.comments,
      shareCount: post._count.shares,
      isSaved: savedSet.has(post.id),
      isLike: likedSet.has(post.id),
      isFollow: !!followMap[post.userId],
      isHide: hiddenSet.has(post.id),
      type: post.type,
      visibleTo: (post as any).visibleTo,
      private_circle: this.isPrivateCircleVisibility((post as any).visibleTo),
    }));
  }

  async getMarketPlaceEbook(userId: string, viewerUserId?: string) {
    const posts = await this.prisma.post.findMany({
      where: {
        isDelete: 'no',
        deletedAt: null,
        userId,
        format: 'ebook',
      },
      include: {
        user: {
          select: {
            displayName: true,
            image: true,
            profile: true,
            profileStatus: true,
          },
        },
        _count: {
          select: {
            likes: true,
            comments: true,
            shares: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    let savedSet: Set<string> = new Set();
    let likedSet: Set<string> = new Set();
    let followMap: Record<string, boolean> = {};
    let hiddenSet: Set<string> = new Set();
    let purchasedSet: Set<string> = new Set();

    if (viewerUserId && posts.length > 0) {
      const postIds = posts.map((post) => post.id);

      const [saved, liked, follows, hidden, purchased] = await Promise.all([
        this.prisma.savePost.findMany({
          where: { userId: viewerUserId, postId: { in: postIds } },
          select: { postId: true },
        }),
        this.prisma.postLike.findMany({
          where: { userId: viewerUserId, postId: { in: postIds } },
          select: { postId: true },
        }),
        this.prisma.followerAndFollowing.findMany({
          where: { followerId: viewerUserId, followingId: userId, status: 'ACCEPTED' },
          select: { followingId: true },
        }),
        this.prisma.hidePost.findMany({
          where: { userId: viewerUserId, postId: { in: postIds } },
          select: { postId: true },
        }),
        (this.prisma as any).ebookPayments.findMany({
          where: {
            buyerId: viewerUserId,
            postId: { in: postIds },
            status: { in: ['SUCCEEDED', 'succeeded'] },
          },
          select: { postId: true },
          distinct: ['postId'],
        }),
      ]);

      savedSet = new Set(saved.map((item) => item.postId));
      likedSet = new Set(liked.map((item) => item.postId));
      hiddenSet = new Set(hidden.map((item) => item.postId));
      purchasedSet = new Set(purchased.map((item: { postId: string }) => item.postId));
      followMap = follows.reduce((acc, item) => {
        acc[item.followingId] = true;
        return acc;
      }, {} as Record<string, boolean>);
    }

    return posts.map((post) => ({
      id: post.id,
      text: post.text,
      images: post.images,
      thumbnails: post.thumbnails,
      caption: post.caption,
      hashtag: post.hashtag,
      location: post.location,
      music: post.music,
      youtubeMusicMeta: post.youtubeMusicMeta,
      taggedPeople: post.taggedPeople,
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
      deletedAt: post.deletedAt,
      userId: post.userId,
      userName: post.user?.displayName || null,
      userImage: post.user?.image || null,
      profile: post.user?.profile || null,
      profileStatus: post.user?.profileStatus || null,
      likeCount: post._count.likes,
      commentCount: post._count.comments,
      shareCount: post._count.shares,
      isSaved: savedSet.has(post.id),
      isLike: likedSet.has(post.id),
      isFollow: !!followMap[post.userId],
      isHide: hiddenSet.has(post.id),
      type: post.type,
      format: post.format,
      link: post.link,
      visibleTo: (post as any).visibleTo,
      private_circle: this.isPrivateCircleVisibility((post as any).visibleTo),
      ebookpdf: post.ebookpdf,
      tableContent: post.tableContent,
      allowDownload: post.allowDownload,
      isPurchased: purchasedSet.has(post.id),
    }));
  }

  async getMarketPlaceEbookById(postId: string, viewerUserId?: string) {
    if (!postId) {
      throw new BadRequestException('Post ID required');
    }

    const post = await this.prisma.post.findFirst({
      where: {
        id: postId,
        isDelete: 'no',
        deletedAt: null,
        format: 'ebook',
      },
      include: {
        user: {
          select: {
            displayName: true,
            image: true,
            profile: true,
            profileStatus: true,
          },
        },
        _count: {
          select: {
            likes: true,
            comments: true,
            shares: true,
          },
        },
      },
    });

    if (!post) {
      throw new BadRequestException('Marketplace ebook post not found');
    }

    const [saved, liked, hidden, follow, purchased] = await Promise.all([
      viewerUserId
        ? this.prisma.savePost.findFirst({
          where: { userId: viewerUserId, postId },
          select: { id: true },
        })
        : Promise.resolve(null),
      viewerUserId
        ? this.prisma.postLike.findFirst({
          where: { userId: viewerUserId, postId },
          select: { id: true },
        })
        : Promise.resolve(null),
      viewerUserId
        ? this.prisma.hidePost.findFirst({
          where: { userId: viewerUserId, postId },
          select: { id: true },
        })
        : Promise.resolve(null),
      viewerUserId
        ? this.prisma.followerAndFollowing.findFirst({
          where: {
            followerId: viewerUserId,
            followingId: post.userId,
            status: 'ACCEPTED',
          },
          select: { id: true },
        })
        : Promise.resolve(null),
      viewerUserId
        ? (this.prisma as any).ebookPayments.findFirst({
          where: {
            buyerId: viewerUserId,
            postId,
            status: { in: ['SUCCEEDED', 'succeeded'] },
          },
          select: { id: true },
        })
        : Promise.resolve(null),
    ]);

    return {
      id: post.id,
      text: post.text,
      images: post.images,
      thumbnails: post.thumbnails,
      caption: post.caption,
      hashtag: post.hashtag,
      location: post.location,
      music: post.music,
      youtubeMusicMeta: post.youtubeMusicMeta,
      taggedPeople: post.taggedPeople,
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
      deletedAt: post.deletedAt,
      userId: post.userId,
      userName: post.user?.displayName || null,
      userImage: post.user?.image || null,
      profile: post.user?.profile || null,
      profileStatus: post.user?.profileStatus || null,
      likeCount: post._count.likes,
      commentCount: post._count.comments,
      shareCount: post._count.shares,
      isSaved: !!saved,
      isLike: !!liked,
      isFollow: !!follow,
      isHide: !!hidden,
      type: post.type,
      format: post.format,
      link: post.link,
      visibleTo: (post as any).visibleTo,
      private_circle: this.isPrivateCircleVisibility((post as any).visibleTo),
      ebookpdf: post.ebookpdf,
      tableContent: post.tableContent,
      allowDownload: post.allowDownload,
      amount: post.amount,
      isPurchased: !!purchased,
    };
  }

  async myEbookLibrary(viewerUserId?: string) {
    if (!viewerUserId) {
      throw new BadRequestException('User not authenticated');
    }

    const payments = await (this.prisma as any).ebookPayments.findMany({
      where: {
        buyerId: viewerUserId,
        status: { in: ['SUCCEEDED', 'succeeded'] },
      },
      select: {
        id: true,
        postId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!payments.length) {
      return [];
    }

    const paymentByPostId = new Map<string, { paymentId: string; purchasedAt: Date }>();
    for (const payment of payments) {
      if (!paymentByPostId.has(payment.postId)) {
        paymentByPostId.set(payment.postId, {
          paymentId: payment.id,
          purchasedAt: payment.createdAt,
        });
      }
    }

    const postIds = Array.from(paymentByPostId.keys());

    const posts = await this.prisma.post.findMany({
      where: {
        id: { in: postIds },
        isDelete: 'no',
        deletedAt: null,
        format: 'ebook',
      },
      include: {
        user: {
          select: {
            displayName: true,
            image: true,
            profile: true,
            profileStatus: true,
          },
        },
        _count: {
          select: {
            likes: true,
            comments: true,
            shares: true,
          },
        },
      },
    });

    if (!posts.length) {
      return [];
    }

    const [saved, liked, hidden, follows] = await Promise.all([
      this.prisma.savePost.findMany({
        where: { userId: viewerUserId, postId: { in: posts.map((post) => post.id) } },
        select: { postId: true },
      }),
      this.prisma.postLike.findMany({
        where: { userId: viewerUserId, postId: { in: posts.map((post) => post.id) } },
        select: { postId: true },
      }),
      this.prisma.hidePost.findMany({
        where: { userId: viewerUserId, postId: { in: posts.map((post) => post.id) } },
        select: { postId: true },
      }),
      this.prisma.followerAndFollowing.findMany({
        where: {
          followerId: viewerUserId,
          followingId: { in: Array.from(new Set(posts.map((post) => post.userId))) },
          status: 'ACCEPTED',
        },
        select: { followingId: true },
      }),
    ]);

    const savedSet = new Set(saved.map((item) => item.postId));
    const likedSet = new Set(liked.map((item) => item.postId));
    const hiddenSet = new Set(hidden.map((item) => item.postId));
    const followMap = follows.reduce((acc, item) => {
      acc[item.followingId] = true;
      return acc;
    }, {} as Record<string, boolean>);

    const postMap = new Map(posts.map((post) => [post.id, post]));

    return postIds
      .map((postId) => {
        const post = postMap.get(postId);
        if (!post) return null;

        const paymentMeta = paymentByPostId.get(post.id);

        return {
          id: post.id,
          text: post.text,
          images: post.images,
          thumbnails: post.thumbnails,
          caption: post.caption,
          hashtag: post.hashtag,
          location: post.location,
          music: post.music,
          youtubeMusicMeta: post.youtubeMusicMeta,
          taggedPeople: post.taggedPeople,
          createdAt: post.createdAt,
          updatedAt: post.updatedAt,
          deletedAt: post.deletedAt,
          userId: post.userId,
          userName: post.user?.displayName || null,
          userImage: post.user?.image || null,
          profile: post.user?.profile || null,
          profileStatus: post.user?.profileStatus || null,
          likeCount: post._count.likes,
          commentCount: post._count.comments,
          shareCount: post._count.shares,
          isSaved: savedSet.has(post.id),
          isLike: likedSet.has(post.id),
          isFollow: !!followMap[post.userId],
          isHide: hiddenSet.has(post.id),
          type: post.type,
          format: post.format,
          link: post.link,
          visibleTo: (post as any).visibleTo,
          private_circle: this.isPrivateCircleVisibility((post as any).visibleTo),
          ebookpdf: post.ebookpdf,
          tableContent: post.tableContent,
          allowDownload: post.allowDownload,
          amount: post.amount,
          isPurchased: true,
          paymentId: paymentMeta?.paymentId || null,
          purchasedAt: paymentMeta?.purchasedAt || null,
        };
      })
      .filter((item) => item !== null);
  }


  async deletePost(postId: string, userId: string) {
    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post || post.deletedAt) throw new BadRequestException('Post not found');
    if (post.userId !== userId) throw new BadRequestException('Unauthorized');
    await this.prisma.$transaction(async (tx) => {
      const postHashtags = await tx.postHashtag.findMany({
        where: { postId },
        select: { hashtagId: true },
      });

      await tx.postHashtag.deleteMany({ where: { postId } });

      await tx.post.update({
        where: { id: postId },
        data: { deletedAt: new Date(), isDelete: 'yes' },
      });

      if (postHashtags.length > 0) {
        await Promise.all(
          postHashtags.map((item) => this.recalculateHashtagCounters(tx, item.hashtagId)),
        );
      }
    });
    return true;
  }

  async reportPost(postId: string, userId: string, reason?: string) {
    if (!postId) throw new BadRequestException('Post ID required');
    if (!userId) throw new BadRequestException('User ID required');

    const post = await this.prisma.post.findUnique({
      where: { id: postId, isDelete: 'no', deletedAt: null },

    });
    if (!post) throw new BadRequestException('Post not found');
    await this.ensureCanViewPost(post, userId);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.postReport.create({
          data: {
            postId,
            userId,
            reason: reason && reason.trim() !== '' ? reason.trim() : null,
          },
        });

        const reportCount = await tx.postReport.count({ where: { postId } });
        let deleted = false;

        if (reportCount >= 100) {
          await tx.post.update({
            where: { id: postId },
            data: { deletedAt: new Date(), isDelete: 'yes' },
          });
          deleted = true;
        }

        return {
          message: deleted ? 'Post deleted due to reports' : 'Post reported',
          reportCount,
          deleted,
        };
      });
    } catch (error) {
      const isUniqueViolation = (error as Prisma.PrismaClientKnownRequestError)?.code === 'P2002';
      if (isUniqueViolation) {
        const reportCount = await this.prisma.postReport.count({ where: { postId } });
        return { message: 'Post already reported', reportCount, deleted: false };
      }
      throw error;
    }
  }

  async editPost(postId: string, userId: string, updateData: any, files?: Express.Multer.File[]) {
    // Check if post exists and belongs to user
    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    // console.log('Service received post:', post?.userId, userId);

    if (!post || post.deletedAt) throw new BadRequestException('Post not found');
    if (post.userId !== userId) throw new BadRequestException('Unauthorized to edit this post');

    const shouldApplyVideoText = updateData.videoText === true;
    const normalizedVideoTextItems: VideoTextOverlayItem[] = Array.isArray(updateData.videoTextItems)
      ? updateData.videoTextItems
        .map((item: any) => ({
          text: String(item?.text || '').trim(),
          xPercent: Number(item?.xPercent),
          yPercent: Number(item?.yPercent),
          fontSize: Number(item?.fontSize),
          color: String(item?.color || 'white').trim() || 'white',
        }))
        .filter((item: VideoTextOverlayItem) => item.text.length > 0)
      : [];

    let mediaFiles = files;
    if (shouldApplyVideoText) {
      if (!mediaFiles || mediaFiles.length === 0) {
        throw new BadRequestException('Video file is required when videoText=true');
      }

      if (normalizedVideoTextItems.length === 0) {
        throw new BadRequestException('videoTextItems is required when videoText=true');
      }

      const hasVideoFile = mediaFiles.some((file) => file.mimetype?.startsWith('video/'));
      if (!hasVideoFile) {
        throw new BadRequestException('At least one video file is required when videoText=true');
      }

      mediaFiles = await Promise.all(
        mediaFiles.map(async (file) => {
          if (!file.mimetype?.startsWith('video/')) return file;
          return applyVideoTextOverlays(file, normalizedVideoTextItems);
        }),
      );
    }

    // Handle new image uploads
    let imageUrls: string[] = post.images || [];
    if (mediaFiles && mediaFiles.length > 0) {
      const uploadedUrls = await Promise.all(mediaFiles.map(f => uploadImageToS3(f, 'post-images')));
      const replaceExistingMedia = updateData.videoText === true;
      imageUrls = replaceExistingMedia ? uploadedUrls : imageUrls.concat(uploadedUrls);
    }

    const existingTaggedPeople = Array.from(
      new Set(((post.taggedPeople || []) as string[]).map((id) => String(id).trim()).filter(Boolean)),
    );

    // Process update data - only update fields that are explicitly provided and not empty
    const updateFields: any = {};

    // Only update text if it's provided and not empty string
    if (updateData.text !== undefined && updateData.text !== null && updateData.text.trim() !== '') {
      updateFields.text = updateData.text;
    } else if (updateData.text === '') {
      // If empty string is explicitly sent, set to null
      updateFields.text = null;
    }

    // Only update caption if it's provided and not empty string
    if (updateData.caption !== undefined && updateData.caption !== null && updateData.caption.trim() !== '') {
      updateFields.caption = updateData.caption;
    } else if (updateData.caption === '') {
      // If empty string is explicitly sent, set to null
      updateFields.caption = null;
    }

    const resolvedNextText =
      updateData.text !== undefined
        ? (typeof updateData.text === 'string' ? updateData.text : String(updateData.text ?? ''))
        : post.text || '';
    const resolvedNextCaption =
      updateData.caption !== undefined
        ? (typeof updateData.caption === 'string' ? updateData.caption : String(updateData.caption ?? ''))
        : post.caption || '';

    const providedHashtagInput =
      updateData.hashtag !== undefined && Array.isArray(updateData.hashtag)
        ? updateData.hashtag
        : post.hashtag || [];
    const resolvedHashtags = this.buildNormalizedPostHashtags(providedHashtagInput, resolvedNextText, resolvedNextCaption);

    // Only update hashtag if it's provided and not empty array
    if (updateData.hashtag !== undefined && Array.isArray(updateData.hashtag)) {
      updateFields.hashtag = resolvedHashtags;
    }

    // Only update location if it's provided and not empty string
    if (updateData.location !== undefined && updateData.location !== null && updateData.location.trim() !== '') {
      updateFields.location = updateData.location;
    } else if (updateData.location === '') {
      // If empty string is explicitly sent, set to null
      updateFields.location = null;
    }

    // Only update music if it's provided and not empty string
    if (updateData.music !== undefined && updateData.music !== null && updateData.music.trim() !== '') {
      updateFields.music = updateData.music;
    } else if (updateData.music === '') {
      // If empty string is explicitly sent, set to null
      updateFields.music = null;
    }

    if (updateData.youtubeMusicMeta !== undefined) {
      updateFields.youtubeMusicMeta = updateData.youtubeMusicMeta === '' ? null : updateData.youtubeMusicMeta;
    }

    if (updateData.type !== undefined && updateData.type !== null && updateData.type.trim() !== '') {
      updateFields.type = updateData.type;
    } else if (updateData.type === '') {
      updateFields.type = null;
    }

    if (updateData.videoText !== undefined) {
      updateFields.videoText = shouldApplyVideoText;
      updateFields.videoTextItems = shouldApplyVideoText ? (normalizedVideoTextItems as any) : null;
    }

    let newlyTaggedUserIds: string[] = [];

    // Only update taggedPeople if it's provided and not empty array
    if (updateData.taggedPeople !== undefined && Array.isArray(updateData.taggedPeople)) {
      const normalizedTaggedSet = new Set<string>();
      for (const rawTaggedId of updateData.taggedPeople as unknown[]) {
        const normalizedTaggedId = String(rawTaggedId).trim();
        if (normalizedTaggedId.length > 0) {
          normalizedTaggedSet.add(normalizedTaggedId);
        }
      }

      const normalizedTaggedPeople: string[] = Array.from(normalizedTaggedSet);

      updateFields.taggedPeople = normalizedTaggedPeople;

      const existingTaggedSet = new Set(existingTaggedPeople);
      newlyTaggedUserIds = normalizedTaggedPeople.filter(
        (taggedId) => taggedId !== userId && !existingTaggedSet.has(taggedId),
      );
    }

    // Only update visibleTo if it's provided and not empty string
    if (updateData.visibleTo !== undefined && updateData.visibleTo !== null && updateData.visibleTo.trim() !== '') {
      if (this.isPrivateCircleVisibility(updateData.visibleTo)) {
        const privateCircle = await this.prisma.privateCircle.findUnique({
          where: { ownerId: userId },
          select: { id: true, isActive: true },
        });

        if (!privateCircle || !privateCircle.isActive) {
          throw new BadRequestException('Set up your private circle before making this a private circle post');
        }

        updateFields.visibleTo = 'PRIVATE_CIRCLE';
        updateFields.privateCircleId = privateCircle.id;
      } else {
        updateFields.visibleTo = updateData.visibleTo;
        updateFields.privateCircleId = null;
      }
    } else if (updateData.visibleTo === '') {
      // If empty string is explicitly sent, set to null
      updateFields.visibleTo = null;
      updateFields.privateCircleId = null;
    }

    // Update images if new files are uploaded
    if (mediaFiles && mediaFiles.length > 0) {
      updateFields.images = imageUrls;
      if (updateData.videoText === true) {
        updateFields.thumbnails = [];
      }
    }

    // Check if content is modified to re-trigger AI moderation
    const isContentModified =
      updateData.text !== undefined ||
      updateData.caption !== undefined ||
      updateData.hashtag !== undefined ||
      (mediaFiles && mediaFiles.length > 0);

    if (isContentModified) {
      const moderation = await this.moderationService.evaluatePost({
        text: updateFields.text !== undefined ? updateFields.text : post.text,
        caption: updateFields.caption !== undefined ? updateFields.caption : post.caption,
        hashtag: updateFields.hashtag !== undefined ? updateFields.hashtag : post.hashtag,
        images: updateFields.images !== undefined ? updateFields.images : post.images,
        type: updateFields.type !== undefined ? updateFields.type : post.type,
        format: post.format,
      });

      updateFields.moderationStatus = moderation.status;
      updateFields.moderationReason = moderation.reason;
      updateFields.moderationScore = moderation.score;
      updateFields.moderatedBy = moderation.moderatedBy;
      updateFields.moderatedAt = new Date();
    }

    const updatedPost = await this.prisma.$transaction(async (tx) => {
      const nextHashtags =
        updateData.hashtag !== undefined || updateData.text !== undefined || updateData.caption !== undefined
          ? resolvedHashtags
          : post.hashtag || [];

      if (updateData.hashtag !== undefined || updateData.text !== undefined || updateData.caption !== undefined) {
        updateFields.hashtag = nextHashtags;
      }

      const savedPost = await tx.post.update({
        where: { id: postId },
        data: updateFields,
      });

      if (updateData.hashtag !== undefined || updateData.text !== undefined || updateData.caption !== undefined) {
        await this.syncPostHashtags(tx, postId, nextHashtags);
      }

      if (updateFields.moderationStatus === 'PENDING_APPROVAL') {
        await (tx as any).moderationAuditLog.create({
          data: {
            contentType: 'POST',
            contentId: postId,
            authorId: userId,
            aiVerdict: 'PENDING_APPROVAL',
            aiReason: updateFields.moderationReason,
            aiConfidence: updateFields.moderationScore,
          },
        });
      }

      return savedPost;
    });

    if (newlyTaggedUserIds.length > 0) {
      const [author, taggedUsers] = await Promise.all([
        this.prisma.user.findUnique({
          where: { id: userId },
          select: { displayName: true, userName: true },
        }),
        this.prisma.user.findMany({
          where: { id: { in: newlyTaggedUserIds } },
          select: { id: true },
        }),
      ]);

      const validNewTaggedUserIds = taggedUsers.map((u) => u.id);

      if (validNewTaggedUserIds.length > 0) {
        const authorName = author?.displayName || author?.userName || 'Someone';
        const isPrivateCirclePost =
          (updatedPost.type || '').trim().toLowerCase() === 'private' &&
          this.isPrivateCircleVisibility(updatedPost.visibleTo);
        const tagNotificationTitle = isPrivateCirclePost ? 'Tagged in a private circle post' : 'Tagged in a post';
        const tagNotificationBody = isPrivateCirclePost
          ? `${authorName} tagged you in a private circle post.`
          : `${authorName} tagged you in a post.`;

        await Promise.all(
          validNewTaggedUserIds.map((taggedUserId) =>
            this.notificationService.sendNotificationToUser(
              taggedUserId,
              tagNotificationTitle,
              tagNotificationBody,
              {
                type: 'post_tag',
                postId: updatedPost.id,
                taggerId: userId,
                post_type: updatedPost.type || '',
                visibleTo: updatedPost.visibleTo || '',
                isTrustPost: Boolean(
                  updatedPost.isTrustPost ||
                  ['mission-post', 'crowdfunding', 'support'].includes(updatedPost.type || ''),
                ),
              },
            ),
          ),
        );
      }
    }

    return {
      ...updatedPost,
      private_circle: this.isPrivateCircleVisibility(updatedPost.visibleTo),
    };
  }

  async searchHashtags(query?: string, limit: number = 20) {
    const normalizedLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const normalizedQuery = this.normalizeHashtagTag(query || '') || '';

    const hashtags = await this.prisma.hashtag.findMany({
      where: normalizedQuery
        ? {
          tag: {
            contains: normalizedQuery,
            mode: 'insensitive',
          },
        }
        : undefined,
      orderBy: [
        { postCount: 'desc' },
        { usageCount: 'desc' },
        { lastUsedAt: 'desc' },
      ],
      take: normalizedLimit,
      select: {
        id: true,
        tag: true,
        postCount: true,
        usageCount: true,
        lastUsedAt: true,
      },
    });

    return hashtags.map((item) => ({
      id: item.id,
      tag: `#${item.tag}`,
      rawTag: item.tag,
      postCount: item.postCount,
      usageCount: item.usageCount,
      lastUsedAt: item.lastUsedAt,
    }));
  }

  async getTrendingHashtags(limit: number = 20, days: number = 7) {
    const normalizedLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const normalizedDays = Math.min(Math.max(Number(days) || 7, 1), 90);
    const since = new Date(Date.now() - normalizedDays * 24 * 60 * 60 * 1000);

    const links = await this.prisma.postHashtag.findMany({
      where: {
        createdAt: { gte: since },
      },
      select: {
        hashtagId: true,
        hashtag: {
          select: {
            id: true,
            tag: true,
            postCount: true,
            usageCount: true,
            lastUsedAt: true,
          },
        },
      },
    });

    const scoreMap = new Map<string, { hashtag: any; recentUseCount: number }>();
    links.forEach((item) => {
      const prev = scoreMap.get(item.hashtagId);
      if (prev) {
        prev.recentUseCount += 1;
      } else {
        scoreMap.set(item.hashtagId, { hashtag: item.hashtag, recentUseCount: 1 });
      }
    });

    return Array.from(scoreMap.values())
      .sort((a, b) => b.recentUseCount - a.recentUseCount || b.hashtag.postCount - a.hashtag.postCount)
      .slice(0, normalizedLimit)
      .map((item) => ({
        id: item.hashtag.id,
        tag: `#${item.hashtag.tag}`,
        rawTag: item.hashtag.tag,
        recentUseCount: item.recentUseCount,
        postCount: item.hashtag.postCount,
        usageCount: item.hashtag.usageCount,
        lastUsedAt: item.hashtag.lastUsedAt,
      }));
  }

  async getPostsByHashtag(tag: string, viewerUserId?: string, page: number = 1, limit: number = 20) {
    const normalizedTag = this.normalizeHashtagTag(tag);
    if (!normalizedTag) {
      throw new BadRequestException('Valid hashtag is required');
    }

    const pageNum = Math.max(Number(page) || 1, 1);
    const takeNum = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const skipNum = (pageNum - 1) * takeNum;

    const hashtag = await this.prisma.hashtag.findUnique({
      where: { tag: normalizedTag },
      select: { id: true, tag: true },
    });

    if (!hashtag) {
      return {
        hashtag: `#${normalizedTag}`,
        total: 0,
        page: pageNum,
        limit: takeNum,
        posts: [],
      };
    }

    const whereClause: Prisma.PostHashtagWhereInput = {
      hashtagId: hashtag.id,
      post: {
        deletedAt: null,
        AND: [this.buildPostVisibilityWhere(viewerUserId)],
      },
    };

    const [total, links] = await Promise.all([
      this.prisma.postHashtag.count({ where: whereClause }),
      this.prisma.postHashtag.findMany({
        where: whereClause,
        orderBy: { createdAt: 'desc' },
        skip: skipNum,
        take: takeNum,
        include: {
          post: {
            include: {
              user: {
                select: {
                  displayName: true,
                  image: true,
                  profile: true,
                  profileStatus: true,
                },
              },
              _count: {
                select: {
                  likes: true,
                  comments: true,
                  shares: true,
                },
              },
            },
          },
        },
      }),
    ]);

    const posts = links.map((item) => item.post);

    let savedSet: Set<string> = new Set();
    let likedSet: Set<string> = new Set();

    if (viewerUserId && posts.length > 0) {
      const [saved, liked] = await Promise.all([
        this.prisma.savePost.findMany({
          where: { userId: viewerUserId, postId: { in: posts.map((p) => p.id) } },
          select: { postId: true },
        }),
        this.prisma.postLike.findMany({
          where: { userId: viewerUserId, postId: { in: posts.map((p) => p.id) } },
          select: { postId: true },
        }),
      ]);
      savedSet = new Set(saved.map((item) => item.postId));
      likedSet = new Set(liked.map((item) => item.postId));
    }

    return {
      hashtag: `#${hashtag.tag}`,
      total,
      page: pageNum,
      limit: takeNum,
      posts: posts.map((post) => ({
        id: post.id,
        text: post.text,
        caption: post.caption,
        images: post.images,
        thumbnails: post.thumbnails,
        hashtag: post.hashtag,
        createdAt: post.createdAt,
        updatedAt: post.updatedAt,
        userId: post.userId,
        userName: post.user?.displayName || null,
        userImage: post.user?.image || null,
        profile: post.user?.profile || null,
        profileStatus: post.user?.profileStatus || null,
        likeCount: post._count.likes,
        commentCount: post._count.comments,
        shareCount: post._count.shares,
        isSaved: savedSet.has(post.id),
        isLike: likedSet.has(post.id),
        type: post.type,
        link: post.link,
        visibleTo: (post as any).visibleTo,
        private_circle: this.isPrivateCircleVisibility((post as any).visibleTo),
      })),
    };
  }

  async postLikeByUser(postId: string, userId: string) {
    if (!postId) throw new BadRequestException('Post ID required');
    if (!userId) throw new BadRequestException('User ID required');

    // Check if post exists
    const post = await this.prisma.post.findUnique({
      where: {
        id: postId,
        deletedAt: null
      },
    });

    if (!post) {
      throw new BadRequestException('Post not found');
    }

    await this.ensureCanViewPost(post, userId);

    // Check if user already liked the post
    const existingLike = await this.prisma.postLike.findUnique({
      where: {
        postId_userId: {
          postId,
          userId,
        },
      },
    });

    if (existingLike) {
      // Unlike the post
      await this.prisma.postLike.delete({
        where: {
          postId_userId: {
            postId,
            userId,
          },
        },
      });
      return { message: 'Post unliked successfully', liked: false };
    } else {
      // Like the post
      await this.prisma.postLike.create({
        data: {
          postId,
          userId,
        },
      });

      try {
        await this.notificationService.sendPostLikeNotification(postId, userId);
      } catch (error) {
        console.error('Failed to send post like notification:', error);
      }

      return { message: 'Post liked successfully', liked: true };
    }
  }

  async postTrustVote(
    postId: string,
    userId: string,
    voteType: 'AGREE' | 'DISAGREE' | 'NOT_SURE',
    comment?: string,
  ) {
    if (!postId) throw new BadRequestException('Post ID required');
    if (!userId) throw new BadRequestException('User ID required');

    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { id: true, isTrustPost: true, deletedAt: true, isDelete: true },
    });

    if (!post || post.deletedAt || post.isDelete === 'yes') {
      throw new BadRequestException('Post not found');
    }

    if (!post.isTrustPost) {
      throw new BadRequestException('This post is not a trust post');
    }

    const prismaClient = this.prisma as any;

    const existingVote = await prismaClient.postTrustVote.findUnique({
      where: {
        userId_postId: {
          userId,
          postId,
        },
      },
      select: { id: true },
    });

    if (existingVote) {
      console.warn('[postTrustVote] Existing vote found in pre-check', {
        userId,
        postId,
        existingVoteId: existingVote.id,
      });
      throw new BadRequestException({
        message: 'You have already voted on this post',
        debug: {
          reason: 'existing_vote_precheck',
          userId,
          postId,
          existingVoteId: existingVote.id,
        },
      });
    }

    const sanitizedComment = typeof comment === 'string' ? comment.trim() : '';

    let vote: any;
    let trustComment: any = null;

    try {
      const transactionResult = await prismaClient.$transaction(async (tx: any) => {
        const createdVote = await tx.postTrustVote.create({
          data: {
            userId,
            postId,
            voteType,
          },
        });

        let createdTrustComment = null;
        if (sanitizedComment) {
          createdTrustComment = await tx.postComment.create({
            data: {
              postId,
              userId,
              comment: sanitizedComment,
              commentType: voteType,
            },
          });
        }

        return {
          vote: createdVote,
          trustComment: createdTrustComment,
        };
      });

      vote = transactionResult.vote;
      trustComment = transactionResult.trustComment;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const targetColumns = Array.isArray((error.meta as any)?.target)
          ? (error.meta as any).target.map((col: any) => String(col))
          : [];

        const hasUserId = targetColumns.includes('userId');
        const hasPostId = targetColumns.includes('postId');

        if (hasPostId && !hasUserId) {
          throw new BadRequestException(
            'Vote conflict due to DB unique constraint on postId. Please apply latest Prisma migrations so uniqueness is on userId+postId.',
          );
        }

        if (hasUserId && hasPostId) {
          throw new BadRequestException('You have already voted on this post');
        }

        throw new BadRequestException(
          `Vote conflict due to unique constraint (${targetColumns.join(', ') || 'unknown target'}).`,
        );
      }
      throw error;
    }

    return {
      message: 'Trust vote added successfully',
      vote,
      trustComment,
    };
  }

  async getPostTrustScore(postId: string) {
    if (!postId) throw new BadRequestException('Post ID required');

    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { id: true, isTrustPost: true, deletedAt: true, isDelete: true },
    });

    if (!post || post.deletedAt || post.isDelete === 'yes') {
      throw new BadRequestException('Post not found');
    }

    if (!post.isTrustPost) {
      throw new BadRequestException('This post is not a trust post');
    }

    const prismaClient = this.prisma as any;

    const [agreeVoteCount, disagreeVoteCount, notSureVoteCount] = await Promise.all([
      prismaClient.postTrustVote.count({ where: { postId, voteType: 'AGREE' } }),
      prismaClient.postTrustVote.count({ where: { postId, voteType: 'DISAGREE' } }),
      prismaClient.postTrustVote.count({ where: { postId, voteType: 'NOT_SURE' } }),
    ]);

    const total = agreeVoteCount + disagreeVoteCount + notSureVoteCount;

    const agreeVotePercentage = total > 0 ? (agreeVoteCount * 100) / total : 0;
    const disagreeVotePercentage = total > 0 ? (disagreeVoteCount * 100) / total : 0;
    const notSureVotePercentage = total > 0 ? (notSureVoteCount * 100) / total : 0;

    return {
      postId,
      total,
      counts: {
        agreeVoteCount,
        disagreeVoteCount,
        notSureVoteCount,
      },
      percentages: {
        agreeVotePercentage,
        disagreeVotePercentage,
        notSureVotePercentage,
      },
    };
  }

  async getTrustVoteBypostId(postId: string, userId: string) {
    if (!postId) throw new BadRequestException('Post ID required');
    if (!userId) throw new BadRequestException('User ID required');

    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { id: true, isTrustPost: true, deletedAt: true, isDelete: true },
    });

    if (!post || post.deletedAt || post.isDelete === 'yes') {
      throw new BadRequestException('Post not found');
    }

    if (!post.isTrustPost) {
      throw new BadRequestException('This post is not a trust post');
    }

    const prismaClient = this.prisma as any;

    const vote = await prismaClient.postTrustVote.findUnique({
      where: {
        userId_postId: {
          userId,
          postId,
        },
      },
      select: {
        id: true,
        voteType: true,
        createdAt: true,
      },
    });

    return {
      postId,
      hasSubmittedVote: !!vote,
      vote: vote || null,
    };
  }

  async removePostTrustVote(postId: string, userId: string) {
    if (!postId) throw new BadRequestException('Post ID required');
    if (!userId) throw new BadRequestException('User ID required');

    const prismaClient = this.prisma as any;

    const existingVote = await prismaClient.postTrustVote.findUnique({
      where: {
        userId_postId: {
          userId,
          postId,
        },
      },
      select: { id: true },
    });

    if (!existingVote) {
      throw new BadRequestException('Trust vote not found');
    }

    await prismaClient.postTrustVote.delete({
      where: {
        userId_postId: {
          userId,
          postId,
        },
      },
    });

    return { message: 'Trust vote removed successfully' };
  }

  async postLikeList(postId: string, viewerUserId?: string) {
    if (!postId) throw new BadRequestException('Post ID required');

    // Check if post exists
    const post = await this.prisma.post.findUnique({
      where: {
        id: postId,
        deletedAt: null
      },
    });

    if (!post) {
      throw new BadRequestException('Post not found');
    }

    await this.ensureCanViewPost(post, viewerUserId);

    // Get likes with user information
    const likes = await this.prisma.postLike.findMany({
      where: { postId },
      include: {
        user: {
          select: {
            id: true,
            displayName: true,
            image: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Get total like count
    const totalLikes = await this.prisma.postLike.count({
      where: { postId },
    });

    // Format the response
    const formattedLikes = likes.map((like: any) => ({
      id: like.id,
      userId: like.user.id,
      displayName: like.user.displayName,
      image: like.user.image,
      createdAt: like.createdAt,
    }));

    return {
      likes: formattedLikes,
      totalLikes,
    };
  }

  // Add a comment to a post
  async commentOnPost(postId: string, userId: string, comment: string, parentCommentId?: string) {
    if (!postId) throw new BadRequestException('Post ID required');
    if (!userId) throw new BadRequestException('User ID required');
    if (!comment || comment.trim() === '') throw new BadRequestException('Comment required');
    // Check if post exists
    const post = await this.prisma.post.findUnique({
      where: { id: postId, deletedAt: null },
    });
    if (!post) throw new BadRequestException('Post not found');
    await this.ensureCanViewPost(post, userId);

    if (parentCommentId) {
      const parent = await this.prisma.postComment.findUnique({ where: { id: parentCommentId } });
      if (!parent || parent.postId !== postId) throw new BadRequestException('Parent comment not found');
      if (parent.parentId) throw new BadRequestException('Replies cannot have subcomments');
    }

    // Run AI Comment Moderation
    const moderation = await this.moderationService.evaluateComment({
      comment,
      postText: post.text || post.caption || undefined,
    });

    if (moderation.status !== 'APPROVED') {
      try {
        await (this.prisma as any).moderationAuditLog.create({
          data: {
            contentType: 'COMMENT',
            contentId: `rejected_${Date.now()}`,
            authorId: userId,
            aiVerdict: moderation.status,
            aiReason: moderation.reason,
            aiConfidence: moderation.score,
            flaggedLabels: moderation.flaggedLabels || [],
          },
        });
      } catch (err) {
        console.error('Failed to log moderation audit:', err);
      }

      throw new BadRequestException(
        moderation.reason || 'Your comment contains inappropriate or prohibited language.',
      );
    }

    const createdComment = await this.prisma.postComment.create({
      data: {
        postId,
        userId,
        comment,
        parentId: parentCommentId || null,
        moderationStatus: moderation.status,
        moderationReason: moderation.reason,
        moderationScore: moderation.score,
        moderatedBy: moderation.moderatedBy,
        moderatedAt: new Date(),
      } as any,
    });

    if ((moderation.status as any) === 'PENDING_APPROVAL') {
      await (this.prisma as any).moderationAuditLog.create({
        data: {
          contentType: 'COMMENT',
          contentId: createdComment.id,
          authorId: userId,
          aiVerdict: 'PENDING_APPROVAL',
          aiReason: moderation.reason,
          aiConfidence: moderation.score,
          flaggedLabels: moderation.flaggedLabels || [],
        },
      });
    }

    if (moderation.status === 'APPROVED') {
      try {
        await Promise.all([
          this.notificationService.sendPostCommentNotification(postId, createdComment.id, userId),
          this.notificationService.sendPostMentionNotifications(postId, createdComment.id, userId),
        ]);
      } catch (error) {
        console.error('Failed to send post comment or mention notification:', error);
      }
    }

    return createdComment;
  }

  async editComment(commentId: string, userId: string, newComment: string) {
    if (!commentId) throw new BadRequestException('Comment ID required');
    if (!userId) throw new BadRequestException('User ID required');
    if (!newComment || newComment.trim() === '') throw new BadRequestException('New comment text required');

    // Find the comment
    const comment = await this.prisma.postComment.findUnique({ where: { id: commentId } });
    if (!comment) throw new BadRequestException('Comment not found');
    if (comment.userId !== userId) throw new BadRequestException('Not allowed to edit this comment');

    const moderation = await this.moderationService.evaluateComment({
      comment: newComment,
    });

    if (moderation.status !== 'APPROVED') {
      throw new BadRequestException(
        moderation.reason || 'Your edited comment contains inappropriate or prohibited language.',
      );
    }

    // Update the comment
    return this.prisma.postComment.update({
      where: { id: commentId },
      data: {
        comment: newComment,
        moderationStatus: moderation.status,
        moderationReason: moderation.reason,
        moderationScore: moderation.score,
        moderatedBy: moderation.moderatedBy,
        moderatedAt: new Date(),
      } as any,
    });
  }

  async reactOnComment(commentId: string, userId: string, reaction: 'LIKE' | 'DISLIKE' | 'NONE') {
    if (!commentId) throw new BadRequestException('Comment ID required');
    if (!userId) throw new BadRequestException('User ID required');
    if (!reaction) throw new BadRequestException('Reaction required');

    const comment = await this.prisma.postComment.findUnique({
      where: { id: commentId },
      include: { post: true },
    });
    if (!comment) throw new BadRequestException('Comment not found');
    await this.ensureCanViewPost(comment.post, userId);

    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.postCommentReaction.findUnique({
        where: {
          commentId_userId: {
            commentId,
            userId,
          },
        },
      });

      if (reaction === 'NONE') {
        if (existing) {
          await tx.postCommentReaction.delete({
            where: {
              commentId_userId: {
                commentId,
                userId,
              },
            },
          });
        }
      } else if (existing) {
        await tx.postCommentReaction.update({
          where: {
            commentId_userId: {
              commentId,
              userId,
            },
          },
          data: { type: reaction },
        });
      } else {
        await tx.postCommentReaction.create({
          data: {
            commentId,
            userId,
            type: reaction,
          },
        });
      }
    });

    const [likeCount, dislikeCount, viewerReaction] = await Promise.all([
      this.prisma.postCommentReaction.count({ where: { commentId, type: 'LIKE' } }),
      this.prisma.postCommentReaction.count({ where: { commentId, type: 'DISLIKE' } }),
      this.prisma.postCommentReaction.findUnique({
        where: { commentId_userId: { commentId, userId } },
        select: { type: true },
      }),
    ]);

    return {
      message: reaction === 'NONE' ? 'Reaction removed successfully' : 'Reaction updated successfully',
      commentId,
      userReaction: viewerReaction?.type || 'NONE',
      likeCount,
      dislikeCount,
    };
  }

  // Get comments for a post (only approved comments or author's own pending)
  async getCommentListOnPost(postId: string, viewerUserId?: string) {
    if (!postId) throw new BadRequestException('Post ID required');
    // Check if post exists
    const post = await this.prisma.post.findUnique({
      where: { id: postId, deletedAt: null },
    });
    if (!post) throw new BadRequestException('Post not found');
    await this.ensureCanViewPost(post, viewerUserId);

    const commentWhere: any = viewerUserId
      ? {
          postId,
          OR: [
            { moderationStatus: 'APPROVED' },
            { userId: viewerUserId },
          ],
        }
      : { postId, moderationStatus: 'APPROVED' };

    const comments = await this.prisma.postComment.findMany({
      where: commentWhere,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { displayName: true, image: true, id: true } },
      },
    });
    const commentCount = await this.prisma.postComment.count({ where: commentWhere });
    const commentIds = comments.map((c: any) => c.id);

    const [reactionCounts, viewerReactions] = await Promise.all([
      commentIds.length
        ? this.prisma.postCommentReaction.groupBy({
          by: ['commentId', 'type'],
          where: { commentId: { in: commentIds } },
          _count: { _all: true },
        })
        : Promise.resolve([] as any[]),
      viewerUserId && commentIds.length
        ? this.prisma.postCommentReaction.findMany({
          where: { commentId: { in: commentIds }, userId: viewerUserId },
          select: { commentId: true, type: true },
        })
        : Promise.resolve([] as any[]),
    ]);

    const reactionCountMap = new Map<string, { likeCount: number; dislikeCount: number }>();
    reactionCounts.forEach((row: any) => {
      const current = reactionCountMap.get(row.commentId) || { likeCount: 0, dislikeCount: 0 };
      if (row.type === 'LIKE') {
        current.likeCount = row._count?._all || 0;
      } else if (row.type === 'DISLIKE') {
        current.dislikeCount = row._count?._all || 0;
      }
      reactionCountMap.set(row.commentId, current);
    });

    const viewerReactionMap = new Map<string, 'LIKE' | 'DISLIKE'>();
    viewerReactions.forEach((row: any) => {
      viewerReactionMap.set(row.commentId, row.type);
    });

    const commentById = new Map<string, any>();
    comments.forEach((c: any) => {
      const reactionCounts = reactionCountMap.get(c.id) || { likeCount: 0, dislikeCount: 0 };
      commentById.set(c.id, {
        id: c.id,
        comment: c.comment,
        createdAt: c.createdAt,
        userId: c.userId,
        displayName: c.user.displayName,
        image: c.user.image,
        commentType: c.commentType,
        likeCount: reactionCounts.likeCount,
        dislikeCount: reactionCounts.dislikeCount,
        userReaction: viewerReactionMap.get(c.id) || 'NONE',
        replies: [],
        parentId: c.parentId || null,
      });
    });

    const nestedComments: any[] = [];
    commentById.forEach((c) => {
      if (c.parentId && commentById.has(c.parentId)) {
        commentById.get(c.parentId).replies.push(c);
      } else {
        nestedComments.push(c);
      }
    });

    const sortByCreatedAtDesc = (items: any[]) => {
      items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      items.forEach((item) => {
        if (Array.isArray(item.replies) && item.replies.length) {
          sortByCreatedAtDesc(item.replies);
        }
      });
    };

    sortByCreatedAtDesc(nestedComments);

    return {
      comments: nestedComments,
      commentCount,
    };
  }

  // Delete a comment
  async commentDelete(postId: string, commentId: string, userId: string) {
    if (!postId) throw new BadRequestException('Post ID required');
    if (!commentId) throw new BadRequestException('Comment ID required');
    if (!userId) throw new BadRequestException('User ID required');
    const comment = await this.prisma.postComment.findUnique({ where: { id: commentId } });
    if (!comment || comment.userId !== userId || comment.postId !== postId) throw new BadRequestException('Not allowed');
    await this.prisma.postComment.delete({ where: { id: commentId } });
    return { message: 'Comment deleted' };
  }

  async getSavedPostsByUser(userId: string, viewerUserId: string) {
    if (!userId) throw new BadRequestException('User ID required');

    // ✅ Get saved posts with full post + user + counts
    const savedPosts = await this.prisma.savePost.findMany({
      where: {
        userId,
        post: {
          deletedAt: null,
          AND: [this.buildPostVisibilityWhere(viewerUserId)],
        },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        post: {
          include: {
            user: {
              select: {
                displayName: true,
                image: true,
                profileStatus: true,
                profile: true,
              },
            },
            _count: {
              select: {
                likes: true,
                comments: true,
                shares: true,
              },
            },
          },
        },
      },
    });

    let savedSet: Set<string> = new Set();
    let likedSet: Set<string> = new Set();

    if (viewerUserId) {
      const postIds = savedPosts.map(sp => sp.postId);

      // ✅ Fetch saved posts for viewer
      const saved = await this.prisma.savePost.findMany({
        where: { userId: viewerUserId, postId: { in: postIds } },
        select: { postId: true },
      });
      savedSet = new Set(saved.map(s => s.postId));

      // ✅ Fetch liked posts for viewer
      const liked = await this.prisma.postLike.findMany({
        where: { userId: viewerUserId, postId: { in: postIds } },
        select: { postId: true },
      });
      likedSet = new Set(liked.map(l => l.postId));

      // ✅ Fetch follow status for each post's author
      const authorIds = Array.from(new Set(savedPosts.map(sp => sp.post.userId)));
      const follows = await this.prisma.followerAndFollowing.findMany({
        where: { followerId: viewerUserId, followingId: { in: authorIds }, status: 'ACCEPTED' },
        select: { followingId: true },
      });
      var followMap: Record<string, boolean> = follows.reduce((acc, f) => { acc[f.followingId] = true; return acc; }, {} as Record<string, boolean>);
    }

    // ✅ Map savedPosts to return actual post info
    return savedPosts.map(sp => {
      const post = sp.post;
      return {
        id: post.id,
        text: post.text,
        images: post.images,
        thumbnails: post.thumbnails,
        caption: post.caption,
        hashtag: post.hashtag,
        location: post.location,
        music: post.music,
        youtubeMusicMeta: post.youtubeMusicMeta,
        taggedPeople: post.taggedPeople,
        createdAt: post.createdAt,
        updatedAt: post.updatedAt,
        deletedAt: post.deletedAt,
        userId: post.userId,
        userName: post.user?.displayName || null,
        userImage: post.user?.image || null,
        profileStatus: post.user?.profileStatus || null,
        profile: post.user?.profile || null,
        likeCount: post._count.likes,
        commentCount: post._count.comments,
        shareCount: post._count.shares,
        isSaved: savedSet.has(post.id),
        isLike: likedSet.has(post.id),
        isFollow: !!(typeof followMap !== 'undefined' && followMap[post.userId]),
        raiseAmount: post.raiseAmount,
        type: post.type,
        link: post.link,
        format: post.format,
        tableContent: post.tableContent,
        ebookpdf: post.ebookpdf,
        allowDownload: post.allowDownload,
        visibleTo: (post as any).visibleTo,
        private_circle: this.isPrivateCircleVisibility((post as any).visibleTo),
        start_time: post.start_time,
        end_time: post.end_time,
      };
    });
  }

  async sharePostToUser(mediaId: string, mediaType: string, conversationType: string, sharedUserId: string, receiverUserId: string) {
    if (!mediaId) throw new BadRequestException('Media ID required');
    if (!mediaType) throw new BadRequestException('Media type required');
    if (!conversationType) throw new BadRequestException('Conversation type required');
    if (!sharedUserId) throw new BadRequestException('Sender user ID required');
    if (!receiverUserId) throw new BadRequestException('Receiver user ID required');

    const normalizedMediaType = mediaType.trim().toUpperCase();
    if (!['POST', 'STORY', 'REEL', 'HIGHLIGHT'].includes(normalizedMediaType)) {
      throw new BadRequestException('mediaType must be one of: POST, STORY, REEL, HIGHLIGHT');
    }

    let isTrustPost: boolean | null = null;
    let ownerId: string | null = null;

    // Prevent sharing to self
    if (sharedUserId === receiverUserId) {
      throw new BadRequestException('Cannot share media to yourself');
    }

    // Find existing ChatBox between sender and receiver (bidirectional)
    let chatBox = await this.prisma.chatBox.findFirst({
      where: {
        OR: [
          { senderId: sharedUserId, receiverId: receiverUserId },
          { senderId: receiverUserId, receiverId: sharedUserId },
        ],
      },
    });

    // If no ChatBox exists, create one
    if (!chatBox) {
      chatBox = await this.prisma.chatBox.create({
        data: {
          senderId: sharedUserId,
          receiverId: receiverUserId,
        },
      });
    }

    // If mediaType is POST or REEL, create a PostShare record to track the share count
    if (normalizedMediaType === 'POST' || normalizedMediaType === 'REEL') {
      const post = await this.prisma.post.findUnique({
        where: { id: mediaId, deletedAt: null },
      });
      if (!post) throw new BadRequestException('Post not found');
      await this.ensureCanViewPost(post, sharedUserId);
      isTrustPost = post.isTrustPost;
      ownerId = post.userId;

      // Check if PostShare already exists (using unique constraint: postId, sharedUserId, receiverUserId)
      const existingPostShare = await this.prisma.postShare.findUnique({
        where: {
          postId_sharedUserId_receiverUserId: {
            postId: mediaId,
            sharedUserId: sharedUserId,
            receiverUserId: receiverUserId,
          },
        },
      });

      // Only create PostShare if it doesn't exist
      if (!existingPostShare) {
        await this.prisma.postShare.create({
          data: {
            postId: mediaId,
            sharedUserId: sharedUserId,
            receiverUserId: receiverUserId,
          },
        });
      }
    } else if (normalizedMediaType === 'STORY') {
      const story = await this.prisma.story.findUnique({
        where: { id: mediaId, deletedAt: null },
      });
      if (!story || story.isDeleted === 'yes') throw new BadRequestException('Story not found');
      ownerId = story.userId;
    } else if (normalizedMediaType === 'HIGHLIGHT') {
      const highlight = await this.prisma.storyHighlight.findUnique({
        where: { id: mediaId },
      });
      if (!highlight) throw new BadRequestException('Highlight not found');
      ownerId = highlight.userId;
    }

    // Always create a new conversation record for media share
    const conversation = await this.prisma.conversation.create({
      data: {
        type: 'MEDIA',
        senderId: sharedUserId,
        receiverId: receiverUserId,
        ownerId,
        mediaId,
        mediaType: normalizedMediaType as any,
        chatId: chatBox.id,
      },
    });

    return { message: 'Media shared successfully', conversationId: conversation.id, isTrustPost, ownerId };
  }

  async sharePostToUsers(
    mediaId: string,
    mediaType: string,
    conversationType: string,
    sharedUserId: string,
    receiverUserId: string[],
  ) {
    if (!Array.isArray(receiverUserId) || receiverUserId.length === 0) {
      throw new BadRequestException('Receiver user IDs required');
    }

    const results = [];
    let isTrustPost: boolean | null = null;
    let postOwnerId: string | null = null;

    for (const receiverId of receiverUserId) {
      try {
        const res = await this.sharePostToUser(
          mediaId,
          mediaType,
          conversationType,
          sharedUserId,
          receiverId,
        );
        isTrustPost = res.isTrustPost ?? isTrustPost;
        if (res.ownerId) {
          postOwnerId = res.ownerId;
        }
        results.push({
          receiverUserId: receiverId,
          status: 'success',
          conversationId: res.conversationId,
          ownerId: res.ownerId,
        });
      } catch (err: any) {
        results.push({
          receiverUserId: receiverId,
          status: 'failed',
          error: err?.message || 'Failed to share post',
        });
      }
    }

    return {
      message: 'Media share process completed',
      results,
      isTrustPost,
      ownerId: postOwnerId,
    };
  }

  async getSharedPostList(userId: string) {
    if (!userId) throw new BadRequestException('User ID required');

    const conversations = await this.prisma.conversation.findMany({
      where: {
        OR: [
          { senderId: userId },
          { receiverId: userId },
        ],
        type: 'MEDIA',
      },
      orderBy: { createdAt: 'desc' },
    });

    // Fetch media data separately based on mediaType
    const mediaConversations = conversations.filter(c => c.type === 'MEDIA');
    const postIds = mediaConversations
      .filter(c => c.mediaType === 'POST' || c.mediaType === 'REEL')
      .map(c => c.mediaId)
      .filter((id): id is string => id !== null);
    const storyIds = mediaConversations
      .filter(c => c.mediaType === 'STORY')
      .map(c => c.mediaId)
      .filter((id): id is string => id !== null);
    const highlightIds = mediaConversations
      .filter(c => c.mediaType === 'HIGHLIGHT')
      .map(c => c.mediaId)
      .filter((id): id is string => id !== null);

    const posts = postIds.length > 0 ? await this.prisma.post.findMany({
      where: {
        id: { in: postIds },
        deletedAt: null,
        AND: [this.buildPostVisibilityWhere(userId)],
      },
      include: {
        user: { select: { displayName: true, image: true, profileStatus: true, profile: true } },
        _count: { select: { likes: true, comments: true, shares: true } },
      },
    }) : [];

    const stories = storyIds.length > 0 ? await this.prisma.story.findMany({
      where: {
        id: { in: storyIds },
        deletedAt: null,
      },
      include: {
        user: { select: { displayName: true, image: true, profileStatus: true, profile: true } },
      },
    }) : [];

    const highlights = highlightIds.length > 0 ? await this.prisma.storyHighlight.findMany({
      where: { id: { in: highlightIds } },
      include: {
        user: { select: { displayName: true, image: true, profileStatus: true, profile: true } },
        items: {
          include: {
            story: {
              select: {
                id: true,
                media: true,
                thumbnails: true,
                caption: true,
                createdAt: true,
              },
            },
          },
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        },
      },
    }) : [];

    const postMap = new Map(posts.map(p => [p.id, p]));
    const storyMap = new Map(stories.map(s => [s.id, s]));
    const highlightMap = new Map(highlights.map(h => [h.id, h]));

    return conversations.map(conv => {
      const post = conv.mediaId ? postMap.get(conv.mediaId) : null;
      const story = conv.mediaId ? storyMap.get(conv.mediaId) : null;
      const highlight = conv.mediaId ? highlightMap.get(conv.mediaId) : null;
      return {
        id: conv.id,
        sharedAt: conv.createdAt,
        mediaType: conv.mediaType,
        content: conv.content,
        ownerId: conv.ownerId || (post?.userId ?? story?.userId ?? highlight?.userId ?? null),
        post: post && {
          id: post.id,
          ownerId: post.userId,
          text: post.text,
          images: post.images,
          thumbnails: post.thumbnails,
          caption: post.caption,
          hashtag: post.hashtag,
          location: post.location,
          music: post.music,
          youtubeMusicMeta: post.youtubeMusicMeta,
          taggedPeople: post.taggedPeople,
          createdAt: post.createdAt,
          updatedAt: post.updatedAt,
          deletedAt: post.deletedAt,
          userId: post.userId,
          userName: post.user?.displayName || null,
          userImage: post.user?.image || null,
          profileStatus: post.user?.profileStatus || null,
          profile: post.user?.profile || null,
          likeCount: post._count.likes,
          commentCount: post._count.comments,
          shareCount: post._count.shares,
          isTrustPost: post.isTrustPost,
          visibleTo: (post as any).visibleTo,
          private_circle: this.isPrivateCircleVisibility((post as any).visibleTo),
          type: post.type,
        },
        story: story && {
          id: story.id,
          ownerId: story.userId,
          caption: story.caption,
          media: story.media,
          thumbnails: story.thumbnails,
          storyMeta: story.storyMeta,
          createdAt: story.createdAt,
          updatedAt: story.updatedAt,
          userId: story.userId,
          userName: story.user?.displayName || null,
          userImage: story.user?.image || null,
          profileStatus: story.user?.profileStatus || null,
          profile: story.user?.profile || null,
        },
        highlight: highlight && {
          id: highlight.id,
          ownerId: highlight.userId,
          title: highlight.title,
          coverImage: highlight.coverImage,
          createdAt: highlight.createdAt,
          userId: highlight.userId,
          userName: highlight.user?.displayName || null,
          userImage: highlight.user?.image || null,
          profileStatus: highlight.user?.profileStatus || null,
          profile: highlight.user?.profile || null,
          itemCount: highlight.items.length,
          items: highlight.items.map(item => ({
            id: item.id,
            storyId: item.storyId,
            position: item.position,
            story: item.story,
          })),
        },
        sharedBy: {
          id: conv.senderId,
          // Note: sender details not fetched, can add if needed
        },
        receivedBy: {
          id: conv.receiverId,
          // Note: receiver details not fetched, can add if needed
        },
      };
    });
  }

  async deleteSharedPosts(shareIds: string[], userId: string) {
    if (!Array.isArray(shareIds) || shareIds.length === 0) throw new BadRequestException('Share IDs required');
    if (!userId) throw new BadRequestException('User ID required');

    // Find all conversation records for the given IDs
    const conversations = await this.prisma.conversation.findMany({
      where: { id: { in: shareIds }, type: 'MEDIA' },
    });

    // Filter to only those the user is authorized to delete
    const deletableIds = conversations
      .filter(conv => conv.senderId === userId || conv.receiverId === userId)
      .map(conv => conv.id);

    if (deletableIds.length === 0) throw new BadRequestException('No authorized shared posts to delete');

    // Delete all authorized conversation records
    await this.prisma.conversation.deleteMany({
      where: { id: { in: deletableIds }, type: 'MEDIA' },
    });

    return { message: 'Shared posts deleted successfully', deletedIds: deletableIds };
  }

  // async hidePost(postId: string, userId: string) {
  //   if (!postId || !userId) throw new BadRequestException('Post ID and User ID required');
  //   return this.prisma.hidePost.upsert({
  //     where: { postId_userId: { postId, userId } },
  //     update: {},
  //     create: { postId, userId },
  //   });
  // }


  async hidePost(postId: string, userId: string) {
    if (!postId || !userId) {
      throw new BadRequestException('Post ID and User ID required');
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Upsert hidePost
      // await tx.hidePost.upsert({
      //   where: { postId_userId: { postId, userId } },
      //   update: {},
      //   create: { postId, userId },
      // });

      const post = await tx.post.findUnique({ where: { id: postId } });
      if (!post || post.deletedAt) throw new BadRequestException('Post not found');
      await this.ensureCanViewPost(post, userId);

      // 2. Update post table
      const updatedPost = await tx.post.update({
        where: { id: postId },
        data: { postHide: 'yes' },
      });

      await tx.savePost.deleteMany({
        where: { postId },
      });
      return updatedPost;
    });
  }

  // async unhidePost(postId: string, userId: string) {
  //   if (!postId || !userId) throw new BadRequestException('Post ID and User ID required');
  //   await this.prisma.hidePost.deleteMany({ where: { postId, userId } });
  //   return { message: 'Post unhidden successfully' };
  // }


  async unhidePost(postId: string, userId: string) {
    if (!postId || !userId) {
      throw new BadRequestException('Post ID and User ID required');
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Remove hide entry
      // await tx.hidePost.deleteMany({
      //   where: { postId, userId },
      // });

      const post = await tx.post.findUnique({ where: { id: postId } });
      if (!post || post.deletedAt) throw new BadRequestException('Post not found');
      await this.ensureCanViewPost(post, userId);

      // 2. Update post table
      const updatedPost = await tx.post.update({
        where: { id: postId },
        data: { postHide: 'no' },
      });

      return {
        message: 'Post unhidden successfully',
        data: updatedPost,
      };
    });
  }

  // async getHidePost(userId: string) {
  //   if (!userId) throw new BadRequestException('User ID required');
  //   const hidden = await this.prisma.hidePost.findMany({
  //     where: { userId },
  //     orderBy: { createdAt: 'desc' },
  //     include: { post: true },
  //   });
  //   return hidden.map(h => h.post);
  // }

  async getHidePost(userId: string) {
    if (!userId) {
      throw new BadRequestException('User ID required');
    }

    const posts = await this.prisma.post.findMany({
      where: {
        userId: userId,
        postHide: 'yes',
        isDelete: 'no',
      },
      orderBy: {
        updatedAt: 'desc',
      },
    });

    return posts;
  }

  // Chat functionality using unified Conversation table
  async sendMessage(senderId: string, receiverId: string, message: string) {
    if (!senderId) throw new BadRequestException('Sender ID required');
    if (!receiverId) throw new BadRequestException('Receiver ID required');
    if (!message || message.trim() === '') throw new BadRequestException('Message required');

    // Prevent sending message to self
    if (senderId === receiverId) {
      throw new BadRequestException('Cannot send message to yourself');
    }

    // Verify both users exist before creating ChatBox
    const [sender, receiver] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: senderId } }),
      this.prisma.user.findUnique({ where: { id: receiverId } }),
    ]);

    if (!sender) {
      throw new BadRequestException('Sender user not found');
    }
    if (!receiver) {
      throw new BadRequestException('Receiver user not found');
    }

    // Find existing ChatBox between sender and receiver (bidirectional)
    let chatBox = await this.prisma.chatBox.findFirst({
      where: {
        OR: [
          { senderId, receiverId },
          { senderId: receiverId, receiverId: senderId },
        ],
      },
    });

    // If no ChatBox exists, create one
    if (!chatBox) {
      chatBox = await this.prisma.chatBox.create({
        data: {
          senderId,
          receiverId,
        },
      });
    }

    const conversation = await this.prisma.conversation.create({
      data: {
        type: 'CHAT',
        senderId,
        receiverId,
        content: message,
        chatId: chatBox.id,
      },
    });

    return conversation;
  }

  private async getSubscriptionRenewalDetailsForConversations(
    conversations: Array<{ id: string; senderId: string; receiverId: string; content?: string | null; chatType?: string | null }>,
  ) {
    const renewalConversations = conversations.filter(
      (c) => (c as any).chatType === 'subscription_renewal',
    );

    const renewalDataMap = new Map<string, Record<string, any>>();
    if (renewalConversations.length === 0) {
      return renewalDataMap;
    }

    const renewalPairs = renewalConversations.map((c) => ({
      fanUserId: c.receiverId,
      buyUserId: c.senderId,
    }));

    const fanUserIds = Array.from(new Set(renewalPairs.map((p) => p.fanUserId)));
    const creatorIds = Array.from(new Set(renewalPairs.map((p) => p.buyUserId)));

    const [fanSubs, notifications, creators, userSubs] = await Promise.all([
      this.prisma.fansSubscriptionBuyData.findMany({
        where: {
          fanUserId: { in: fanUserIds },
          buyUserId: { in: creatorIds },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.notification.findMany({
        where: {
          userId: { in: fanUserIds },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.findMany({
        where: {
          id: { in: creatorIds },
        },
        select: {
          id: true,
          displayName: true,
          userName: true,
          image: true,
        },
      }),
      this.prisma.userSubscription.findMany({
        where: {
          userId: { in: creatorIds },
          isDelete: 0,
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const fanSubMap = new Map<string, (typeof fanSubs)[0]>();
    for (const sub of fanSubs) {
      const key = `${sub.fanUserId}_${sub.buyUserId}`;
      if (!fanSubMap.has(key)) {
        fanSubMap.set(key, sub);
      }
    }

    const priceChangeNotifMap = new Map<string, Record<string, any>>();
    for (const notif of notifications) {
      const data = notif.data as any;
      if (data && data.type === 'subscription_price_changed' && data.creatorId) {
        const key = `${notif.userId}_${data.creatorId}`;
        if (!priceChangeNotifMap.has(key)) {
          priceChangeNotifMap.set(key, data);
        }
      }
    }

    const creatorMap = new Map(creators.map((c) => [c.id, c]));
    const userSubMap = new Map<string, (typeof userSubs)[0]>();
    for (const us of userSubs) {
      if (!userSubMap.has(us.userId)) {
        userSubMap.set(us.userId, us);
      }
    }

    for (const conv of renewalConversations) {
      const creatorId = conv.senderId;
      const fanUserId = conv.receiverId;
      const pairKey = `${fanUserId}_${creatorId}`;
      const sub = fanSubMap.get(pairKey);
      const notifData = priceChangeNotifMap.get(pairKey);
      const creator = creatorMap.get(creatorId);
      const creatorSub = userSubMap.get(creatorId);

      const priceMatch = conv.content?.match(/from\s+\$([0-9.]+)\s+to\s+\$([0-9.]+)/i);
      const extractedOldPrice = priceMatch ? Number(priceMatch[1]) : (creatorSub?.previousAmount ?? null);
      const extractedNewPrice = priceMatch ? Number(priceMatch[2]) : (creatorSub?.subscriptionAmount ?? null);
      const dateMatch = conv.content?.match(/until\s+([^.]+)\./i);
      const extractedEndDate = dateMatch ? dateMatch[1].trim() : null;

      const notifStatus = String(notifData?.status || notifData?.priceUpdateStatus || '').toUpperCase();
      let isAccepted =
        notifStatus === 'ACCEPTED' ||
        notifData?.isAccepted === true ||
        notifData?.isAccepted === 'true';
      let isDeclined =
        !isAccepted &&
        (notifStatus === 'CANCELLED' ||
          notifStatus === 'DECLINED' ||
          notifData?.isDeclined === true ||
          notifData?.isDeclined === 'true' ||
          notifData?.isCancelled === true ||
          notifData?.isCancelled === 'true');

      if (sub && sub.status === 'ACTIVE' && new Date(sub.endDate) > new Date()) {
        if (sub.autoRenew && !sub.cancelAtPeriodEnd) {
          isAccepted = true;
          isDeclined = false;
        }
      }

      const isPending = !isAccepted && !isDeclined;
      const priceUpdateStatus = isAccepted ? 'ACCEPTED' : (isDeclined ? 'DECLINED' : 'PENDING');

      const data = {
        creatorId,
        creatorName: creator?.displayName || creator?.userName || '',
        creatorImage: creator?.image || null,
        oldPrice: notifData?.oldPrice ? Number(notifData.oldPrice) : extractedOldPrice,
        newPrice: notifData?.newPrice ? Number(notifData.newPrice) : (extractedNewPrice ?? creatorSub?.subscriptionAmount ?? null),
        subscriptionId: sub?.id || notifData?.subscriptionId || null,
        endDate: sub?.endDate ? sub.endDate.toISOString() : (notifData?.endDate || extractedEndDate),
        priceUpdateStatus,
        isAccepted,
        isDeclined,
        isPending,
        hasPurchasedNewPrice: isAccepted,
        status: priceUpdateStatus,
      };

      renewalDataMap.set(conv.id, data);
    }

    return renewalDataMap;
  }

  async getConversations(userId: string) {
    if (!userId) throw new BadRequestException('User ID required');

    const conversations = await this.prisma.conversation.findMany({
      where: {
        OR: [
          { senderId: userId },
          { receiverId: userId },
        ],
      },
      orderBy: { createdAt: 'desc' },
      include: {
        sender: { select: { id: true, displayName: true, image: true } },
        receiver: { select: { id: true, displayName: true, image: true } },
      },
    });

    const renewalDataMap = await this.getSubscriptionRenewalDetailsForConversations(conversations);

    return conversations.map(conv => {
      const renewalData = renewalDataMap.get(conv.id);
      return {
        id: conv.id,
        type: conv.type,
        chatType: (conv as any).chatType,
        typeOfChat: (conv as any).chatType,
        content: conv.content,
        createdAt: conv.createdAt,
        sender: conv.sender,
        receiver: conv.receiver,
        post: null,
        story: null,
        highlight: null,
        ...(renewalData
          ? {
              creatorId: renewalData.creatorId,
              creatorName: renewalData.creatorName,
              creatorImage: renewalData.creatorImage,
              oldPrice: renewalData.oldPrice,
              newPrice: renewalData.newPrice,
              subscriptionId: renewalData.subscriptionId,
              endDate: renewalData.endDate,
              priceUpdateStatus: renewalData.priceUpdateStatus,
              isAccepted: renewalData.isAccepted,
              isDeclined: renewalData.isDeclined,
              isPending: renewalData.isPending,
              hasPurchasedNewPrice: renewalData.hasPurchasedNewPrice,
              status: renewalData.status,
              subscriptionRenewalData: renewalData,
            }
          : {}),
      };
    });
  }

  async getUserChatBox(userId: string) {
    if (!userId) throw new BadRequestException('User ID required');

    const chatBoxes = await this.prisma.chatBox.findMany({
      where: {
        OR: [
          { senderId: userId },
          { receiverId: userId },
        ],
      },
      include: {
        sender: {
          select: {
            id: true,
            displayName: true,
            image: true,
            profile: true,
            profileStatus: true,
          },
        },
        receiver: {
          select: {
            id: true,
            displayName: true,
            image: true,
            profile: true,
            profileStatus: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Get conversation details for each chatBox
    const chatBoxIds = chatBoxes.map(cb => cb.id);
    const conversations = await this.prisma.conversation.findMany({
      where: {
        chatId: { in: chatBoxIds },
      },
      select: {
        id: true,
        senderId: true,
        receiverId: true,
        isSeen: true,
        chatId: true,
        createdAt: true,
        content: true,
        type: true,
        chatType: true,
        mediaId: true,
        mediaType: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    // Group conversations by chatId
    const conversationsByChatId = conversations.reduce((acc, conv) => {
      if (!acc[conv.chatId!]) {
        acc[conv.chatId!] = [];
      }
      acc[conv.chatId!].push(conv);
      return acc;
    }, {} as Record<string, any[]>);

    const result = chatBoxes.map(chatBox => {
      const isSender = chatBox.senderId === userId;
      const user = isSender ? chatBox.receiver : chatBox.sender;
      const chatConversations = conversationsByChatId[chatBox.id] || [];
      const lastMessage = chatConversations.length > 0 ? chatConversations[0] : null;

      // Instagram-like behavior:
      // - If I (current user) sent the last message, my unreadCount = 0
      // - If the other user sent the last message, count all unread messages I received from them
      let unreadCount = 0;

      if (lastMessage && lastMessage.senderId === userId) {
        // Current user sent the last message, so unreadCount = 0
        // (Even if there are old unread messages, we don't show them because user is actively chatting)
        unreadCount = 0;
      } else {
        // Other user sent the last message (or no messages), count all unread messages received
        unreadCount = chatConversations.filter(
          conv => {
            // Only count messages that:
            // 1. Are unread (isSeen === 0)
            // 2. Were received by the current user (receiverId === userId)
            // 3. Were NOT sent by the current user (senderId !== userId)
            return conv.isSeen === 0 && conv.receiverId === userId && conv.senderId !== userId;
          }
        ).length;
      }

      return {
        id: chatBox.id,
        createdAt: chatBox.createdAt,
        updatedAt: chatBox.updatedAt,
        user: user,
        unreadCount,
        lastMessage,
        isHidden: chatBox.hiddenBy.includes(userId),
        sortKey: lastMessage ? lastMessage.createdAt : chatBox.createdAt,
      };
    });

    // Sort by latest conversation activity (descending)
    result.sort((a, b) => new Date(b.sortKey).getTime() - new Date(a.sortKey).getTime());

    // Remove sortKey from response
    return result.map(({ sortKey, ...item }) => item);
  }

  async getConversationWithUser(userId: string, otherUserId: string) {
    if (!userId) throw new BadRequestException('User ID required');
    if (!otherUserId) throw new BadRequestException('Other user ID required');

    const conversations = await this.prisma.conversation.findMany({
      where: {
        OR: [
          { senderId: userId, receiverId: otherUserId },
          { senderId: otherUserId, receiverId: userId },
        ],
      },
      orderBy: { createdAt: 'desc' },
      include: {
        sender: { select: { id: true, displayName: true, image: true } },
        receiver: { select: { id: true, displayName: true, image: true } },
      },
    });

    // Collect media IDs for MEDIA type conversations
    const mediaConversations = conversations.filter(c => c.type === 'MEDIA');
    const postIds = mediaConversations
      .filter(c => c.mediaType === 'POST' || c.mediaType === 'REEL')
      .map(c => c.mediaId)
      .filter((id): id is string => id !== null);
    const storyIds = mediaConversations
      .filter(c => c.mediaType === 'STORY')
      .map(c => c.mediaId)
      .filter((id): id is string => id !== null);
    const highlightIds = mediaConversations
      .filter(c => c.mediaType === 'HIGHLIGHT')
      .map(c => c.mediaId)
      .filter((id): id is string => id !== null);

    // Fetch posts with user details
    const posts = postIds.length > 0 ? await this.prisma.post.findMany({
      where: {
        id: { in: postIds },
        deletedAt: null,
        AND: [this.buildPostVisibilityWhere(userId)],
      },
      include: {
        user: { select: { id: true, displayName: true, image: true, profile: true } },
      },
    }) : [];

    // Fetch stories with user details
    const stories = storyIds.length > 0 ? await this.prisma.story.findMany({
      where: { id: { in: storyIds } },
      include: {
        user: { select: { id: true, displayName: true, image: true, profile: true } },
      },
    }) : [];

    // Fetch highlights with user details and stories
    const highlights = highlightIds.length > 0 ? await this.prisma.storyHighlight.findMany({
      where: { id: { in: highlightIds } },
      include: {
        user: { select: { id: true, displayName: true, image: true, profile: true } },
        items: {
          include: {
            story: {
              select: {
                id: true,
                media: true,
                thumbnails: true,
                caption: true,
                createdAt: true,
              },
            },
          },
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        },
      },
    }) : [];

    // Create maps for quick lookup
    const postMap = new Map(posts.map(p => [p.id, p]));
    const storyMap = new Map(stories.map(s => [s.id, s]));
    const highlightMap = new Map(highlights.map(h => [h.id, h]));

    const renewalDataMap = await this.getSubscriptionRenewalDetailsForConversations(conversations);

    return conversations.map(conv => {
      let post = null;
      let story = null;
      let highlight = null;
      const renewalData = renewalDataMap.get(conv.id);

      if (conv.type === 'MEDIA' && conv.mediaId) {
        if (conv.mediaType === 'POST' || conv.mediaType === 'REEL') {
          const p = postMap.get(conv.mediaId);
          if (p) {
            post = {
              id: p.id,
              ownerId: p.userId,
              text: p.text,
              images: p.images,
              thumbnails: p.thumbnails,
              caption: p.caption,
              hashtag: p.hashtag,
              location: p.location,
              music: p.music,
              youtubeMusicMeta: p.youtubeMusicMeta,
              taggedPeople: p.taggedPeople,
              createdAt: p.createdAt,
              updatedAt: p.updatedAt,
              deletedAt: p.deletedAt,
              userId: p.userId,
              userName: p.user.displayName,
              userImage: p.user.image,
              profile: p.user.profile,
              type: p.type,
              link: p.link,
              visibleTo: p.visibleTo,
              private_circle: this.isPrivateCircleVisibility(p.visibleTo),
              start_time: p.start_time,
              end_time: p.end_time,
              raiseAmount: p.raiseAmount,
              isTrustPost: p.isTrustPost,
            };
          }
        } else if (conv.mediaType === 'STORY') {
          const s = storyMap.get(conv.mediaId);
          if (s) {
            story = {
              id: s.id,
              ownerId: s.userId,
              caption: s.caption,
              media: s.media,
              thumbnails: s.thumbnails,
              storyMeta: s.storyMeta,
              createdAt: s.createdAt,
              updatedAt: s.updatedAt,
              userId: s.userId,
              userName: s.user.displayName,
              userImage: s.user.image,
              profile: s.user.profile,
            };
          }
        } else if (conv.mediaType === 'HIGHLIGHT') {
          const h = highlightMap.get(conv.mediaId);
          if (h) {
            highlight = {
              id: h.id,
              ownerId: h.userId,
              title: h.title,
              coverImage: h.coverImage,
              createdAt: h.createdAt,
              userId: h.userId,
              userName: h.user?.displayName || null,
              userImage: h.user?.image || null,
              profile: h.user?.profile || null,
              itemCount: h.items.length,
              items: h.items.map(item => ({
                id: item.id,
                storyId: item.storyId,
                position: item.position,
                story: item.story,
              })),
            };
          }
        }
      }
      return {
        id: conv.id,
        type: conv.type,
        chatType: (conv as any).chatType,
        typeOfChat: (conv as any).chatType,
        content: conv.content,
        mediaType: conv.mediaType,
        ownerId: conv.ownerId || (post?.ownerId ?? story?.ownerId ?? highlight?.ownerId ?? null),
        music: post?.music ?? null,
        createdAt: conv.createdAt,
        isSeen: conv.isSeen,
        sender: conv.sender,
        receiver: conv.receiver,
        post,
        story,
        highlight,
        ...(renewalData
          ? {
              creatorId: renewalData.creatorId,
              creatorName: renewalData.creatorName,
              creatorImage: renewalData.creatorImage,
              oldPrice: renewalData.oldPrice,
              newPrice: renewalData.newPrice,
              subscriptionId: renewalData.subscriptionId,
              endDate: renewalData.endDate,
              priceUpdateStatus: renewalData.priceUpdateStatus,
              isAccepted: renewalData.isAccepted,
              isDeclined: renewalData.isDeclined,
              isPending: renewalData.isPending,
              hasPurchasedNewPrice: renewalData.hasPurchasedNewPrice,
              status: renewalData.status,
              subscriptionRenewalData: renewalData,
            }
          : {}),
      };
    });
  }

  async chatStatusUpdate(chatId: string) {
    if (!chatId) throw new BadRequestException('Chat ID required');

    // Update all conversation records where chatId matches and isSeen is 0 to set isSeen to 1
    const result = await this.prisma.conversation.updateMany({
      where: {
        chatId,
        isSeen: 0,
      },
      data: {
        isSeen: 1,
      },
    });

    return {
      message: 'Chat status updated successfully',
      updatedCount: result.count,
    };
  }

  async messageSeenUpdate(messageId: string, userId: string) {
    if (!messageId) throw new BadRequestException('Message ID required');
    if (!userId) throw new BadRequestException('User ID required');

    // Only the receiver can mark a message as seen
    const result = await this.prisma.conversation.updateMany({
      where: {
        id: messageId,
        receiverId: userId,
        isSeen: 0,
      },
      data: {
        isSeen: 1,
      },
    });

    return {
      message: 'Message seen updated successfully',
      updatedCount: result.count,
    };
  }

  async hideChat(chatId: string, userId: string) {
    if (!chatId) throw new BadRequestException('Chat ID required');
    if (!userId) throw new BadRequestException('User ID required');

    // Find the chatBox
    const chatBox = await this.prisma.chatBox.findUnique({
      where: { id: chatId },
    });

    if (!chatBox) {
      throw new BadRequestException('Chat not found');
    }

    // Check if user is part of this chat
    if (chatBox.senderId !== userId && chatBox.receiverId !== userId) {
      throw new BadRequestException('Unauthorized to hide this chat');
    }

    // Add userId to hiddenBy array
    const updatedHiddenBy = [...(chatBox.hiddenBy || []), userId];

    // If both users have hidden the chat, delete it completely
    if (updatedHiddenBy.length >= 2) {
      // Delete all conversations first
      await this.prisma.conversation.deleteMany({
        where: { chatId },
      });

      // Then delete the chatBox
      await this.prisma.chatBox.delete({
        where: { id: chatId },
      });

      return { message: 'Chat deleted permanently' };
    } else {
      // Just hide for this user
      await this.prisma.chatBox.update({
        where: { id: chatId },
        data: { hiddenBy: updatedHiddenBy },
      });

      return { message: 'Chat hidden successfully' };
    }
  }

  async unhideChat(chatId: string, userId: string) {
    if (!chatId) throw new BadRequestException('Chat ID required');
    if (!userId) throw new BadRequestException('User ID required');

    // Find the chatBox
    const chatBox = await this.prisma.chatBox.findUnique({
      where: { id: chatId },
    });

    if (!chatBox) {
      throw new BadRequestException('Chat not found');
    }

    // Remove userId from hiddenBy array
    const updatedHiddenBy = (chatBox.hiddenBy || []).filter(id => id !== userId);

    await this.prisma.chatBox.update({
      where: { id: chatId },
      data: { hiddenBy: updatedHiddenBy },
    });

    return { message: 'Chat unhidden successfully' };
  }

}
