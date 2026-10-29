import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { GetSubscribersQueryDto, SubscriberSortBy, SubscriberStatusFilter } from './dto/get-subscribers-query.dto';
import { GetMySubscriptionsQueryDto, SubscriptionSortBy, SubscriptionStatusFilter } from './dto/get-my-subscriptions-query.dto';
import { CancelPayFollowingSubscriptionDto } from './dto/cancel-pay-following-subscription.dto';
import { RespondPriceChangeDto, PriceChangeResponseAction } from './dto/respond-price-change.dto';
import { GetPriceUpdateSubscribersQueryDto, PriceUpdateResponseStatusFilter, PriceUpdateSubscriberSortBy } from './dto/get-price-update-subscribers.dto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from '../notification/notification.service';
import {
  normalizeLanguage,
  translatePaymentType,
  translatePaymentStatus,
  translateTypeTransaction,
} from './payment.translator';
import { WalletService } from '../wallet/wallet.service';
import { PagBankService } from '../pagbank/pagbank.service';
import { PaymentProviderResolver } from '../marketPlace/payment/payment-provider.resolver';
import { CurrencyConverterService } from '../common/currency/currency-converter.service';
import Stripe from 'stripe';
import { ethers } from 'ethers';
import { v4 as uuidv4 } from 'uuid';

const PLATFORM_POINTS_HIT_COST = 1000;
const PLATFORM_POINTS_HIT_COUNT = 1;
export const MAX_PURCHASED_HITS = 5;
const MIN_WITHDRAWAL_MAJOR = 10;

@Injectable()
export class BillingService {
  private stripe: Stripe;
  private readonly usdtInterface = new ethers.Interface([
    'event Transfer(address indexed from, address indexed to, uint256 value)',
  ]);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationService: NotificationService,
    private readonly walletService: WalletService,
    private readonly pagBankService: PagBankService,
    private readonly paymentProviderResolver: PaymentProviderResolver,
    private readonly currencyConverter: CurrencyConverterService,
  ) {
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
      apiVersion: '2024-06-20',
    });
  }

  private getRpcUrlForChain(chain: string): string {
    const normalized = chain.toUpperCase();
    const mapping: Record<string, string | undefined> = {
      POLYGON: process.env.POLYGON_RPC_URL,
    };
    return mapping[normalized] || '';
  }

  private getUsdtAddressForChain(chain: string): string {
    const normalized = chain.toUpperCase();
    const mapping: Record<string, string | undefined> = {
      POLYGON: process.env.USDT_ADDRESS_POLYGON || '0xc2132D05D31c914a87C6611C10748AaCB3b14dD6',
    };
    return mapping[normalized] || '';
  }

  async ensureStripeCustomer(userId: string) {
    if (!userId) throw new BadRequestException('User ID required');
    const provider = await this.paymentProviderResolver.resolveProviderForUser(userId);
    if (provider === 'PAGBANK') {
      throw new BadRequestException(
        'Brazil users use PagBank only. Stripe checkout is not available for this account.',
      );
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');
    if (user.stripeCustomerId) return user.stripeCustomerId;
    const customer = await this.stripe.customers.create({
      metadata: { userId },
      email: user.email || undefined,
    });
    await this.prisma.user.update({ where: { id: userId }, data: { stripeCustomerId: customer.id } });
    return customer.id;
  }

  async createCheckoutSession(userId: string) {
    const provider = await this.paymentProviderResolver.resolveProviderForUser(userId);
    if (provider === 'PAGBANK') {
      return this.createPagBankValensSubscriptionCheckout(userId);
    }

    const customerId = await this.ensureStripeCustomer(userId);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { profile: true } });
    if (!user) throw new BadRequestException('User not found');
    const isCompany = (user.profile || '').toLowerCase() === 'company';
    const priceId = (isCompany ? process.env.STRIPE_PRICE_ID_Business : process.env.STRIPE_PRICE_ID) as string;
    const successUrl = process.env.STRIPE_SUCCESS_URL as string;
    const cancelUrl = process.env.STRIPE_CANCEL_URL as string;
    if (!priceId || !successUrl || !cancelUrl) {
      throw new BadRequestException(
        'Missing STRIPE_PRICE_ID/STRIPE_PRICE_ID_Business/STRIPE_SUCCESS_URL/STRIPE_CANCEL_URL env vars',
      );
    }
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      success_url: successUrl,
      cancel_url: cancelUrl,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      metadata: { userId },
    });
    return session;
  }

  /**
  /**
   * BR Valens plan: one-time PIX for ~1 month access (PagBank has no Stripe-style recurring Billing).
   * Persona: R$ 14.90 (1490 centavos) default / PAGBANK_SUBSCRIPTION_AMOUNT_PERSONA_MINOR
   * Business: R$ 29.90 (2990 centavos) default / PAGBANK_SUBSCRIPTION_AMOUNT_BUSINESS_MINOR
   */
  private async resolveValensSubscriptionAmountMinor(userId: string): Promise<number> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { profile: true } });
    const isCompany =
      (user?.profile || '').toLowerCase() === 'company' ||
      (user?.profile || '').toLowerCase() === 'business';

    if (isCompany) {
      const businessAmount = Number(
        process.env.PAGBANK_SUBSCRIPTION_AMOUNT_BUSINESS_MINOR ||
        process.env.PAGBANK_SUBSCRIPTION_AMOUNT_MINOR ||
        2990,
      );
      if (businessAmount > 0) return Math.round(businessAmount);
    } else {
      const personaAmount = Number(
        process.env.PAGBANK_SUBSCRIPTION_AMOUNT_PERSONA_MINOR ||
        process.env.PAGBANK_SUBSCRIPTION_AMOUNT_MINOR ||
        1490,
      );
      if (personaAmount > 0) return Math.round(personaAmount);
    }

    const priceId = (isCompany ? process.env.STRIPE_PRICE_ID_Business : process.env.STRIPE_PRICE_ID) as string;
    if (priceId) {
      try {
        const price = await this.stripe.prices.retrieve(priceId);
        const amount = price.unit_amount || 0;
        if (amount > 0) return amount;
      } catch {
        // Fall back to default Brazilian minor units
      }
    }
    return isCompany ? 2990 : 1490;
  }

  private async createPagBankValensSubscriptionCheckout(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, displayName: true, userName: true },
    });
    if (!user) throw new BadRequestException('User not found');

    const amountMinor = await this.resolveValensSubscriptionAmountMinor(userId);
    const periodStart = new Date();
    const periodEnd = new Date(periodStart);
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    const payment = await this.prisma.payment.create({
      data: {
        userId,
        amount: Number((amountMinor / 100).toFixed(2)),
        totalAmount: Number((amountMinor / 100).toFixed(2)),
        currency: 'BRL',
        status: 'pending',
        forPayment: 'subscription',
        periodStart,
        periodEnd,
      },
    });

    const checkout = await this.pagBankService.createPixCheckout({
      referenceId: payment.id,
      amountMinor,
      description: 'Valens Subscription',
      customerEmail: user.email || undefined,
      customerName: user.displayName || user.userName || undefined,
    });

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { stripePaymentIntentId: checkout.orderId },
    });

    return {
      id: checkout.orderId,
      url: checkout.checkoutUrl,
      ...checkout,
    };
  }

  /** Default platform fee: Valens keeps 5%, rest goes to creator's Stripe Connect account (no holding). */
  private get PLATFORM_FEE_PERCENT(): number {
    return Number(process.env.PLATFORM_FEE_MISSION_POST_PERCENT || 0.05);
  }
  /** Pay-following / Private Subscriber Content platform fee: Valens keeps 20%, rest credits creator available wallet. */
  private get PAY_FOLLOWING_PLATFORM_FEE_PERCENT(): number {
    return Number(process.env.PLATFORM_FEE_PRIVATE_CONTENT_PERCENT || 0.20);
  }
  /** Ebook platform fee: Valens keeps 10%, rest goes to seller Stripe Connect account. */
  private get EBOOK_PLATFORM_FEE_PERCENT(): number {
    return Number(process.env.PLATFORM_FEE_EBOOK_PERCENT || 0.10);
  }

  private getPayFollowingAmountSplit(amountCents: number) {
    const totalAmount = Number((amountCents / 100).toFixed(2));
    const platformFeeCents = Math.round(amountCents * this.PAY_FOLLOWING_PLATFORM_FEE_PERCENT);
    const receiverAmountCents = Math.max(0, amountCents - platformFeeCents);
    const platformFee = Number((platformFeeCents / 100).toFixed(2));
    const receiverAmount = Number((receiverAmountCents / 100).toFixed(2));

    return {
      totalAmount,
      platformFee,
      receiverAmount,
      platformFeeCents,
      receiverAmountCents,
    };
  }

  private getTipAmountSplit(amountCents: number) {
    const totalAmount = Number((amountCents / 100).toFixed(2));
    const platformFeeCents = 0;
    const receiverAmountCents = Math.max(0, amountCents - platformFeeCents);
    const platformFee = 0;
    const receiverAmount = totalAmount;

    return {
      totalAmount,
      platformFee,
      receiverAmount,
      platformFeeCents,
      receiverAmountCents,
    };
  }

  private getEbookAmountSplit(amountCents: number) {
    const totalAmount = Math.round(amountCents / 100);
    const platformFeeCents = Math.round(amountCents * this.EBOOK_PLATFORM_FEE_PERCENT);
    const receiverAmountCents = Math.max(0, amountCents - platformFeeCents);
    const platformFee = Math.round(platformFeeCents / 100);
    const receiverAmount = Math.max(0, totalAmount - platformFee);

    return {
      totalAmount,
      platformFee,
      receiverAmount,
      platformFeeCents,
      receiverAmountCents,
    };
  }

  private sumStripeBalanceByCurrency(
    rows: Array<{ amount: number; currency: string }> | null | undefined,
    currency: string,
  ): number {
    if (!rows?.length) return 0;
    const normalized = (currency || 'usd').toLowerCase();
    return rows
      .filter((row) => (row.currency || '').toLowerCase() === normalized)
      .reduce((sum, row) => sum + Math.trunc(row.amount || 0), 0);
  }

  private toMajor(amountMinor: number): number {
    return Number((amountMinor / 100).toFixed(2));
  }

  /**
   * Wallet balance plus provider live availability.
   * effectiveWithdrawableNow = min(app wallet available, provider available now).
   */
  async getWalletBalanceWithProviderAvailability(userId: string) {
    const provider = await this.paymentProviderResolver.ensureUserPaymentProvider(userId);
    const currency = provider === 'PAGBANK' ? 'brl' : 'usd';

    // Keep provider/currency scoped totals for withdrawal calculations.
    const wallet = await this.walletService.getBalance(userId, { currency, provider });

    if (provider === 'PAGBANK') {
      const appWithdrawableMinor = wallet.availableBalanceMinor;
      return {
        ...wallet,
        provider,
        currency,
        appWithdrawableBalanceMinor: appWithdrawableMinor,
        appWithdrawableBalance: this.toMajor(appWithdrawableMinor),
        providerAvailableBalanceMinor: appWithdrawableMinor,
        providerAvailableBalance: this.toMajor(appWithdrawableMinor),
        providerPendingBalanceMinor: 0,
        providerPendingBalance: 0,
        effectiveWithdrawableNowMinor: appWithdrawableMinor,
        effectiveWithdrawableNow: this.toMajor(appWithdrawableMinor),
        providerAvailabilitySource: 'wallet',
        providerAvailabilityNote:
          'PagBank provider live balance API is not queried here. Effective amount uses wallet availability.',
      };
    }

    const appWithdrawableMinor = wallet.availableBalanceMinor;

    try {
      const stripeAccount = await this.stripe.accounts.retrieve();
      const platformBalance = await this.stripe.balance.retrieve();
      const providerAvailableMinor = this.sumStripeBalanceByCurrency(
        platformBalance.available as Array<{ amount: number; currency: string }> | undefined,
        currency,
      );
      const providerPendingMinor = this.sumStripeBalanceByCurrency(
        platformBalance.pending as Array<{ amount: number; currency: string }> | undefined,
        currency,
      );
      const effectiveMinor = Math.min(appWithdrawableMinor, providerAvailableMinor);

      return {
        ...wallet,
        provider,
        currency,
        appWithdrawableBalanceMinor: appWithdrawableMinor,
        appWithdrawableBalance: this.toMajor(appWithdrawableMinor),
        providerAvailableBalanceMinor: providerAvailableMinor,
        providerAvailableBalance: this.toMajor(providerAvailableMinor),
        providerPendingBalanceMinor: providerPendingMinor,
        providerPendingBalance: this.toMajor(providerPendingMinor),
        effectiveWithdrawableNowMinor: effectiveMinor,
        effectiveWithdrawableNow: this.toMajor(effectiveMinor),
        providerAvailabilitySource: 'stripe_platform_balance',
        stripeAccountId: stripeAccount.id,
        stripeBalanceFetchedAt: new Date().toISOString(),
      };
    } catch (error: any) {
      return {
        ...wallet,
        provider,
        currency,
        appWithdrawableBalanceMinor: appWithdrawableMinor,
        appWithdrawableBalance: this.toMajor(appWithdrawableMinor),
        providerAvailableBalanceMinor: null,
        providerAvailableBalance: null,
        providerPendingBalanceMinor: null,
        providerPendingBalance: null,
        effectiveWithdrawableNowMinor: null,
        effectiveWithdrawableNow: null,
        providerAvailabilitySource: 'stripe_platform_balance_error',
        stripeBalanceFetchedAt: new Date().toISOString(),
        providerAvailabilityError: error?.message || 'Unable to fetch Stripe platform balance',
      };
    }
  }

  /** Check if user has completed provider onboarding and can withdraw. */
  async getOnboardingStatus(userId: string): Promise<{
    canReceivePayments: boolean;
    onboardingUrl?: string;
    accountId?: string;
    message?: string;
    provider: 'STRIPE' | 'PAGBANK';
    country?: string | null;
  }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');

    const provider = await this.paymentProviderResolver.ensureUserPaymentProvider(userId);

    if (provider === 'PAGBANK') {
      const status = await this.pagBankService.getOnboardingStatus(userId);
      return { ...status, country: user.country };
    }

    if (!user.stripeAccountId) {
      return {
        provider: 'STRIPE',
        country: user.country,
        canReceivePayments: false,
        message: 'Complete Stripe onboarding to withdraw available balance.',
      };
    }
    try {
      const account = await this.stripe.accounts.retrieve(user.stripeAccountId);
      const canReceive = !!(account.details_submitted && account.payouts_enabled !== false);
      return {
        provider: 'STRIPE',
        country: user.country,
        canReceivePayments: canReceive,
        accountId: user.stripeAccountId,
        message: canReceive
          ? undefined
          : 'Finish onboarding (e.g. add bank account) to withdraw.',
      };
    } catch {
      return {
        provider: 'STRIPE',
        country: user.country,
        canReceivePayments: false,
        accountId: user.stripeAccountId,
        message: 'Stripe account not ready.',
      };
    }
  }

  /** Throws if user cannot receive withdrawals to Connect (onboarding required). */
  private async requireCanReceivePayments(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');
    if (!user.stripeAccountId) {
      throw new BadRequestException(
        'Complete Stripe onboarding before withdrawing. Call POST /billing/create-onboarding-link first.',
      );
    }
    const account = await this.stripe.accounts.retrieve(user.stripeAccountId);
    if (!account.details_submitted) {
      throw new BadRequestException(
        'Finish Stripe onboarding (identity and bank details) before withdrawing.',
      );
    }
    return user.stripeAccountId;
  }

  private async ensureUserExists(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) throw new BadRequestException('User not found');
  }

  /** Credit seller available wallet (idempotent via payment ref). Uses seller paymentProvider and handles FX conversion if currency differs. */
  private async creditSellerAvailableWallet(params: {
    sellerUserId: string;
    amountMinor: number;
    source: 'TIP' | 'FOLLOWING' | 'EBOOK' | 'SHOP_EBOOK' | 'FAN_SUBSCRIPTION' | 'MISSION_DONATION';
    refId: string;
    note?: string;
    currency?: string;
  }) {
    if (!params.sellerUserId || params.amountMinor <= 0) return;
    const provider = await this.paymentProviderResolver.resolveProviderForUser(params.sellerUserId);
    const targetCurrency = provider === 'PAGBANK' ? 'brl' : 'usd';
    const sourceCurrency = (params.currency || targetCurrency).toLowerCase();

    let amountMinor = Math.round(params.amountMinor);
    if (sourceCurrency !== targetCurrency) {
      amountMinor = await this.currencyConverter.convertMinor(
        amountMinor,
        sourceCurrency,
        targetCurrency,
      );
    }

    await this.walletService.creditAvailable({
      userId: params.sellerUserId,
      amountMinor,
      currency: targetCurrency,
      provider,
      source: params.source,
      refType: 'PAYMENT',
      refId: params.refId,
      note: `${params.note || 'Seller payment'}${sourceCurrency !== targetCurrency ? ` (converted from ${params.amountMinor} ${sourceCurrency.toUpperCase()})` : ''}`,
    });
  }

  async createOneTimePaymentCheckoutSession(
    payerUserId: string,
    contentUserId: string,
    amount: number,
    isAutoRenew: boolean = true,
  ) {
    await this.ensureUserExists(contentUserId);

    const payerProvider = await this.paymentProviderResolver.resolveProviderForUser(payerUserId);
    if (payerProvider === 'PAGBANK') {
      return this.createPagBankFollowingCheckout(payerUserId, contentUserId, amount);
    }

    const customerId = await this.ensureStripeCustomer(payerUserId);
    const successUrl = process.env.STRIPE_SUCCESS_URL as string;
    const cancelUrl = process.env.STRIPE_CANCEL_URL as string;
    if (!successUrl || !cancelUrl) {
      throw new BadRequestException('Missing STRIPE_SUCCESS_URL/STRIPE_CANCEL_URL env vars');
    }
    const amountCents = Math.round(amount * 100);
    const {
      platformFeeCents: applicationFeeCents,
      receiverAmountCents,
      platformFee,
      receiverAmount,
      totalAmount,
    } = this.getPayFollowingAmountSplit(amountCents);

    const contentUser = await this.prisma.user.findUnique({
      where: { id: contentUserId },
      select: { displayName: true, userName: true },
    });
    const creatorName = contentUser?.displayName || contentUser?.userName || 'Creator';

    if (isAutoRenew) {
      const session = await this.stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        success_url: successUrl,
        cancel_url: cancelUrl,
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: `Monthly Subscription to ${creatorName}`,
              },
              unit_amount: amountCents,
              recurring: {
                interval: 'month',
              },
            },
            quantity: 1,
          },
        ],
        subscription_data: {
          metadata: {
            payerUserId,
            contentUserId,
            type: 'following',
            isAutoRenew: 'true',
            amount: amount.toString(),
            totalAmount: totalAmount.toString(),
            platformFee: platformFee.toString(),
            platformFeeCents: applicationFeeCents.toString(),
            receiverAmount: receiverAmount.toString(),
            receiverAmountCents: receiverAmountCents.toString(),
          },
        },
        metadata: {
          payerUserId,
          contentUserId,
          type: 'following',
          isAutoRenew: 'true',
          amount: amount.toString(),
          totalAmount: totalAmount.toString(),
          platformFee: platformFee.toString(),
          platformFeeCents: applicationFeeCents.toString(),
          receiverAmount: receiverAmount.toString(),
          receiverAmountCents: receiverAmountCents.toString(),
        },
      });
      return session;
    }

    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      success_url: successUrl,
      cancel_url: cancelUrl,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Following Payment to ${creatorName}`,
            },
            unit_amount: amountCents,
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        metadata: {
          payerUserId,
          contentUserId,
          type: 'following',
          isAutoRenew: 'false',
          amount: amount.toString(),
          totalAmount: totalAmount.toString(),
          platformFee: platformFee.toString(),
          platformFeeCents: applicationFeeCents.toString(),
          receiverAmount: receiverAmount.toString(),
          receiverAmountCents: receiverAmountCents.toString(),
        },
      },
      metadata: {
        payerUserId,
        contentUserId,
        type: 'following',
        isAutoRenew: 'false',
        amount: amount.toString(),
        totalAmount: totalAmount.toString(),
        platformFee: platformFee.toString(),
        platformFeeCents: applicationFeeCents.toString(),
        receiverAmount: receiverAmount.toString(),
        receiverAmountCents: receiverAmountCents.toString(),
      },
    });
    return session;
  }

  async cancelSubscriberAutoRenewals(creatorUserId: string): Promise<number> {
    const activeSubscriptions = await this.prisma.fansSubscriptionBuyData.findMany({
      where: {
        buyUserId: creatorUserId,
        status: 'ACTIVE',
        stripeSubscriptionId: { not: null },
        cancelAtPeriodEnd: false,
      },
    });

    let cancelledCount = 0;
    for (const sub of activeSubscriptions) {
      if (sub.stripeSubscriptionId) {
        try {
          await this.stripe.subscriptions.update(sub.stripeSubscriptionId, {
            cancel_at_period_end: true,
          });
          await this.prisma.fansSubscriptionBuyData.update({
            where: { id: sub.id },
            data: {
              cancelAtPeriodEnd: true,
              autoRenew: false,
            },
          });
          cancelledCount++;
        } catch (err: any) {
          console.error(`[BillingService] Failed to cancel auto-renew for subscription ${sub.id}:`, err?.message || err);
        }
      }
    }
    return cancelledCount;
  }

  async cancelPayFollowingSubscription(fanUserId: string, dto: CancelPayFollowingSubscriptionDto) {
    if (!fanUserId) {
      throw new BadRequestException('User ID is required');
    }
    if (!dto.subscriptionId && !dto.creatorId) {
      throw new BadRequestException('Either subscriptionId or creatorId must be provided');
    }

    const where: Prisma.FansSubscriptionBuyDataWhereInput = {
      fanUserId,
      ...(dto.subscriptionId ? { id: dto.subscriptionId } : {}),
      ...(dto.creatorId ? { buyUserId: dto.creatorId } : {}),
    };

    const sub = await this.prisma.fansSubscriptionBuyData.findFirst({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        buyUser: {
          select: {
            id: true,
            userName: true,
            displayName: true,
            image: true,
          },
        },
      },
    });

    if (!sub) {
      throw new NotFoundException('Pay-following subscription record not found');
    }

    const now = new Date();
    // Check if subscription has already expired or ended
    if (sub.status !== 'ACTIVE' && sub.endDate <= now) {
      throw new BadRequestException('This subscription is already inactive or expired');
    }

    // Check if autopay is already cancelled
    if (sub.cancelAtPeriodEnd && !sub.autoRenew) {
      await this.updatePriceChangeNotificationStatus(
        sub.fanUserId,
        sub.buyUserId,
        'CANCELLED',
        false,
        undefined,
        sub.id,
      );
      const creatorName = sub.buyUser?.displayName || sub.buyUser?.userName || 'creator';
      return {
        success: true,
        message: `Autopay is already cancelled. You will have access to @${creatorName} until ${sub.endDate.toISOString()}.`,
        subscription: {
          id: sub.id,
          fanUserId: sub.fanUserId,
          creatorId: sub.buyUserId,
          creatorName,
          creatorImage: sub.buyUser?.image || null,
          startDate: sub.startDate,
          endDate: sub.endDate,
          status: sub.status,
          isActive: true,
          isEnded: false,
          isCancelled: true,
          autoRenew: sub.autoRenew,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
          stripeSubscriptionId: sub.stripeSubscriptionId,
          paymentProvider: sub.paymentProvider,
        },
      };
    }

    // If there is a Stripe subscription associated, update Stripe to cancel at period end
    if (sub.stripeSubscriptionId) {
      try {
        await this.stripe.subscriptions.update(sub.stripeSubscriptionId, {
          cancel_at_period_end: true,
        });
      } catch (err: any) {
        // If Stripe returns resource_missing (e.g. deleted already), log and proceed to update DB
        if (err?.code !== 'resource_missing') {
          console.error(
            `[BillingService] Failed to cancel auto-renew on Stripe for subscription ${sub.stripeSubscriptionId}:`,
            err?.message || err,
          );
          throw new BadRequestException(`Failed to cancel Stripe recurring subscription: ${err?.message || 'Stripe error'}`);
        }
      }
    }

    const updated = await this.prisma.fansSubscriptionBuyData.update({
      where: { id: sub.id },
      data: {
        cancelAtPeriodEnd: true,
        autoRenew: false,
      },
      include: {
        buyUser: {
          select: {
            id: true,
            userName: true,
            displayName: true,
            image: true,
          },
        },
      },
    });

    const creatorName = updated.buyUser?.displayName || updated.buyUser?.userName || 'creator';
    const formattedEndDate = updated.endDate
      ? new Date(updated.endDate).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
      : 'the end of your billing cycle';

    // Send in-app and push notification to the fan
    try {
      await this.notificationService.sendNotificationToUser(
        updated.fanUserId,
        'Subscription Autopay Cancelled',
        `Your auto-renewal for @${creatorName} has been cancelled. Your access will remain active until ${formattedEndDate}.`,
        {
          type: 'subscription_cancelled',
          action: 'subscription_cancelled',
          subscriptionId: updated.id,
          creatorId: updated.buyUserId,
          creatorName,
          endDate: updated.endDate.toISOString(),
          isEnded: 'false',
          isCancelled: 'true',
          autoRenew: 'false',
          cancelAtPeriodEnd: 'true',
          status: 'ACTIVE',
        },
      );
    } catch (err: any) {
      console.error(
        `[BillingService] Failed to send subscription cancellation notification to fan ${updated.fanUserId}:`,
        err?.message || err,
      );
    }

    // Sync existing subscription_price_changed notification data if any
    await this.updatePriceChangeNotificationStatus(
      updated.fanUserId,
      updated.buyUserId,
      'CANCELLED',
      false,
    );

    return {
      success: true,
      message: `Autopay cancelled successfully. You will have access to @${creatorName} until ${updated.endDate.toISOString()}.`,
      subscription: {
        id: updated.id,
        fanUserId: updated.fanUserId,
        creatorId: updated.buyUserId,
        creatorName,
        creatorImage: updated.buyUser?.image || null,
        startDate: updated.startDate,
        endDate: updated.endDate,
        status: updated.status,
        isActive: true,
        isEnded: false,
        isCancelled: true,
        autoRenew: updated.autoRenew,
        cancelAtPeriodEnd: updated.cancelAtPeriodEnd,
        stripeSubscriptionId: updated.stripeSubscriptionId,
        paymentProvider: updated.paymentProvider,
      },
    };
  }

  async respondToPriceChange(fanUserId: string, dto: RespondPriceChangeDto) {
    if (!fanUserId) {
      throw new BadRequestException('User ID is required');
    }
    if (!dto.creatorId && !dto.subscriptionId && !dto.notificationId) {
      throw new BadRequestException('At least one of creatorId, subscriptionId, or notificationId is required');
    }

    let creatorId = dto.creatorId;
    let subscriptionId = dto.subscriptionId;

    if (dto.notificationId) {
      const notif = await this.prisma.notification.findUnique({
        where: { id: dto.notificationId },
      });
      if (notif) {
        let notifData = notif.data as any;
        if (typeof notifData === 'string') {
          try { notifData = JSON.parse(notifData); } catch {}
        }
        if (notifData?.creatorId && !creatorId) creatorId = notifData.creatorId;
        if (notifData?.subscriptionId && !subscriptionId) subscriptionId = notifData.subscriptionId;
      }
    }

    if (subscriptionId && !creatorId) {
      const sub = await this.prisma.fansSubscriptionBuyData.findUnique({
        where: { id: subscriptionId },
      });
      if (sub) {
        creatorId = sub.buyUserId;
      }
    }

    const isCancelAction =
      dto.action === PriceChangeResponseAction.CANCEL ||
      dto.action === PriceChangeResponseAction.DECLINE ||
      dto.action === PriceChangeResponseAction.DECLINED ||
      (dto.action as any) === 'CANCEL' ||
      (dto.action as any) === 'DECLINE' ||
      (dto.action as any) === 'DECLINED';

    const isAcceptAction =
      dto.action === PriceChangeResponseAction.ACCEPT ||
      (dto.action as any) === 'ACCEPT' ||
      (dto.action as any) === 'ACCEPTED';

    if (isCancelAction) {
      let cancelSub: any = null;
      try {
        const cancelResult = await this.cancelPayFollowingSubscription(fanUserId, {
          creatorId,
          subscriptionId,
        });
        cancelSub = cancelResult.subscription;
      } catch (err: any) {
        // If autopay was already paused (e.g. paused upon creator price update), retrieve existing subscription record
        const existingSub = await this.prisma.fansSubscriptionBuyData.findFirst({
          where: {
            fanUserId,
            ...(subscriptionId ? { id: subscriptionId } : {}),
            ...(creatorId ? { buyUserId: creatorId } : {}),
          },
          orderBy: { createdAt: 'desc' },
          include: {
            buyUser: {
              select: { id: true, userName: true, displayName: true, image: true },
            },
          },
        });
        if (existingSub) {
          const creatorName = existingSub.buyUser?.displayName || existingSub.buyUser?.userName || 'creator';
          cancelSub = {
            id: existingSub.id,
            fanUserId: existingSub.fanUserId,
            creatorId: existingSub.buyUserId,
            creatorName,
            creatorImage: existingSub.buyUser?.image || null,
            startDate: existingSub.startDate,
            endDate: existingSub.endDate,
            status: existingSub.status,
            isActive: existingSub.status === 'ACTIVE',
            isEnded: false,
            isCancelled: true,
            autoRenew: false,
            cancelAtPeriodEnd: true,
            stripeSubscriptionId: existingSub.stripeSubscriptionId,
            paymentProvider: existingSub.paymentProvider,
          };
        } else {
          throw err;
        }
      }

      await this.updatePriceChangeNotificationStatus(
        fanUserId,
        creatorId || cancelSub?.creatorId,
        'CANCELLED',
        false,
        dto.notificationId,
        subscriptionId || cancelSub?.id,
      );
      return {
        success: true,
        action: 'DECLINED',
        priceUpdateStatus: 'DECLINED',
        isAccepted: false,
        isDeclined: true,
        isPending: false,
        hasPurchasedNewPrice: false,
        message: 'You have declined the new price. Auto-renew has been cancelled and access will expire at period end.',
        subscription: cancelSub,
      };
    }

    if (isAcceptAction) {
      const sub = await this.prisma.fansSubscriptionBuyData.findFirst({
        where: {
          fanUserId,
          ...(subscriptionId ? { id: subscriptionId } : {}),
          ...(creatorId ? { buyUserId: creatorId } : {}),
        },
        orderBy: { createdAt: 'desc' },
      });

      if (!sub) {
        throw new NotFoundException('Subscription record not found');
      }

      // If user has a stripe subscription with cancel_at_period_end = true, un-cancel on Stripe
      if (sub.stripeSubscriptionId) {
        try {
          await this.stripe.subscriptions.update(sub.stripeSubscriptionId, {
            cancel_at_period_end: false,
          });
        } catch (err: any) {
          console.warn(`[BillingService] Could not un-cancel Stripe subscription directly:`, err?.message || err);
        }
      }

      const updatedSub = await this.prisma.fansSubscriptionBuyData.update({
        where: { id: sub.id },
        data: {
          autoRenew: true,
          cancelAtPeriodEnd: false,
        },
        include: {
          buyUser: {
            select: { id: true, userName: true, displayName: true, image: true },
          },
        },
      });

      await this.updatePriceChangeNotificationStatus(
        fanUserId,
        sub.buyUserId,
        'ACCEPTED',
        true,
        dto.notificationId,
        sub.id,
      );

      const creatorName = updatedSub.buyUser?.displayName || updatedSub.buyUser?.userName || 'creator';

      return {
        success: true,
        action: 'ACCEPTED',
        priceUpdateStatus: 'ACCEPTED',
        isAccepted: true,
        isDeclined: false,
        isPending: false,
        hasPurchasedNewPrice: true,
        message: `You have accepted the price change for @${creatorName}. Auto-renew is now active.`,
        subscription: {
          id: updatedSub.id,
          fanUserId: updatedSub.fanUserId,
          creatorId: updatedSub.buyUserId,
          creatorName,
          creatorImage: updatedSub.buyUser?.image || null,
          startDate: updatedSub.startDate,
          endDate: updatedSub.endDate,
          status: updatedSub.status,
          isActive: true,
          isEnded: false,
          isCancelled: false,
          autoRenew: true,
          cancelAtPeriodEnd: false,
        },
      };
    }

    throw new BadRequestException('Invalid action. Must be ACCEPT, CANCEL, or DECLINE.');
  }

  async updatePriceChangeNotificationStatus(
    fanUserId: string,
    creatorId?: string,
    status: 'ACCEPTED' | 'CANCELLED' | 'DECLINED' | 'PENDING' = 'CANCELLED',
    autoRenew: boolean = false,
    notificationId?: string,
    subscriptionId?: string,
  ) {
    try {
      const where: Prisma.NotificationWhereInput = {
        userId: fanUserId,
        ...(notificationId ? { id: notificationId } : {}),
      };
      const notifs = await this.prisma.notification.findMany({ where });
      for (const notif of notifs) {
        let data = notif.data as any;
        if (typeof data === 'string') {
          try {
            data = JSON.parse(data);
          } catch {
            data = {};
          }
        }
        if (!data || data.type !== 'subscription_price_changed') {
          continue;
        }

        const isMatch =
          Boolean(notificationId && notif.id === notificationId) ||
          Boolean(creatorId && data.creatorId === creatorId) ||
          Boolean(subscriptionId && data.subscriptionId === subscriptionId) ||
          (!notificationId && !creatorId && !subscriptionId);

        if (!isMatch) {
          continue;
        }

        const isAccepted = status === 'ACCEPTED';
        const isDeclined = status === 'CANCELLED' || status === 'DECLINED';
        const isPending = status === 'PENDING';
        const priceUpdateStatus = isAccepted ? 'ACCEPTED' : (isDeclined ? 'DECLINED' : 'PENDING');

        await this.prisma.notification.update({
          where: { id: notif.id },
          data: {
            data: {
              ...data,
              status: priceUpdateStatus,
              priceUpdateStatus,
              isAccepted,
              isDeclined,
              isPending,
              hasPurchasedNewPrice: isAccepted,
              isCancelled: isDeclined ? 'true' : 'false',
              autoRenew: autoRenew ? 'true' : 'false',
              cancelAtPeriodEnd: isDeclined ? 'true' : 'false',
            },
          },
        });
      }
    } catch (err: any) {
      console.error('[BillingService] Failed to update price change notification status:', err?.message || err);
    }
  }

  async createTipCheckoutSession(
    senderUserId: string,
    receiverUserId: string,
    amount: number,
  ) {
    await this.ensureUserExists(receiverUserId);

    const payerProvider = await this.paymentProviderResolver.resolveProviderForUser(senderUserId);
    if (payerProvider === 'PAGBANK') {
      return this.createPagBankTipCheckout(senderUserId, receiverUserId, amount);
    }

    const customerId = await this.ensureStripeCustomer(senderUserId);
    const successUrl = process.env.STRIPE_SUCCESS_URL as string;
    const cancelUrl = process.env.STRIPE_CANCEL_URL as string;
    if (!successUrl || !cancelUrl) {
      throw new BadRequestException('Missing STRIPE_SUCCESS_URL/STRIPE_CANCEL_URL env vars');
    }

    const amountCents = Math.round(amount * 100);
    const {
      platformFeeCents: applicationFeeCents,
      receiverAmountCents,
      platformFee,
      receiverAmount,
      totalAmount,
    } = this.getTipAmountSplit(amountCents);

    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      success_url: successUrl,
      cancel_url: cancelUrl,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Tip Payment',
            },
            unit_amount: amountCents,
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        metadata: {
          senderUserId,
          receiverUserId,
          type: 'tip',
          amount: amount.toString(),
          totalAmount: totalAmount.toString(),
          platformFee: platformFee.toString(),
          platformFeeCents: applicationFeeCents.toString(),
          receiverAmount: receiverAmount.toString(),
          receiverAmountCents: receiverAmountCents.toString(),
        },
      },
      metadata: {
        senderUserId,
        receiverUserId,
        type: 'tip',
        amount: amount.toString(),
        totalAmount: totalAmount.toString(),
        platformFee: platformFee.toString(),
        platformFeeCents: applicationFeeCents.toString(),
        receiverAmount: receiverAmount.toString(),
        receiverAmountCents: receiverAmountCents.toString(),
      },
    });

    return session;
  }

  private async createPagBankTipCheckout(
    senderUserId: string,
    receiverUserId: string,
    amount: number,
  ) {
    const amountCents = Math.round(amount * 100);
    const { platformFee, receiverAmount, totalAmount } = this.getTipAmountSplit(amountCents);
    const sender = await this.prisma.user.findUnique({
      where: { id: senderUserId },
      select: { email: true, displayName: true, userName: true },
    });

    const payment = await this.prisma.payment.create({
      data: {
        userId: senderUserId,
        receiverId: receiverUserId,
        amount: receiverAmount,
        platformFee,
        totalAmount,
        currency: 'BRL',
        status: 'pending',
        forPayment: 'TIP',
      },
    });

    const checkout = await this.pagBankService.createPixCheckout({
      referenceId: payment.id,
      amountMinor: amountCents,
      description: 'Tip Payment',
      customerEmail: sender?.email || undefined,
      customerName: sender?.displayName || sender?.userName || undefined,
    });

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { stripePaymentIntentId: checkout.orderId },
    });

    return {
      id: checkout.orderId,
      url: checkout.checkoutUrl,
      ...checkout,
    };
  }

  private async createPagBankFollowingCheckout(
    payerUserId: string,
    contentUserId: string,
    amount: number,
  ) {
    const amountCents = Math.round(amount * 100);
    const { platformFee, receiverAmount, totalAmount } = this.getPayFollowingAmountSplit(amountCents);
    const payer = await this.prisma.user.findUnique({
      where: { id: payerUserId },
      select: { email: true, displayName: true, userName: true },
    });

    const payment = await this.prisma.payment.create({
      data: {
        userId: payerUserId,
        receiverId: contentUserId,
        amount: receiverAmount,
        platformFee,
        totalAmount,
        currency: 'BRL',
        status: 'pending',
        forPayment: 'following',
      },
    });

    const checkout = await this.pagBankService.createPixCheckout({
      referenceId: payment.id,
      amountMinor: amountCents,
      description: 'Following Payment',
      customerEmail: payer?.email || undefined,
      customerName: payer?.displayName || payer?.userName || undefined,
    });

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { stripePaymentIntentId: checkout.orderId },
    });

    return {
      id: checkout.orderId,
      url: checkout.checkoutUrl,
      ...checkout,
    };
  }

  async createEbookCheckoutSession(
    buyerUserId: string,
    targetUserId: string,
    postId: string,
    amount: number,
  ) {
    await this.ensureUserExists(targetUserId);

    const buyerProvider = await this.paymentProviderResolver.resolveProviderForUser(buyerUserId);
    if (buyerProvider === 'PAGBANK') {
      // continue below after validations, then branch before Stripe session
    }

    const customerId = buyerProvider === 'STRIPE' ? await this.ensureStripeCustomer(buyerUserId) : null;
    const successUrl = process.env.STRIPE_SUCCESS_URL as string;
    const cancelUrl = process.env.STRIPE_CANCEL_URL as string;

    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: {
        id: true,
        userId: true,
        format: true,
        deletedAt: true,
        isDelete: true,
        amount: true,
      },
    });

    if (!post || post.deletedAt || post.isDelete !== 'no') {
      throw new BadRequestException('Ebook post not found');
    }

    if (post.format !== 'ebook') {
      throw new BadRequestException('Selected post is not an ebook');
    }

    if (post.userId !== targetUserId) {
      throw new BadRequestException('targetUserId does not own this ebook post');
    }

    const resolvedAmount = (amount !== undefined && amount !== null && !isNaN(Number(amount)) && Number(amount) > 0)
      ? Number(amount)
      : (post.amount ? Number(post.amount) : null);

    if (!resolvedAmount || resolvedAmount <= 0 || isNaN(resolvedAmount)) {
      throw new BadRequestException('Valid payment amount is required');
    }

    const amountCents = Math.round(resolvedAmount * 100);
    const {
      platformFeeCents,
      receiverAmountCents,
      platformFee,
      receiverAmount,
      totalAmount,
    } = this.getEbookAmountSplit(amountCents);

    const ebookPayment = await (this.prisma as any).ebookPayments.create({
      data: {
        buyerId: buyerUserId,
        sellerId: targetUserId,
        postId,
        amount: amountCents,
        platformFee: platformFeeCents,
        sellerAmount: receiverAmountCents,
        currency: buyerProvider === 'PAGBANK' ? 'brl' : 'usd',
        provider: buyerProvider,
        status: 'PENDING',
        metadata: {
          buyerUserId,
          targetUserId,
          postId,
          amount: resolvedAmount,
          totalAmount,
          platformFee,
          receiverAmount,
          receiverAmountCents,
        },
      },
      select: { id: true },
    });

    if (buyerProvider === 'PAGBANK') {
      try {
        const buyer = await this.prisma.user.findUnique({
          where: { id: buyerUserId },
          select: { email: true, displayName: true, userName: true },
        });
        const checkout = await this.pagBankService.createPixCheckout({
          referenceId: ebookPayment.id,
          amountMinor: amountCents,
          description: 'Ebook Payment',
          customerEmail: buyer?.email || undefined,
          customerName: buyer?.displayName || buyer?.userName || undefined,
        });
        await (this.prisma as any).ebookPayments.update({
          where: { id: ebookPayment.id },
          data: {
            checkoutSessionId: checkout.orderId,
            paymentIntentId: checkout.orderId,
          },
        });
        return {
          id: checkout.orderId,
          url: checkout.checkoutUrl,
          ...checkout,
        };
      } catch (error) {
        await (this.prisma as any).ebookPayments.update({
          where: { id: ebookPayment.id },
          data: { status: 'FAILED' },
        });
        throw error;
      }
    }

    if (!successUrl || !cancelUrl) {
      throw new BadRequestException('Missing STRIPE_SUCCESS_URL/STRIPE_CANCEL_URL env vars');
    }
    if (!customerId) {
      throw new BadRequestException('Stripe customer required');
    }

    try {
      const session = await this.stripe.checkout.sessions.create({
        mode: 'payment',
        customer: customerId,
        success_url: successUrl,
        cancel_url: cancelUrl,
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: 'Ebook Payment',
              },
              unit_amount: amountCents,
            },
            quantity: 1,
          },
        ],
        payment_intent_data: {
          metadata: {
            type: 'ebook',
            ebookPaymentId: ebookPayment.id,
            buyerUserId,
            targetUserId,
            postId,
            amount: amount.toString(),
            totalAmount: totalAmount.toString(),
            platformFee: platformFee.toString(),
            platformFeeCents: platformFeeCents.toString(),
            receiverAmount: receiverAmount.toString(),
            receiverAmountCents: receiverAmountCents.toString(),
          },
        },
        metadata: {
          type: 'ebook',
          ebookPaymentId: ebookPayment.id,
          buyerUserId,
          targetUserId,
          postId,
          amount: amount.toString(),
          totalAmount: totalAmount.toString(),
          platformFee: platformFee.toString(),
          platformFeeCents: platformFeeCents.toString(),
          receiverAmount: receiverAmount.toString(),
          receiverAmountCents: receiverAmountCents.toString(),
        },
      });

      await (this.prisma as any).ebookPayments.update({
        where: { id: ebookPayment.id },
        data: {
          checkoutSessionId: session.id,
          paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
        },
      });

      return session;
    } catch {
      await (this.prisma as any).ebookPayments.update({
        where: { id: ebookPayment.id },
        data: { status: 'FAILED' },
      });
      throw new BadRequestException('Stripe API failure while creating ebook checkout session');
    }
  }

  async createShopEbookCheckoutSession(
    buyerUserId: string,
    closetId: string,
    ebookId: string,
    amount: number,
  ) {
    if (!closetId) throw new BadRequestException('closetId is required');
    if (!ebookId) throw new BadRequestException('ebookId is required');
    if (!amount || amount <= 0) throw new BadRequestException('Invalid amount');

    const ebook = await (this.prisma as any).shopEbook.findUnique({
      where: { id: ebookId },
      select: {
        id: true,
        userId: true,
        closetId: true,
        amount: true,
        caption: true,
      },
    });

    if (!ebook) {
      throw new BadRequestException('Shop ebook not found');
    }

    if (ebook.closetId !== closetId) {
      throw new BadRequestException('ebookId does not belong to closetId');
    }

    if (ebook.userId === buyerUserId) {
      throw new BadRequestException('You cannot buy your own ebook');
    }

    const closet = await this.prisma.mycloset.findUnique({
      where: { id: closetId },
      select: { id: true, userId: true, shopName: true },
    });

    if (!closet) {
      throw new BadRequestException('Closet not found');
    }

    if (closet.userId !== ebook.userId) {
      throw new BadRequestException('Closet owner does not match ebook seller');
    }

    if (Math.abs((ebook.amount ?? 0) - amount) > 0.000001) {
      throw new BadRequestException('Amount mismatch with ebook price');
    }

    await this.ensureUserExists(ebook.userId);
    const buyerProvider = await this.paymentProviderResolver.resolveProviderForUser(buyerUserId);
    const customerId = buyerProvider === 'STRIPE' ? await this.ensureStripeCustomer(buyerUserId) : null;
    const successUrl = process.env.STRIPE_SUCCESS_URL as string;
    const cancelUrl = process.env.STRIPE_CANCEL_URL as string;

    const amountCents = Math.round(amount * 100);
    const {
      platformFeeCents,
      receiverAmountCents,
      platformFee,
      receiverAmount,
      totalAmount,
    } = this.getEbookAmountSplit(amountCents);

    const shopEbookPayment = await (this.prisma as any).shopEbookPayments.create({
      data: {
        buyerId: buyerUserId,
        sellerId: ebook.userId,
        closetId,
        ebookId,
        amount: amountCents,
        platformFee: platformFeeCents,
        sellerAmount: receiverAmountCents,
        currency: buyerProvider === 'PAGBANK' ? 'brl' : 'usd',
        provider: buyerProvider,
        status: 'PENDING',
        metadata: {
          buyerUserId,
          sellerUserId: ebook.userId,
          closetId,
          ebookId,
          amount,
          totalAmount,
          platformFee,
          receiverAmount,
          receiverAmountCents,
        },
      },
      select: { id: true },
    });

    if (buyerProvider === 'PAGBANK') {
      try {
        const buyer = await this.prisma.user.findUnique({
          where: { id: buyerUserId },
          select: { email: true, displayName: true, userName: true },
        });
        const checkout = await this.pagBankService.createPixCheckout({
          referenceId: shopEbookPayment.id,
          amountMinor: amountCents,
          description: ebook.caption || 'Shop Ebook Payment',
          customerEmail: buyer?.email || undefined,
          customerName: buyer?.displayName || buyer?.userName || undefined,
        });
        await (this.prisma as any).shopEbookPayments.update({
          where: { id: shopEbookPayment.id },
          data: {
            checkoutSessionId: checkout.orderId,
            paymentIntentId: checkout.orderId,
          },
        });
        return { id: checkout.orderId, url: checkout.checkoutUrl, ...checkout };
      } catch (error) {
        await (this.prisma as any).shopEbookPayments.update({
          where: { id: shopEbookPayment.id },
          data: { status: 'FAILED' },
        });
        throw error;
      }
    }

    if (!successUrl || !cancelUrl) {
      throw new BadRequestException('Missing STRIPE_SUCCESS_URL/STRIPE_CANCEL_URL env vars');
    }
    if (!customerId) throw new BadRequestException('Stripe customer required');

    try {
      const session = await this.stripe.checkout.sessions.create({
        mode: 'payment',
        customer: customerId,
        success_url: successUrl,
        cancel_url: cancelUrl,
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: ebook.caption || 'Shop Ebook Payment',
              },
              unit_amount: amountCents,
            },
            quantity: 1,
          },
        ],
        payment_intent_data: {
          metadata: {
            type: 'shop_ebook',
            shopEbookPaymentId: shopEbookPayment.id,
            buyerUserId,
            sellerUserId: ebook.userId,
            closetId,
            ebookId,
            amount: amount.toString(),
            totalAmount: totalAmount.toString(),
            platformFee: platformFee.toString(),
            platformFeeCents: platformFeeCents.toString(),
            receiverAmount: receiverAmount.toString(),
            receiverAmountCents: receiverAmountCents.toString(),
          },
        },
        metadata: {
          type: 'shop_ebook',
          shopEbookPaymentId: shopEbookPayment.id,
          buyerUserId,
          sellerUserId: ebook.userId,
          closetId,
          ebookId,
          amount: amount.toString(),
          totalAmount: totalAmount.toString(),
          platformFee: platformFee.toString(),
          platformFeeCents: platformFeeCents.toString(),
          receiverAmount: receiverAmount.toString(),
          receiverAmountCents: receiverAmountCents.toString(),
        },
      });

      await (this.prisma as any).shopEbookPayments.update({
        where: { id: shopEbookPayment.id },
        data: {
          checkoutSessionId: session.id,
          paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
        },
      });

      return session;
    } catch {
      await (this.prisma as any).shopEbookPayments.update({
        where: { id: shopEbookPayment.id },
        data: { status: 'FAILED' },
      });
      throw new BadRequestException('Stripe API failure while creating shop ebook checkout session');
    }
  }

  async cancelSubscriptionAtPeriodEnd(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');
    let subscriptionId = user.stripeSubscriptionId || null;
    // Try to backfill subscription id if missing
    if (!subscriptionId && user.stripeCustomerId) {
      const list = await this.stripe.subscriptions.list({ customer: user.stripeCustomerId, status: 'active', limit: 1 });
      const activeSub = list.data[0];
      if (activeSub) {
        subscriptionId = activeSub.id;
        await this.prisma.user.update({ where: { id: userId }, data: { stripeSubscriptionId: subscriptionId } });
      }
    }
    if (!subscriptionId) throw new BadRequestException('No active subscription');
    const sub = await this.stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });
    await this.prisma.user.update({ where: { id: userId }, data: { subscriptionStatus: 'CANCELED' } });
    return sub;
  }

  /**
   * Helper to localize forPayment and status fields according to user language preference
   */
  private localizePaymentFields(lang: string | boolean, forPayment?: string | null, status?: string | null) {
    const normalizedLang = typeof lang === 'boolean' ? (lang ? 'pt' : 'en') : normalizeLanguage(lang);
    if (normalizedLang === 'en') {
      return {
        forPayment: forPayment ?? null,
        status: status ?? null,
      };
    }

    return {
      forPayment: translatePaymentType(forPayment, normalizedLang),
      status: translatePaymentStatus(status, normalizedLang),
    };
  }

  async getSubscriptionDetails(userId: string, deviceId?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');
    const lang = await this.notificationService.getUserLanguage(userId, deviceId);
    const normalizedLang = normalizeLanguage(lang);

    const latestPayment = await this.prisma.payment.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    let rawStatus: string | null = user.subscriptionStatus;
    if (latestPayment?.status && (!rawStatus || rawStatus.toUpperCase() === 'INACTIVE')) {
      const paymentStatus = latestPayment.status.toLowerCase();
      if (paymentStatus === 'succeed' || paymentStatus === 'succeeded') {
        rawStatus = latestPayment.status;
      }
    }

    const { forPayment, status } = this.localizePaymentFields(
      normalizedLang,
      latestPayment?.forPayment ?? null,
      rawStatus,
    );

    let isCancel: boolean | string = 'pending';
    const normalizedRawStatus = (user.subscriptionStatus || '').toUpperCase();

    if (normalizedRawStatus === 'CANCELED' || normalizedRawStatus === 'CANCELLED') {
      isCancel = true;
    } else if (normalizedRawStatus === 'ACTIVE' || normalizedRawStatus === 'PAST_DUE') {
      isCancel = 'no';
    } else if (
      !user.subscriptionStart &&
      !user.stripeSubscriptionId &&
      !user.currentPeriodEnd &&
      !user.subscriptionEnd
    ) {
      isCancel = 'pending';
    } else {
      isCancel = true;
    }

    return {
      status,
      forPayment,
      start: user.subscriptionStart,
      end: user.subscriptionEnd,
      currentPeriodEnd: user.currentPeriodEnd,
      isCancel,
    };
  }

  // Webhook handlers
  async handleFollowingCheckoutSessionCompleted(session: Stripe.Checkout.Session) {
    const payerUserId = session.metadata?.payerUserId;
    const contentUserId = session.metadata?.contentUserId;
    const subscriptionId = typeof session.subscription === 'string' ? session.subscription : (session.subscription as any)?.id;
    const isAutoRenew = session.metadata?.isAutoRenew !== 'false';
    const amount = Number(session.metadata?.amount) || (session.amount_total ? session.amount_total / 100 : 0);

    if (payerUserId && contentUserId) {
      const startDate = new Date();
      const endDate = new Date(startDate);
      endDate.setMonth(endDate.getMonth() + 1);

      const existing = await this.prisma.fansSubscriptionBuyData.findFirst({
        where: {
          fanUserId: payerUserId,
          buyUserId: contentUserId,
        },
      });

      if (existing) {
        await this.prisma.fansSubscriptionBuyData.update({
          where: { id: existing.id },
          data: {
            startDate,
            endDate,
            status: 'ACTIVE',
            priceAtSubscription: amount,
            stripeSubscriptionId: subscriptionId || existing.stripeSubscriptionId,
            autoRenew: isAutoRenew,
            cancelAtPeriodEnd: false,
          },
        });
      } else {
        await this.prisma.fansSubscriptionBuyData.create({
          data: {
            fanUserId: payerUserId,
            buyUserId: contentUserId,
            startDate,
            endDate,
            status: 'ACTIVE',
            priceAtSubscription: amount,
            stripeSubscriptionId: subscriptionId || null,
            autoRenew: isAutoRenew,
            cancelAtPeriodEnd: false,
            paymentProvider: 'STRIPE',
          },
        });
      }

      await this.updatePriceChangeNotificationStatus(
        payerUserId,
        contentUserId,
        'ACCEPTED',
        isAutoRenew,
      );
    }
  }

  async handleInvoicePaid(invoice: Stripe.Invoice) {
    const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
    if (!customerId) return;
    const user = await this.prisma.user.findFirst({ where: { stripeCustomerId: customerId } });
    if (!user) return;
    const subscriptionId = typeof invoice.subscription === 'string' ? invoice.subscription : (invoice.subscription as any)?.id;
    const amount = invoice.amount_paid ?? 0;
    const currency = invoice.currency?.toUpperCase() ?? 'USD';
    const periodStart = invoice.lines.data[0]?.period?.start
      ? new Date(invoice.lines.data[0].period.start * 1000)
      : undefined;
    const periodEnd = invoice.lines.data[0]?.period?.end ? new Date(invoice.lines.data[0].period.end * 1000) : undefined;

    // Check if this invoice is for a creator following subscription
    let type = invoice.lines.data[0]?.metadata?.type || (invoice as any).subscription_details?.metadata?.type;
    let contentUserId = invoice.lines.data[0]?.metadata?.contentUserId || (invoice as any).subscription_details?.metadata?.contentUserId;

    if (!type && subscriptionId) {
      const existingFanSub = await this.prisma.fansSubscriptionBuyData.findFirst({
        where: { stripeSubscriptionId: subscriptionId },
      });
      if (existingFanSub) {
        type = 'following';
        contentUserId = existingFanSub.buyUserId;
      } else {
        try {
          const stripeSub = await this.stripe.subscriptions.retrieve(subscriptionId);
          type = stripeSub.metadata?.type;
          contentUserId = stripeSub.metadata?.contentUserId;
        } catch {
          // ignore
        }
      }
    }

    if (type === 'following' && contentUserId) {
      const {
        totalAmount,
        platformFee,
        receiverAmount,
        receiverAmountCents,
      } = this.getPayFollowingAmountSplit(amount);

      const periodStartDate = periodStart || new Date();
      const periodEndDate = periodEnd || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      const payment = await this.prisma.payment.create({
        data: {
          user: { connect: { id: user.id } },
          receiver: { connect: { id: contentUserId } },
          amount: receiverAmount,
          platformFee,
          totalAmount,
          currency,
          status: 'succeeded',
          forPayment: 'following',
          stripeInvoiceId: invoice.id,
          stripePaymentIntentId: typeof invoice.payment_intent === 'string' ? invoice.payment_intent : (invoice.payment_intent as any)?.id,
          periodStart: periodStartDate,
          periodEnd: periodEndDate,
        },
      });

      const existingFanSub = await this.prisma.fansSubscriptionBuyData.findFirst({
        where: {
          OR: [
            { stripeSubscriptionId: subscriptionId },
            { fanUserId: user.id, buyUserId: contentUserId },
          ],
        },
      });

      if (existingFanSub) {
        await this.prisma.fansSubscriptionBuyData.update({
          where: { id: existingFanSub.id },
          data: {
            stripeSubscriptionId: subscriptionId || existingFanSub.stripeSubscriptionId,
            startDate: periodStartDate,
            endDate: periodEndDate,
            status: 'ACTIVE',
            priceAtSubscription: totalAmount,
            autoRenew: true,
            cancelAtPeriodEnd: false,
          },
        });
      } else {
        await this.prisma.fansSubscriptionBuyData.create({
          data: {
            fanUserId: user.id,
            buyUserId: contentUserId,
            stripeSubscriptionId: subscriptionId || null,
            startDate: periodStartDate,
            endDate: periodEndDate,
            status: 'ACTIVE',
            priceAtSubscription: totalAmount,
            autoRenew: true,
            cancelAtPeriodEnd: false,
            paymentProvider: 'STRIPE',
          },
        });
      }

      await this.updatePriceChangeNotificationStatus(
        user.id,
        contentUserId,
        'ACCEPTED',
        true,
      );

      await this.creditSellerAvailableWallet({
        sellerUserId: contentUserId,
        amountMinor: receiverAmountCents,
        source: 'FOLLOWING',
        refId: invoice.id,
        currency: invoice.currency || 'usd',
        note: `Pay-following subscription payment ${payment.id}`,
      });
      return;
    }

    // Default: Platform subscription
    await this.prisma.payment.create({
      data: {
        userId: user.id,
        amount: amount,
        currency,
        status: 'succeeded',
        forPayment: 'subscription',
        stripeInvoiceId: invoice.id,
        stripePaymentIntentId: typeof invoice.payment_intent === 'string' ? invoice.payment_intent : (invoice.payment_intent as any)?.id,
        periodStart,
        periodEnd,
      },
    });
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        subscriptionStatus: 'ACTIVE',
        stripeSubscriptionId: subscriptionId ?? user.stripeSubscriptionId ?? undefined,
        subscriptionStart: user.subscriptionStart ?? (periodStart || new Date()),
        subscriptionEnd: null,
        currentPeriodEnd: periodEnd,
      },
    });

    // Grant 5 subscription hits valid for 30 days (until periodEnd)
    const subExpiresAt = periodEnd || (() => {
      const d = new Date(periodStart || new Date());
      d.setMonth(d.getMonth() + 1);
      return d;
    })();

    const postHit = await this.prisma.postHit.findFirst({
      where: { userId: user.id },
    });

    if (postHit) {
      const purchasedHits = postHit.purchasedHitsLeft || 0;
      await this.prisma.postHit.update({
        where: { id: postHit.id },
        data: {
          subscriptionHitsLeft: 5,
          subscriptionHitsExpiresAt: subExpiresAt,
          hitLeft: 5 + purchasedHits,
        },
      });
    } else {
      await this.prisma.postHit.create({
        data: {
          userId: user.id,
          subscriptionHitsLeft: 5,
          subscriptionHitsExpiresAt: subExpiresAt,
          purchasedHitsLeft: 0,
          hitLeft: 5,
        },
      });
    }
  }

  async handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
    const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
    if (!customerId) return;
    const user = await this.prisma.user.findFirst({ where: { stripeCustomerId: customerId } });
    if (!user) return;
    const currency = invoice.currency?.toUpperCase() ?? 'USD';
    await this.prisma.payment.create({
      data: {
        userId: user.id,
        amount: invoice.amount_due ?? 0,
        currency,
        status: 'failed',
        forPayment: 'subscription',
        stripeInvoiceId: invoice.id,
        stripePaymentIntentId: typeof invoice.payment_intent === 'string' ? invoice.payment_intent : invoice.payment_intent?.id,
        periodStart: undefined,
        periodEnd: undefined,
      },
    });
    await this.prisma.user.update({ where: { id: user.id }, data: { subscriptionStatus: 'PAST_DUE' } });
  }

  async handleSubscriptionDeleted(subscription: Stripe.Subscription) {
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;

    // Check if this was a following subscription
    const fanSub = await this.prisma.fansSubscriptionBuyData.findFirst({
      where: { stripeSubscriptionId: subscription.id },
      include: {
        buyUser: {
          select: { id: true, userName: true, displayName: true },
        },
      },
    });
    if (fanSub) {
      await this.prisma.fansSubscriptionBuyData.update({
        where: { id: fanSub.id },
        data: {
          status: 'STOP',
          autoRenew: false,
        },
      });

      const creatorName = fanSub.buyUser?.displayName || fanSub.buyUser?.userName || 'creator';
      try {
        await this.notificationService.sendNotificationToUser(
          fanSub.fanUserId,
          'Subscription Ended',
          `Your subscription to @${creatorName} has ended.`,
          {
            type: 'subscription_ended',
            action: 'subscription_ended',
            subscriptionId: fanSub.id,
            creatorId: fanSub.buyUserId,
            creatorName,
            isEnded: 'true',
            isCancelled: 'true',
            status: 'STOP',
            autoRenew: 'false',
            cancelAtPeriodEnd: 'true',
            endDate: fanSub.endDate ? fanSub.endDate.toISOString() : new Date().toISOString(),
          },
        );
      } catch (err: any) {
        console.error(
          `[BillingService] Failed to send subscription ended notification to fan ${fanSub.fanUserId}:`,
          err?.message || err,
        );
      }
      return;
    }

    if (!customerId) return;
    const user = await this.prisma.user.findFirst({ where: { stripeCustomerId: customerId } });
    if (!user) return;
    const currentPeriodEnd = subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null;
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        subscriptionStatus: 'INACTIVE',
        subscriptionEnd: currentPeriodEnd,
        currentPeriodEnd: currentPeriodEnd,
        stripeSubscriptionId: null,
      },
    });
  }

  async handleCheckoutSessionCompleted(session: Stripe.Checkout.Session) {
    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
    const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
    if (!customerId || !subscriptionId) return;
    const user = await this.prisma.user.findFirst({ where: { stripeCustomerId: customerId } });
    if (!user) return;
    await this.prisma.user.update({
      where: { id: user.id },
      data: { stripeSubscriptionId: subscriptionId },
    });
  }

  async handleOneTimePaymentSuccess(paymentIntent: Stripe.PaymentIntent) {
    // eslint-disable-next-line no-console
    // console.log('[Billing] handleOneTimePaymentSuccess — paymentIntentId:', paymentIntent.id);
    const customerId = typeof paymentIntent.customer === 'string' ? paymentIntent.customer : paymentIntent.customer?.id;
    if (!customerId) {
      console.warn('[Billing] handleOneTimePaymentSuccess — no customerId on PaymentIntent, skipping');
      return;
    }
    const user = await this.prisma.user.findFirst({ where: { stripeCustomerId: customerId } });
    if (!user) {
      console.warn('[Billing] handleOneTimePaymentSuccess — no user found for customerId:', customerId);
      return;
    }
    const amountCents = paymentIntent.amount ?? 0;
    const {
      totalAmount,
      platformFee,
      receiverAmount,
    } = this.getPayFollowingAmountSplit(amountCents);
    const currency = paymentIntent.currency?.toUpperCase() ?? 'USD';
    const contentUserId = paymentIntent.metadata?.contentUserId;
    const periodStart = new Date();
    const periodEnd = new Date(periodStart);
    periodEnd.setMonth(periodEnd.getMonth() + 1);
    const payment = await this.prisma.payment.create({
      data: {
        user: { connect: { id: user.id } },
        ...(contentUserId && { receiver: { connect: { id: contentUserId } } }),
        amount: receiverAmount,
        platformFee,
        totalAmount,
        currency,
        status: 'succeeded',
        forPayment: 'following',
        stripePaymentIntentId: paymentIntent.id,
        periodStart,
        periodEnd,
      },
    });

    if (contentUserId) {
      const existing = await this.prisma.fansSubscriptionBuyData.findFirst({
        where: {
          fanUserId: user.id,
          buyUserId: contentUserId,
        },
      });

      if (existing) {
        await this.prisma.fansSubscriptionBuyData.update({
          where: { id: existing.id },
          data: {
            startDate: periodStart,
            endDate: periodEnd,
            status: 'ACTIVE',
            priceAtSubscription: totalAmount,
            autoRenew: false,
          },
        });
      } else {
        await this.prisma.fansSubscriptionBuyData.create({
          data: {
            fanUserId: user.id,
            buyUserId: contentUserId,
            startDate: periodStart,
            endDate: periodEnd,
            status: 'ACTIVE',
            priceAtSubscription: totalAmount,
            autoRenew: false,
            paymentProvider: 'STRIPE',
          },
        });
      }

      await this.updatePriceChangeNotificationStatus(
        user.id,
        contentUserId,
        'ACCEPTED',
        false,
      );

      const receiverAmountCents =
        Number(paymentIntent.metadata?.receiverAmountCents) ||
        Math.round(receiverAmount * 100);
      await this.creditSellerAvailableWallet({
        sellerUserId: contentUserId,
        amountMinor: receiverAmountCents,
        source: 'FOLLOWING',
        refId: paymentIntent.id,
        currency: paymentIntent.currency || 'usd',
        note: `Pay-following payment ${payment.id}`,
      });
    }
  }

  async handleOneTimePaymentFailed(paymentIntent: Stripe.PaymentIntent) {
    // eslint-disable-next-line no-console
    // console.log('[Billing] handleOneTimePaymentFailed — paymentIntentId:', paymentIntent.id);
    const existing = await this.prisma.payment.findFirst({
      where: { stripePaymentIntentId: paymentIntent.id, forPayment: 'following' },
    });
    if (existing) {
      await this.prisma.payment.update({
        where: { id: existing.id },
        data: { status: 'failed' },
      });
      // eslint-disable-next-line no-console
      // console.log('[Billing] Payment updated to failed (pay-following): id=', existing.id);
      return;
    }
    const customerId = typeof paymentIntent.customer === 'string' ? paymentIntent.customer : paymentIntent.customer?.id;
    if (!customerId) {
      console.warn('[Billing] handleOneTimePaymentFailed — no customerId on PaymentIntent, skipping');
      return;
    }
    const user = await this.prisma.user.findFirst({ where: { stripeCustomerId: customerId } });
    if (!user) {
      console.warn('[Billing] handleOneTimePaymentFailed — no user found for customerId:', customerId);
      return;
    }
    const amountCents = paymentIntent.amount ?? 0;
    const {
      totalAmount,
      platformFee,
      receiverAmount,
    } = this.getPayFollowingAmountSplit(amountCents);
    const currency = paymentIntent.currency?.toUpperCase() ?? 'USD';
    const contentUserId = paymentIntent.metadata?.contentUserId;
    const periodStart = new Date();
    const periodEnd = new Date(periodStart);
    periodEnd.setMonth(periodEnd.getMonth() + 1);
    const payment = await this.prisma.payment.create({
      data: {
        user: { connect: { id: user.id } },
        ...(contentUserId && { receiver: { connect: { id: contentUserId } } }),
        amount: receiverAmount,
        platformFee,
        totalAmount,
        currency,
        status: 'failed',
        forPayment: 'following',
        stripePaymentIntentId: paymentIntent.id,
        periodStart,
        periodEnd,
      },
    });
    // eslint-disable-next-line no-console
    // console.log('[Billing] Payment created (pay-following failed): id=', payment.id, 'userId=', user.id, 'receiverId=', contentUserId ?? 'none', 'amountReceived(USD)=', receiverAmount, 'platformFee(USD)=', platformFee, 'totalAmount(USD)=', totalAmount, 'status=failed');
  }

  async handleTipPaymentSuccess(paymentIntent: Stripe.PaymentIntent) {
    const customerId = typeof paymentIntent.customer === 'string' ? paymentIntent.customer : paymentIntent.customer?.id;
    if (!customerId) return;

    const user = await this.prisma.user.findFirst({ where: { stripeCustomerId: customerId } });
    if (!user) return;

    const amountCents = paymentIntent.amount ?? 0;
    const {
      totalAmount,
      platformFee,
      receiverAmount,
    } = this.getTipAmountSplit(amountCents);
    const currency = paymentIntent.currency?.toUpperCase() ?? 'USD';
    const receiverUserId = paymentIntent.metadata?.receiverUserId;

    await this.prisma.payment.create({
      data: {
        user: { connect: { id: user.id } },
        ...(receiverUserId && { receiver: { connect: { id: receiverUserId } } }),
        amount: receiverAmount,
        platformFee,
        totalAmount,
        currency,
        status: 'succeeded',
        forPayment: 'TIP',
        stripePaymentIntentId: paymentIntent.id,
      },
    });

    if (receiverUserId) {
      const receiverAmountCents =
        Number(paymentIntent.metadata?.receiverAmountCents) ||
        Math.round(receiverAmount * 100);
      await this.creditSellerAvailableWallet({
        sellerUserId: receiverUserId,
        amountMinor: receiverAmountCents,
        source: 'TIP',
        refId: paymentIntent.id,
        currency: paymentIntent.currency || 'usd',
        note: `Tip payment ${paymentIntent.id}`,
      });
    }
  }

  async handleTipPaymentFailed(paymentIntent: Stripe.PaymentIntent) {
    const existing = await this.prisma.payment.findFirst({
      where: { stripePaymentIntentId: paymentIntent.id, forPayment: 'TIP' },
    });
    if (existing) {
      await this.prisma.payment.update({
        where: { id: existing.id },
        data: { status: 'failed' },
      });
      return;
    }

    const customerId = typeof paymentIntent.customer === 'string' ? paymentIntent.customer : paymentIntent.customer?.id;
    if (!customerId) return;

    const user = await this.prisma.user.findFirst({ where: { stripeCustomerId: customerId } });
    if (!user) return;

    const amountCents = paymentIntent.amount ?? 0;
    const {
      totalAmount,
      platformFee,
      receiverAmount,
    } = this.getTipAmountSplit(amountCents);
    const currency = paymentIntent.currency?.toUpperCase() ?? 'USD';
    const receiverUserId = paymentIntent.metadata?.receiverUserId;

    await this.prisma.payment.create({
      data: {
        user: { connect: { id: user.id } },
        ...(receiverUserId && { receiver: { connect: { id: receiverUserId } } }),
        amount: receiverAmount,
        platformFee,
        totalAmount,
        currency,
        status: 'failed',
        forPayment: 'TIP',
        stripePaymentIntentId: paymentIntent.id,
      },
    });
  }

  async handleEbookPaymentSuccess(paymentIntent: Stripe.PaymentIntent) {
    const existing = await (this.prisma as any).ebookPayments.findFirst({
      where: {
        OR: [
          { paymentIntentId: paymentIntent.id },
          ...(paymentIntent.metadata?.ebookPaymentId ? [{ id: paymentIntent.metadata.ebookPaymentId }] : []),
        ],
      },
      select: { id: true, status: true, sellerId: true, sellerAmount: true, currency: true },
    });

    if (existing) {
      if (existing.status === 'SUCCEEDED') {
        await this.creditSellerAvailableWallet({
          sellerUserId: existing.sellerId,
          amountMinor: existing.sellerAmount,
          source: 'EBOOK',
          refId: existing.id,
          currency: existing.currency || paymentIntent.currency || 'usd',
          note: `Ebook payment ${existing.id}`,
        });
        return;
      }
      await (this.prisma as any).ebookPayments.update({
        where: { id: existing.id },
        data: { status: 'SUCCEEDED', paymentIntentId: paymentIntent.id },
      });
      await this.creditSellerAvailableWallet({
        sellerUserId: existing.sellerId,
        amountMinor: existing.sellerAmount,
        source: 'EBOOK',
        refId: existing.id,
        currency: existing.currency || paymentIntent.currency || 'usd',
        note: `Ebook payment ${existing.id}`,
      });
      return;
    }

    const buyerUserId = paymentIntent.metadata?.buyerUserId;
    const targetUserId = paymentIntent.metadata?.targetUserId;
    const postId = paymentIntent.metadata?.postId;

    if (!buyerUserId || !targetUserId || !postId) return;

    const amountCents = paymentIntent.amount ?? 0;
    const { platformFeeCents, receiverAmountCents } = this.getEbookAmountSplit(amountCents);

    const created = await (this.prisma as any).ebookPayments.create({
      data: {
        buyerId: buyerUserId,
        sellerId: targetUserId,
        postId,
        amount: amountCents,
        platformFee: platformFeeCents,
        sellerAmount: receiverAmountCents,
        currency: paymentIntent.currency?.toLowerCase() ?? 'usd',
        provider: 'STRIPE',
        status: 'SUCCEEDED',
        paymentIntentId: paymentIntent.id,
        metadata: {
          source: 'payment_intent.succeeded',
          paymentIntentId: paymentIntent.id,
        },
      },
      select: { id: true, sellerId: true, sellerAmount: true, currency: true },
    });

    await this.creditSellerAvailableWallet({
      sellerUserId: created.sellerId,
      amountMinor: created.sellerAmount,
      source: 'EBOOK',
      refId: created.id,
      currency: created.currency || 'usd',
      note: `Ebook payment ${created.id}`,
    });
  }

  async handleEbookPaymentFailed(paymentIntent: Stripe.PaymentIntent) {
    const existing = await (this.prisma as any).ebookPayments.findFirst({
      where: {
        OR: [
          { paymentIntentId: paymentIntent.id },
          ...(paymentIntent.metadata?.ebookPaymentId ? [{ id: paymentIntent.metadata.ebookPaymentId }] : []),
        ],
      },
      select: { id: true },
    });

    if (existing) {
      await (this.prisma as any).ebookPayments.update({
        where: { id: existing.id },
        data: { status: 'FAILED', paymentIntentId: paymentIntent.id },
      });
      return;
    }

    const buyerUserId = paymentIntent.metadata?.buyerUserId;
    const targetUserId = paymentIntent.metadata?.targetUserId;
    const postId = paymentIntent.metadata?.postId;
    if (!buyerUserId || !targetUserId || !postId) return;

    const amountCents = paymentIntent.amount ?? 0;
    const { platformFeeCents, receiverAmountCents } = this.getEbookAmountSplit(amountCents);

    await (this.prisma as any).ebookPayments.create({
      data: {
        buyerId: buyerUserId,
        sellerId: targetUserId,
        postId,
        amount: amountCents,
        platformFee: platformFeeCents,
        sellerAmount: receiverAmountCents,
        currency: paymentIntent.currency?.toLowerCase() ?? 'usd',
        provider: 'STRIPE',
        status: 'FAILED',
        paymentIntentId: paymentIntent.id,
        metadata: {
          source: 'payment_intent.payment_failed',
          paymentIntentId: paymentIntent.id,
        },
      },
    });
  }

  async handleShopEbookPaymentSuccess(paymentIntent: Stripe.PaymentIntent) {
    const existing = await (this.prisma as any).shopEbookPayments.findFirst({
      where: {
        OR: [
          { paymentIntentId: paymentIntent.id },
          ...(paymentIntent.metadata?.shopEbookPaymentId ? [{ id: paymentIntent.metadata.shopEbookPaymentId }] : []),
        ],
      },
      select: { id: true, status: true, sellerId: true, sellerAmount: true, currency: true },
    });

    if (existing) {
      if (existing.status === 'SUCCEEDED') {
        await this.creditSellerAvailableWallet({
          sellerUserId: existing.sellerId,
          amountMinor: existing.sellerAmount,
          source: 'SHOP_EBOOK',
          refId: existing.id,
          currency: existing.currency || paymentIntent.currency || 'usd',
          note: `Shop ebook payment ${existing.id}`,
        });
        return;
      }
      await (this.prisma as any).shopEbookPayments.update({
        where: { id: existing.id },
        data: { status: 'SUCCEEDED', paymentIntentId: paymentIntent.id },
      });
      await this.creditSellerAvailableWallet({
        sellerUserId: existing.sellerId,
        amountMinor: existing.sellerAmount,
        source: 'SHOP_EBOOK',
        refId: existing.id,
        currency: existing.currency || paymentIntent.currency || 'usd',
        note: `Shop ebook payment ${existing.id}`,
      });
      return;
    }

    const buyerUserId = paymentIntent.metadata?.buyerUserId;
    const sellerUserId = paymentIntent.metadata?.sellerUserId;
    const closetId = paymentIntent.metadata?.closetId;
    const ebookId = paymentIntent.metadata?.ebookId;

    if (!buyerUserId || !sellerUserId || !closetId || !ebookId) return;

    const amountCents = paymentIntent.amount ?? 0;
    const { platformFeeCents, receiverAmountCents } = this.getEbookAmountSplit(amountCents);

    const created = await (this.prisma as any).shopEbookPayments.create({
      data: {
        buyerId: buyerUserId,
        sellerId: sellerUserId,
        closetId,
        ebookId,
        amount: amountCents,
        platformFee: platformFeeCents,
        sellerAmount: receiverAmountCents,
        currency: paymentIntent.currency?.toLowerCase() ?? 'usd',
        provider: 'STRIPE',
        status: 'SUCCEEDED',
        paymentIntentId: paymentIntent.id,
        metadata: {
          source: 'payment_intent.succeeded',
          paymentIntentId: paymentIntent.id,
        },
      },
      select: { id: true, sellerId: true, sellerAmount: true, currency: true },
    });

    await this.creditSellerAvailableWallet({
      sellerUserId: created.sellerId,
      amountMinor: created.sellerAmount,
      source: 'SHOP_EBOOK',
      refId: created.id,
      currency: created.currency || 'usd',
      note: `Shop ebook payment ${created.id}`,
    });
  }

  async handleShopEbookPaymentFailed(paymentIntent: Stripe.PaymentIntent) {
    const existing = await (this.prisma as any).shopEbookPayments.findFirst({
      where: {
        OR: [
          { paymentIntentId: paymentIntent.id },
          ...(paymentIntent.metadata?.shopEbookPaymentId ? [{ id: paymentIntent.metadata.shopEbookPaymentId }] : []),
        ],
      },
      select: { id: true },
    });

    if (existing) {
      await (this.prisma as any).shopEbookPayments.update({
        where: { id: existing.id },
        data: { status: 'FAILED', paymentIntentId: paymentIntent.id },
      });
      return;
    }

    const buyerUserId = paymentIntent.metadata?.buyerUserId;
    const sellerUserId = paymentIntent.metadata?.sellerUserId;
    const closetId = paymentIntent.metadata?.closetId;
    const ebookId = paymentIntent.metadata?.ebookId;
    if (!buyerUserId || !sellerUserId || !closetId || !ebookId) return;

    const amountCents = paymentIntent.amount ?? 0;
    const { platformFeeCents, receiverAmountCents } = this.getEbookAmountSplit(amountCents);

    await (this.prisma as any).shopEbookPayments.create({
      data: {
        buyerId: buyerUserId,
        sellerId: sellerUserId,
        closetId,
        ebookId,
        amount: amountCents,
        platformFee: platformFeeCents,
        sellerAmount: receiverAmountCents,
        currency: paymentIntent.currency?.toLowerCase() ?? 'usd',
        provider: 'STRIPE',
        status: 'FAILED',
        paymentIntentId: paymentIntent.id,
        metadata: {
          source: 'payment_intent.payment_failed',
          paymentIntentId: paymentIntent.id,
        },
      },
    });
  }

  async getLatestTransactions(userId: string, limit: number = 50, deviceId?: string) {
    const lang = await this.notificationService.getUserLanguage(userId, deviceId);
    const normalizedLang = normalizeLanguage(lang);
    const transactions = await this.prisma.payment.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(1, limit), 100),
    });

    if (normalizedLang === 'en') return transactions;

    return transactions.map((p) => {
      const localized = this.localizePaymentFields(normalizedLang, p.forPayment, p.status);
      return {
        ...p,
        forPayment: localized.forPayment,
        status: localized.status,
      };
    });
  }

  async getTransactionDetails(userId: string, paymentId?: string, transactionId?: string, deviceId?: string) {
    const normalizedPaymentId = paymentId?.trim();
    const normalizedTransactionId = transactionId?.trim();
    if (!normalizedPaymentId && !normalizedTransactionId) {
      throw new BadRequestException('paymentId or transactionId is required');
    }

    const lang = await this.notificationService.getUserLanguage(userId, deviceId);
    const normalizedLang = normalizeLanguage(lang);

    const identifiers = [
      ...(normalizedPaymentId ? [{ id: normalizedPaymentId }] : []),
      ...(normalizedTransactionId
        ? [
          { stripePaymentIntentId: normalizedTransactionId },
          { paymentIntentId: normalizedTransactionId },
          { transactionId: normalizedTransactionId },
          { stripeCheckoutSessionId: normalizedTransactionId },
        ]
        : []),
    ];
    const profileSelect = { id: true, displayName: true, userName: true, image: true };
    const paymentAccess = { OR: [{ userId }, { receiverId: userId }] };

    const payment = await this.prisma.payment.findFirst({
      where: { AND: [paymentAccess, { OR: identifiers.filter((item) => 'stripePaymentIntentId' in item || 'id' in item) }] },
      include: { user: { select: profileSelect }, receiver: { select: profileSelect } },
    });
    if (payment) {
      const provider = payment.currency.toUpperCase() === 'BRL' ? 'PAGBANK' : 'STRIPE';
      const mission = payment.forPayment === 'missionDonation'
        ? await this.prisma.donationData.findFirst({
          where: {
            userId: payment.userId,
            OR: [
              ...(payment.stripePaymentIntentId ? [{ stripePaymentIntentId: payment.stripePaymentIntentId }] : []),
              ...(payment.stripePaymentIntentId ? [{ stripeCheckoutSessionId: payment.stripePaymentIntentId }] : []),
            ],
          },
          select: { postId: true, note: true },
        })
        : null;
      const localized = this.localizePaymentFields(normalizedLang, payment.forPayment, payment.status);
      const localizedSource = payment.forPayment === 'missionDonation'
        ? (normalizedLang === 'en' ? 'MISSION_DONATION' : translatePaymentType('missionDonation', normalizedLang))
        : localized.forPayment;
      return {
        paymentId: payment.id,
        transactionId: payment.stripePaymentIntentId,
        source: localizedSource,
        status: localized.status,
        // Clients must not derive payment confirmation from a translated status label.
        rawStatus: payment.status,
        type: localized.forPayment,
        currency: payment.currency,
        amount: payment.amount,
        fee: payment.platformFee || 0,
        total: payment.totalAmount ?? payment.amount + (payment.platformFee || 0),
        paymentMethod: provider,
        createdAt: payment.createdAt,
        periodStart: payment.periodStart,
        periodEnd: payment.periodEnd,
        note: mission?.note ?? null,
        from: payment.user,
        to: payment.receiver,
        direction: payment.userId === userId ? 'SENT' : 'RECEIVED',
        ...(mission?.postId ? { postId: mission.postId } : {}),
      };
    }

    const [mission, ebook, shopEbook, marketplace] = await Promise.all([
      this.prisma.donationData.findFirst({
        where: {
          AND: [
            { OR: [{ userId }, { vendorId: userId }] },
            { OR: identifiers.filter((item) => 'id' in item || 'stripePaymentIntentId' in item || 'stripeCheckoutSessionId' in item) },
          ],
        },
      }),
      (this.prisma as any).ebookPayments.findFirst({
        where: {
          AND: [
            { OR: [{ buyerId: userId }, { sellerId: userId }] },
            { OR: identifiers.filter((item) => 'id' in item || 'paymentIntentId' in item) },
          ],
        },
        include: { buyer: { select: profileSelect }, seller: { select: profileSelect } },
      }),
      (this.prisma as any).shopEbookPayments.findFirst({
        where: {
          AND: [
            { OR: [{ buyerId: userId }, { sellerId: userId }] },
            { OR: identifiers.filter((item) => 'id' in item || 'paymentIntentId' in item) },
          ],
        },
        include: { buyer: { select: profileSelect }, seller: { select: profileSelect } },
      }),
      (this.prisma as any).marketPlacePayments.findFirst({
        where: {
          AND: [
            { OR: [{ userId }, { orders: { some: { OR: [{ buyerId: userId }, { sellerId: userId }] } } }] },
            {
              OR: [
                ...identifiers.filter((item) => 'id' in item || 'paymentIntentId' in item || 'transactionId' in item),
                ...(normalizedPaymentId
                  ? [
                    { orderId: normalizedPaymentId },
                    { orders: { some: { id: normalizedPaymentId } } },
                    { orders: { some: { orderNumber: normalizedPaymentId } } },
                  ]
                  : []),
                ...(normalizedTransactionId
                  ? [
                    { orderId: normalizedTransactionId },
                    { orders: { some: { id: normalizedTransactionId } } },
                    { orders: { some: { orderNumber: normalizedTransactionId } } },
                  ]
                  : []),
              ],
            },
          ],
        },
        include: {
          orders: {
            select: {
              id: true,
              orderNumber: true,
              orderStatus: true,
              paymentStatus: true,
              subtotal: true,
              shippingCost: true,
              serviceFee: true,
              total: true,
              platformFeeMinor: true,
              sellerAmountMinor: true,
              refundId: true,
              refundAmount: true,
              refundedAt: true,
              cancellationReason: true,
              cancelledBy: true,
              buyer: { select: profileSelect },
              seller: { select: profileSelect },
              items: {
                select: {
                  id: true,
                  productId: true,
                  productName: true,
                  productImage: true,
                  quantity: true,
                  price: true,
                  subtotal: true,
                },
              },
            },
          },
        },
      }),
    ]);

    if (mission) {
      const [from, to] = await Promise.all([
        this.prisma.user.findUnique({ where: { id: mission.userId }, select: profileSelect }),
        mission.vendorId
          ? this.prisma.user.findUnique({ where: { id: mission.vendorId }, select: profileSelect })
          : Promise.resolve(null),
      ]);
      const localizedSource = normalizedLang === 'en' ? 'MISSION_DONATION' : translatePaymentType('missionDonation', normalizedLang);
      const localizedStatus = normalizedLang === 'en' ? mission.status : translatePaymentStatus(mission.status, normalizedLang);
      const localizedType = normalizedLang === 'en' ? 'missionDonation' : translatePaymentType('missionDonation', normalizedLang);
      const fee = mission.platformFees || 0;
      const total = mission.totalAmount ?? mission.amount + fee;
      return {
        paymentId: mission.id,
        transactionId: mission.stripePaymentIntentId || mission.stripeCheckoutSessionId,
        source: localizedSource,
        status: localizedStatus,
        type: localizedType,
        currency: mission.currency,
        amount: mission.amount,
        fee,
        total,
        platformFee: fee,
        platformFees: fee,
        sellerAmount: mission.amount,
        totalAmount: total,
        paymentMethod: mission.currency.toUpperCase() === 'BRL' ? 'PAGBANK' : 'STRIPE',
        createdAt: mission.createdAt,
        note: mission.note,
        from,
        to,
        direction: mission.userId === userId ? 'SENT' : 'RECEIVED',
        postId: mission.postId,
      };
    }

    if (ebook || shopEbook) {
      const record = ebook || shopEbook;
      const rawType = ebook ? 'ebook' : 'shopEbook';
      const localizedSource = normalizedLang === 'en' ? (ebook ? 'EBOOK' : 'SHOP_EBOOK') : translatePaymentType(rawType, normalizedLang);
      const localizedStatus = normalizedLang === 'en' ? record.status : translatePaymentStatus(record.status, normalizedLang);
      const localizedType = normalizedLang === 'en' ? rawType : translatePaymentType(rawType, normalizedLang);
      const sellerAmount = Number(((record.sellerAmount || 0) / 100).toFixed(2));
      const platformFee = Number(((record.platformFee || 0) / 100).toFixed(2));
      const totalAmount = Number(((record.amount || 0) / 100).toFixed(2));
      return {
        paymentId: record.id,
        transactionId: record.paymentIntentId || record.checkoutSessionId,
        source: localizedSource,
        status: localizedStatus,
        type: localizedType,
        currency: record.currency,
        amount: sellerAmount,
        fee: platformFee,
        total: totalAmount,
        platformFee,
        platformFees: platformFee,
        sellerAmount,
        totalAmount,
        paymentMethod: record.provider,
        createdAt: record.createdAt,
        note: null,
        from: record.buyer,
        to: record.seller,
        direction: record.buyerId === userId ? 'SENT' : 'RECEIVED',
        ...(ebook ? { postId: record.postId } : { closetId: record.closetId, ebookId: record.ebookId }),
      };
    }

    if (marketplace) {
      const order = marketplace.orders?.find((item: any) => item.buyer?.id === userId || item.seller?.id === userId) || marketplace.orders?.[0];
      const from = order?.buyer || null;
      const to = order?.seller || null;
      const metadata = marketplace.metadata as Record<string, any> | null;

      const platformFee = order?.platformFeeMinor != null
        ? Number((order.platformFeeMinor / 100).toFixed(2))
        : order?.serviceFee != null
          ? Number(order.serviceFee.toFixed(2))
          : metadata?.platformFeeMinor != null
            ? Number((metadata.platformFeeMinor / 100).toFixed(2))
            : 0;

      const sellerAmount = order?.sellerAmountMinor != null
        ? Number((order.sellerAmountMinor / 100).toFixed(2))
        : order?.total != null
          ? Number(((order.total || 0) - (order.serviceFee || 0)).toFixed(2))
          : metadata?.sellerAmountMinor != null
            ? Number((metadata.sellerAmountMinor / 100).toFixed(2))
            : Number(((marketplace.amount / 100) - platformFee).toFixed(2));

      const totalAmount = order?.total != null
        ? Number(order.total.toFixed(2))
        : metadata?.grandTotalMinor != null
          ? Number((metadata.grandTotalMinor / 100).toFixed(2))
          : Number((marketplace.amount / 100).toFixed(2));

      const localizedSource = normalizedLang === 'en' ? 'SHOP' : translatePaymentType('shop', normalizedLang);
      const localizedStatus = normalizedLang === 'en' ? marketplace.status : translatePaymentStatus(marketplace.status, normalizedLang);
      const localizedType = normalizedLang === 'en' ? 'shop' : translatePaymentType('shop', normalizedLang);
      return {
        paymentId: marketplace.id,
        transactionId: marketplace.transactionId || marketplace.paymentIntentId || marketplace.orderId,
        source: localizedSource,
        status: localizedStatus,
        type: localizedType,
        currency: marketplace.currency,
        amount: sellerAmount,
        fee: platformFee,
        total: totalAmount,
        platformFee,
        platformFees: platformFee,
        sellerAmount,
        totalAmount,
        subtotal: order?.subtotal ?? (metadata?.subtotalMinor ? Number((metadata.subtotalMinor / 100).toFixed(2)) : null),
        shippingCost: order?.shippingCost ?? (metadata?.shippingMinor ? Number((metadata.shippingMinor / 100).toFixed(2)) : null),
        paymentMethod: marketplace.provider,
        createdAt: marketplace.createdAt,
        note: order?.cancellationReason || null,
        from,
        to,
        direction: marketplace.userId === userId || from?.id === userId ? 'SENT' : 'RECEIVED',
        orderId: marketplace.orderId || order?.id,
        orderNumber: order?.orderNumber || null,
        cartId: marketplace.cartId,
        items: order?.items || [],
        refundId: order?.refundId || null,
        refundAmount: order?.refundAmount != null ? order.refundAmount : (marketplace.status === 'REFUNDED' ? marketplace.amount / 100 : null),
        refundedAt: order?.refundedAt || null,
        cancellationReason: order?.cancellationReason || null,
        cancelledBy: order?.cancelledBy || null,
      };
    }

    const orderDirect = await this.prisma.order.findFirst({
      where: {
        AND: [
          { OR: [{ buyerId: userId }, { sellerId: userId }] },
          {
            OR: [
              ...(normalizedPaymentId ? [{ id: normalizedPaymentId }, { paymentId: normalizedPaymentId }, { orderNumber: normalizedPaymentId }] : []),
              ...(normalizedTransactionId ? [{ id: normalizedTransactionId }, { stripeChargeId: normalizedTransactionId }, { orderNumber: normalizedTransactionId }] : []),
            ],
          },
        ],
      },
      include: {
        buyer: { select: profileSelect },
        seller: { select: profileSelect },
        payment: true,
        items: {
          select: {
            id: true,
            productId: true,
            productName: true,
            productImage: true,
            quantity: true,
            price: true,
            subtotal: true,
          },
        },
      },
    });

    if (orderDirect) {
      const from = orderDirect.buyer || null;
      const to = orderDirect.seller || null;
      const platformFee = orderDirect.platformFeeMinor != null
        ? Number((orderDirect.platformFeeMinor / 100).toFixed(2))
        : Number((orderDirect.serviceFee || 0).toFixed(2));
      const sellerAmount = orderDirect.sellerAmountMinor != null
        ? Number((orderDirect.sellerAmountMinor / 100).toFixed(2))
        : Number(((orderDirect.total || 0) - (orderDirect.serviceFee || 0)).toFixed(2));
      const totalAmount = Number((orderDirect.total || 0).toFixed(2));
      const localizedSource = normalizedLang === 'en' ? 'SHOP' : translatePaymentType('shop', normalizedLang);
      const localizedStatus = normalizedLang === 'en' ? orderDirect.paymentStatus : translatePaymentStatus(orderDirect.paymentStatus, normalizedLang);
      const localizedType = normalizedLang === 'en' ? 'shop' : translatePaymentType('shop', normalizedLang);

      return {
        paymentId: orderDirect.paymentId || orderDirect.id,
        transactionId: orderDirect.payment?.transactionId || orderDirect.stripeChargeId || orderDirect.id,
        source: localizedSource,
        status: localizedStatus,
        type: localizedType,
        currency: orderDirect.payment?.currency || 'usd',
        amount: sellerAmount,
        fee: platformFee,
        total: totalAmount,
        platformFee,
        platformFees: platformFee,
        sellerAmount,
        totalAmount,
        subtotal: orderDirect.subtotal,
        shippingCost: orderDirect.shippingCost,
        paymentMethod: orderDirect.paymentMethod || orderDirect.payment?.provider || 'STRIPE',
        createdAt: orderDirect.createdAt,
        note: orderDirect.cancellationReason || null,
        from,
        to,
        direction: orderDirect.buyerId === userId ? 'SENT' : 'RECEIVED',
        orderId: orderDirect.id,
        orderNumber: orderDirect.orderNumber,
        cartId: orderDirect.payment?.cartId || null,
        items: orderDirect.items || [],
        refundId: orderDirect.refundId || null,
        refundAmount: orderDirect.refundAmount != null ? orderDirect.refundAmount : null,
        refundedAt: orderDirect.refundedAt || null,
        cancellationReason: orderDirect.cancellationReason || null,
        cancelledBy: orderDirect.cancelledBy || null,
      };
    }

    throw new NotFoundException('Transaction not found');
  }

  async getMyEbookPayments(
    userId: string,
    role: 'buyer' | 'seller' | 'all' = 'all',
    page: number = 1,
    limit: number = 10,
  ) {
    const safePage = Math.max(1, page || 1);
    const safeLimit = Math.min(50, Math.max(1, limit || 10));
    const skip = (safePage - 1) * safeLimit;

    const where =
      role === 'buyer'
        ? { buyerId: userId }
        : role === 'seller'
          ? { sellerId: userId }
          : {
            OR: [{ buyerId: userId }, { sellerId: userId }],
          };

    const [totalCount, totals, records] = await Promise.all([
      (this.prisma as any).ebookPayments.count({ where }),
      (this.prisma as any).ebookPayments.aggregate({
        where,
        _sum: {
          amount: true,
          platformFee: true,
          sellerAmount: true,
        },
      }),
      (this.prisma as any).ebookPayments.findMany({
        where,
        include: {
          buyer: {
            select: {
              id: true,
              displayName: true,
              image: true,
            },
          },
          seller: {
            select: {
              id: true,
              displayName: true,
              image: true,
            },
          },
          post: {
            select: {
              id: true,
              caption: true,
              format: true,
              amount: true,
              ebookpdf: true,
              thumbnails: true,
              images: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: safeLimit,
      }),
    ]);

    return {
      role,
      page: safePage,
      limit: safeLimit,
      totalCount,
      totalPages: Math.ceil(totalCount / safeLimit),
      totals: {
        amount: totals?._sum?.amount ?? 0,
        platformFee: totals?._sum?.platformFee ?? 0,
        sellerAmount: totals?._sum?.sellerAmount ?? 0,
      },
      records,
    };
  }

  async getPayFollowingReceivedSummary(receiverId: string, page: number = 1, pageSize: number = 10) {
    const safePage = Math.max(1, page || 1);
    const safePageSize = Math.min(Math.max(1, pageSize || 10), 50);
    const skip = (safePage - 1) * safePageSize;
    const where = {
      receiverId,
      forPayment: 'following',
      status: 'succeeded',
    } as const;

    const [sumResult, transactions] = await Promise.all([
      this.prisma.payment.aggregate({
        where,
        _sum: { amount: true },
      }),
      this.prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: safePageSize,
      }),
    ]);

    return {
      totalAmount: sumResult._sum.amount ?? 0,
      transactions,
    };
  }

  async getPayFollowingSubscribers(creatorId: string, query: GetSubscribersQueryDto) {
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 10));
    const skip = (page - 1) * limit;
    const now = new Date();

    const andConditions: Prisma.FansSubscriptionBuyDataWhereInput[] = [
      { buyUserId: creatorId },
    ];

    const statusFilter = query.status || SubscriberStatusFilter.ALL;
    if (statusFilter === SubscriberStatusFilter.ACTIVE) {
      andConditions.push({
        status: 'ACTIVE',
        endDate: { gt: now },
      });
    } else if (statusFilter === SubscriberStatusFilter.EXPIRED) {
      andConditions.push({
        OR: [
          { status: 'STOP' },
          { endDate: { lte: now } },
        ],
      });
    } else if (statusFilter === SubscriberStatusFilter.STOP) {
      andConditions.push({
        status: 'STOP',
      });
    }

    if (query.search && query.search.trim()) {
      const term = query.search.trim();
      andConditions.push({
        fanUser: {
          OR: [
            { userName: { contains: term, mode: 'insensitive' } },
            { displayName: { contains: term, mode: 'insensitive' } },
            { email: { contains: term, mode: 'insensitive' } },
          ],
        },
      });
    }

    const whereClause: Prisma.FansSubscriptionBuyDataWhereInput = {
      AND: andConditions,
    };

    let orderBy: Prisma.FansSubscriptionBuyDataOrderByWithRelationInput = { createdAt: 'desc' };
    if (query.sortBy === SubscriberSortBy.OLDEST) {
      orderBy = { createdAt: 'asc' };
    } else if (query.sortBy === SubscriberSortBy.PRICE_HIGH) {
      orderBy = { priceAtSubscription: 'desc' };
    } else if (query.sortBy === SubscriberSortBy.PRICE_LOW) {
      orderBy = { priceAtSubscription: 'asc' };
    } else if (query.sortBy === SubscriberSortBy.EXPIRY_SOON) {
      orderBy = { endDate: 'asc' };
    }

    const [totalSubscribers, activeCount, expiredCount, records] = await Promise.all([
      this.prisma.fansSubscriptionBuyData.count({
        where: whereClause,
      }),
      this.prisma.fansSubscriptionBuyData.count({
        where: {
          buyUserId: creatorId,
          status: 'ACTIVE',
          endDate: { gt: now },
        },
      }),
      this.prisma.fansSubscriptionBuyData.count({
        where: {
          buyUserId: creatorId,
          OR: [
            { status: 'STOP' },
            { endDate: { lte: now } },
          ],
        },
      }),
      this.prisma.fansSubscriptionBuyData.findMany({
        where: whereClause,
        include: {
          fanUser: {
            select: {
              id: true,
              userName: true,
              displayName: true,
              email: true,
              image: true,
              country: true,
              kyc: true,
              createdAt: true,
            },
          },
        },
        orderBy,
        skip,
        take: limit,
      }),
    ]);

    const fanUserIds = records.map((r) => r.fanUserId);
    const paymentsAggregates = fanUserIds.length > 0
      ? await this.prisma.payment.groupBy({
        by: ['userId'],
        where: {
          receiverId: creatorId,
          userId: { in: fanUserIds },
          forPayment: 'following',
          status: 'succeeded',
        },
        _sum: { amount: true, totalAmount: true },
        _count: { id: true },
      })
      : [];

    const paymentMap = new Map<string, { totalPaidAmount: number; totalEarnedAmount: number; paymentsCount: number }>();
    for (const agg of paymentsAggregates) {
      paymentMap.set(agg.userId, {
        totalPaidAmount: agg._sum?.totalAmount || 0,
        totalEarnedAmount: agg._sum?.amount || 0,
        paymentsCount: agg._count?.id || 0,
      });
    }

    const subscribers = records.map((item) => {
      const isCurrentlyActive = item.status === 'ACTIVE' && item.endDate > now;
      const paymentStats = paymentMap.get(item.fanUserId) || {
        totalPaidAmount: 0,
        totalEarnedAmount: 0,
        paymentsCount: 0,
      };

      return {
        subscriptionId: item.id,
        subscriber: item.fanUser,
        priceAtSubscription: item.priceAtSubscription,
        startDate: item.startDate,
        endDate: item.endDate,
        status: item.status,
        isActive: isCurrentlyActive,
        isEnded: !isCurrentlyActive,
        isCancelled: item.cancelAtPeriodEnd || !item.autoRenew,
        autoRenew: item.autoRenew,
        cancelAtPeriodEnd: item.cancelAtPeriodEnd,
        paymentProvider: item.paymentProvider,
        stripeSubscriptionId: item.stripeSubscriptionId,
        totalEarnedFromSubscriber: paymentStats.totalEarnedAmount,
        totalPaidBySubscriber: paymentStats.totalPaidAmount,
        paymentsCount: paymentStats.paymentsCount,
        subscribedAt: item.createdAt,
        updatedAt: item.updatedAt,
      };
    });

    return {
      meta: {
        totalSubscribers,
        activeSubscribers: activeCount,
        expiredSubscribers: expiredCount,
        page,
        limit,
        totalPages: Math.ceil(totalSubscribers / limit),
      },
      subscribers,
    };
  }

  async getPayFollowingPriceUpdateSummary(creatorId: string) {
    const subscription = await this.prisma.userSubscription.findFirst({
      where: { userId: creatorId, isDelete: 0 },
      orderBy: { createdAt: 'desc' },
    });

    if (!subscription) {
      return {
        hasSubscription: false,
        message: 'No active pay-following subscription plan found for this creator',
      };
    }

    const currentAmount = Number(subscription.subscriptionAmount);
    const previousAmount =
      subscription.previousAmount !== null && subscription.previousAmount !== undefined
        ? Number(subscription.previousAmount)
        : currentAmount;

    const priceCreatedAt = subscription.priceUpdatedAt || subscription.createdAt || new Date();
    const renewalDate =
      subscription.nextPriceUpdateAvailableAt ||
      new Date(priceCreatedAt.getTime() + 180 * 24 * 60 * 60 * 1000);
    const now = new Date();
    const diffMs = renewalDate.getTime() - now.getTime();
    const daysUntilNextUpdate = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
    const canUpdatePrice = daysUntilNextUpdate === 0;

    const formatCurrency = (val: number) => `$${Number(val).toFixed(2)} / month`;
    const formatDate = (d: Date) =>
      d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    // Mode 2: If creator chose old users pay same price (GRANDFATHER_EXISTING)
    if (subscription.pricingPolicy === 'GRANDFATHER_EXISTING') {
      return {
        pricingPolicy: 'GRANDFATHER_EXISTING',
        title: 'Existing subscribers keep current price',
        oldPrice: previousAmount,
        currentPrice: currentAmount,
        oldPriceFormatted: formatCurrency(previousAmount),
        currentPriceFormatted: formatCurrency(currentAmount),
        priceCreatedAt: priceCreatedAt.toISOString(),
        priceCreatedAtFormatted: formatDate(priceCreatedAt),
        renewalDate: renewalDate.toISOString(),
        renewalDateFormatted: formatDate(renewalDate),
        daysUntilNextUpdate,
        canUpdatePrice,
      };
    }

    // Mode 1: New price for all users (REQUIRE_NEW_CONSENT)
    const subscriberRecords = await this.prisma.fansSubscriptionBuyData.findMany({
      where: {
        buyUserId: creatorId,
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        id: true,
        fanUserId: true,
        status: true,
        priceAtSubscription: true,
        endDate: true,
        cancelAtPeriodEnd: true,
        autoRenew: true,
        updatedAt: true,
        createdAt: true,
      },
    });

    // Deduplicate by fanUserId to get current status per subscriber
    const uniqueFansMap = new Map<string, (typeof subscriberRecords)[0]>();
    for (const sub of subscriberRecords) {
      if (!uniqueFansMap.has(sub.fanUserId)) {
        uniqueFansMap.set(sub.fanUserId, sub);
      }
    }

    let acceptedCount = 0;
    let canceledCount = 0;
    let pendingCount = 0;

    for (const sub of uniqueFansMap.values()) {
      const isExpired = new Date(sub.endDate) <= now;
      const isPriceUpdatedSubscriber =
        sub.priceAtSubscription !== null &&
        sub.priceAtSubscription !== undefined &&
        Number(sub.priceAtSubscription) >= currentAmount;
      const isUpdatedAfterPriceChange = new Date(sub.updatedAt) >= priceCreatedAt;

      if (sub.status === 'STOP' || (sub.cancelAtPeriodEnd && isExpired)) {
        canceledCount++;
      } else if (sub.status === 'ACTIVE' && (isPriceUpdatedSubscriber || isUpdatedAfterPriceChange)) {
        acceptedCount++;
      } else if (sub.status === 'ACTIVE' && !isExpired) {
        pendingCount++;
      } else {
        canceledCount++;
      }
    }

    const totalSubscribers = acceptedCount + canceledCount + pendingCount;
    const statusBadge = pendingCount === 0 ? 'Completed' : 'In Progress';

    return {
      pricingPolicy: 'REQUIRE_NEW_CONSENT',
      title: 'Price update to all subscribers',
      status: statusBadge,
      from: formatCurrency(previousAmount),
      to: formatCurrency(currentAmount),
      fromPrice: previousAmount,
      toPrice: currentAmount,
      effective: 'On next renewal',
      date: formatDate(priceCreatedAt),
      dateIso: priceCreatedAt.toISOString(),
      counts: {
        accepted: acceptedCount,
        declined: canceledCount,
        pending: pendingCount,
        total: totalSubscribers,
      },
      renewalDate: renewalDate.toISOString(),
      renewalDateFormatted: formatDate(renewalDate),
      daysUntilNextUpdate,
      canUpdatePrice,
    };
  }

  async getPayFollowingPriceUpdateSubscribers(
    creatorId: string,
    query: GetPriceUpdateSubscribersQueryDto,
  ) {
    const subscription = await this.prisma.userSubscription.findFirst({
      where: { userId: creatorId, isDelete: 0 },
      orderBy: { createdAt: 'desc' },
    });

    if (!subscription) {
      return {
        hasSubscription: false,
        message: 'No active pay-following subscription plan found for this creator',
        counts: { accepted: 0, declined: 0, pending: 0, total: 0 },
        meta: { total: 0, totalSubscribers: 0, page: 1, limit: 10, totalPages: 0, filter: 'ALL' },
        subscribers: [],
      };
    }

    const currentAmount = Number(subscription.subscriptionAmount);
    const previousAmount =
      subscription.previousAmount !== null && subscription.previousAmount !== undefined
        ? Number(subscription.previousAmount)
        : currentAmount;

    const priceCreatedAt = subscription.priceUpdatedAt || subscription.createdAt || new Date();
    const renewalDate =
      subscription.nextPriceUpdateAvailableAt ||
      new Date(priceCreatedAt.getTime() + 180 * 24 * 60 * 60 * 1000);
    const now = new Date();
    const diffMs = renewalDate.getTime() - now.getTime();
    const daysUntilNextUpdate = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
    const canUpdatePrice = daysUntilNextUpdate === 0;

    const formatCurrency = (val: number) => `$${Number(val).toFixed(2)} / month`;
    const formatDate = (d: Date) =>
      d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    const subscriberRecords = await this.prisma.fansSubscriptionBuyData.findMany({
      where: {
        buyUserId: creatorId,
      },
      orderBy: {
        createdAt: 'desc',
      },
      include: {
        fanUser: {
          select: {
            id: true,
            userName: true,
            displayName: true,
            email: true,
            image: true,
            country: true,
            kyc: true,
            createdAt: true,
          },
        },
      },
    });

    // Deduplicate by fanUserId to get current status per subscriber
    const uniqueFansMap = new Map<string, (typeof subscriberRecords)[0]>();
    for (const sub of subscriberRecords) {
      if (!uniqueFansMap.has(sub.fanUserId)) {
        uniqueFansMap.set(sub.fanUserId, sub);
      }
    }

    const fanUserIds = Array.from(uniqueFansMap.keys());
    const paymentsAggregates = fanUserIds.length > 0
      ? await this.prisma.payment.groupBy({
        by: ['userId'],
        where: {
          receiverId: creatorId,
          userId: { in: fanUserIds },
          forPayment: 'following',
          status: 'succeeded',
        },
        _sum: { amount: true, totalAmount: true },
        _count: { id: true },
      })
      : [];

    const paymentMap = new Map<string, { totalPaidAmount: number; totalEarnedAmount: number; paymentsCount: number }>();
    for (const agg of paymentsAggregates) {
      paymentMap.set(agg.userId, {
        totalPaidAmount: agg._sum?.totalAmount || 0,
        totalEarnedAmount: agg._sum?.amount || 0,
        paymentsCount: agg._count?.id || 0,
      });
    }

    let acceptedCount = 0;
    let declinedCount = 0;
    let pendingCount = 0;

    const processedList: any[] = [];

    for (const sub of uniqueFansMap.values()) {
      const isExpired = new Date(sub.endDate) <= now;
      const isPriceUpdatedSubscriber =
        sub.priceAtSubscription !== null &&
        sub.priceAtSubscription !== undefined &&
        Number(sub.priceAtSubscription) >= currentAmount;
      const isUpdatedAfterPriceChange = new Date(sub.updatedAt) >= priceCreatedAt;

      let responseStatus: 'ACCEPTED' | 'DECLINED' | 'PENDING';

      if (subscription.pricingPolicy === 'GRANDFATHER_EXISTING') {
        responseStatus = 'ACCEPTED';
      } else if (sub.status === 'STOP' || (sub.cancelAtPeriodEnd && isExpired)) {
        responseStatus = 'DECLINED';
      } else if (sub.status === 'ACTIVE' && (isPriceUpdatedSubscriber || isUpdatedAfterPriceChange)) {
        responseStatus = 'ACCEPTED';
      } else if (sub.status === 'ACTIVE' && !isExpired) {
        responseStatus = 'PENDING';
      } else {
        responseStatus = 'DECLINED';
      }

      if (responseStatus === 'ACCEPTED') acceptedCount++;
      else if (responseStatus === 'DECLINED') declinedCount++;
      else if (responseStatus === 'PENDING') pendingCount++;

      const userInfo = sub.fanUser || {
        id: sub.fanUserId,
        userName: null,
        displayName: null,
        email: null,
        image: null,
        country: null,
        kyc: null,
        createdAt: sub.createdAt,
      };

      const paymentStats = paymentMap.get(sub.fanUserId) || {
        totalPaidAmount: 0,
        totalEarnedAmount: 0,
        paymentsCount: 0,
      };

      const isCurrentlyActive = sub.status === 'ACTIVE' && new Date(sub.endDate) > now;

      const item = {
        subscriptionId: sub.id,
        fanUserId: sub.fanUserId,
        responseStatus,
        responseStatusFormatted: responseStatus === 'ACCEPTED' ? 'Accepted' : responseStatus === 'DECLINED' ? 'Declined' : 'Pending',
        priceAtSubscription: sub.priceAtSubscription !== null && sub.priceAtSubscription !== undefined ? Number(sub.priceAtSubscription) : null,
        currentPrice: currentAmount,
        previousPrice: previousAmount,
        status: sub.status,
        isActive: isCurrentlyActive,
        isEnded: !isCurrentlyActive,
        isCancelled: sub.cancelAtPeriodEnd || !sub.autoRenew,
        startDate: sub.startDate,
        endDate: sub.endDate,
        autoRenew: sub.autoRenew,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        paymentProvider: sub.paymentProvider,
        stripeSubscriptionId: sub.stripeSubscriptionId,
        totalEarnedFromSubscriber: paymentStats.totalEarnedAmount,
        totalPaidBySubscriber: paymentStats.totalPaidAmount,
        paymentsCount: paymentStats.paymentsCount,
        createdAt: sub.createdAt,
        updatedAt: sub.updatedAt,
        subscriber: userInfo,
      };

      processedList.push(item);
    }

    const totalSubscribers = acceptedCount + declinedCount + pendingCount;
    const statusBadge = pendingCount === 0 ? 'Completed' : 'In Progress';

    // Resolve filter
    const rawFilter = (
      query.filter ||
      query.status ||
      query.responseStatus ||
      'ALL'
    ).toString().toUpperCase().trim();

    let normalizedFilter: 'ALL' | 'ACCEPTED' | 'DECLINED' | 'PENDING' = 'ALL';
    if (rawFilter === 'ACCEPTED' || rawFilter === 'ACCEPT') {
      normalizedFilter = 'ACCEPTED';
    } else if (
      rawFilter === 'DECLINED' ||
      rawFilter === 'DECLINE' ||
      rawFilter === 'CANCELED' ||
      rawFilter === 'CANCEL' ||
      rawFilter === 'CANCELLED' ||
      rawFilter === 'STOP'
    ) {
      normalizedFilter = 'DECLINED';
    } else if (rawFilter === 'PENDING') {
      normalizedFilter = 'PENDING';
    }

    let filtered = processedList;
    if (normalizedFilter !== 'ALL') {
      filtered = filtered.filter((item) => item.responseStatus === normalizedFilter);
    }

    // Search by name, username, display name, email, or user ID
    const searchTerm = (query.search || query.name || query.q || '').toString().trim().toLowerCase();
    if (searchTerm) {
      filtered = filtered.filter((item) => {
        const u = item.subscriber;
        if (!u) return false;
        const userName = (u.userName || '').toLowerCase();
        const displayName = (u.displayName || '').toLowerCase();
        const email = (u.email || '').toLowerCase();
        const fanUserId = (item.fanUserId || '').toLowerCase();

        return (
          userName.includes(searchTerm) ||
          displayName.includes(searchTerm) ||
          email.includes(searchTerm) ||
          fanUserId.includes(searchTerm)
        );
      });
    }

    const sortBy = query.sortBy || PriceUpdateSubscriberSortBy.NEWEST;
    filtered.sort((a, b) => {
      if (sortBy === PriceUpdateSubscriberSortBy.OLDEST) {
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      } else if (sortBy === PriceUpdateSubscriberSortBy.PRICE_HIGH) {
        return (Number(b.priceAtSubscription) || 0) - (Number(a.priceAtSubscription) || 0);
      } else if (sortBy === PriceUpdateSubscriberSortBy.PRICE_LOW) {
        return (Number(a.priceAtSubscription) || 0) - (Number(b.priceAtSubscription) || 0);
      } else if (sortBy === PriceUpdateSubscriberSortBy.EXPIRY_SOON) {
        return new Date(a.endDate).getTime() - new Date(b.endDate).getTime();
      } else if (sortBy === PriceUpdateSubscriberSortBy.NAME_ASC) {
        const nameA = (a.subscriber?.displayName || a.subscriber?.userName || '').toLowerCase();
        const nameB = (b.subscriber?.displayName || b.subscriber?.userName || '').toLowerCase();
        return nameA.localeCompare(nameB);
      } else if (sortBy === PriceUpdateSubscriberSortBy.NAME_DESC) {
        const nameA = (a.subscriber?.displayName || a.subscriber?.userName || '').toLowerCase();
        const nameB = (b.subscriber?.displayName || b.subscriber?.userName || '').toLowerCase();
        return nameB.localeCompare(nameA);
      } else {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
    });

    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 10));
    const skip = (page - 1) * limit;
    const paginatedItems = filtered.slice(skip, skip + limit);

    return {
      pricingPolicy: subscription.pricingPolicy,
      title:
        subscription.pricingPolicy === 'GRANDFATHER_EXISTING'
          ? 'Existing subscribers keep current price'
          : 'Price update to all subscribers',
      status: statusBadge,
      from: formatCurrency(previousAmount),
      to: formatCurrency(currentAmount),
      fromPrice: previousAmount,
      toPrice: currentAmount,
      effective: 'On next renewal',
      date: formatDate(priceCreatedAt),
      dateIso: priceCreatedAt.toISOString(),
      renewalDate: renewalDate.toISOString(),
      renewalDateFormatted: formatDate(renewalDate),
      daysUntilNextUpdate,
      canUpdatePrice,
      counts: {
        accepted: acceptedCount,
        declined: declinedCount,
        pending: pendingCount,
        total: totalSubscribers,
      },
      meta: {
        total: filtered.length,
        totalSubscribers,
        page,
        limit,
        totalPages: Math.ceil(filtered.length / limit) || 1,
        filter: normalizedFilter,
      },
      subscribers: paginatedItems,
    };
  }

  async getMyPayFollowingSubscriptions(fanUserId: string, query: GetMySubscriptionsQueryDto) {
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 10));
    const skip = (page - 1) * limit;
    const now = new Date();

    const andConditions: Prisma.FansSubscriptionBuyDataWhereInput[] = [
      { fanUserId },
    ];

    const statusFilter = query.status || SubscriptionStatusFilter.ALL;
    if (statusFilter === SubscriptionStatusFilter.ACTIVE) {
      andConditions.push({
        status: 'ACTIVE',
        endDate: { gt: now },
      });
    } else if (statusFilter === SubscriptionStatusFilter.EXPIRED) {
      andConditions.push({
        OR: [
          { status: 'STOP' },
          { endDate: { lte: now } },
        ],
      });
    } else if (statusFilter === SubscriptionStatusFilter.STOP) {
      andConditions.push({
        status: 'STOP',
      });
    }

    if (query.search && query.search.trim()) {
      const term = query.search.trim();
      andConditions.push({
        buyUser: {
          OR: [
            { userName: { contains: term, mode: 'insensitive' } },
            { displayName: { contains: term, mode: 'insensitive' } },
            { email: { contains: term, mode: 'insensitive' } },
          ],
        },
      });
    }

    const whereClause: Prisma.FansSubscriptionBuyDataWhereInput = {
      AND: andConditions,
    };

    let orderBy: Prisma.FansSubscriptionBuyDataOrderByWithRelationInput = { createdAt: 'desc' };
    if (query.sortBy === SubscriptionSortBy.OLDEST) {
      orderBy = { createdAt: 'asc' };
    } else if (query.sortBy === SubscriptionSortBy.PRICE_HIGH) {
      orderBy = { priceAtSubscription: 'desc' };
    } else if (query.sortBy === SubscriptionSortBy.PRICE_LOW) {
      orderBy = { priceAtSubscription: 'asc' };
    } else if (query.sortBy === SubscriptionSortBy.EXPIRY_SOON) {
      orderBy = { endDate: 'asc' };
    }

    const [totalSubscriptions, activeCount, expiredCount, records] = await Promise.all([
      this.prisma.fansSubscriptionBuyData.count({
        where: whereClause,
      }),
      this.prisma.fansSubscriptionBuyData.count({
        where: {
          fanUserId,
          status: 'ACTIVE',
          endDate: { gt: now },
        },
      }),
      this.prisma.fansSubscriptionBuyData.count({
        where: {
          fanUserId,
          OR: [
            { status: 'STOP' },
            { endDate: { lte: now } },
          ],
        },
      }),
      this.prisma.fansSubscriptionBuyData.findMany({
        where: whereClause,
        include: {
          buyUser: {
            select: {
              id: true,
              userName: true,
              displayName: true,
              email: true,
              image: true,
              bio: true,
              country: true,
              kyc: true,
              createdAt: true,
              userSubscriptions: {
                where: { isDelete: 0, status: 'ACTIVE' },
                select: {
                  id: true,
                  subscriptionAmount: true,
                  status: true,
                  pricingPolicy: true,
                  comment: true,
                },
                take: 1,
              },
            },
          },
        },
        orderBy,
        skip,
        take: limit,
      }),
    ]);

    const creatorIds = records.map((r) => r.buyUserId);
    const paymentsAggregates = creatorIds.length > 0
      ? await this.prisma.payment.groupBy({
        by: ['receiverId'],
        where: {
          userId: fanUserId,
          receiverId: { in: creatorIds },
          forPayment: 'following',
          status: 'succeeded',
        },
        _sum: { totalAmount: true },
        _count: { id: true },
      })
      : [];

    const paymentMap = new Map<string, { totalPaidAmount: number; paymentsCount: number }>();
    for (const agg of paymentsAggregates) {
      if (agg.receiverId) {
        paymentMap.set(agg.receiverId, {
          totalPaidAmount: agg._sum?.totalAmount || 0,
          paymentsCount: agg._count?.id || 0,
        });
      }
    }

    const subscriptions = records.map((item) => {
      const isCurrentlyActive = item.status === 'ACTIVE' && item.endDate > now;
      const paymentStats = paymentMap.get(item.buyUserId) || {
        totalPaidAmount: 0,
        paymentsCount: 0,
      };
      const creatorUser = item.buyUser;
      const currentTier = creatorUser?.userSubscriptions?.[0] || null;

      return {
        subscriptionId: item.id,
        creator: {
          id: creatorUser?.id,
          userName: creatorUser?.userName,
          displayName: creatorUser?.displayName,
          email: creatorUser?.email,
          image: creatorUser?.image,
          bio: creatorUser?.bio,
          country: creatorUser?.country,
          kyc: creatorUser?.kyc,
          currentMonthlyPrice: currentTier?.subscriptionAmount ?? item.priceAtSubscription,
          pricingPolicy: currentTier?.pricingPolicy ?? 'REQUIRE_NEW_CONSENT',
        },
        priceAtSubscription: item.priceAtSubscription,
        startDate: item.startDate,
        endDate: item.endDate,
        status: item.status,
        isActive: isCurrentlyActive,
        isEnded: !isCurrentlyActive,
        isCancelled: item.cancelAtPeriodEnd || !item.autoRenew,
        autoRenew: item.autoRenew,
        cancelAtPeriodEnd: item.cancelAtPeriodEnd,
        paymentProvider: item.paymentProvider,
        stripeSubscriptionId: item.stripeSubscriptionId,
        totalPaidToCreator: paymentStats.totalPaidAmount,
        paymentsCount: paymentStats.paymentsCount,
        subscribedAt: item.createdAt,
        updatedAt: item.updatedAt,
      };
    });

    return {
      meta: {
        totalSubscriptions,
        activeSubscriptions: activeCount,
        expiredSubscriptions: expiredCount,
        page,
        limit,
        totalPages: Math.ceil(totalSubscriptions / limit),
      },
      subscriptions,
    };
  }

  async getSubscriptionEarningGraph(receiverId: string) {
    const now = new Date();

    const formatDayKey = (d: Date) => {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };

    const addUtcDays = (d: Date, days: number) => {
      const copy = new Date(d);
      copy.setUTCDate(copy.getUTCDate() + days);
      return copy;
    };

    const startOfUtcDay = (d: Date) =>
      new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const days = 7;
    const endDay = startOfUtcDay(now);
    const startDay = addUtcDays(endDay, -(days - 1));

    const rows = await this.prisma.$queryRaw<Array<{ bucket: Date; amount: bigint }>>`
      SELECT date_trunc('day', "createdAt") AS bucket,
             COALESCE(SUM("amount"), 0)::bigint AS amount
      FROM "Payment"
      WHERE "receiverId" = ${receiverId}
        AND "forPayment" = 'following'
        AND "status" = 'succeeded'
        AND "createdAt" >= ${startDay}
      GROUP BY bucket
      ORDER BY bucket ASC
    `;

    const amountByDay = new Map<string, number>(
      rows.map((r) => [formatDayKey(new Date(r.bucket)), Number(r.amount)]),
    );

    const points = Array.from({ length: days }, (_, i) => {
      const dayDate = addUtcDays(startDay, i);
      const day = formatDayKey(dayDate);
      return {
        day,
        dayname: dayNames[dayDate.getUTCDay()],
        amount: amountByDay.get(day) ?? 0,
      };
    });

    const totalAmount = points.reduce((sum, p) => sum + (p.amount || 0), 0);
    return {
      range: '7d',
      totalAmount,
      startDate: startDay.toISOString(),
      endDate: now.toISOString(),
      points,
    };
  }

  /**
   * Get fan subscription status: whether the current user (payer) has an active pay-following
   * to the given receiver (creator). Uses latest succeeded payment and periodEnd.
   */
  async getFanSubscriptionStatus(userId: string, receiverId: string, deviceId?: string): Promise<{ status: string }> {
    const lang = await this.notificationService.getUserLanguage(userId, deviceId);
    const isPt = normalizeLanguage(lang) === 'pt';

    const latest = await this.prisma.payment.findFirst({
      where: {
        userId,
        receiverId,
        forPayment: 'following',
        status: 'succeeded',
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!latest || !latest.periodEnd) {
      return { status: isPt ? 'INACTIVE' : 'INACTIVE' };
    }
    const now = new Date();
    return { status: latest.periodEnd > now ? (isPt ? 'ACTIVE' : 'ACTIVE') : (isPt ? 'INACTIVE' : 'INACTIVE') };
  }

  /**
   * Withdraw from available wallet balance to the user's connected account (Stripe or PagBank).
   * Pending (48h marketplace) balance cannot be withdrawn.
   */
  async requestWithdrawal(userId: string, amount: number) {
    if (!userId) throw new BadRequestException('User ID required');
    if (typeof amount !== 'number' || Number.isNaN(amount)) {
      throw new BadRequestException('Invalid withdrawal amount');
    }
    if (amount < MIN_WITHDRAWAL_MAJOR) {
      throw new BadRequestException(`Minimum withdrawal is ${MIN_WITHDRAWAL_MAJOR}`);
    }

    const amountMinor = Math.round(amount * 100);
    if (amountMinor <= 0) {
      throw new BadRequestException('Invalid withdrawal amount');
    }

    const provider = await this.paymentProviderResolver.ensureUserPaymentProvider(userId);
    const currency = provider === 'PAGBANK' ? 'brl' : 'usd';

    if (provider === 'STRIPE') {
      await this.requireCanReceivePayments(userId);
    } else {
      const status = await this.pagBankService.getOnboardingStatus(userId);
      if (!status.canReceivePayments) {
        throw new BadRequestException(
          status.message || 'Complete PagBank onboarding before withdrawing.',
        );
      }
    }

    const balance = await this.walletService.getBalance(userId, { currency, provider });
    if (balance.availableBalanceMinor < amountMinor) {
      throw new BadRequestException(
        `Insufficient available balance. Available: ${balance.availableBalance.toFixed(2)}, requested: ${amount.toFixed(2)}. Pending (${balance.pendingBalance.toFixed(2)}) cannot be withdrawn until the 48h protection window ends.`,
      );
    }

    const withdrawal = await this.prisma.withdrawalRecord.create({
      data: {
        userId,
        withdrawAmount: amount,
        amountMinor,
        currency,
        provider,
        status: 'processing',
        processingAt: new Date(),
      },
    });

    try {
      await this.walletService.debitAvailableForWithdrawal({
        userId,
        amountMinor,
        currency,
        provider,
        withdrawalId: withdrawal.id,
        note: `Withdrawal request ${withdrawal.id}`,
      });

      let transferId: string;

      if (provider === 'PAGBANK') {
        const payout = await this.pagBankService.payoutToConnectedAccount({
          userId,
          amountMinor,
          currency,
          withdrawalId: withdrawal.id,
        });
        transferId = payout.transferId;
      } else {
        const destinationAccountId = await this.requireCanReceivePayments(userId);
        const transfer = await this.stripe.transfers.create(
          {
            amount: amountMinor,
            currency,
            destination: destinationAccountId,
            metadata: {
              type: 'seller_wallet_withdrawal',
              withdrawalId: withdrawal.id,
              userId,
            },
          },
          { idempotencyKey: `wallet-withdrawal-${withdrawal.id}` },
        );
        transferId = transfer.id;
      }

      const updated = await this.prisma.withdrawalRecord.update({
        where: { id: withdrawal.id },
        data: {
          status: 'success',
          transferId,
          txhash: transferId,
        },
      });

      try {
        await this.notificationService.sendNotificationToUser(
          userId,
          'Withdrawal Successful',
          `Your withdrawal of ${amount.toFixed(2)} ${currency.toUpperCase()} has been sent to your connected account.`,
          {
            type: 'withdrawal_success',
            withdrawalId: withdrawal.id,
            amount: amount.toString(),
            transferId,
            provider,
          },
        );
      } catch (notificationError) {
        console.error('Failed to send withdrawal success notification:', notificationError);
      }

      const nextBalance = await this.walletService.getBalance(userId, { currency, provider });

      return {
        message: 'Withdrawal sent to your connected account',
        withdrawal: {
          id: updated.id,
          amount: updated.withdrawAmount,
          amountMinor: updated.amountMinor,
          currency: updated.currency,
          provider: updated.provider,
          status: updated.status,
          transferId: updated.transferId,
          createdAt: updated.createdAt,
        },
        balance: {
          pendingBalance: nextBalance.pendingBalance,
          availableBalance: nextBalance.availableBalance,
          withdrawableBalance: nextBalance.withdrawableBalance,
        },
      };
    } catch (error: any) {
      const failureReason = error?.message || 'Withdrawal transfer failed';

      try {
        await this.walletService.reverseWithdrawal({
          userId,
          amountMinor,
          currency,
          provider,
          withdrawalId: withdrawal.id,
          note: failureReason,
        });
      } catch (reverseError) {
        console.error('Failed to reverse wallet debit after withdrawal error:', reverseError);
      }

      await this.prisma.withdrawalRecord.update({
        where: { id: withdrawal.id },
        data: {
          status: error?.message?.includes('onboarding') || error?.message?.includes('Complete')
            ? 'requires_onboarding'
            : 'failed',
          failureReason,
        },
      });

      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException(failureReason);
    }
  }

  async getWithdrawalHistory(userId: string) {
    const withdrawals = await this.prisma.withdrawalRecord.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    return {
      withdrawals: withdrawals.map((w) => ({
        id: w.id,
        amount: w.withdrawAmount,
        amountMinor: w.amountMinor,
        currency: w.currency,
        provider: w.provider,
        status: w.status,
        transferId: w.transferId || w.txhash,
        failureReason: w.failureReason,
        processingAt: w.processingAt,
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
      })),
    };
  }

  /** @deprecated Prefer requestWithdrawal which transfers immediately. */
  async processWithdrawal(_withdrawalId: string) {
    return;
  }

  // Generate provider onboarding link (Stripe Connect or PagBank Connect).
  // We create and persist stripeAccountId on first Stripe link request. If the user closes the
  // onboarding URL without completing, we keep the same account and issue a new link
  // next time (links expire ~30 min). Withdrawals are only allowed when onboarding is
  // complete (requireCanReceivePayments checks details_submitted).
  async createAccountOnboardingLink(userId: string) {
    const provider = await this.paymentProviderResolver.ensureUserPaymentProvider(userId);

    if (provider === 'PAGBANK') {
      return this.pagBankService.createAccountOnboardingLink(userId);
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');

    let stripeAccountId = user.stripeAccountId;
    if (!stripeAccountId) {
      try {
        const account = await this.stripe.accounts.create({
          type: 'express',
          country: user.country && user.country !== 'BR' ? user.country : 'US',
          email: user.email || undefined,
          capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true },
          },
        });

        stripeAccountId = account.id;

        await this.prisma.user.update({
          where: { id: userId },
          data: { stripeAccountId },
        });
      } catch (error: any) {
        console.error('Stripe error creating account:', {
          message: error.message,
          type: error.type,
          code: error.code,
          requestId: error.requestId,
          raw: error.raw,
        });
        throw error;
      }
    } else {
      await this.stripe.accounts.update(stripeAccountId, {
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
      });
    }

    try {
      // Use backend URL so Stripe redirects to our success page (GET /withdrawal/success). Set to your API base, e.g. https://api.valenscorp.com
      const baseUrl = (process.env.STRIPE_CONNECT_RETURN_BASE_URL || process.env.BACKEND_URL || process.env.FRONTEND_URL || '').replace(/\/$/, '');
      if (!baseUrl) {
        throw new BadRequestException(
          'Set STRIPE_CONNECT_RETURN_BASE_URL, BACKEND_URL, or FRONTEND_URL so Stripe can redirect after onboarding.',
        );
      }
      const accountLink = await this.stripe.accountLinks.create({
        account: stripeAccountId,
        refresh_url: `${baseUrl}/withdrawal/reauth`,
        return_url: `${baseUrl}/withdrawal/success`,
        type: 'account_onboarding',
      });

      return { onboardingUrl: accountLink.url, provider: 'STRIPE' as const };
    } catch (error: any) {
      console.error('Error creating account link:', error.message);
      throw new BadRequestException('Failed to create onboarding link. Please try again later.');
    }
  }

  async handlePagBankConnectCallback(code: string, state: string) {
    return this.pagBankService.handleConnectCallback({ code, state });
  }

  // Handle payout success/failure webhooks (Connect account → bank).
  // Seller wallet withdrawal completes when the Transfer to Connect succeeds.
  async handlePayoutPaid(payout: Stripe.Payout) {
    const withdrawal = await this.findWithdrawalByPayoutOrTransfer(payout);
    if (!withdrawal) return;

    if (withdrawal.status !== 'success') {
      await this.prisma.withdrawalRecord.update({
        where: { id: withdrawal.id },
        data: { status: 'success' },
      });
    }

    try {
      await this.notificationService.sendNotificationToUser(
        withdrawal.userId,
        'Payout Deposited',
        `Your withdrawal of $${withdrawal.withdrawAmount} is being deposited to your bank.`,
        {
          type: 'withdrawal_payout_paid',
          withdrawalId: withdrawal.id,
          amount: (withdrawal.withdrawAmount || 0).toString(),
        },
      );
    } catch (notificationError) {
      console.error('Failed to send payout paid notification:', notificationError);
    }
  }

  async handlePayoutFailed(payout: Stripe.Payout) {
    // Money already left the platform wallet to Connect; bank payout failure should not
    // re-credit the in-app available balance.
    const withdrawal = await this.findWithdrawalByPayoutOrTransfer(payout);
    if (!withdrawal) return;

    await this.prisma.withdrawalRecord.update({
      where: { id: withdrawal.id },
      data: {
        failureReason: `Connect payout failed: ${payout.failure_message || payout.failure_code || 'unknown'}`,
      },
    });

    try {
      await this.notificationService.sendNotificationToUser(
        withdrawal.userId,
        'Bank Payout Issue',
        'Your connected account payout to bank had an issue. Funds remain on your Stripe account — check onboarding/bank details.',
        {
          type: 'withdrawal_payout_failed',
          withdrawalId: withdrawal.id,
          amount: (withdrawal.withdrawAmount || 0).toString(),
        },
      );
    } catch (notificationError) {
      console.error('Failed to send payout failed notification:', notificationError);
    }
  }

  async handleTransferCreated(transfer: Stripe.Transfer) {
    const withdrawalId = transfer.metadata?.withdrawalId;
    const withdrawal = withdrawalId
      ? await this.prisma.withdrawalRecord.findUnique({ where: { id: withdrawalId } })
      : await this.prisma.withdrawalRecord.findFirst({
        where: {
          OR: [{ transferId: transfer.id }, { txhash: transfer.id }],
        },
      });

    if (!withdrawal) return;

    if (withdrawal.status === 'processing' || withdrawal.status === 'processing_transfer') {
      await this.prisma.withdrawalRecord.update({
        where: { id: withdrawal.id },
        data: {
          status: 'success',
          transferId: transfer.id,
          txhash: transfer.id,
        },
      });
    }
  }

  async handleTransferFailedOrReversed(transfer: Stripe.Transfer, reason: string) {
    const withdrawalId = transfer.metadata?.withdrawalId;
    const withdrawal = withdrawalId
      ? await this.prisma.withdrawalRecord.findUnique({ where: { id: withdrawalId } })
      : await this.prisma.withdrawalRecord.findFirst({
        where: {
          OR: [{ transferId: transfer.id }, { txhash: transfer.id }],
        },
      });

    if (!withdrawal) return;
    if (withdrawal.status === 'failed') return;

    const amountMinor =
      withdrawal.amountMinor ??
      Math.round(Number(withdrawal.withdrawAmount || 0) * 100);

    if (amountMinor > 0) {
      await this.walletService.reverseWithdrawal({
        userId: withdrawal.userId,
        amountMinor,
        currency: withdrawal.currency || 'usd',
        provider: (withdrawal.provider as 'STRIPE' | 'PAGBANK') || 'STRIPE',
        withdrawalId: withdrawal.id,
        note: reason,
      });
    }

    await this.prisma.withdrawalRecord.update({
      where: { id: withdrawal.id },
      data: {
        status: 'failed',
        failureReason: reason,
        transferId: transfer.id,
        txhash: transfer.id,
      },
    });

    try {
      await this.notificationService.sendNotificationToUser(
        withdrawal.userId,
        'Withdrawal Failed',
        `Your withdrawal of $${withdrawal.withdrawAmount} failed and was returned to your available balance.`,
        {
          type: 'withdrawal_failed',
          withdrawalId: withdrawal.id,
          amount: (withdrawal.withdrawAmount || 0).toString(),
        },
      );
    } catch (notificationError) {
      console.error('Failed to send withdrawal failed notification:', notificationError);
    }
  }

  private async findWithdrawalByPayoutOrTransfer(payout: Stripe.Payout) {
    return this.prisma.withdrawalRecord.findFirst({
      where: {
        OR: [
          { txhash: payout.id },
          { transferId: payout.id },
          ...(typeof (payout as any).balance_transaction === 'string'
            ? [{ txhash: (payout as any).balance_transaction as string }]
            : []),
        ],
      },
    });
  }

  async buyHit(hitCount: number, userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');
    if (!hitCount || hitCount <= 0) throw new BadRequestException('hitCount must be greater than 0');
    if (hitCount > MAX_PURCHASED_HITS) {
      throw new BadRequestException(`You cannot buy more than ${MAX_PURCHASED_HITS} hits at a time`);
    }

    const postHit = await this.prisma.postHit.findFirst({ where: { userId } });
    const currentPurchasedHits = postHit?.purchasedHitsLeft || 0;

    if (currentPurchasedHits >= MAX_PURCHASED_HITS) {
      throw new BadRequestException(
        `You have already reached the maximum limit of ${MAX_PURCHASED_HITS} purchased hits. Please use your existing hits before buying more.`
      );
    }

    if (currentPurchasedHits + hitCount > MAX_PURCHASED_HITS) {
      const allowedHits = MAX_PURCHASED_HITS - currentPurchasedHits;
      throw new BadRequestException(
        `You currently have ${currentPurchasedHits} purchased hit(s). You can only buy up to ${allowedHits} more hit(s) to stay within the maximum limit of ${MAX_PURCHASED_HITS}.`
      );
    }

    const amount = Math.round(hitCount * (Number(process.env.CREDIT_PRICE) * 100));
    const provider = await this.paymentProviderResolver.resolveProviderForUser(userId);

    if (provider === 'PAGBANK') {
      const perHitMinor = Number(process.env.PAGBANK_HIT_PRICE_MINOR || 499);
      const calculatedMinor = Math.round(hitCount * perHitMinor);
      const amountMinor = amount > 0 && Math.round(amount * 100) === calculatedMinor ? calculatedMinor : calculatedMinor;
      const amountMajor = Number((amountMinor / 100).toFixed(2));

      const payment = await this.prisma.payment.create({
        data: {
          userId,
          amount: amountMajor,
          totalAmount: amountMajor,
          currency: 'BRL',
          status: 'pending',
          forPayment: 'buyHit',
          // hitCount carried for PagBank webhook fulfillment
          stripeInvoiceId: String(hitCount),
        },
      });

      const checkout = await this.pagBankService.createPixCheckout({
        referenceId: payment.id,
        amountMinor,
        description: `Buy ${hitCount} Hits`,
        customerEmail: user.email || undefined,
        customerName: user.displayName || user.userName || undefined,
      });

      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { stripePaymentIntentId: checkout.orderId },
      });

      return { sessionId: checkout.orderId, url: checkout.checkoutUrl, ...checkout };
    }

    if (!amount || amount <= 0) throw new BadRequestException('amount must be greater than 0');
    // const amountMinor = Math.round(amount * 100);
    const amountMinor = amount;

    const session = await this.stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Buy ${hitCount} Hits`,
              description: `Purchase ${hitCount} additional hits for posting`,
            },
            unit_amount: amountMinor,
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: process.env.STRIPE_SUCCESS_URL!,
      cancel_url: process.env.STRIPE_CANCEL_URL!,
      metadata: {
        type: 'buy_hit',
        userId: userId,
        hitCount: hitCount.toString(),
      },
      customer_email: user.email || undefined,
    });

    await this.prisma.payment.create({
      data: {
        userId: userId,
        amount: amountMinor,
        currency: 'USD',
        status: 'pending',
        forPayment: 'buyHit',
        stripePaymentIntentId: (session.payment_intent as string) || session.id,
        stripeInvoiceId: String(hitCount),
      },
    });

    return { sessionId: session.id, url: session.url };
  }

  private async resolveFansPageAmountMinor(): Promise<number> {
    const fromEnv = Number(process.env.FANS_PAGE_SUBSCRIPTION_AMOUNT_CENTS || 0);
    if (fromEnv > 0) return Math.round(fromEnv);
    const price = await this.stripe.prices.retrieve('price_1STKIwEfZnDK6m7OP2vahCdr');
    const amount = price.unit_amount || 0;
    if (amount <= 0) {
      throw new BadRequestException('Fans page subscription price amount is missing');
    }
    return amount;
  }

  async createFansPageSubscriptionCheckoutSession(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');

    const provider = await this.paymentProviderResolver.resolveProviderForUser(userId);
    const amount = await this.resolveFansPageAmountMinor();

    if (provider === 'PAGBANK') {
      const payment = await this.prisma.payment.create({
        data: {
          userId,
          amount: Number((amount / 100).toFixed(2)),
          totalAmount: Number((amount / 100).toFixed(2)),
          currency: 'BRL',
          status: 'pending',
          forPayment: 'fanSubscription',
        },
      });

      const checkout = await this.pagBankService.createPixCheckout({
        referenceId: payment.id,
        amountMinor: amount,
        description: 'Fans Page Subscription',
        customerEmail: user.email || undefined,
        customerName: user.displayName || user.userName || undefined,
      });

      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { stripePaymentIntentId: checkout.orderId },
      });

      return { sessionId: checkout.orderId, url: checkout.checkoutUrl, ...checkout };
    }

    const customerId = await this.ensureStripeCustomer(userId);

    const session = await this.stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer: customerId,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Fans Page Subscription',
            },
            unit_amount: amount,
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: process.env.STRIPE_SUCCESS_URL!,
      cancel_url: process.env.STRIPE_CANCEL_URL!,
      metadata: {
        type: 'fans_page_subscription',
        userId: userId,
      },
    });

    await this.prisma.payment.create({
      data: {
        userId: userId,
        amount: amount,
        currency: 'USD',
        status: 'pending',
        forPayment: 'fanSubscription',
        stripePaymentIntentId: (session.payment_intent as string) || session.id,
      },
    });

    return { sessionId: session.id, url: session.url };
  }

  async handleFansPageSubscriptionPayment(session: Stripe.Checkout.Session) {
    const userId = session.metadata?.userId;

    if (!userId) {
      console.error('Missing userId in fans_page_subscription session metadata');
      return;
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      console.error(`User ${userId} not found for fans_page_subscription payment`);
      return;
    }

    // Update the existing pending payment record to success
    const paymentIntentId = session.payment_intent as string;
    await this.prisma.payment.updateMany({
      where: {
        userId: userId,
        stripePaymentIntentId: paymentIntentId,
        forPayment: 'fanSubscription',
        status: 'pending'
      },
      data: {
        status: 'succeeded',
        amount: session.amount_total || 0,
        currency: session.currency?.toUpperCase() || 'USD',
      },
    });

    // Update user fansPage to 1
    await this.prisma.user.update({
      where: { id: userId },
      data: { fansPage: 1 } as any,
    });

    // console.log(`✅ Fans page subscription payment processed: User ${userId} fansPage set to 1`);
  }

  async handleFanSubscriptionBuyPayment(session: Stripe.Checkout.Session) {
    const fanUserId = session.metadata?.fanUserId;
    const buyUserId = session.metadata?.buyUserId;
    const customPaymentIntentId = session.metadata?.customPaymentIntentId;

    if (!fanUserId || !buyUserId || !customPaymentIntentId) {
      console.error('Missing fanUserId, buyUserId, or customPaymentIntentId in fan_subscription_buy session metadata');
      return;
    }

    const fanUser = await this.prisma.user.findUnique({ where: { id: fanUserId } });
    if (!fanUser) {
      console.error(`Fan user ${fanUserId} not found for fan_subscription_buy payment`);
      return;
    }

    // Update the existing pending payment record to success
    const updateResult = await this.prisma.payment.updateMany({
      where: {
        userId: buyUserId,
        stripePaymentIntentId: customPaymentIntentId,
        forPayment: 'fanSubscriptionBuy',
        status: 'pending'
      },
      data: {
        status: 'succeeded',
        amount: session.amount_total || 0,
        currency: session.currency?.toUpperCase() || 'USD',
      },
    });

    // Create FansSubscriptionBuyData entry
    const startDate = new Date();
    const endDate = new Date(startDate);
    endDate.setMonth(endDate.getMonth() + 1); // Add 30 days (approximately one month)

    await this.prisma.fansSubscriptionBuyData.create({
      data: {
        fanUserId,
        buyUserId,
        startDate,
        endDate,
        status: 'ACTIVE',
      },
    });

    await this.updatePriceChangeNotificationStatus(
      fanUserId,
      buyUserId,
      'ACCEPTED',
      true,
    );

    const amountCents = session.amount_total || Number(session.metadata?.amount || 0) * 100;
    const receiverAmountCents =
      Number(session.metadata?.receiverAmountCents) ||
      Math.max(0, Math.round(amountCents * (1 - this.PLATFORM_FEE_PERCENT)));

    await this.creditSellerAvailableWallet({
      sellerUserId: buyUserId,
      amountMinor: receiverAmountCents,
      source: 'FAN_SUBSCRIPTION',
      refId: customPaymentIntentId,
      currency: session.currency || 'usd',
      note: `Fan subscription buy ${session.id}`,
    });
  }

  async createOneTimePaymentCheckForFanSubscription(amount: number, buyUserId: string, fanUserId: string) {
    if (!buyUserId) throw new BadRequestException('Creator user id is required');
    if (!fanUserId) throw new BadRequestException('Fan user id is required');
    if (buyUserId === fanUserId) throw new BadRequestException('You cannot buy your own fan subscription');
    if (!amount || amount <= 0) throw new BadRequestException('Amount must be greater than 0');

    await this.ensureUserExists(buyUserId);
    const fanProvider = await this.paymentProviderResolver.resolveProviderForUser(fanUserId);
    const buyUser = await this.prisma.user.findUnique({ where: { id: buyUserId } });
    if (!buyUser) throw new BadRequestException('Buy user not found');

    const customPaymentIntentId = uuidv4();
    const amountCents = Math.round(amount * 100);
    const applicationFeeCents = Math.round(amountCents * this.PAY_FOLLOWING_PLATFORM_FEE_PERCENT);
    const receiverAmountCents = Math.max(0, amountCents - applicationFeeCents);
    const receiverAmount = receiverAmountCents / 100;
    const platformFee = applicationFeeCents / 100;
    const totalAmount = amountCents / 100;

    const payment = await this.prisma.payment.create({
      data: {
        userId: buyUserId,
        receiverId: buyUserId,
        amount: receiverAmount,
        platformFee,
        totalAmount,
        currency: fanProvider === 'PAGBANK' ? 'BRL' : 'USD',
        status: 'pending',
        forPayment: 'fanSubscriptionBuy',
        stripePaymentIntentId: customPaymentIntentId,
        // PagBank webhook reads fan payer id from stripeInvoiceId
        stripeInvoiceId: fanUserId,
      },
    });

    if (fanProvider === 'PAGBANK') {
      const fan = await this.prisma.user.findUnique({
        where: { id: fanUserId },
        select: { email: true, displayName: true, userName: true },
      });
      const checkout = await this.pagBankService.createPixCheckout({
        referenceId: payment.id,
        amountMinor: amountCents,
        description: `Fan Subscription to ${buyUser.displayName || buyUser.userName}`,
        customerEmail: fan?.email || undefined,
        customerName: fan?.displayName || fan?.userName || undefined,
      });
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { stripePaymentIntentId: checkout.orderId },
      });
      return {
        sessionId: checkout.orderId,
        url: checkout.checkoutUrl,
        ...checkout,
      };
    }

    const customerId = await this.ensureStripeCustomer(fanUserId);

    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      success_url: process.env.STRIPE_SUCCESS_URL!,
      cancel_url: process.env.STRIPE_CANCEL_URL!,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Fan Subscription to ${buyUser.displayName || buyUser.userName}`,
            },
            unit_amount: amountCents,
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        metadata: {
          type: 'fan_subscription_buy',
          fanUserId,
          buyUserId,
          amount: amount.toString(),
          customPaymentIntentId,
          platformFeeCents: applicationFeeCents.toString(),
          receiverAmountCents: receiverAmountCents.toString(),
        },
      },
      metadata: {
        type: 'fan_subscription_buy',
        fanUserId,
        buyUserId,
        amount: amount.toString(),
        customPaymentIntentId,
        platformFeeCents: applicationFeeCents.toString(),
        receiverAmountCents: receiverAmountCents.toString(),
      },
    });

    return { sessionId: session.id, url: session.url };
  }

  private getUtcYearMonth(date: Date = new Date()): string {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }

  private getNextUtcMonthStart(date: Date = new Date()): Date {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  }

  async buyHitWithPlatformPoints(userId: string) {
    if (!userId) throw new BadRequestException('User not authenticated');

    const now = new Date();
    const yearMonth = this.getUtcYearMonth(now);
    const nextEligibleAt = this.getNextUtcMonthStart(now);

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT id
            FROM "User"
            WHERE id = ${userId}
            FOR UPDATE
          `;

          const user = await tx.user.findUnique({
            where: { id: userId },
            select: {
              id: true,
              totalPlatformPoints: true,
            },
          });

          if (!user) {
            throw new BadRequestException('User not found');
          }

          const existingPurchase = await tx.platformPointsHitPurchase.findUnique({
            where: {
              userId_yearMonth: {
                userId,
                yearMonth,
              },
            },
            select: { id: true },
          });

          if (existingPurchase) {
            throw new BadRequestException(
              `You can buy only 1 hit with platform points once per month. Next eligible at ${nextEligibleAt.toISOString()}`,
            );
          }

          const availablePoints = user.totalPlatformPoints ?? 0;
          if (availablePoints < PLATFORM_POINTS_HIT_COST) {
            throw new BadRequestException(
              `Insufficient platform points. Need ${PLATFORM_POINTS_HIT_COST}, have ${availablePoints}`,
            );
          }

          const existingPostHit = await tx.postHit.findFirst({
            where: { userId },
            select: { id: true, hitLeft: true, purchasedHitsLeft: true, subscriptionHitsLeft: true, subscriptionHitsExpiresAt: true },
          });

          const currentPurchasedHits = existingPostHit?.purchasedHitsLeft || 0;
          if (currentPurchasedHits >= MAX_PURCHASED_HITS) {
            throw new BadRequestException(
              `You have already reached the maximum limit of ${MAX_PURCHASED_HITS} purchased hits. Please use your existing hits before redeeming more.`
            );
          }

          const updatedUser = await tx.user.update({
            where: { id: userId },
            data: {
              totalPlatformPoints: { decrement: PLATFORM_POINTS_HIT_COST },
            },
            select: {
              totalPlatformPoints: true,
            },
          });

          let hitLeft: number;
          let purchasedHitsLeft: number;
          let subscriptionHitsLeft: number = 0;
          const now = new Date();
          if (existingPostHit) {
            const isSubActive =
              existingPostHit.subscriptionHitsExpiresAt &&
              existingPostHit.subscriptionHitsExpiresAt > now;
            const activeSubHits = isSubActive ? (existingPostHit.subscriptionHitsLeft || 0) : 0;
            subscriptionHitsLeft = activeSubHits;
            const newPurchasedHits = Math.min(
              MAX_PURCHASED_HITS,
              (existingPostHit.purchasedHitsLeft || 0) + PLATFORM_POINTS_HIT_COUNT,
            );
            const newTotalHitLeft = activeSubHits + newPurchasedHits;
            const updatedPostHit = await tx.postHit.update({
              where: { id: existingPostHit.id },
              data: {
                purchasedHitsLeft: newPurchasedHits,
                hitLeft: newTotalHitLeft,
              },
              select: { hitLeft: true, purchasedHitsLeft: true },
            });
            hitLeft = updatedPostHit.hitLeft;
            purchasedHitsLeft = updatedPostHit.purchasedHitsLeft;
          } else {
            const newPurchasedHits = Math.min(MAX_PURCHASED_HITS, PLATFORM_POINTS_HIT_COUNT);
            const createdPostHit = await tx.postHit.create({
              data: {
                userId,
                purchasedHitsLeft: newPurchasedHits,
                subscriptionHitsLeft: 0,
                subscriptionHitsExpiresAt: null,
                hitLeft: newPurchasedHits,
              },
              select: { hitLeft: true, purchasedHitsLeft: true },
            });
            hitLeft = createdPostHit.hitLeft;
            purchasedHitsLeft = createdPostHit.purchasedHitsLeft;
          }

          await tx.platformPointsHitPurchase.create({
            data: {
              userId,
              pointsSpent: PLATFORM_POINTS_HIT_COST,
              hitCount: PLATFORM_POINTS_HIT_COUNT,
              yearMonth,
            },
          });

          return {
            success: true,
            hitAdded: PLATFORM_POINTS_HIT_COUNT,
            pointsSpent: PLATFORM_POINTS_HIT_COST,
            hitLeft,
            purchasedHitsLeft,
            subscriptionHitsLeft,
            totalPlatformPoints: updatedUser.totalPlatformPoints,
            yearMonth,
            nextEligibleAt,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error: any) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      if (
        error?.code === 'P2002' ||
        (typeof error?.message === 'string' &&
          error.message.toLowerCase().includes('could not serialize access'))
      ) {
        throw new BadRequestException(
          `You can buy only 1 hit with platform points once per month. Next eligible at ${nextEligibleAt.toISOString()}`,
        );
      }

      throw error;
    }
  }

  async handleBuyHitPayment(session: Stripe.Checkout.Session) {
    const userId = session.metadata?.userId;
    const hitCount = parseInt(session.metadata?.hitCount || '0');

    if (!userId || !hitCount) {
      console.error('Missing userId or hitCount in buy_hit session metadata');
      return;
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      console.error(`User ${userId} not found for buy_hit payment`);
      return;
    }

    // Update the existing pending payment record to success
    const paymentIntentId = session.payment_intent as string;
    await this.prisma.payment.updateMany({
      where: {
        userId: userId,
        stripePaymentIntentId: paymentIntentId,
        forPayment: 'buyHit',
        status: 'pending'
      },
      data: {
        status: 'succeeded',
        amount: session.amount_total || 0,
        currency: session.currency?.toUpperCase() || 'USD',
      },
    });

    // Update or create postHit record with purchased hits (which never expire)
    const existingPostHit = await this.prisma.postHit.findFirst({
      where: { userId: userId },
    });

    const now = new Date();
    if (existingPostHit) {
      const isSubActive =
        existingPostHit.subscriptionHitsExpiresAt &&
        existingPostHit.subscriptionHitsExpiresAt > now;
      const activeSubHits = isSubActive ? (existingPostHit.subscriptionHitsLeft || 0) : 0;
      const currentPurchased = existingPostHit.purchasedHitsLeft || 0;
      const newPurchasedHits = Math.min(MAX_PURCHASED_HITS, currentPurchased + hitCount);
      const newTotalHitLeft = activeSubHits + newPurchasedHits;
      await this.prisma.postHit.update({
        where: { id: existingPostHit.id },
        data: {
          purchasedHitsLeft: newPurchasedHits,
          hitLeft: newTotalHitLeft,
        },
      });
    } else {
      const newPurchasedHits = Math.min(MAX_PURCHASED_HITS, hitCount);
      await this.prisma.postHit.create({
        data: {
          userId: userId,
          purchasedHitsLeft: newPurchasedHits,
          subscriptionHitsLeft: 0,
          subscriptionHitsExpiresAt: null,
          hitLeft: newPurchasedHits,
        },
      });
    }

    // console.log(`✅ Buy hit payment processed: User ${userId} received ${hitCount} hits`);
  }

  // Valens: withdrawals disabled; cron commented to avoid log noise.
  // @Cron(CronExpression.EVERY_5_MINUTES)
  async processPendingWithdrawals() {
    return;
    // console.log('[CRON] Processing pending withdrawals...');
    // const pendingWithdrawals = await this.prisma.withdrawalRecord.findMany({
    //   where: { status: 'pending' },
    //   select: { id: true },
    // });
    // if (pendingWithdrawals.length === 0) {
    //   console.log('[CRON] No pending withdrawals to process');
    //   return;
    // }
    // ...
    // for (const withdrawal of pendingWithdrawals) {
    //   try {
    //     await this.processWithdrawal(withdrawal.id);
    //     ...
    //   } catch (error) { ... }
    // }
    // console.log('[CRON] Finished processing pending withdrawals');
  }

  async getUserBuyFanSubscriptionList(userId: string) {
    return this.prisma.fansSubscriptionBuyData.findMany({
      where: { buyUserId: userId },
      include: {
        fanUser: {
          select: { userName: true, image: true }
        }
      }
    });
  }

  async fanSubscriptionUserList(userId: string) {
    return this.prisma.fansSubscriptionBuyData.findMany({
      where: { fanUserId: userId },
      include: {
        buyUser: {
          select: { id: true, userName: true, image: true }
        }
      }
    });
  }

  async userTransactionHistory(userId: string, transactionType: string, limit: number = 50, deviceId?: string) {
    const lang = await this.notificationService.getUserLanguage(userId, deviceId);
    const normalizedLang = normalizeLanguage(lang);
    const take = Math.min(Math.max(1, limit), 100);

    const localizeRecord = (tx: any) => {
      if (normalizedLang === 'en') return tx;
      const localizedTypeTransaction = tx.typeTransaction ? translateTypeTransaction(tx.typeTransaction, normalizedLang) : tx.typeTransaction;
      const localizedStatus = tx.status ? translatePaymentStatus(tx.status, normalizedLang) : tx.status;
      const localizedForPayment = tx.forPayment ? translatePaymentType(tx.forPayment, normalizedLang) : tx.forPayment;
      return {
        ...tx,
        ...(tx.typeTransaction !== undefined ? { typeTransaction: localizedTypeTransaction } : {}),
        ...(tx.status !== undefined ? { status: localizedStatus } : {}),
        ...(tx.forPayment !== undefined ? { forPayment: localizedForPayment } : {}),
      };
    };

    if (transactionType === 'all') {
      const [withdrawals, tokenSales, tokenPurchases, payments, marketplace] = await Promise.all([
        this.prisma.withdrawalRecord.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          take,
        }),
        this.prisma.tokenSale.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          take,
        }),
        this.prisma.tokenPurchase.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          take,
        }),
        this.prisma.payment.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          take,
        }),
        this.prisma.marketPlacePayments.findMany({
          where: {
            OR: [{ userId }, { orders: { some: { OR: [{ buyerId: userId }, { sellerId: userId }] } } }],
          },
          include: {
            orders: {
              select: {
                id: true,
                orderNumber: true,
                orderStatus: true,
                paymentStatus: true,
                refundId: true,
                refundAmount: true,
                refundedAt: true,
                cancellationReason: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          take,
        }),
      ]);

      const allTransactions = [
        ...withdrawals.map((w) => ({ ...w, typeTransaction: 'withdrawal' })),
        ...tokenSales.map((ts) => ({ ...ts, typeTransaction: 'tokenSale' })),
        ...tokenPurchases.map((tp) => ({ ...tp, typeTransaction: 'tokenPurchase' })),
        ...payments.map((p) => ({ ...p, typeTransaction: 'payment' })),
        ...marketplace.map((mp) => {
          const firstOrder = mp.orders[0];
          return {
            ...mp,
            typeTransaction: 'marketplace',
            amount: mp.amount / 100,
            refundAmount: firstOrder?.refundAmount != null ? firstOrder.refundAmount : (mp.status === 'REFUNDED' ? mp.amount / 100 : null),
            refundId: firstOrder?.refundId || null,
            refundedAt: firstOrder?.refundedAt || null,
            cancellationReason: firstOrder?.cancellationReason || null,
          };
        }),
      ];

      const sorted = allTransactions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return sorted.map(localizeRecord);
    } else {
      switch (transactionType) {
        case 'withdrawal': {
          const records = await this.prisma.withdrawalRecord.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take,
          });
          return records.map((r) => localizeRecord({ ...r, typeTransaction: 'withdrawal' }));
        }
        case 'tokenSale': {
          const records = await this.prisma.tokenSale.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take,
          });
          return records.map((r) => localizeRecord({ ...r, typeTransaction: 'tokenSale' }));
        }
        case 'tokenPurchase': {
          const records = await this.prisma.tokenPurchase.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take,
          });
          return records.map((r) => localizeRecord({ ...r, typeTransaction: 'tokenPurchase' }));
        }
        case 'payment': {
          const records = await this.prisma.payment.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take,
          });
          return records.map((r) => localizeRecord({ ...r, typeTransaction: 'payment' }));
        }
        case 'marketplace':
        case 'shop': {
          const mpRecords = await this.prisma.marketPlacePayments.findMany({
            where: {
              OR: [{ userId }, { orders: { some: { OR: [{ buyerId: userId }, { sellerId: userId }] } } }],
            },
            include: {
              orders: {
                select: {
                  id: true,
                  orderNumber: true,
                  orderStatus: true,
                  paymentStatus: true,
                  refundId: true,
                  refundAmount: true,
                  refundedAt: true,
                  cancellationReason: true,
                },
              },
            },
            orderBy: { createdAt: 'desc' },
            take,
          });
          return mpRecords.map((mp) => {
            const firstOrder = mp.orders[0];
            return localizeRecord({
              ...mp,
              typeTransaction: 'marketplace',
              amount: mp.amount / 100,
              refundAmount: firstOrder?.refundAmount != null ? firstOrder.refundAmount : (mp.status === 'REFUNDED' ? mp.amount / 100 : null),
              refundId: firstOrder?.refundId || null,
              refundedAt: firstOrder?.refundedAt || null,
              cancellationReason: firstOrder?.cancellationReason || null,
            });
          });
        }
        default:
          throw new BadRequestException('Invalid transaction type');
      }
    }
  }

  async addDigitalBadge(senderId: string, dto: { receiverId: string; amount: number; txId: string }) {
    try {
      const digitalBadge = await this.prisma.digital_transaction.create({
        data: {
          senderId,
          receiverId: dto.receiverId,
          amount: dto.amount,
          txId: dto.txId,
          txType: 'MANUAL',
          txValue: dto.amount,
        },
      });
      return digitalBadge;
    } catch (error: any) {
      const message = error instanceof Error ? error.message : 'Failed to add digital badge';
      throw new BadRequestException(message);
    }
  }

  async getDigitalBadge(userId: string) {
    const result = await this.prisma.digital_transaction.aggregate({
      where: { receiverId: userId },
      _sum: { amount: true },
    });
    const totalAmount = result._sum?.amount != null ? Number(result._sum.amount) : 0;
    return { totalAmount };
  }

  async getUsdtTransfersReceived(receiverId: string, limit: number = 50) {
    const take = Math.min(Math.max(1, limit), 100);
    return this.prisma.digital_transaction.findMany({
      where: { receiverId },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  async getReceivedTotals(userId: string) {
    const [payFollowingSum, tipSum, missionDonationSum, usdtSum, paidOrdersSummary, shopEbookSummary] = await Promise.all([
      this.prisma.payment.aggregate({
        where: {
          receiverId: userId,
          forPayment: 'following',
          status: 'succeeded',
        },
        _sum: { amount: true },
      }),
      this.prisma.payment.aggregate({
        where: {
          receiverId: userId,
          forPayment: 'TIP',
          status: 'succeeded',
        },
        _sum: { amount: true },
      }),
      this.prisma.donationData.aggregate({
        where: {
          vendorId: userId,
          status: 'completed',
          action: { in: ['missionDonation', 'donate'] },
        },
        _sum: { amount: true },
      }),
      this.prisma.digital_transaction.aggregate({
        where: { receiverId: userId },
        _sum: { amount: true },
      }),
      this.prisma.order.aggregate({
        where: {
          sellerId: userId,
          paymentStatus: 'PAID',
        },
        _sum: {
          total: true,
          serviceFee: true,
        },
      }),
      (this.prisma as any).shopEbookPayments.aggregate({
        where: {
          sellerId: userId,
          status: 'SUCCEEDED',
        },
        _sum: {
          sellerAmount: true,
        },
      }),
    ]);

    const totalShopItemsEarning =
      Number(paidOrdersSummary._sum.total || 0) - Number(paidOrdersSummary._sum.serviceFee || 0);
    const totalShopEbookEarning = Number(shopEbookSummary._sum.sellerAmount || 0) / 100;
    const totalShopEarning = totalShopItemsEarning + totalShopEbookEarning;

    const totalReceived =
      Number(payFollowingSum._sum.amount ?? 0)
      + Number(tipSum._sum.amount ?? 0)
      + Number(missionDonationSum._sum.amount ?? 0)
      + Number(usdtSum._sum.amount ?? 0)
      + totalShopEarning;

    return {
      totalReceived: Number(totalReceived.toFixed(2)),
      totalShopItemsEarning: Number(totalShopItemsEarning.toFixed(2)),
      totalShopEbookEarning: Number(totalShopEbookEarning.toFixed(2)),
      totalShopEarning: Number(totalShopEarning.toFixed(2)),
    };
  }

  private async getAllTimeEarningTotals(userId: string) {
    const [payFollowingSum, tipSum, missionDonationSum, usdtSum, paidOrdersSummary, shopEbookSummary] = await Promise.all([
      this.prisma.payment.aggregate({
        where: {
          receiverId: userId,
          forPayment: 'following',
          status: 'succeeded',
        },
        _sum: { amount: true },
      }),
      this.prisma.payment.aggregate({
        where: {
          receiverId: userId,
          forPayment: 'TIP',
          status: 'succeeded',
        },
        _sum: { amount: true },
      }),
      this.prisma.donationData.aggregate({
        where: {
          vendorId: userId,
          status: 'completed',
          action: { in: ['missionDonation', 'donate'] },
        },
        _sum: { amount: true },
      }),
      this.prisma.digital_transaction.aggregate({
        where: { receiverId: userId },
        _sum: { amount: true },
      }),
      this.prisma.order.aggregate({
        where: {
          sellerId: userId,
          paymentStatus: 'PAID',
        },
        _sum: {
          total: true,
          serviceFee: true,
        },
      }),
      (this.prisma as any).shopEbookPayments.aggregate({
        where: {
          sellerId: userId,
          status: 'SUCCEEDED',
        },
        _sum: {
          sellerAmount: true,
        },
      }),
    ]);

    const payFollowingTotalAllTime = Number(payFollowingSum._sum.amount ?? 0);
    const tipTotalAllTime = Number(tipSum._sum.amount ?? 0);
    const missionDonationTotalAllTime = Number(missionDonationSum._sum.amount ?? 0);
    const usdtTotalAllTime = Number(usdtSum._sum.amount ?? 0);
    const totalShopItemsEarningAllTime = Number(
      (Number(paidOrdersSummary._sum.total || 0) - Number(paidOrdersSummary._sum.serviceFee || 0)).toFixed(2),
    );
    const totalShopEbookEarningAllTime = Number((Number(shopEbookSummary._sum.sellerAmount || 0) / 100).toFixed(2));
    const totalShopEarningAllTime = Number((totalShopItemsEarningAllTime + totalShopEbookEarningAllTime).toFixed(2));

    const totalEarningAllTime = Number((
      payFollowingTotalAllTime
      + tipTotalAllTime
      + missionDonationTotalAllTime
      + usdtTotalAllTime
      + totalShopEarningAllTime
    ).toFixed(2));

    return {
      payFollowingTotalAllTime,
      tipTotalAllTime,
      missionDonationTotalAllTime,
      usdtTotalAllTime,
      totalShopItemsEarningAllTime,
      totalShopEbookEarningAllTime,
      totalShopEarningAllTime,
      totalEarningAllTime,
    };
  }

  async getPayFollowingGraph(userId: string) {
    const now = new Date();
    const startDate = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - 6,
      0,
      0,
      0,
      0,
    ));

    const [payFollowingRows] = await Promise.all([
      this.prisma.payment.findMany({
        where: {
          receiverId: userId,
          forPayment: 'following',
          status: 'succeeded',
          createdAt: {
            gte: startDate,
            lte: now,
          },
        },
        select: {
          amount: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const dayAmountMap = new Map<string, number>();
    const labels: string[] = [];

    for (let i = 0; i < 7; i += 1) {
      const day = new Date(Date.UTC(
        startDate.getUTCFullYear(),
        startDate.getUTCMonth(),
        startDate.getUTCDate() + i,
        0,
        0,
        0,
        0,
      ));
      const key = day.toISOString().slice(0, 10);
      labels.push(key);
      dayAmountMap.set(key, 0);
    }

    payFollowingRows.forEach((row) => {
      const key = row.createdAt.toISOString().slice(0, 10);
      const current = dayAmountMap.get(key) || 0;
      dayAmountMap.set(key, current + Number(row.amount || 0));
    });

    const graphData = labels.map((date) => ({
      date,
      amount: Number((dayAmountMap.get(date) || 0).toFixed(2)),
    }));

    const totals = await this.getAllTimeEarningTotals(userId);
    const payFollowingTotal = totals.payFollowingTotalAllTime;
    const totalEarning = totals.totalEarningAllTime;

    const payFollowingPercentageOfTotalEarning =
      totalEarning > 0 ? Number(((payFollowingTotal / totalEarning) * 100).toFixed(2)) : 0;

    return {
      range: '7d',
      startDate: startDate.toISOString(),
      endDate: now.toISOString(),
      payFollowingTotal,
      totalEarning,
      payFollowingPercentageOfTotalEarning,
      graphData,
    };
  }

  async getTipGraph(userId: string) {
    const now = new Date();
    const startDate = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - 6,
      0,
      0,
      0,
      0,
    ));

    const [tipRows] = await Promise.all([
      this.prisma.payment.findMany({
        where: {
          receiverId: userId,
          forPayment: 'TIP',
          status: 'succeeded',
          createdAt: {
            gte: startDate,
            lte: now,
          },
        },
        select: {
          amount: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const dayAmountMap = new Map<string, number>();
    const labels: string[] = [];

    for (let i = 0; i < 7; i += 1) {
      const day = new Date(Date.UTC(
        startDate.getUTCFullYear(),
        startDate.getUTCMonth(),
        startDate.getUTCDate() + i,
        0,
        0,
        0,
        0,
      ));
      const key = day.toISOString().slice(0, 10);
      labels.push(key);
      dayAmountMap.set(key, 0);
    }

    tipRows.forEach((row) => {
      const key = row.createdAt.toISOString().slice(0, 10);
      const current = dayAmountMap.get(key) || 0;
      dayAmountMap.set(key, current + Number(row.amount || 0));
    });

    const graphData = labels.map((date) => ({
      date,
      amount: Number((dayAmountMap.get(date) || 0).toFixed(2)),
    }));

    const totals = await this.getAllTimeEarningTotals(userId);
    const totalTipEarning = totals.tipTotalAllTime;
    const totalEarning = totals.totalEarningAllTime;

    const tipPercentageOfTotalEarning =
      totalEarning > 0 ? Number(((totalTipEarning / totalEarning) * 100).toFixed(2)) : 0;

    return {
      range: '7d',
      startDate: startDate.toISOString(),
      endDate: now.toISOString(),
      totalTipEarning,
      totalEarning,
      tipPercentageOfTotalEarning,
      graphData,
    };
  }

  async getTotalTipEarningByUserId(userId: string) {
    const normalizedUserId = (userId || '').trim();
    if (!normalizedUserId) {
      throw new BadRequestException('User ID is required');
    }

    await this.ensureUserExists(normalizedUserId);

    const tipSummary = await this.prisma.payment.aggregate({
      where: {
        receiverId: normalizedUserId,
        forPayment: 'TIP',
        status: 'succeeded',
      },
      _sum: {
        amount: true,
      },
    });

    const totalTipEarning = Number(Number(tipSummary._sum.amount ?? 0).toFixed(2));

    return {
      userId: normalizedUserId,
      totalTipEarning,
    };
  }

  async getMissionDonationsGraph(userId: string) {
    const now = new Date();
    const startDate = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - 6,
      0,
      0,
      0,
      0,
    ));

    const [missionDonationRows] = await Promise.all([
      this.prisma.donationData.findMany({
        where: {
          vendorId: userId,
          status: 'completed',
          action: { in: ['missionDonation', 'donate'] },
          createdAt: {
            gte: startDate,
            lte: now,
          },
        },
        select: {
          amount: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const dayAmountMap = new Map<string, number>();
    const labels: string[] = [];

    for (let i = 0; i < 7; i += 1) {
      const day = new Date(Date.UTC(
        startDate.getUTCFullYear(),
        startDate.getUTCMonth(),
        startDate.getUTCDate() + i,
        0,
        0,
        0,
        0,
      ));
      const key = day.toISOString().slice(0, 10);
      labels.push(key);
      dayAmountMap.set(key, 0);
    }

    missionDonationRows.forEach((row) => {
      const key = row.createdAt.toISOString().slice(0, 10);
      const current = dayAmountMap.get(key) || 0;
      dayAmountMap.set(key, current + Number(row.amount || 0));
    });

    const graphData = labels.map((date) => ({
      date,
      amount: Number((dayAmountMap.get(date) || 0).toFixed(2)),
    }));

    const totals = await this.getAllTimeEarningTotals(userId);
    const totalMissionDonationsEarning = totals.missionDonationTotalAllTime;
    const totalEarning = totals.totalEarningAllTime;

    const missionDonationsPercentageOfTotalEarning =
      totalEarning > 0 ? Number(((totalMissionDonationsEarning / totalEarning) * 100).toFixed(2)) : 0;

    return {
      range: '7d',
      startDate: startDate.toISOString(),
      endDate: now.toISOString(),
      totalMissionDonationsEarning,
      totalEarning,
      missionDonationsPercentageOfTotalEarning,
      graphData,
    };
  }

  async getShopEarningGraph(userId: string) {
    const now = new Date();
    const startDate = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - 6,
      0,
      0,
      0,
      0,
    ));

    const [paidOrders, shopEbookPayments] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          sellerId: userId,
          paymentStatus: 'PAID',
          createdAt: {
            gte: startDate,
            lte: now,
          },
        },
        select: {
          total: true,
          serviceFee: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      (this.prisma as any).shopEbookPayments.findMany({
        where: {
          sellerId: userId,
          status: 'SUCCEEDED',
          createdAt: {
            gte: startDate,
            lte: now,
          },
        },
        select: {
          sellerAmount: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const dayAmountMap = new Map<string, number>();
    const labels: string[] = [];

    for (let i = 0; i < 7; i += 1) {
      const day = new Date(Date.UTC(
        startDate.getUTCFullYear(),
        startDate.getUTCMonth(),
        startDate.getUTCDate() + i,
        0,
        0,
        0,
        0,
      ));
      const key = day.toISOString().slice(0, 10);
      labels.push(key);
      dayAmountMap.set(key, 0);
    }

    paidOrders.forEach((order) => {
      const key = order.createdAt.toISOString().slice(0, 10);
      const netOrderEarning = Number(order.total || 0) - Number(order.serviceFee || 0);
      const current = dayAmountMap.get(key) || 0;
      dayAmountMap.set(key, current + netOrderEarning);
    });

    shopEbookPayments.forEach((payment: any) => {
      const key = payment.createdAt.toISOString().slice(0, 10);
      // sellerAmount is stored in minor units; convert to major units.
      const netEbookEarning = Number(payment.sellerAmount || 0) / 100;
      const current = dayAmountMap.get(key) || 0;
      dayAmountMap.set(key, current + netEbookEarning);
    });

    const graphData = labels.map((date) => ({
      date,
      amount: Number((dayAmountMap.get(date) || 0).toFixed(2)),
    }));

    const totals = await this.getAllTimeEarningTotals(userId);
    const totalShopItemsEarning = totals.totalShopItemsEarningAllTime;
    const totalShopEbookEarning = totals.totalShopEbookEarningAllTime;
    const totalShopEarning = totals.totalShopEarningAllTime;
    const totalEarning = totals.totalEarningAllTime;

    const shopEarningPercentageOfTotalEarning =
      totalEarning > 0 ? Number(((totalShopEarning / totalEarning) * 100).toFixed(2)) : 0;

    return {
      range: '7d',
      startDate: startDate.toISOString(),
      endDate: now.toISOString(),
      totalShopEarning,
      totalShopItemsEarning,
      totalShopEbookEarning,
      totalEarning,
      shopEarningPercentageOfTotalEarning,
      graphData,
    };
  }

  async getUsdtTransferGraph(userId: string) {
    const now = new Date();
    const startDate = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - 6,
      0,
      0,
      0,
      0,
    ));

    const [usdtRows] = await Promise.all([
      this.prisma.digital_transaction.findMany({
        where: {
          receiverId: userId,
          createdAt: {
            gte: startDate,
            lte: now,
          },
        },
        select: {
          amount: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const dayAmountMap = new Map<string, number>();
    const labels: string[] = [];

    for (let i = 0; i < 7; i += 1) {
      const day = new Date(Date.UTC(
        startDate.getUTCFullYear(),
        startDate.getUTCMonth(),
        startDate.getUTCDate() + i,
        0,
        0,
        0,
        0,
      ));
      const key = day.toISOString().slice(0, 10);
      labels.push(key);
      dayAmountMap.set(key, 0);
    }

    usdtRows.forEach((row) => {
      const key = row.createdAt.toISOString().slice(0, 10);
      const current = dayAmountMap.get(key) || 0;
      dayAmountMap.set(key, current + Number(row.amount || 0));
    });

    const graphData = labels.map((date) => ({
      date,
      amount: Number((dayAmountMap.get(date) || 0).toFixed(2)),
    }));

    const totals = await this.getAllTimeEarningTotals(userId);
    const totalUsdtTransferEarning = totals.usdtTotalAllTime;
    const totalEarning = totals.totalEarningAllTime;

    const usdtTransferPercentageOfTotalEarning =
      totalEarning > 0 ? Number(((totalUsdtTransferEarning / totalEarning) * 100).toFixed(2)) : 0;

    return {
      range: '7d',
      startDate: startDate.toISOString(),
      endDate: now.toISOString(),
      totalUsdtTransferEarning,
      totalEarning,
      usdtTransferPercentageOfTotalEarning,
      graphData,
    };
  }

  async getReceivedTotalsTransactions(
    userId: string,
    page: number = 1,
    limit: number = 10,
    deviceId?: string,
  ) {
    const lang = await this.notificationService.getUserLanguage(userId, deviceId);
    const normalizedLang = normalizeLanguage(lang);
    const safePage = Math.max(1, page || 1);
    const safeLimit = Math.min(Math.max(1, limit || 10), 50);
    const takePerSource = safePage * safeLimit;

    const [
      followingPayments,
      tipPayments,
      missionDonations,
      usdtTransfers,
      paidOrders,
      shopEbookPayments,
      totalFollowingPayments,
      totalTipPayments,
      totalMissionDonations,
      totalUsdtTransfers,
      totalPaidOrders,
      totalShopEbookPayments,
      followingPaymentsSummary,
      tipPaymentsSummary,
      missionDonationsSummary,
      usdtTransfersSummary,
      paidOrdersSummary,
      shopEbookSummary,
    ] = await Promise.all([
      this.prisma.payment.findMany({
        where: {
          receiverId: userId,
          forPayment: 'following',
          status: 'succeeded',
        },
        orderBy: { createdAt: 'desc' },
        take: takePerSource,
      }),
      this.prisma.payment.findMany({
        where: {
          receiverId: userId,
          forPayment: 'TIP',
          status: 'succeeded',
        },
        orderBy: { createdAt: 'desc' },
        take: takePerSource,
      }),
      this.prisma.donationData.findMany({
        where: {
          vendorId: userId,
          status: 'completed',
          action: { in: ['missionDonation', 'donate'] },
        },
        orderBy: { createdAt: 'desc' },
        take: takePerSource,
      }),
      this.prisma.digital_transaction.findMany({
        where: { receiverId: userId },
        orderBy: { createdAt: 'desc' },
        take: takePerSource,
      }),
      this.prisma.order.findMany({
        where: {
          sellerId: userId,
          paymentStatus: 'PAID',
        },
        include: {
          buyer: {
            select: { id: true, userName: true, displayName: true, image: true },
          },
          items: {
            select: {
              id: true,
              productId: true,
              productName: true,
              productImage: true,
              quantity: true,
              price: true,
              subtotal: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: takePerSource,
      }),
      (this.prisma as any).shopEbookPayments.findMany({
        where: {
          sellerId: userId,
          status: 'SUCCEEDED',
        },
        include: {
          buyer: {
            select: { id: true, userName: true, displayName: true, image: true },
          },
          ebook: {
            select: { id: true, caption: true, text: true, images: true, ebookpdf: true, amount: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: takePerSource,
      }),
      this.prisma.payment.count({
        where: {
          receiverId: userId,
          forPayment: 'following',
          status: 'succeeded',
        },
      }),
      this.prisma.payment.count({
        where: {
          receiverId: userId,
          forPayment: 'TIP',
          status: 'succeeded',
        },
      }),
      this.prisma.donationData.count({
        where: {
          vendorId: userId,
          status: 'completed',
          action: { in: ['missionDonation', 'donate'] },
        },
      }),
      this.prisma.digital_transaction.count({
        where: { receiverId: userId },
      }),
      this.prisma.order.count({
        where: {
          sellerId: userId,
          paymentStatus: 'PAID',
        },
      }),
      (this.prisma as any).shopEbookPayments.count({
        where: {
          sellerId: userId,
          status: 'SUCCEEDED',
        },
      }),
      this.prisma.payment.aggregate({
        where: {
          receiverId: userId,
          forPayment: 'following',
          status: 'succeeded',
        },
        _sum: {
          amount: true,
          platformFee: true,
          totalAmount: true,
        },
      }),
      this.prisma.payment.aggregate({
        where: {
          receiverId: userId,
          forPayment: 'TIP',
          status: 'succeeded',
        },
        _sum: {
          amount: true,
          platformFee: true,
          totalAmount: true,
        },
      }),
      this.prisma.donationData.aggregate({
        where: {
          vendorId: userId,
          status: 'completed',
          action: { in: ['missionDonation', 'donate'] },
        },
        _sum: {
          amount: true,
          totalAmount: true,
          platformFees: true,
        },
      }),
      this.prisma.digital_transaction.aggregate({
        where: { receiverId: userId },
        _sum: { amount: true },
      }),
      this.prisma.order.aggregate({
        where: {
          sellerId: userId,
          paymentStatus: 'PAID',
        },
        _sum: {
          total: true,
          serviceFee: true,
        },
      }),
      (this.prisma as any).shopEbookPayments.aggregate({
        where: {
          sellerId: userId,
          status: 'SUCCEEDED',
        },
        _sum: {
          amount: true,
          platformFee: true,
          sellerAmount: true,
        },
      }),
    ]);

    const combined = [
      ...followingPayments.map((p) => ({ ...p, typeTransaction: 'payFollowing', type: 'credit' })),
      ...tipPayments.map((p) => ({ ...p, typeTransaction: 'tip', type: 'credit' })),
      ...missionDonations.map((d) => ({ ...d, typeTransaction: 'donation', type: 'credit' })),
      ...usdtTransfers.map((t) => ({ ...t, typeTransaction: 'usdt', type: 'credit' })),
      ...paidOrders.map((o) => {
        const sellerEarnings = o.sellerAmountMinor != null
          ? Number((o.sellerAmountMinor / 100).toFixed(2))
          : Number(((o.total || 0) - (o.serviceFee || 0)).toFixed(2));
        const platformFee = o.platformFeeMinor != null
          ? Number((o.platformFeeMinor / 100).toFixed(2))
          : Number((o.serviceFee || 0).toFixed(2));
        return {
          ...o,
          amount: sellerEarnings,
          totalAmount: o.total,
          sellerAmount: sellerEarnings,
          platformFee,
          forPayment: 'marketplace',
          typeTransaction: 'marketplace',
          type: 'credit',
          status: o.paymentStatus,
        };
      }),
      ...shopEbookPayments.map((e: any) => {
        const totalAmount = Number(((e.amount || 0) / 100).toFixed(2));
        const sellerAmount = Number(((e.sellerAmount || 0) / 100).toFixed(2));
        const platformFee = Number(((e.platformFee || 0) / 100).toFixed(2));
        return {
          ...e,
          amount: sellerAmount,
          totalAmount,
          sellerAmount,
          platformFee,
          forPayment: 'shopEbook',
          typeTransaction: 'shopEbook',
          type: 'credit',
          status: e.status,
        };
      }),
    ].sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const start = (safePage - 1) * safeLimit;
    const end = start + safeLimit;
    const rawTransactions = combined.slice(start, end);

    const totalItems =
      totalFollowingPayments
      + totalTipPayments
      + totalMissionDonations
      + totalUsdtTransfers
      + totalPaidOrders
      + totalShopEbookPayments;
    const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / safeLimit);

    const payFollowingUserReceived = Number(followingPaymentsSummary._sum.amount ?? 0);
    const tipUserReceived = Number(tipPaymentsSummary._sum.amount ?? 0);
    const donationUserReceived = Number(missionDonationsSummary._sum.amount ?? 0);
    const usdtUserReceived = Number(usdtTransfersSummary._sum.amount ?? 0);
    const paidOrdersUserReceived = Number(
      (Number(paidOrdersSummary._sum.total || 0) - Number(paidOrdersSummary._sum.serviceFee || 0)).toFixed(2),
    );
    const shopEbookUserReceived = Number((Number(shopEbookSummary._sum.sellerAmount || 0) / 100).toFixed(2));

    const payFollowingPlatformFee = Number(followingPaymentsSummary._sum.platformFee ?? 0);
    const tipPlatformFee = Number(tipPaymentsSummary._sum.platformFee ?? 0);
    const donationPlatformFee = Number(missionDonationsSummary._sum.platformFees ?? 0);
    const paidOrdersPlatformFee = Number(paidOrdersSummary._sum.serviceFee || 0);
    const shopEbookPlatformFee = Number((Number(shopEbookSummary._sum.platformFee || 0) / 100).toFixed(2));

    const payFollowingTotalAmount = Number(
      followingPaymentsSummary._sum.totalAmount
      ?? (payFollowingUserReceived + payFollowingPlatformFee),
    );
    const tipTotalAmount = Number(
      tipPaymentsSummary._sum.totalAmount
      ?? (tipUserReceived + tipPlatformFee),
    );
    const donationTotalAmount = Number(
      missionDonationsSummary._sum.totalAmount
      ?? (donationUserReceived + donationPlatformFee),
    );
    const usdtTotalAmount = usdtUserReceived;
    const paidOrdersTotalAmount = Number(paidOrdersSummary._sum.total || 0);
    const shopEbookTotalAmount = Number((Number(shopEbookSummary._sum.amount || 0) / 100).toFixed(2));

    const userReceived = Number(
      (
        payFollowingUserReceived
        + tipUserReceived
        + donationUserReceived
        + usdtUserReceived
        + paidOrdersUserReceived
        + shopEbookUserReceived
      ).toFixed(2),
    );
    const platformFee = Number(
      (
        payFollowingPlatformFee
        + tipPlatformFee
        + donationPlatformFee
        + paidOrdersPlatformFee
        + shopEbookPlatformFee
      ).toFixed(2),
    );
    const totalAmount = Number(
      (
        payFollowingTotalAmount
        + tipTotalAmount
        + donationTotalAmount
        + usdtTotalAmount
        + paidOrdersTotalAmount
        + shopEbookTotalAmount
      ).toFixed(2),
    );

    const transactions = normalizedLang !== 'en'
      ? rawTransactions.map((t: any) => {
        const localized = this.localizePaymentFields(normalizedLang, t.forPayment, t.status);
        const localizedTypeTransaction = translateTypeTransaction(t.typeTransaction, normalizedLang);
        return {
          ...t,
          ...(t.forPayment !== undefined ? { forPayment: localized.forPayment } : {}),
          ...(t.typeTransaction !== undefined ? { typeTransaction: localizedTypeTransaction } : {}),
          ...(t.status !== undefined ? { status: localized.status } : {}),
        };
      })
      : rawTransactions;

    return {
      totalAmount,
      userReceived,
      platformFee,
      page: safePage,
      limit: safeLimit,
      totalItems,
      totalPages,
      transactions,
    };
  }

  async getReceivedTransactions(
    userId: string,
    page: number = 1,
    limit: number = 10,
    paymentType?: string,
    deviceId?: string,
  ) {
    const lang = await this.notificationService.getUserLanguage(userId, deviceId);
    const normalizedLang = normalizeLanguage(lang);
    const safePage = Math.max(1, page || 1);
    const safeLimit = Math.min(Math.max(1, limit || 10), 50);
    const takePerSource = safePage * safeLimit;
    const normalizedType = (paymentType || '').trim().toLowerCase();

    const isSubscriptions = ['subscriptions', 'subscription', 'payfollowing', 'following', 'fansubscriptionbuy'].includes(normalizedType);
    const isTip = ['tip', 'tips'].includes(normalizedType);
    const isDonation = ['donation', 'donations', 'missiondonation', 'donate'].includes(normalizedType);
    const isUsdt = ['usdt', 'crypto', 'digital_transaction'].includes(normalizedType);
    const isMarketplace = ['marketplace', 'product', 'products', 'order', 'orders', 'shop', 'closet', 'closetitem', 'closetitems'].includes(normalizedType);
    const isEbook = ['ebook', 'ebooks', 'shopebook', 'shopebooks'].includes(normalizedType);
    const isFiltered = isSubscriptions || isTip || isDonation || isUsdt || isMarketplace || isEbook;

    if (isFiltered) {
      let combined: any[] = [];
      let totalItems = 0;

      if (isSubscriptions) {
        const [creditPayments, debitPayments, totalCredit, totalDebit] = await Promise.all([
          this.prisma.payment.findMany({
            where: {
              receiverId: userId,
              forPayment: { in: ['following', 'fanSubscriptionBuy'] },
              status: 'succeeded',
            },
            orderBy: { createdAt: 'desc' },
            take: takePerSource,
          }),
          this.prisma.payment.findMany({
            where: {
              userId,
              forPayment: { in: ['following', 'fanSubscriptionBuy'] },
              status: 'succeeded',
            },
            orderBy: { createdAt: 'desc' },
            take: takePerSource,
          }),
          this.prisma.payment.count({
            where: {
              receiverId: userId,
              forPayment: { in: ['following', 'fanSubscriptionBuy'] },
              status: 'succeeded',
            },
          }),
          this.prisma.payment.count({
            where: {
              userId,
              forPayment: { in: ['following', 'fanSubscriptionBuy'] },
              status: 'succeeded',
            },
          }),
        ]);

        combined = [
          ...creditPayments.map((p) => ({ ...p, typeTransaction: 'payFollowing', type: 'credit' })),
          ...debitPayments.map((p) => ({ ...p, typeTransaction: 'payFollowing', type: 'debit' })),
        ].sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        totalItems = totalCredit + totalDebit;
      } else if (isTip) {
        const [creditPayments, debitPayments, totalCredit, totalDebit] = await Promise.all([
          this.prisma.payment.findMany({
            where: {
              receiverId: userId,
              forPayment: 'TIP',
              status: 'succeeded',
            },
            orderBy: { createdAt: 'desc' },
            take: takePerSource,
          }),
          this.prisma.payment.findMany({
            where: {
              userId,
              forPayment: 'TIP',
              status: 'succeeded',
            },
            orderBy: { createdAt: 'desc' },
            take: takePerSource,
          }),
          this.prisma.payment.count({
            where: {
              receiverId: userId,
              forPayment: 'TIP',
              status: 'succeeded',
            },
          }),
          this.prisma.payment.count({
            where: {
              userId,
              forPayment: 'TIP',
              status: 'succeeded',
            },
          }),
        ]);

        combined = [
          ...creditPayments.map((p) => ({ ...p, typeTransaction: 'tip', type: 'credit' })),
          ...debitPayments.map((p) => ({ ...p, typeTransaction: 'tip', type: 'debit' })),
        ].sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        totalItems = totalCredit + totalDebit;
      } else if (isDonation) {
        const [creditDonations, debitDonations, totalCredit, totalDebit] = await Promise.all([
          this.prisma.donationData.findMany({
            where: {
              vendorId: userId,
              status: 'completed',
              action: { in: ['missionDonation', 'donate'] },
            },
            orderBy: { createdAt: 'desc' },
            take: takePerSource,
          }),
          this.prisma.donationData.findMany({
            where: {
              userId,
              status: 'completed',
              action: { in: ['missionDonation', 'donate'] },
            },
            orderBy: { createdAt: 'desc' },
            take: takePerSource,
          }),
          this.prisma.donationData.count({
            where: {
              vendorId: userId,
              status: 'completed',
              action: { in: ['missionDonation', 'donate'] },
            },
          }),
          this.prisma.donationData.count({
            where: {
              userId,
              status: 'completed',
              action: { in: ['missionDonation', 'donate'] },
            },
          }),
        ]);

        combined = [
          ...creditDonations.map((d) => ({ ...d, typeTransaction: 'donation', type: 'credit' })),
          ...debitDonations.map((d) => ({ ...d, typeTransaction: 'donation', type: 'debit' })),
        ].sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        totalItems = totalCredit + totalDebit;
      } else if (isUsdt) {
        const [creditUsdt, debitUsdt, totalCredit, totalDebit] = await Promise.all([
          this.prisma.digital_transaction.findMany({
            where: { receiverId: userId },
            orderBy: { createdAt: 'desc' },
            take: takePerSource,
          }),
          this.prisma.digital_transaction.findMany({
            where: { senderId: userId },
            orderBy: { createdAt: 'desc' },
            take: takePerSource,
          }),
          this.prisma.digital_transaction.count({
            where: { receiverId: userId },
          }),
          this.prisma.digital_transaction.count({
            where: { senderId: userId },
          }),
        ]);

        combined = [
          ...creditUsdt.map((t) => ({ ...t, typeTransaction: 'usdt', type: 'credit' })),
          ...debitUsdt.map((t) => ({ ...t, typeTransaction: 'usdt', type: 'debit' })),
        ].sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        totalItems = totalCredit + totalDebit;
      } else if (isMarketplace) {
        const [creditOrders, debitOrders, totalCredit, totalDebit] = await Promise.all([
          this.prisma.order.findMany({
            where: {
              sellerId: userId,
              paymentStatus: 'PAID',
            },
            include: {
              buyer: {
                select: { id: true, userName: true, displayName: true, image: true },
              },
              items: {
                select: {
                  id: true,
                  productId: true,
                  productName: true,
                  productImage: true,
                  quantity: true,
                  price: true,
                  subtotal: true,
                },
              },
            },
            orderBy: { createdAt: 'desc' },
            take: takePerSource,
          }),
          this.prisma.order.findMany({
            where: {
              buyerId: userId,
              paymentStatus: 'PAID',
            },
            include: {
              seller: {
                select: { id: true, userName: true, displayName: true, image: true },
              },
              items: {
                select: {
                  id: true,
                  productId: true,
                  productName: true,
                  productImage: true,
                  quantity: true,
                  price: true,
                  subtotal: true,
                },
              },
            },
            orderBy: { createdAt: 'desc' },
            take: takePerSource,
          }),
          this.prisma.order.count({
            where: {
              sellerId: userId,
              paymentStatus: 'PAID',
            },
          }),
          this.prisma.order.count({
            where: {
              buyerId: userId,
              paymentStatus: 'PAID',
            },
          }),
        ]);

        combined = [
          ...creditOrders.map((o) => {
            const sellerEarnings = o.sellerAmountMinor != null
              ? Number((o.sellerAmountMinor / 100).toFixed(2))
              : Number(((o.total || 0) - (o.serviceFee || 0)).toFixed(2));
            const platformFee = o.platformFeeMinor != null
              ? Number((o.platformFeeMinor / 100).toFixed(2))
              : Number((o.serviceFee || 0).toFixed(2));
            return {
              ...o,
              amount: sellerEarnings,
              totalAmount: o.total,
              sellerAmount: sellerEarnings,
              platformFee,
              forPayment: 'marketplace',
              typeTransaction: 'marketplace',
              type: 'credit',
              status: o.paymentStatus,
            };
          }),
          ...debitOrders.map((o) => {
            const sellerEarnings = o.sellerAmountMinor != null
              ? Number((o.sellerAmountMinor / 100).toFixed(2))
              : Number(((o.total || 0) - (o.serviceFee || 0)).toFixed(2));
            const platformFee = o.platformFeeMinor != null
              ? Number((o.platformFeeMinor / 100).toFixed(2))
              : Number((o.serviceFee || 0).toFixed(2));
            return {
              ...o,
              amount: o.total,
              totalAmount: o.total,
              sellerAmount: sellerEarnings,
              platformFee,
              forPayment: 'marketplace',
              typeTransaction: 'marketplace',
              type: 'debit',
              status: o.paymentStatus,
            };
          }),
        ].sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        totalItems = totalCredit + totalDebit;
      } else if (isEbook) {
        const [creditShopEbooks, debitShopEbooks, totalCredit, totalDebit] = await Promise.all([
          (this.prisma as any).shopEbookPayments.findMany({
            where: {
              sellerId: userId,
              status: 'SUCCEEDED',
            },
            include: {
              buyer: {
                select: { id: true, userName: true, displayName: true, image: true },
              },
              ebook: {
                select: { id: true, caption: true, text: true, images: true, ebookpdf: true, amount: true },
              },
            },
            orderBy: { createdAt: 'desc' },
            take: takePerSource,
          }),
          (this.prisma as any).shopEbookPayments.findMany({
            where: {
              buyerId: userId,
              status: 'SUCCEEDED',
            },
            include: {
              seller: {
                select: { id: true, userName: true, displayName: true, image: true },
              },
              ebook: {
                select: { id: true, caption: true, text: true, images: true, ebookpdf: true, amount: true },
              },
            },
            orderBy: { createdAt: 'desc' },
            take: takePerSource,
          }),
          (this.prisma as any).shopEbookPayments.count({
            where: {
              sellerId: userId,
              status: 'SUCCEEDED',
            },
          }),
          (this.prisma as any).shopEbookPayments.count({
            where: {
              buyerId: userId,
              status: 'SUCCEEDED',
            },
          }),
        ]);

        combined = [
          ...creditShopEbooks.map((e: any) => {
            const totalAmount = Number(((e.amount || 0) / 100).toFixed(2));
            const sellerAmount = Number(((e.sellerAmount || 0) / 100).toFixed(2));
            const platformFee = Number(((e.platformFee || 0) / 100).toFixed(2));
            return {
              ...e,
              amount: sellerAmount,
              totalAmount,
              sellerAmount,
              platformFee,
              forPayment: 'shopEbook',
              typeTransaction: 'shopEbook',
              type: 'credit',
              status: e.status,
            };
          }),
          ...debitShopEbooks.map((e: any) => {
            const totalAmount = Number(((e.amount || 0) / 100).toFixed(2));
            const sellerAmount = Number(((e.sellerAmount || 0) / 100).toFixed(2));
            const platformFee = Number(((e.platformFee || 0) / 100).toFixed(2));
            return {
              ...e,
              amount: totalAmount,
              totalAmount,
              sellerAmount,
              platformFee,
              forPayment: 'shopEbook',
              typeTransaction: 'shopEbook',
              type: 'debit',
              status: e.status,
            };
          }),
        ].sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        totalItems = totalCredit + totalDebit;
      }

      const start = (safePage - 1) * safeLimit;
      const end = start + safeLimit;
      const rawTransactions = combined.slice(start, end);
      const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / safeLimit);
      const transactions = normalizedLang !== 'en'
        ? rawTransactions.map((t: any) => {
          const localized = this.localizePaymentFields(normalizedLang, t.forPayment, t.status);
          const localizedTypeTransaction = translateTypeTransaction(t.typeTransaction, normalizedLang);
          return {
            ...t,
            ...(t.forPayment !== undefined ? { forPayment: localized.forPayment } : {}),
            ...(t.typeTransaction !== undefined ? { typeTransaction: localizedTypeTransaction } : {}),
            ...(t.status !== undefined ? { status: localized.status } : {}),
          };
        })
        : rawTransactions;

      return {
        page: safePage,
        limit: safeLimit,
        totalItems,
        totalPages,
        transactions,
      };
    }

    // Default: fetch and combine all transaction types
    const [
      followingPaymentsCredit,
      followingPaymentsDebit,
      tipPaymentsCredit,
      tipPaymentsDebit,
      donationsCredit,
      donationsDebit,
      usdtTransfersCredit,
      usdtTransfersDebit,
      marketplaceOrdersCredit,
      marketplaceOrdersDebit,
      shopEbooksCredit,
      shopEbooksDebit,
      totalFollowingPaymentsCredit,
      totalFollowingPaymentsDebit,
      totalTipPaymentsCredit,
      totalTipPaymentsDebit,
      totalDonationsCredit,
      totalDonationsDebit,
      totalUsdtTransfersCredit,
      totalUsdtTransfersDebit,
      totalMarketplaceOrdersCredit,
      totalMarketplaceOrdersDebit,
      totalShopEbooksCredit,
      totalShopEbooksDebit,
    ] = await Promise.all([
      this.prisma.payment.findMany({
        where: {
          receiverId: userId,
          forPayment: { in: ['following', 'fanSubscriptionBuy'] },
          status: 'succeeded',
        },
        orderBy: { createdAt: 'desc' },
        take: takePerSource,
      }),
      this.prisma.payment.findMany({
        where: {
          userId,
          forPayment: { in: ['following', 'fanSubscriptionBuy'] },
          status: 'succeeded',
        },
        orderBy: { createdAt: 'desc' },
        take: takePerSource,
      }),
      this.prisma.payment.findMany({
        where: {
          receiverId: userId,
          forPayment: 'TIP',
          status: 'succeeded',
        },
        orderBy: { createdAt: 'desc' },
        take: takePerSource,
      }),
      this.prisma.payment.findMany({
        where: {
          userId,
          forPayment: 'TIP',
          status: 'succeeded',
        },
        orderBy: { createdAt: 'desc' },
        take: takePerSource,
      }),
      this.prisma.donationData.findMany({
        where: {
          vendorId: userId,
          status: 'completed',
          action: { in: ['missionDonation', 'donate'] },
        },
        orderBy: { createdAt: 'desc' },
        take: takePerSource,
      }),
      this.prisma.donationData.findMany({
        where: {
          userId,
          status: 'completed',
          action: { in: ['missionDonation', 'donate'] },
        },
        orderBy: { createdAt: 'desc' },
        take: takePerSource,
      }),
      this.prisma.digital_transaction.findMany({
        where: { receiverId: userId },
        orderBy: { createdAt: 'desc' },
        take: takePerSource,
      }),
      this.prisma.digital_transaction.findMany({
        where: { senderId: userId },
        orderBy: { createdAt: 'desc' },
        take: takePerSource,
      }),
      this.prisma.order.findMany({
        where: {
          sellerId: userId,
          paymentStatus: 'PAID',
        },
        include: {
          buyer: {
            select: { id: true, userName: true, displayName: true, image: true },
          },
          items: {
            select: {
              id: true,
              productId: true,
              productName: true,
              productImage: true,
              quantity: true,
              price: true,
              subtotal: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: takePerSource,
      }),
      this.prisma.order.findMany({
        where: {
          buyerId: userId,
          paymentStatus: 'PAID',
        },
        include: {
          seller: {
            select: { id: true, userName: true, displayName: true, image: true },
          },
          items: {
            select: {
              id: true,
              productId: true,
              productName: true,
              productImage: true,
              quantity: true,
              price: true,
              subtotal: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: takePerSource,
      }),
      (this.prisma as any).shopEbookPayments.findMany({
        where: {
          sellerId: userId,
          status: 'SUCCEEDED',
        },
        include: {
          buyer: {
            select: { id: true, userName: true, displayName: true, image: true },
          },
          ebook: {
            select: { id: true, caption: true, text: true, images: true, ebookpdf: true, amount: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: takePerSource,
      }),
      (this.prisma as any).shopEbookPayments.findMany({
        where: {
          buyerId: userId,
          status: 'SUCCEEDED',
        },
        include: {
          seller: {
            select: { id: true, userName: true, displayName: true, image: true },
          },
          ebook: {
            select: { id: true, caption: true, text: true, images: true, ebookpdf: true, amount: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: takePerSource,
      }),
      this.prisma.payment.count({
        where: {
          receiverId: userId,
          forPayment: { in: ['following', 'fanSubscriptionBuy'] },
          status: 'succeeded',
        },
      }),
      this.prisma.payment.count({
        where: {
          userId,
          forPayment: { in: ['following', 'fanSubscriptionBuy'] },
          status: 'succeeded',
        },
      }),
      this.prisma.payment.count({
        where: {
          receiverId: userId,
          forPayment: 'TIP',
          status: 'succeeded',
        },
      }),
      this.prisma.payment.count({
        where: {
          userId,
          forPayment: 'TIP',
          status: 'succeeded',
        },
      }),
      this.prisma.donationData.count({
        where: {
          vendorId: userId,
          status: 'completed',
          action: { in: ['missionDonation', 'donate'] },
        },
      }),
      this.prisma.donationData.count({
        where: {
          userId,
          status: 'completed',
          action: { in: ['missionDonation', 'donate'] },
        },
      }),
      this.prisma.digital_transaction.count({
        where: { receiverId: userId },
      }),
      this.prisma.digital_transaction.count({
        where: { senderId: userId },
      }),
      this.prisma.order.count({
        where: {
          sellerId: userId,
          paymentStatus: 'PAID',
        },
      }),
      this.prisma.order.count({
        where: {
          buyerId: userId,
          paymentStatus: 'PAID',
        },
      }),
      (this.prisma as any).shopEbookPayments.count({
        where: {
          sellerId: userId,
          status: 'SUCCEEDED',
        },
      }),
      (this.prisma as any).shopEbookPayments.count({
        where: {
          buyerId: userId,
          status: 'SUCCEEDED',
        },
      }),
    ]);

    const combined = [
      ...followingPaymentsCredit.map((p) => ({ ...p, typeTransaction: 'payFollowing', type: 'credit' })),
      ...followingPaymentsDebit.map((p) => ({ ...p, typeTransaction: 'payFollowing', type: 'debit' })),
      ...tipPaymentsCredit.map((p) => ({ ...p, typeTransaction: 'tip', type: 'credit' })),
      ...tipPaymentsDebit.map((p) => ({ ...p, typeTransaction: 'tip', type: 'debit' })),
      ...donationsCredit.map((d) => ({ ...d, typeTransaction: 'donation', type: 'credit' })),
      ...donationsDebit.map((d) => ({ ...d, typeTransaction: 'donation', type: 'debit' })),
      ...usdtTransfersCredit.map((t) => ({ ...t, typeTransaction: 'usdt', type: 'credit' })),
      ...usdtTransfersDebit.map((t) => ({ ...t, typeTransaction: 'usdt', type: 'debit' })),
      ...marketplaceOrdersCredit.map((o) => {
        const sellerEarnings = o.sellerAmountMinor != null
          ? Number((o.sellerAmountMinor / 100).toFixed(2))
          : Number(((o.total || 0) - (o.serviceFee || 0)).toFixed(2));
        const platformFee = o.platformFeeMinor != null
          ? Number((o.platformFeeMinor / 100).toFixed(2))
          : Number((o.serviceFee || 0).toFixed(2));
        return {
          ...o,
          amount: sellerEarnings,
          totalAmount: o.total,
          sellerAmount: sellerEarnings,
          platformFee,
          forPayment: 'marketplace',
          typeTransaction: 'marketplace',
          type: 'credit',
          status: o.paymentStatus,
        };
      }),
      ...marketplaceOrdersDebit.map((o) => {
        const sellerEarnings = o.sellerAmountMinor != null
          ? Number((o.sellerAmountMinor / 100).toFixed(2))
          : Number(((o.total || 0) - (o.serviceFee || 0)).toFixed(2));
        const platformFee = o.platformFeeMinor != null
          ? Number((o.platformFeeMinor / 100).toFixed(2))
          : Number((o.serviceFee || 0).toFixed(2));
        return {
          ...o,
          amount: o.total,
          totalAmount: o.total,
          sellerAmount: sellerEarnings,
          platformFee,
          forPayment: 'marketplace',
          typeTransaction: 'marketplace',
          type: 'debit',
          status: o.paymentStatus,
        };
      }),
      ...shopEbooksCredit.map((e: any) => {
        const totalAmount = Number(((e.amount || 0) / 100).toFixed(2));
        const sellerAmount = Number(((e.sellerAmount || 0) / 100).toFixed(2));
        const platformFee = Number(((e.platformFee || 0) / 100).toFixed(2));
        return {
          ...e,
          amount: sellerAmount,
          totalAmount,
          sellerAmount,
          platformFee,
          forPayment: 'shopEbook',
          typeTransaction: 'shopEbook',
          type: 'credit',
          status: e.status,
        };
      }),
      ...shopEbooksDebit.map((e: any) => {
        const totalAmount = Number(((e.amount || 0) / 100).toFixed(2));
        const sellerAmount = Number(((e.sellerAmount || 0) / 100).toFixed(2));
        const platformFee = Number(((e.platformFee || 0) / 100).toFixed(2));
        return {
          ...e,
          amount: totalAmount,
          totalAmount,
          sellerAmount,
          platformFee,
          forPayment: 'shopEbook',
          typeTransaction: 'shopEbook',
          type: 'debit',
          status: e.status,
        };
      }),
    ].sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const start = (safePage - 1) * safeLimit;
    const end = start + safeLimit;
    const rawTransactions = combined.slice(start, end);

    const totalItems =
      totalFollowingPaymentsCredit
      + totalFollowingPaymentsDebit
      + totalTipPaymentsCredit
      + totalTipPaymentsDebit
      + totalDonationsCredit
      + totalDonationsDebit
      + totalUsdtTransfersCredit
      + totalUsdtTransfersDebit
      + totalMarketplaceOrdersCredit
      + totalMarketplaceOrdersDebit
      + totalShopEbooksCredit
      + totalShopEbooksDebit;
    const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / safeLimit);
    const transactions = normalizedLang !== 'en'
      ? rawTransactions.map((t: any) => {
        const localized = this.localizePaymentFields(normalizedLang, t.forPayment, t.status);
        const localizedTypeTransaction = translateTypeTransaction(t.typeTransaction, normalizedLang);
        return {
          ...t,
          ...(t.forPayment !== undefined ? { forPayment: localized.forPayment } : {}),
          ...(t.typeTransaction !== undefined ? { typeTransaction: localizedTypeTransaction } : {}),
          ...(t.status !== undefined ? { status: localized.status } : {}),
        };
      })
      : rawTransactions;

    return {
      page: safePage,
      limit: safeLimit,
      totalItems,
      totalPages,
      transactions,
    };
  }

  async verifyAndStoreUsdtTransaction(
    authUserId: string,
    dto: { senderId: string; receiverId: string; txHash: string; chain: string },
  ) {
    try {
      const normalizedChain = dto.chain.toUpperCase();
      const txHash = dto.txHash.toLowerCase();

      if (dto.senderId !== authUserId) {
        throw new BadRequestException('Sender ID mismatch');
      }

      const existing = await this.prisma.digital_transaction.findUnique({
        where: { txId: txHash },
      });
      if (existing) {
        throw new BadRequestException('Transaction already recorded');
      }

      const rpcUrl = this.getRpcUrlForChain(normalizedChain);
      if (!rpcUrl) {
        throw new BadRequestException('Only POLYGON is supported, or POLYGON RPC URL is missing');
      }

      const usdtAddress = this.getUsdtAddressForChain(normalizedChain);
      if (!usdtAddress) {
        throw new BadRequestException('USDT contract address not configured for chain');
      }

      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt) {
        throw new BadRequestException('Transaction not found or not yet mined');
      }

      if (receipt.status !== 1) {
        throw new BadRequestException('Transaction failed on-chain');
      }

      const normalizedUsdt = ethers.getAddress(usdtAddress);
      const transferEvent = this.usdtInterface.getEvent('Transfer');
      if (!transferEvent) {
        throw new BadRequestException('USDT Transfer event not found in ABI');
      }
      const transferTopic = transferEvent.topicHash;

      let matchedTransfer: { from: string; to: string; value: bigint } | null = null;
      for (const log of receipt.logs) {
        if (!log.address) continue;
        const logAddress = ethers.getAddress(log.address);
        if (logAddress !== normalizedUsdt) continue;
        if (!log.topics || log.topics.length === 0 || log.topics[0] !== transferTopic) continue;

        const parsed = this.usdtInterface.parseLog({ topics: log.topics, data: log.data });
        if (!parsed) continue;

        const fromRaw = (parsed.args as any)?.from as string | undefined;
        const toRaw = (parsed.args as any)?.to as string | undefined;
        const valueRaw = (parsed.args as any)?.value as bigint | undefined;
        if (!fromRaw || !toRaw || valueRaw === undefined || valueRaw === null) continue;

        const from = ethers.getAddress(fromRaw);
        const to = ethers.getAddress(toRaw);
        const value = valueRaw;
        matchedTransfer = { from, to, value };
        break;
      }

      if (!matchedTransfer) {
        throw new BadRequestException('USDT transfer not found in transaction logs');
      }

      const amount = ethers.formatUnits(matchedTransfer.value, 6);
      const txValue = matchedTransfer.value.toString();

      const saved = await this.prisma.digital_transaction.create({
        data: {
          senderId: dto.senderId,
          receiverId: dto.receiverId,
          txId: txHash,
          txType: normalizedChain,
          amount,
          txValue,
        },
      });

      return saved;
    } catch (error: any) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'Failed to verify transaction';
      throw new BadRequestException(message);
    }
  }
}

