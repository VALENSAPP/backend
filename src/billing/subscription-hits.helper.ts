import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from '../notification/notification.service';

const logger = new Logger('SubscriptionHitsHelper');

/**
 * Ensures active yearly/monthly subscribers receive their 5 monthly subscription hits
 * for the current 30-day window.
 *
 * Rules:
 * 1. User must have subscriptionStatus === 'ACTIVE' and currentPeriodEnd > now.
 * 2. Unused subscription hits from previous cycle expire (never accumulate).
 * 3. Purchased hits (purchasedHitsLeft) are preserved.
 * 4. Total hits = 5 + purchasedHitsLeft.
 * 5. subscriptionHitsExpiresAt = min(now + 30 days, currentPeriodEnd).
 * 6. Atomic update with condition to prevent double grants / race conditions.
 * 7. Sends localized push / in-app notification upon successful refresh.
 */
export async function ensureMonthlySubscriptionHits(
  prisma: PrismaService,
  userId: string,
  notificationService?: NotificationService,
): Promise<boolean> {
  if (!userId) return false;

  const now = new Date();

  // 1. Check user subscription status
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      subscriptionStatus: true,
      currentPeriodEnd: true,
      isDeleted: true,
      deletedAt: true,
    },
  });

  if (!user || user.isDeleted || user.deletedAt) return false;
  if (user.subscriptionStatus !== 'ACTIVE' || !user.currentPeriodEnd || user.currentPeriodEnd <= now) {
    return false;
  }

  // 2. Fetch existing PostHit record
  const postHit = await prisma.postHit.findFirst({
    where: { userId },
  });

  // If hits are already active for the current window, no refresh needed
  if (postHit?.subscriptionHitsExpiresAt && postHit.subscriptionHitsExpiresAt > now) {
    return false;
  }

  // 3. Compute new expiration: 30 days from now, but capped at the subscription's currentPeriodEnd
  const thirtyDaysLater = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const nextExpiry = thirtyDaysLater < user.currentPeriodEnd ? thirtyDaysLater : user.currentPeriodEnd;

  const purchasedHits = postHit?.purchasedHitsLeft || 0;

  // 4. Atomic update / create
  let wasGranted = false;

  if (postHit) {
    // Atomic update guarded by where clause to prevent race conditions
    const updateResult = await prisma.postHit.updateMany({
      where: {
        id: postHit.id,
        OR: [
          { subscriptionHitsExpiresAt: null },
          { subscriptionHitsExpiresAt: { lte: now } },
        ],
      },
      data: {
        subscriptionHitsLeft: 5,
        subscriptionHitsExpiresAt: nextExpiry,
        hitLeft: 5 + purchasedHits,
      },
    });

    wasGranted = updateResult.count > 0;
  } else {
    try {
      await prisma.postHit.create({
        data: {
          userId,
          subscriptionHitsLeft: 5,
          subscriptionHitsExpiresAt: nextExpiry,
          purchasedHitsLeft: 0,
          hitLeft: 5,
        },
      });
      wasGranted = true;
    } catch {
      // Record might have been created concurrently
      wasGranted = false;
    }
  }

  // 5. Send notification if hits were granted
  if (wasGranted && notificationService) {
    try {
      await notificationService.sendNotificationToUser(
        userId,
        'Monthly Hits Renewed!',
        'Your 5 monthly subscription hits for this cycle have been added. They are valid for 30 days.',
        { type: 'monthly_hits_renewed' },
      );
    } catch (err: any) {
      logger.warn(`Failed to send monthly hits renewal notification to user ${userId}: ${err?.message || err}`);
    }
  }

  return wasGranted;
}

