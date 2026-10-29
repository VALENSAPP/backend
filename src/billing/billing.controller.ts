import { Controller, Get, Post, Req, UseGuards, Body, BadRequestException, Query, Param, ValidationPipe } from '@nestjs/common';
import { BillingService } from './billing.service';
import { ApiBearerAuth, ApiOperation, ApiTags, ApiBody, ApiQuery, ApiParam, ApiResponse } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { IsString, IsNotEmpty, IsNumber, Min, IsObject } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { BuyHitDto } from './dto/buy-hit.dto';
import { BuyFanSubscriptionDto } from './dto/buy-fan-subscription.dto';
import { PayFollowingDto } from './dto/pay-following.dto';
import { CancelPayFollowingSubscriptionDto } from './dto/cancel-pay-following-subscription.dto';
import { RespondPriceChangeDto } from './dto/respond-price-change.dto';
import { GetSubscribersQueryDto } from './dto/get-subscribers-query.dto';
import { GetPriceUpdateSubscribersQueryDto } from './dto/get-price-update-subscribers.dto';
import { GetMySubscriptionsQueryDto } from './dto/get-my-subscriptions-query.dto';
import { SendTipDto } from './dto/send-tip.dto';
import { CreateEbookPaymentDto } from './dto/create-ebook-payment.dto';
import { CreateShopEbookPaymentDto } from './dto/create-shop-ebook-payment.dto';
import { AddDigitalBadgeDto } from './dto/add-digital-badge.dto';
import { VerifyUsdtTransactionDto } from './dto/verify-usdt-transaction.dto';
import { WalletService } from '../wallet/wallet.service';


export class RequestWithdrawalDto {
  @ApiProperty({
    description: 'Amount to withdraw in USD',
    example: 50.00,
    minimum: 10
  })
  @IsNumber()
  @Min(10)
  @IsNotEmpty()
  amount!: number;
}

export class TotalTipEarningDto {
  @ApiProperty({
    description: 'User ID for which to fetch total tip earning',
    example: 'user_123',
  })
  @IsString()
  @IsNotEmpty()
  userId!: string;
}

@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(
    private readonly billingService: BillingService,
    private readonly walletService: WalletService,
  ) { }

  @Post('subscribe')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create Stripe Checkout Session for subscription (uses env vars)' })
  async createSubscription(@Req() req: Request) {
    const userId = (req.user as any).userId;
    const session = await this.billingService.createCheckoutSession(userId);
    return { url: session.url };
  }

  @Post('cancel')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cancel subscription at period end' })
  async cancelSubscription(@Req() req: Request) {
    const userId = (req.user as any).userId;
    const result = await this.billingService.cancelSubscriptionAtPeriodEnd(userId);
    return { message: 'Subscription will cancel at period end', result };
  }

  @Post('pay-following')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create Stripe Checkout Session for recurring or one-time creator following subscription' })
  @ApiBody({ type: PayFollowingDto })
  async createOneTimePayment(
    @Req() req: Request,
    @Body(new ValidationPipe({ whitelist: true, transform: true })) dto: PayFollowingDto,
  ) {
    const payerUserId = (req.user as any).userId;
    if (dto.contentUserId === payerUserId) {
      throw new BadRequestException('You cannot pay yourself');
    }
    const session = await this.billingService.createOneTimePaymentCheckoutSession(
      payerUserId,
      dto.contentUserId,
      dto.amount,
      dto.isAutoRenew !== false,
    );
    return { url: session.url };
  }

  @Post('pay-following/cancel-subscription')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cancel recurring auto-pay for a creator following subscription at period end' })
  @ApiBody({ type: CancelPayFollowingSubscriptionDto })
  async cancelPayFollowingSubscription(
    @Req() req: Request,
    @Body(new ValidationPipe({ whitelist: true, transform: true })) dto: CancelPayFollowingSubscriptionDto,
  ) {
    const fanUserId = (req.user as any)?.userId || (req.user as any)?.sub || (req.user as any)?.id;
    return this.billingService.cancelPayFollowingSubscription(fanUserId, dto);
  }

  @Post('pay-following/respond-price-change')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Respond to creator subscription price change: ACCEPT (keep auto-renew active) or CANCEL (decline and stop auto-renew)' })
  @ApiBody({ type: RespondPriceChangeDto })
  async respondToPriceChange(
    @Req() req: Request,
    @Body(new ValidationPipe({ whitelist: true, transform: true })) dto: RespondPriceChangeDto,
  ) {
    const fanUserId = (req.user as any)?.userId || (req.user as any)?.sub || (req.user as any)?.id;
    return this.billingService.respondToPriceChange(fanUserId, dto);
  }

  @Post('send-tip')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a tip checkout using the payer payment provider' })
  @ApiBody({ type: SendTipDto })
  async sendTip(
    @Req() req: Request,
    @Body(new ValidationPipe({ whitelist: true, transform: true })) dto: SendTipDto,
  ) {
    const senderUserId = (req.user as any).userId;
    if (dto.receiverUserId === senderUserId) {
      throw new BadRequestException('You cannot tip yourself');
    }
    const session = await this.billingService.createTipCheckoutSession(
      senderUserId,
      dto.receiverUserId,
      dto.amount,
    );
    // Keep the legacy URL while exposing the fields required by the native PIX checkout.
    if ('provider' in session && session.provider === 'PAGBANK') {
      return {
        url: session.url,
        provider: session.provider,
        paymentId: session.referenceId,
        orderId: session.orderId,
        currency: session.currency.toUpperCase(),
        amountMinor: session.amountMinor,
        qrCode: session.qrCode,
        pixCopyPaste: session.pixCopyPaste,
        expiresAt: session.expiresAt,
      };
    }
    return { url: session.url };
  }

  @Post('ebook-payment')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create Stripe Checkout Session for ebook payment (10% platform, 90% seller)' })
  @ApiBody({ type: CreateEbookPaymentDto })
  async createEbookPayment(
    @Req() req: Request,
    @Body(new ValidationPipe({ whitelist: true, transform: true })) dto: CreateEbookPaymentDto,
  ) {
    const buyerUserId = (req.user as any).userId;
    if (dto.targetUserId === buyerUserId) {
      throw new BadRequestException('You cannot buy your own ebook');
    }
    const session = await this.billingService.createEbookCheckoutSession(
      buyerUserId,
      dto.targetUserId,
      dto.postId,
      dto.amount,
    );
    return { url: session.url };
  }

  @Post('shop-ebook-payment')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create Stripe Checkout Session for shop ebook payment (10% platform, 90% seller)' })
  @ApiBody({ type: CreateShopEbookPaymentDto })
  async createShopEbookPayment(
    @Req() req: Request,
    @Body(new ValidationPipe({ whitelist: true, transform: true })) dto: CreateShopEbookPaymentDto,
  ) {
    const buyerUserId = (req.user as any).userId;
    const session = await this.billingService.createShopEbookCheckoutSession(
      buyerUserId,
      dto.closetId,
      dto.ebookId,
      dto.amount,
    );
    return { url: session.url };
  }

  @Get('ebook-payments/me')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get authenticated user ebook payments (buyer/seller/all)' })
  @ApiQuery({ name: 'role', required: false, enum: ['buyer', 'seller', 'all'], example: 'all' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 10 })
  async getMyEbookPayments(
    @Req() req: Request,
    @Query('role') role?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const userId = (req.user as any).userId;
    const normalizedRole = (role || 'all').toString().trim().toLowerCase();
    const parsedRole =
      normalizedRole === 'buyer' || normalizedRole === 'seller' || normalizedRole === 'all'
        ? (normalizedRole as 'buyer' | 'seller' | 'all')
        : 'all';

    const pageNum = Math.max(1, parseInt(page || '1', 10) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit || '10', 10) || 10));

    return this.billingService.getMyEbookPayments(userId, parsedRole, pageNum, limitNum);
  }

  @Get('pay-following/received')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get total received pay-following amount and latest transactions' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  async getPayFollowingReceived(@Req() req: Request, @Query('page') page?: string) {
    const userId = (req.user as any).userId;
    const pageNum = Math.max(1, parseInt(page || '1', 10) || 1);
    return this.billingService.getPayFollowingReceivedSummary(userId, pageNum, 10);
  }

  @Get('pay-following/price-update-summary')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get creator pay-following subscription price update summary and subscriber responses' })
  @ApiResponse({ status: 200, description: 'Price update summary retrieved successfully' })
  async getPayFollowingPriceUpdateSummary(@Req() req: Request) {
    const creatorId = (req.user as any).userId;
    return this.billingService.getPayFollowingPriceUpdateSummary(creatorId);
  }

  @Get('pay-following/price-update-subscribers')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get list of users who accepted, declined, or are pending for creator pay-following price update' })
  @ApiResponse({ status: 200, description: 'Pay-following price update subscribers retrieved successfully' })
  async getPayFollowingPriceUpdateSubscribers(
    @Req() req: Request,
    @Query() query: GetPriceUpdateSubscribersQueryDto,
  ) {
    const creatorId = (req.user as any).userId;
    return this.billingService.getPayFollowingPriceUpdateSubscribers(creatorId, query);
  }


  @Get('pay-following/subscribers')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get list of users who bought my subscription through pay-following' })
  async getPayFollowingSubscribers(
    @Req() req: Request,
    @Query() query: GetSubscribersQueryDto,
  ) {
    const creatorId = (req.user as any).userId;
    return this.billingService.getPayFollowingSubscribers(creatorId, query);
  }

  @Get('pay-following/subscriptions')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get list of users/creators to whom I bought subscriptions through pay-following' })
  async getMyPayFollowingSubscriptions(
    @Req() req: Request,
    @Query() query: GetMySubscriptionsQueryDto,
  ) {
    const fanUserId = (req.user as any).userId;
    return this.billingService.getMyPayFollowingSubscriptions(fanUserId, query);
  }

  @Get('pay-following/my-subscriptions')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Alias for GET /billing/pay-following/subscriptions' })
  async getMyPayFollowingSubscriptionsAlias(
    @Req() req: Request,
    @Query() query: GetMySubscriptionsQueryDto,
  ) {
    const fanUserId = (req.user as any).userId;
    return this.billingService.getMyPayFollowingSubscriptions(fanUserId, query);
  }

  @Get('subscription-earning/graph')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get subscription earning graph (pay-following received) for last 7 days' })
  async getSubscriptionEarningGraph(@Req() req: Request) {
    const userId = (req.user as any).userId;
    return this.billingService.getSubscriptionEarningGraph(userId);
  }

  @Get('me')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user subscription details' })
  @ApiQuery({ name: 'deviceId', required: false, type: String, description: 'Device ID for device-level language preference' })
  async getMySubscription(@Req() req: Request, @Query('deviceId') queryDeviceId?: string) {
    const userId = (req.user as any).userId;
    const deviceId = queryDeviceId || (req?.headers as any)?.['x-device-id'] || undefined;
    const details = await this.billingService.getSubscriptionDetails(userId, deviceId);
    return { subscription: details, isCancel: details.isCancel, forPayment: details.forPayment };
  }

  @Get('get-latest-transactions')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get latest transactions for the user' })
  @ApiQuery({ name: 'deviceId', required: false, type: String, description: 'Device ID for device-level language preference' })
  async getLatestTransactions(@Req() req: Request, @Query('deviceId') queryDeviceId?: string) {
    const userId = (req.user as any).userId;
    const deviceId = queryDeviceId || (req?.headers as any)?.['x-device-id'] || undefined;
    const transactions = await this.billingService.getLatestTransactions(userId, 50, deviceId);
    return { transactions };
  }

  @Get('transaction-details')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get details for a payment by payment ID or provider transaction ID' })
  @ApiQuery({ name: 'paymentId', required: false, description: 'Internal Payment.id' })
  @ApiQuery({ name: 'transactionId', required: false, description: 'Stripe PaymentIntent ID or PagBank order ID' })
  @ApiQuery({ name: 'deviceId', required: false, type: String, description: 'Device ID for device-level language preference' })
  async getTransactionDetails(
    @Req() req: Request,
    @Query('paymentId') paymentId?: string,
    @Query('transactionId') transactionId?: string,
    @Query('deviceId') queryDeviceId?: string,
  ) {
    const userId = (req.user as any).userId;
    const deviceId = queryDeviceId || (req?.headers as any)?.['x-device-id'] || undefined;
    return this.billingService.getTransactionDetails(userId, paymentId, transactionId, deviceId);
  }

  @Get('getfanSubscriptionStatus/:id')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get fan subscription status for current user and given receiver (creator) id' })
  @ApiParam({ name: 'id', description: 'Receiver (creator) user id' })
  @ApiQuery({ name: 'deviceId', required: false, type: String, description: 'Device ID for device-level language preference' })
  async getFanSubscriptionStatus(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('deviceId') queryDeviceId?: string,
  ) {
    const userId = (req.user as any).userId;
    const deviceId = queryDeviceId || (req?.headers as any)?.['x-device-id'] || undefined;
    return this.billingService.getFanSubscriptionStatus(userId, id, deviceId);
  }

  // Valens: withdrawals/redemptions excluded. Revenue from software services (Stripe subscriptions) only.
  @Get('balance')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get wallet balance plus provider live availability for withdrawals',
  })
  async getWalletBalance(@Req() req: Request) {
    const userId = (req.user as any).userId;
    return this.billingService.getWalletBalanceWithProviderAvailability(userId);
  }

  @Post('request-withdrawal')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiBody({ type: RequestWithdrawalDto })
  @ApiOperation({
    summary: 'Withdraw available wallet balance to Stripe Connect account',
    description:
      'Withdraws from available balance only (marketplace unlocked after 48h + other earnings). Pending balance cannot be withdrawn. Requires completed Stripe Connect onboarding. Minimum $10.',
  })
  async requestWithdrawal(@Req() req: Request, @Body() dto: RequestWithdrawalDto) {
    const userId = (req.user as any).userId;
    return this.billingService.requestWithdrawal(userId, dto.amount);
  }

  @Get('withdrawal-history')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get withdrawal history for the authenticated user' })
  async getWithdrawalHistory(@Req() req: Request) {
    const userId = (req.user as any).userId;
    return this.billingService.getWithdrawalHistory(userId);
  }

  @Post('create-onboarding-link')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create payment-provider onboarding link (Stripe Connect or PagBank)',
    description: 'Brazil users (paymentProvider=PAGBANK) get PagBank Connect; others get Stripe Express.',
  })
  async createOnboardingLink(@Req() req: Request) {
    const userId = (req.user as any).userId;
    const result = await this.billingService.createAccountOnboardingLink(userId);
    return result;
  }

  @Get('pagbank/callback')
  @ApiOperation({ summary: 'PagBank Connect OAuth callback' })
  @ApiQuery({ name: 'code', required: false })
  @ApiQuery({ name: 'state', required: false })
  @ApiQuery({ name: 'error', required: false })
  @ApiQuery({ name: 'error_description', required: false })
  async pagbankCallback(
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
    @Query('error_description') errorDescription?: string,
  ) {
    if (error) {
      throw new BadRequestException(
        `PagBank Connect error: ${error}${errorDescription ? ` - ${errorDescription}` : ''}`,
      );
    }
    if (!code || !state) {
      throw new BadRequestException('Missing code or state from PagBank Connect');
    }
    return this.billingService.handlePagBankConnectCallback(code, state);
  }

  @Get('onboarding-status')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get Stripe Connect onboarding status for current user' })
  async getOnboardingStatus(@Req() req: Request) {
    const userId = (req.user as any).userId;
    return this.billingService.getOnboardingStatus(userId);
  }

  @Post('buy-hit')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create Stripe Checkout Session for buying hits' })
  @ApiBody({ type: BuyHitDto })
  async buyHit(
    @Req() req: Request,
    @Body(new ValidationPipe({ whitelist: true, transform: true })) dto: BuyHitDto,
  ) {
    const userId = (req.user as any).userId;

    // Validate that the userId in the request matches the authenticated user
    if (dto.userId !== userId) {
      throw new BadRequestException('User ID mismatch');
    }

    const result = await this.billingService.buyHit(dto.hitCount, dto.userId);
    return { message: 'Checkout session created', ...result };
  }

  @Post('buy-hit-with-points')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Buy 1 hit using 1000 platform points (once per calendar month UTC)',
  })
  async buyHitWithPlatformPoints(@Req() req: Request) {
    const userId = (req.user as any)?.userId;
    if (!userId) {
      throw new BadRequestException('User not authenticated');
    }

    return this.billingService.buyHitWithPlatformPoints(userId);
  }

  @Post('fans-page-subscription')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create Stripe Checkout Session for fans page subscription' })
  async fansPageSubscription(@Req() req: Request) {
    const userId = (req.user as any).userId;
    const session = await this.billingService.createFansPageSubscriptionCheckoutSession(userId);
    return { url: session.url };
  }

  @Post('buy-fan-subscription')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create Stripe Checkout Session for buying fan subscription' })
  @ApiBody({ type: BuyFanSubscriptionDto })
  async buyFanSubscription(
    @Req() req: Request,
    @Body(new ValidationPipe({ whitelist: true, transform: true })) dto: BuyFanSubscriptionDto,
  ) {
    const userId = (req.user as any).userId;

    if (!userId) {
      throw new BadRequestException('User not authenticated');
    }

    if (!dto.buyUserId) {
      throw new BadRequestException('Creator user id is required');
    }

    if (dto.buyUserId === userId) {
      throw new BadRequestException('You cannot buy your own fan subscription');
    }

    if (dto.fanUserId && dto.fanUserId !== userId) {
      throw new BadRequestException('Fan user id must match authenticated user');
    }

    const result = await this.billingService.createOneTimePaymentCheckForFanSubscription(dto.amount, dto.buyUserId, userId);
    return { message: 'Checkout session created', ...result };
  }

  @Get('user-buy-fan-subscription-list')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get list of fans who bought subscription to the user' })
  async getUserBuyFanSubscriptionList(@Query('userId') userId: string) {
    const subscriptions = await this.billingService.getUserBuyFanSubscriptionList(userId);
    return { subscriptions };
  }

  @Get('fan-subscription-user-list')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get list of subscriptions bought by the fan user' })
  async fanSubscriptionUserList(@Query('userId') userId: string) {
    const subscriptions = await this.billingService.fanSubscriptionUserList(userId);
    return { subscriptions };
  }

  @Get('user-transaction-history')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get user transaction history by type or all types combined' })
  @ApiQuery({ name: 'userId', required: true, example: 'user_123' })
  @ApiQuery({ name: 'transactionType', required: true, example: 'all' })
  @ApiQuery({ name: 'deviceId', required: false, type: String, description: 'Device ID for device-level language preference' })
  async userTransactionHistory(
    @Req() req: Request,
    @Query('userId') userId: string,
    @Query('transactionType') transactionType: string,
    @Query('deviceId') queryDeviceId?: string,
  ) {
    const deviceId = queryDeviceId || (req?.headers as any)?.['x-device-id'] || undefined;
    const transactions = await this.billingService.userTransactionHistory(userId, transactionType, 50, deviceId);
    return { transactions };
  }

  @Post('add-digital-badge')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Add a digital badge transaction (sender = current user from token)' })
  @ApiBody({ type: AddDigitalBadgeDto })
  async addDigitalBadge(@Req() req: Request, @Body() dto: AddDigitalBadgeDto) {
    const senderId = (req.user as any).userId;
    const result = await this.billingService.addDigitalBadge(senderId, dto);
    return { message: 'Digital badge added', data: result };
  }

  @Post('verify-usdt-transaction')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Verify USDT transaction on-chain and store it' })
  @ApiBody({ type: VerifyUsdtTransactionDto })
  async verifyUsdtTransaction(@Req() req: Request, @Body() dto: VerifyUsdtTransactionDto) {
    try {
      const authUserId = (req.user as any).userId;
      const result = await this.billingService.verifyAndStoreUsdtTransaction(authUserId, dto);
      return { success: true, data: result };
    } catch (error: any) {
      throw new BadRequestException({
        success: false,
        message: error?.message || 'Failed to verify transaction',
      });
    }
  }

  @Get('get-digital-badge')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get total digital badge amount received by current user' })
  async getDigitalBadge(@Req() req: Request) {
    const userId = (req.user as any).userId;
    return this.billingService.getDigitalBadge(userId);
  }

  @Get('usdt-transfers/received')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get USDT transfers received by current user' })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  async getUsdtTransfersReceived(@Req() req: Request, @Query('limit') limit?: string) {
    const userId = (req.user as any).userId;
    const limitNum = Math.min(Math.max(1, parseInt(limit || '50', 10) || 50), 100);
    const transactions = await this.billingService.getUsdtTransfersReceived(userId, limitNum);
    return { transactions };
  }

  @Get('received-totals')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get totals for received tips, mission donations, pay-following, and USDT transfers' })
  async getReceivedTotals(@Req() req: Request) {
    const userId = (req.user as any).userId;
    return this.billingService.getReceivedTotals(userId);
  }

  @Get('pay-following-graph')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get 7-day pay-following graph, total pay-following earning, and percentage of total earning' })
  async getPayFollowingGraph(@Req() req: Request) {
    const userId = (req.user as any).userId;
    return this.billingService.getPayFollowingGraph(userId);
  }

  @Get('tip-graph')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get 7-day tip graph, total tip earning, and percentage of total earning' })
  async getTipGraph(@Req() req: Request) {
    const userId = (req.user as any).userId;
    return this.billingService.getTipGraph(userId);
  }

  @Post('total-tip-earning')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get total tip earning by user id' })
  @ApiBody({ type: TotalTipEarningDto })
  async getTotalTipEarning(@Body() dto: TotalTipEarningDto) {
    return this.billingService.getTotalTipEarningByUserId(dto.userId);
  }

  @Get('mission-donations-graph')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get 7-day mission donations graph, total mission donations earning, and percentage of total earning' })
  async getMissionDonationsGraph(@Req() req: Request) {
    const userId = (req.user as any).userId;
    return this.billingService.getMissionDonationsGraph(userId);
  }

  @Get('shop-earning-graph')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get 7-day shop earning graph (shop items + shop ebooks), excluding platform fee' })
  async getShopEarningGraph(@Req() req: Request) {
    const userId = (req.user as any).userId;
    return this.billingService.getShopEarningGraph(userId);
  }

  @Get('usdt-transfer-graph')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get 7-day USDT transfer graph, total USDT transfer earning, and percentage of total earning' })
  async getUsdtTransferGraph(@Req() req: Request) {
    const userId = (req.user as any).userId;
    return this.billingService.getUsdtTransferGraph(userId);
  }

  @Get('received-totals-transactions')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get transactions included in received-totals calculation' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 10 })
  @ApiQuery({ name: 'deviceId', required: false, type: String, description: 'Device ID for device-level language preference' })
  async getReceivedTotalsTransactions(
    @Req() req: Request,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('deviceId') queryDeviceId?: string,
  ) {
    const userId = (req.user as any).userId;
    const pageNum = Math.max(1, parseInt(page || '1', 10) || 1);
    const limitNum = Math.min(Math.max(1, parseInt(limit || '10', 10) || 10), 50);
    const deviceId = queryDeviceId || (req?.headers as any)?.['x-device-id'] || undefined;
    return this.billingService.getReceivedTotalsTransactions(userId, pageNum, limitNum, deviceId);
  }

  @Get('received-transactions')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get credit and debit transactions (combined or filtered) sorted by createdAt desc with pagination' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 10 })
  @ApiQuery({
    name: 'paymentType',
    required: false,
    example: 'subscriptions',
    description: 'Filter transactions by type: subscriptions (or subscription, payFollowing), tip, donation, usdt, marketplace (or product, order, shop), ebook (or shopEbook). Leave empty or pass all to return all transactions.',
  })
  @ApiQuery({ name: 'deviceId', required: false, type: String, description: 'Device ID for device-level language preference' })
  async getReceivedTransactions(
    @Req() req: Request,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('paymentType') paymentType?: string,
    @Query('deviceId') queryDeviceId?: string,
  ) {
    const userId = (req.user as any).userId;
    const pageNum = Math.max(1, parseInt(page || '1', 10) || 1);
    const limitNum = Math.min(Math.max(1, parseInt(limit || '10', 10) || 10), 50);
    const filterPaymentType = paymentType || (req.query as any)?.paymenttype || (req.query as any)?.payment_type;
    const deviceId = queryDeviceId || (req?.headers as any)?.['x-device-id'] || undefined;
    return this.billingService.getReceivedTransactions(userId, pageNum, limitNum, filterPaymentType, deviceId);
  }
}
