import { Injectable, BadRequestException, Logger, UnauthorizedException, HttpException } from '@nestjs/common';
import { assertUserKyc } from '../common/kyc.util';
import { PrismaService } from '../prisma/prisma.service';
import { PurchaseTokensDto, TokenPurchaseResponseDto, BuyTokenDto, SellTokenDto, DonationResponseDto, MissionDonationDto } from './dto/purchase-tokens.dto';
import { TokenService } from '../token/token.service';
import { UserService } from '../user/user.service';
import { NotificationService } from '../notification/notification.service';
import { WalletService } from '../wallet/wallet.service';
import { PagBankService } from '../pagbank/pagbank.service';
import { PaymentProviderResolver } from '../marketPlace/payment/payment-provider.resolver';
import { CurrencyConverterService } from '../common/currency/currency-converter.service';
import { normalizeCountryCode } from '../common/payment-provider.util';
import Stripe from 'stripe';
import { ethers } from 'ethers';
import { timingSafeEqual } from 'crypto';
import { decryptSecret } from '../common/crypto.util';

@Injectable()
export class TokenPurchaseService {
  private readonly logger = new Logger(TokenPurchaseService.name);
  private stripe: Stripe;

  private readonly TOKEN_RATE = 100; // 1 USD = 100 tokens
  /** Platform fee for mission donation: 5% to platform, 95% to vendor available wallet. */
  private get PLATFORM_FEE_PERCENT(): number {
    return Number(process.env.PLATFORM_FEE_MISSION_POST_PERCENT || 0.05);
  }

  private roundCurrency(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private getUnknownDonorEmail(): string {
    return 'unknown.donor@valens.invalid';
  }

  private ensureExternalDonationKey(providedKey?: string): void {
    const expectedKey = process.env.EXTERNAL_MISSION_DONATION_KEY;

    if (!expectedKey) {
      this.logger.error('EXTERNAL_MISSION_DONATION_KEY is not configured');
      throw new UnauthorizedException('Unauthorized');
    }

    if (!providedKey) {
      throw new UnauthorizedException('Unauthorized');
    }

    const expectedBuffer = Buffer.from(expectedKey, 'utf8');
    const providedBuffer = Buffer.from(providedKey, 'utf8');

    if (expectedBuffer.length !== providedBuffer.length) {
      throw new UnauthorizedException('Unauthorized');
    }

    if (!timingSafeEqual(expectedBuffer, providedBuffer)) {
      throw new UnauthorizedException('Unauthorized');
    }
  }

  private async getOrCreateUnknownDonorUserId(): Promise<string> {
    const configuredUnknownUserId = process.env.UNKNOWN_DONOR_USER_ID;
    if (configuredUnknownUserId) {
      const existing = await this.prisma.user.findUnique({
        where: { id: configuredUnknownUserId },
        select: { id: true },
      });
      if (existing) {
        return existing.id;
      }

      this.logger.warn(`UNKNOWN_DONOR_USER_ID is set but no user found for id ${configuredUnknownUserId}. Falling back to lookup/create.`);
    }

    const existingUnknownByEmail = await this.prisma.user.findUnique({
      where: { email: this.getUnknownDonorEmail() },
      select: { id: true },
    });

    if (existingUnknownByEmail) {
      return existingUnknownByEmail.id;
    }

    const created = await this.prisma.user.create({
      data: {
        email: this.getUnknownDonorEmail(),
        userName: 'Unknown User',
        registrationType: 'NORMAL',
      },
      select: { id: true },
    });

    this.logger.log(`Created Unknown User donor account with id ${created.id}. Set UNKNOWN_DONOR_USER_ID to this value in environment.`);

    return created.id;
  }

  private async createMissionDonationSession(userId: string, dto: MissionDonationDto, donorSource: 'internal' | 'external'): Promise<DonationResponseDto> {
    // Validate payer exists
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, displayName: true, userName: true },
    });

    if (!user) {
      throw new BadRequestException('User not found');
    }
    if (donorSource === 'internal') {
      await assertUserKyc(this.prisma, userId, 'PAYER');
    }
    await assertUserKyc(this.prisma, dto.vendorId, 'RECEIVER');

    // Keep donation checks simple: allow only during active mission window.
    const missionPost = await this.getMissionPostOrThrow(dto.postId, dto.vendorId);
    const now = new Date();
    if (missionPost.start_time! > now) {
      throw new BadRequestException('Mission has not started yet');
    }
    if (missionPost.end_time! <= now) {
      throw new BadRequestException('Mission is closed because deadline has passed');
    }

    // Vendor (recipient of 95%) must exist; Connect onboarding is only required to withdraw.
    await this.ensureVendorExists(dto.vendorId);

    const payerProvider = await this.paymentProviderResolver.resolveProviderForUser(userId);
    const isPagBank = payerProvider === 'PAGBANK';

    const vendorUser = await this.prisma.user.findUnique({
      where: { id: dto.vendorId },
      select: { paymentProvider: true, country: true },
    });
    const vendorIsPagBank =
      (vendorUser?.paymentProvider || '').toUpperCase() === 'PAGBANK' ||
      (vendorUser?.country && normalizeCountryCode(vendorUser.country) === 'BR');

    const vendorCurrency = vendorIsPagBank ? 'BRL' : 'USD';
    const payerCurrency = isPagBank ? 'BRL' : 'USD';

    // Calculate donation in vendor currency for goal comparison & donationData
    let amountInVendorCurrency = dto.amount;
    if (payerCurrency !== vendorCurrency) {
      amountInVendorCurrency = await this.currencyConverter.convertMajor(
        dto.amount,
        payerCurrency,
        vendorCurrency,
      );
    }

    const goalAmount = Number(missionPost.raiseAmount || 0);
    if (goalAmount > 0) {
      const raisedAmount = await this.getCompletedMissionRaisedAmount(dto.postId);
      const raisedCents = Math.round(raisedAmount * 100);
      const goalCents = Math.round(goalAmount * 100);
      const amountVendorCents = Math.round(amountInVendorCurrency * 100);
      const remainingCents = Math.max(0, goalCents - raisedCents);

      if (remainingCents <= 0) {
        throw new BadRequestException('Mission goal has already been achieved');
      }
      if (amountVendorCents > remainingCents) {
        const symbol = vendorCurrency === 'BRL' ? 'R$' : '$';
        throw new BadRequestException(
          `Donation exceeds remaining goal amount of ${symbol}${(remainingCents / 100).toFixed(2)}`,
        );
      }
    }

    const productName = 'Mission Donation';
    const productDescription = `Donate ${payerCurrency === 'BRL' ? 'R$' : '$'}${dto.amount} to mission`;
    const metadataType = 'MissionDonation';
    const amountCents = Math.round(dto.amount * 100);
    const applicationFeeCents = Math.round(amountCents * this.PLATFORM_FEE_PERCENT);
    const receiverAmountCents = Math.max(0, amountCents - applicationFeeCents);
    const totalAmount = this.roundCurrency(amountCents / 100);
    const platformFees = this.roundCurrency(applicationFeeCents / 100);
    const receiverAmount = this.roundCurrency(receiverAmountCents / 100);

    // Vendor currency splits for donationData (mission progress)
    const vendorReceiverAmount = this.roundCurrency(amountInVendorCurrency * (1 - this.PLATFORM_FEE_PERCENT));
    const vendorPlatformFees = this.roundCurrency(amountInVendorCurrency * this.PLATFORM_FEE_PERCENT);
    const vendorTotalAmount = this.roundCurrency(amountInVendorCurrency);

    this.logger.log(
      `Creating mission donation for user ${userId}: ${payerCurrency} ${dto.amount} (5% platform, 95% to vendor wallet ${dto.vendorId}) [source=${donorSource}, provider=${payerProvider}, vendorCurrency=${vendorCurrency}]`,
    );

    if (isPagBank) {
      // Store major currency units (same as tip/following PagBank rows) for wallet credit on webhook.
      const payment = await this.prisma.payment.create({
        data: {
          userId,
          receiverId: dto.vendorId,
          amount: Math.round(receiverAmount),
          platformFee: Math.round(platformFees),
          totalAmount: Math.round(totalAmount),
          currency: 'BRL',
          status: 'pending',
          forPayment: 'missionDonation',
        },
      });

      const checkout = await this.pagBankService.createPixCheckout({
        referenceId: payment.id,
        amountMinor: amountCents,
        description: productName,
        customerEmail: user.email || undefined,
        customerName: user.displayName || user.userName || undefined,
      });

      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { stripePaymentIntentId: checkout.orderId },
      });

      const donationRecord = await this.prisma.donationData.create({
        data: {
          userId,
          vendorId: dto.vendorId,
          postId: dto.postId,
          amount: vendorReceiverAmount,
          totalAmount: vendorTotalAmount,
          platformFees: vendorPlatformFees,
          currency: vendorCurrency,
          stripeCheckoutSessionId: checkout.orderId,
          stripePaymentIntentId: checkout.orderId,
          status: 'pending',
          action: 'missionDonation',
          note: dto.note,
        } as any,
      });

      return {
        id: donationRecord.id,
        amount: donationRecord.amount,
        totalAmount: donationRecord.totalAmount ?? vendorTotalAmount,
        platformFees: donationRecord.platformFees ?? vendorPlatformFees,
        status: donationRecord.status,
        sessionUrl: checkout.checkoutUrl || checkout.pixCopyPaste || checkout.orderId,
        ...(checkout as any),
      };
    }

    // Get success and cancel URLs from environment
    const successUrl = process.env.STRIPE_SUCCESS_URL as string;
    const cancelUrl = process.env.STRIPE_CANCEL_URL as string;

    // Create Stripe Checkout Session — funds stay on platform; vendor gets available wallet credit on success
    const session = await this.stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: productName,
              description: productDescription,
            },
            unit_amount: amountCents,
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      payment_intent_data: {
        metadata: {
          userId,
          vendorId: dto.vendorId,
          type: metadataType,
          donorSource,
          platformFeeCents: applicationFeeCents.toString(),
          receiverAmountCents: receiverAmountCents.toString(),
        },
      },
      metadata: {
        userId,
        vendorId: dto.vendorId,
        type: metadataType,
        donorSource,
        platformFeeCents: applicationFeeCents.toString(),
        receiverAmountCents: receiverAmountCents.toString(),
      },
      customer_email: user.email || undefined,
    });

    const paymentData: any = {
      userId,
      receiverId: dto.vendorId,
      amount: receiverAmountCents,
      platformFee: applicationFeeCents,
      totalAmount: amountCents,
      currency: 'usd',
      stripePaymentIntentId: session.id,
      status: 'pending',
      forPayment: 'missionDonation'
    };

    await this.prisma.payment.create({
      data: paymentData,
    });

    const donationData: any = {
      userId,
      vendorId: dto.vendorId,
      postId: dto.postId,
      amount: vendorReceiverAmount,
      totalAmount: vendorTotalAmount,
      platformFees: vendorPlatformFees,
      currency: vendorCurrency,
      stripeCheckoutSessionId: session.id,
      status: 'pending',
      action: 'missionDonation',
      note: dto.note,
    };

    const donationRecord = await this.prisma.donationData.create({
      data: donationData,
    });

    return {
      id: donationRecord.id,
      amount: donationRecord.amount,
      totalAmount: donationRecord.totalAmount ?? vendorTotalAmount,
      platformFees: donationRecord.platformFees ?? vendorPlatformFees,
      status: donationRecord.status,
      sessionUrl: session.url!,
    };
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
    private readonly userService: UserService,
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

  /** Ensure vendor exists (Connect onboarding only required at withdrawal time). */
  private async ensureVendorExists(vendorId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: vendorId },
      select: { id: true },
    });
    if (!user) {
      throw new BadRequestException('Vendor not found');
    }
  }

  private static readonly MISSION_POST_TYPES = ['crowdfunding', 'support', 'mission-post'] as const;

  private async getCompletedMissionRaisedAmount(postId: string): Promise<number> {
    const raisedResult = await this.prisma.donationData.aggregate({
      where: {
        postId,
        status: 'completed',
        action: { in: ['missionDonation', 'donate'] },
      },
      _sum: { amount: true, totalAmount: true },
    });

    return Number(raisedResult._sum.totalAmount ?? raisedResult._sum.amount ?? 0);
  }

  private async getMissionPostOrThrow(postId: string, vendorId: string) {
    const post = await this.prisma.post.findFirst({
      where: {
        id: postId,
        userId: vendorId,
        deletedAt: null,
        isDelete: 'no',
        postHide: 'no',
        type: { in: [...TokenPurchaseService.MISSION_POST_TYPES] },
      },
      select: {
        id: true,
        start_time: true,
        end_time: true,
        raiseAmount: true,
      },
    });

    if (!post) {
      throw new BadRequestException('Mission post not found for this vendor');
    }

    if (!post.start_time || !post.end_time) {
      throw new BadRequestException('Mission post timeline is not configured correctly');
    }

    return post;
  }

  /** @deprecated Valens does not display token amounts/prices or tie engagement to token activity. */
  async getTotalTokenData(userId: string) {
    return [];
    // Original implementation commented: no token pricing/balance display per Valens requirements.
  }


  /**
   * Create a token purchase session
   */
  async createTokenPurchase(userId: string, dto: PurchaseTokensDto): Promise<TokenPurchaseResponseDto> {
    try {
      // Validate user exists
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, displayName: true, userName: true },
      });

      if (!user) {
        throw new BadRequestException('User not found');
      }
      await assertUserKyc(this.prisma, userId, 'PAYER');

      // Validate vendor if provided
      if (dto.vendorId) {
        const vendor = await this.prisma.user.findUnique({
          where: { id: dto.vendorId },
          select: { id: true },
        });
        if (!vendor) {
          throw new BadRequestException('Vendor not found');
        }
        await assertUserKyc(this.prisma, dto.vendorId, 'RECEIVER');
      }

      let productName: string;
      let productDescription: string;
      let metadataType: string;

      if (dto.type === 'token_purchase') {
        // Valens: token purchase excluded. Revenue from software/Stripe only, not token activity.
        throw new BadRequestException(
          'Token purchase is not available. Valens does not issue, sell, or settle tokens. Revenue is from software services (e.g. subscriptions) via Stripe only.'
        );
      } else if (dto.type === 'donation') {
        productName = 'Donation';
        productDescription = `Donate $${dto.amount}`;
        metadataType = 'donation';
        this.logger.log(`Creating donation for user ${userId}: $${dto.amount}`);
      } else {
        throw new BadRequestException('Invalid type');
      }

      const payerProvider = await this.paymentProviderResolver.resolveProviderForUser(userId);
      const amountMinor = Math.round(dto.amount * 100);

      if (payerProvider === 'PAGBANK') {
        const payment = await this.prisma.payment.create({
          data: {
            userId,
            receiverId: dto.vendorId || null,
            amount: Math.round(dto.amount),
            totalAmount: Math.round(dto.amount),
            currency: 'BRL',
            status: 'pending',
            forPayment: 'donation',
          },
        });

        const checkout = await this.pagBankService.createPixCheckout({
          referenceId: payment.id,
          amountMinor,
          description: productName,
          customerEmail: user.email || undefined,
          customerName: user.displayName || user.userName || undefined,
        });

        await this.prisma.payment.update({
          where: { id: payment.id },
          data: { stripePaymentIntentId: checkout.orderId },
        });

        const donationData: any = {
          userId,
          vendorId: dto.vendorId,
          postId: dto.postId,
          amount: dto.amount,
          stripeCheckoutSessionId: checkout.orderId,
          stripePaymentIntentId: checkout.orderId,
          status: 'pending',
          currency: 'BRL',
        };
        if (dto.purchaseTokenPrice !== undefined) {
          donationData.purchaseTokenPrice = dto.purchaseTokenPrice;
        }

        const record = await this.prisma.donationData.create({ data: donationData });
        const response: any = {
          id: record.id,
          amount: dto.amount,
          status: record.status,
          sessionUrl: checkout.checkoutUrl || checkout.pixCopyPaste || checkout.orderId,
          ...checkout,
        };
        if (dto.purchaseTokenPrice !== undefined) {
          response.purchaseTokenPrice = dto.purchaseTokenPrice;
        }
        return response;
      }

      // Get success and cancel URLs from environment
      const successUrl = process.env.STRIPE_SUCCESS_URL as string;
      const cancelUrl = process.env.STRIPE_CANCEL_URL as string;

      // Create Stripe Checkout Session
      const session = await this.stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: productName,
                description: productDescription,
              },
              unit_amount: amountMinor,
            },
            quantity: 1,
          },
        ],
        mode: 'payment',
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          userId,
          vendorId: dto.vendorId || '',
          type: metadataType,
        },
        customer_email: user.email || undefined,
      });

      // Create payment record for tracking (token_purchase branch throws above, so only donation reaches here)
      const paymentData: any = {
        userId,
        amount: amountMinor,
        currency: 'usd',
        stripePaymentIntentId: session.id,
        status: 'pending',
        forPayment: 'donation',
        ...(dto.vendorId ? { receiverId: dto.vendorId } : {}),
      };

      await this.prisma.payment.create({
        data: paymentData,
      });

      let record: any;
      let response: any;

      if (dto.type === 'donation') {
        // Create donation record
        const donationData: any = {
          userId,
          vendorId: dto.vendorId,
          postId: dto.postId,
          amount: dto.amount,
          stripeCheckoutSessionId: session.id,
          status: 'pending',
        };

        // Only include purchaseTokenPrice if it's provided
        if (dto.purchaseTokenPrice !== undefined) {
          donationData.purchaseTokenPrice = dto.purchaseTokenPrice;
        }

        record = await this.prisma.donationData.create({
          data: donationData,
        });

        response = {
          id: record.id,
          amount: dto.amount,
          status: record.status,
          sessionUrl: session.url!,
        };

        // Only include purchaseTokenPrice in response if it was provided
        if (dto.purchaseTokenPrice !== undefined) {
          response.purchaseTokenPrice = dto.purchaseTokenPrice;
        }
      } else {
        throw new BadRequestException('Invalid type');
      }

      return response;

    } catch (error) {
      this.logger.error('Error creating purchase:', error);
      if (error instanceof HttpException) {
        throw error;
      }
      throw new BadRequestException('Failed to create purchase');
    }
  }

  /**
   * Handle successful payment webhook
   */
  async handlePaymentSuccess(paymentIntentId: string) {
    try {
      // Find the token purchase
      const tokenPurchase = await this.prisma.tokenPurchase.findFirst({
        where: { stripePaymentIntentId: paymentIntentId },
      });

      if (!tokenPurchase) {
        this.logger.warn(`Token purchase not found for payment intent: ${paymentIntentId}`);
        return;
      }

      if (tokenPurchase.status === 'completed') {
        this.logger.log(`Token purchase already completed: ${tokenPurchase.id}`);
        return;
      }

      // Update token purchase status
      await this.prisma.tokenPurchase.update({
        where: { id: tokenPurchase.id },
        data: {
          status: 'completed',
          completedAt: new Date(),
        },
      });

      this.logger.log(`Token purchase completed: ${tokenPurchase.id} - ${tokenPurchase.tokensReceived} tokens purchased for user ${tokenPurchase.userId}`);

    } catch (error) {
      this.logger.error('Error handling payment success:', error);
      throw error;
    }
  }

  /**
   * Handle successful checkout session webhook
   */
  async handleCheckoutSessionCompleted(sessionId: string) {
    try {
      // Find the token purchase
      const tokenPurchase = await this.prisma.tokenPurchase.findFirst({
        where: { stripeCheckoutSessionId: sessionId } as any,
      });

      if (!tokenPurchase) {
        this.logger.warn(`Token purchase not found for checkout session: ${sessionId}`);
        return;
      }

      this.logger.log(`Token purchase found: ${JSON.stringify({
        id: tokenPurchase.id,
        userId: tokenPurchase.userId,
        vendorId: tokenPurchase.vendorId,
        amount: tokenPurchase.amount,
        status: tokenPurchase.status
      })}`);

      if (tokenPurchase.status === 'completed') {
        this.logger.log(`Token purchase already completed: ${tokenPurchase.id}`);
        return;
      }

      // Update payment status
      await this.prisma.payment.updateMany({
        where: {
          userId: tokenPurchase.userId,
          stripePaymentIntentId: sessionId,
          status: 'pending',
          forPayment: 'tokenPurchase',
        },
        data: {
          status: 'completed',
        },
      });

      // Update token purchase status
      await this.prisma.tokenPurchase.update({
        where: { id: tokenPurchase.id },
        data: {
          status: 'completed',
          completedAt: new Date(),
        },
      });

      // Get user details
      const user = await this.prisma.user.findUnique({
        where: { id: tokenPurchase.userId },
        select: { id: true, walletAddress: true },
      });

      if (!user) {
        this.logger.error(`User ${tokenPurchase.userId} not found`);
        return;
      }
      // Valens: no blockchain token purchase; coin address / buyToken / token-based follow skipped.
      // if (!tokenPurchase.vendorId) { ... }
      // const buyResult = await this.buyToken(...);
      // await this.userService.followPerson(...);
      this.logger.log(`Token purchase record ${tokenPurchase.id} completed (blockchain/token flow disabled per Valens requirements).`);

      // Send push notification to the user
      try {
        await this.notificationService.sendLocalizedNotificationToUser(
          tokenPurchase.userId,
          'notifications.TOKEN_PURCHASE_TITLE',
          'notifications.TOKEN_PURCHASE_BODY',
          {
            bodyArgs: { amount: tokenPurchase.tokensReceived },
            data: { type: 'token_purchase', purchaseId: tokenPurchase.id },
          },
        );
      } catch (notificationError) {
        this.logger.error('Failed to send push notification:', notificationError);
      }

    } catch (error) {
      this.logger.error('Error handling checkout session success:', error);
      throw error;
    }
  }

  /**
   * Handle checkout session expired webhook
   */
  async handleCheckoutSessionExpired(sessionId: string) {
    try {
      // Find the token purchase
      const tokenPurchase = await this.prisma.tokenPurchase.findFirst({
        where: { stripeCheckoutSessionId: sessionId } as any,
      });

      if (!tokenPurchase) {
        this.logger.warn(`Token purchase not found for checkout session: ${sessionId}`);
        return;
      }

      // Update status to expired
      await this.prisma.tokenPurchase.update({
        where: { id: tokenPurchase.id },
        data: {
          status: 'expired',
        },
      });

      this.logger.log(`Token purchase expired: ${tokenPurchase.id}`);

    } catch (error) {
      this.logger.error('Error handling checkout session expiration:', error);
      throw error;
    }
  }

  /**
   * Handle failed payment webhook
   */
  async handlePaymentFailed(paymentIntentId: string) {
    try {
      // Find the token purchase
      const tokenPurchase = await this.prisma.tokenPurchase.findFirst({
        where: { stripePaymentIntentId: paymentIntentId },
      });

      if (!tokenPurchase) {
        this.logger.warn(`Token purchase not found for payment intent: ${paymentIntentId}`);
        return;
      }

      // Update status to failed
      await this.prisma.tokenPurchase.update({
        where: { id: tokenPurchase.id },
        data: {
          status: 'failed',
        },
      });

      this.logger.log(`Token purchase failed: ${tokenPurchase.id}`);

    } catch (error) {
      this.logger.error('Error handling payment failure:', error);
      throw error;
    }
  }

  /** @deprecated Valens does not maintain internal token balances. */
  async getUserTokenBalance(userId: string): Promise<number> {
    return 0;
    // Valens: no internal balances per requirements.
  }

  /** @deprecated Valens does not tie engagement to token amounts. */
  async getVendorTokenAmount(userId: string, vendorId: string): Promise<number> {
    return 0;
  }

  /**
   * Get user's token purchase history
   */
  async getUserTokenPurchases(userId: string) {
    return this.prisma.tokenPurchase.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        amount: true,
        platformFee: true,
        vendorFee: true,
        restAmount: true,
        tokensReceived: true,
        status: true,
        createdAt: true,
        completedAt: true,
      },
    });
  }

  /** @deprecated Valens does not display token purchase/sale history or balances. */
  async getUserTokenHistory(userId: string, tokenAddress?: string, period?: 'week' | 'month' | 'year') {
    return {
      tokenAddress: tokenAddress || null,
      period: period || null,
      totalTransactions: 0,
      currentBalance: 0,
      history: [],
    };
  }

  /** @deprecated Valens does not buy/sell tokens or interact with DEX. */
  async buyToken(buyerUserId: string, dto: BuyTokenDto) {
    throw new BadRequestException(
      'Token purchase is not available. Valens does not issue, sell, or settle tokens.'
    );
  }

  /** @deprecated Valens does not rank by token purchases or display token status. */
  async getTopCreators() {
    return [];
    // Top creators by token price excluded per Valens requirements.
  }

  /** @deprecated Valens does not sell tokens or interact with DEX. */
  async sellToken(sellerUserId: string, dto: SellTokenDto) {
    throw new BadRequestException(
      'Token sale is not available. Valens does not issue, sell, or settle tokens.'
    );
  }

  async handleDonationPayment(session: Stripe.Checkout.Session) {
    try {
      const userId = session.metadata?.userId;
      const vendorId = session.metadata?.vendorId;

      if (!userId) {
        this.logger.error('Missing userId in donation session metadata');
        return;
      }

      // Update payment status
      await this.prisma.payment.updateMany({
        where: {
          userId,
          stripePaymentIntentId: session.id,
          status: 'pending',
          forPayment: 'donation',
        },
        data: {
          status: 'completed',
        },
      });

      // Update donation status to completed
      const updateResult = await this.prisma.donationData.updateMany({
        where: {
          userId,
          stripeCheckoutSessionId: session.id,
          status: 'pending',
        },
        data: {
          status: 'completed',
          completedAt: new Date(),
        },
      });

      if (updateResult.count === 0) {
        this.logger.warn(`No pending donation found for session ${session.id}`);
        return;
      }

      this.logger.log(`Donation for session ${session.id} completed successfully`);
    } catch (error) {
      this.logger.error('Error handling donation payment:', error);
    }
  }

  async handleMissionDonationPayment(session: Stripe.Checkout.Session) {
    try {
      const userId = session.metadata?.userId;
      const vendorId = session.metadata?.vendorId;

      if (!userId) {
        this.logger.error('Missing userId in mission donation session metadata');
        return;
      }

      // Update payment status to completed
      const paymentUpdateResult = await this.prisma.payment.updateMany({
        where: {
          userId,
          stripePaymentIntentId: session.id,
          status: 'pending',
          forPayment: 'missionDonation',
        },
        data: {
          status: 'completed',
        },
      });

      // Update mission donation status to completed
      const donationUpdateResult = await this.prisma.donationData.updateMany({
        where: {
          userId,
          stripeCheckoutSessionId: session.id,
          status: 'pending',
          action: 'missionDonation',
        },
        data: {
          status: 'completed',
          completedAt: new Date(),
        },
      });

      if (paymentUpdateResult.count === 0 && donationUpdateResult.count === 0) {
        this.logger.warn(`No pending mission donation records found for session ${session.id}`);
        return;
      }

      const completedDonation = await this.prisma.donationData.findFirst({
        where: {
          userId,
          stripeCheckoutSessionId: session.id,
          status: 'completed',
          action: 'missionDonation',
        },
        select: { id: true, postId: true, amount: true, vendorId: true },
      });

      if (completedDonation?.vendorId) {
        const receiverAmountCents =
          Number(session.metadata?.receiverAmountCents) ||
          Math.round(Number(completedDonation.amount || 0) * 100);

        if (receiverAmountCents > 0) {
          const seller = await this.prisma.user.findUnique({
            where: { id: completedDonation.vendorId },
            select: { paymentProvider: true, country: true },
          });
          const isPagBank =
            (seller?.paymentProvider || '').toUpperCase() === 'PAGBANK' ||
            (seller?.country && normalizeCountryCode(seller.country) === 'BR');
          const provider: 'PAGBANK' | 'STRIPE' = isPagBank ? 'PAGBANK' : 'STRIPE';
          const targetCurrency = provider === 'PAGBANK' ? 'brl' : 'usd';

          const finalMinor =
            targetCurrency === 'brl'
              ? await this.currencyConverter.convertMinor(receiverAmountCents, 'usd', 'brl')
              : receiverAmountCents;

          await this.walletService.creditAvailable({
            userId: completedDonation.vendorId,
            amountMinor: finalMinor,
            currency: targetCurrency,
            provider,
            source: 'MISSION_DONATION',
            refType: 'PAYMENT',
            refId: session.id,
            note: `Mission donation ${completedDonation.id}${targetCurrency === 'brl' ? ` (converted from ${receiverAmountCents} USD cents)` : ''}`,
          });
        }
      }

      if (completedDonation?.postId) {
        try {
          await this.notificationService.sendMissionContributionConfirmed(completedDonation.id);
          await this.notificationService.sendNewMissionBackerNotification(completedDonation.id);
          await this.notificationService.sendMissionGoalMilestoneIfNeeded(completedDonation.postId);
          await this.notificationService.sendMissionFullyFundedIfNeeded(completedDonation.postId);
        } catch (notificationError) {
          this.logger.error('Failed to send mission donation notification:', notificationError);
        }
      }

      this.logger.log(`Mission donation for session ${session.id} completed successfully`);
    } catch (error) {
      this.logger.error('Error handling mission donation payment:', error);
    }
  }

  async getPostDonationTotal(postId: string): Promise<{ totalDonation: number }> {
    try {
      // Aggregate the total donation amount for the post
      const donations = await this.prisma.donationData.findMany({
        where: {
          postId,
          status: 'completed', // Only count completed donations
        },
        select: {
          amount: true,
          totalAmount: true,
        },
      });

      const totalDonation = donations.reduce(
        (sum, donation) => sum + Number(donation.totalAmount ?? donation.amount ?? 0),
        0,
      );

      this.logger.log(`Total donation for post ${postId}: $${totalDonation}`);

      return { totalDonation };
    } catch (error) {
      this.logger.error('Error getting post donation total:', error);
      throw new BadRequestException('Failed to get post donation total');
    }
  }

  async getMissionDonationReceivedSummary(vendorId: string, page: number = 1, pageSize: number = 10) {
    const safePage = Math.max(1, page || 1);
    const safePageSize = Math.min(Math.max(1, pageSize || 10), 50);
    const skip = (safePage - 1) * safePageSize;
    const where = {
      vendorId,
      status: 'completed',
      action: { in: ['missionDonation', 'donate'] },
    };

    const now = new Date();

    const [sumResult, transactions, activePostCount] = await Promise.all([
      this.prisma.donationData.aggregate({
        where,
        _sum: { amount: true },
      }),
      this.prisma.donationData.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: safePageSize,
      }),
      this.prisma.post.count({
        where: {
          userId: vendorId,
          deletedAt: null,
          isDelete: 'no',
          postHide: 'no',
          type: { in: ['crowdfunding', 'support', 'mission-post'] },
          start_time: { lte: now },
          end_time: { gte: now },
        },
      }),
    ]);

    return {
      totalAmount: sumResult._sum?.amount ?? 0,
      activePostCount,
      transactions,
    };
  }

  async missionPostDonation(userId: string, dto: MissionDonationDto): Promise<DonationResponseDto> {
    try {
      return await this.createMissionDonationSession(userId, dto, 'internal');
    } catch (error) {
      this.logger.error('Error creating mission donation:', error);
      if (error instanceof HttpException) {
        throw error;
      }
      throw new BadRequestException('Failed to create mission donation');
    }
  }

  async externalMissionPostDonation(dto: MissionDonationDto, providedKey?: string): Promise<DonationResponseDto> {
    try {
      this.ensureExternalDonationKey(providedKey);
      const unknownDonorUserId = await this.getOrCreateUnknownDonorUserId();
      return await this.createMissionDonationSession(unknownDonorUserId, dto, 'external');
    } catch (error) {
      this.logger.error('Error creating external mission donation:', error);
      if (error instanceof BadRequestException || error instanceof UnauthorizedException) {
        throw error;
      }
      throw new BadRequestException('Failed to create external mission donation');
    }
  }

  /** Public web donation page — no API key; donor stored as Unknown User. */
  async webMissionPostDonation(dto: MissionDonationDto): Promise<DonationResponseDto> {
    try {
      const unknownDonorUserId = await this.getOrCreateUnknownDonorUserId();
      return await this.createMissionDonationSession(unknownDonorUserId, dto, 'external');
    } catch (error) {
      this.logger.error('Error creating web mission donation:', error);
      if (error instanceof BadRequestException || error instanceof UnauthorizedException) {
        throw error;
      }
      throw new BadRequestException('Failed to create web mission donation');
    }
  }
}
