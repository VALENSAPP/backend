import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Request } from 'express';
import Stripe from 'stripe';
import { BillingService } from './billing.service';
import { TokenPurchaseService } from '../token-purchase/token-purchase.service';
import { MarketplaceBattleBoostService } from '../marketPlace/marketplace-battles/marketplace-battle-boost.service';
import { MarketplaceWinnerPromotionService } from '../marketPlace/marketplace-battles/marketplace-winner-promotion.service';
import { PaymentService } from '../marketPlace/payment/payment.service';
import { BookingService as ServiceBookingService, SERVICE_BOOKING_STRIPE_TYPE } from '../pro-services/services/booking.service';

@ApiExcludeController()
@Controller('billing')
export class BillingWebhookController {
  private readonly logger = new Logger(BillingWebhookController.name);
  private stripe: Stripe;

  constructor(
    private readonly billingService: BillingService,
    private readonly tokenPurchaseService: TokenPurchaseService,
    private readonly marketPlacePaymentService: PaymentService,
    private readonly marketplaceBattleBoostService: MarketplaceBattleBoostService,
    private readonly marketplaceWinnerPromotionService: MarketplaceWinnerPromotionService,
    private readonly serviceBookingService: ServiceBookingService,
  ) {
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
      apiVersion: '2024-06-20',
    });
  }

  @Post('webhook')
  @HttpCode(200)
  async handleWebhook(@Req() req: Request, @Headers('stripe-signature') signature: string) {
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET as string;
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent((req as any).body, signature, endpointSecret);
    } catch (err: any) {
      this.logger.warn(`Stripe webhook signature verification failed: ${err?.message || 'unknown_error'}`);
      throw new BadRequestException('Invalid webhook signature');
    }

    // eslint-disable-next-line no-console
    // console.log(`[Stripe Webhook] Received event: ${event.type} (id: ${event.id})`);

    switch (event.type) {
      case 'checkout.session.completed':
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.metadata?.type === 'token_purchase') {
          await this.tokenPurchaseService.handleCheckoutSessionCompleted(session.id);
        } else if (session.metadata?.type === 'ebook') {
          const paymentIntentId =
            typeof session.payment_intent === 'string' ? session.payment_intent : null;
          if (paymentIntentId) {
            const paymentIntent = await this.stripe.paymentIntents.retrieve(paymentIntentId);
            await this.billingService.handleEbookPaymentSuccess(paymentIntent);
          }
        } else if (session.metadata?.type === 'shop_ebook') {
          const paymentIntentId =
            typeof session.payment_intent === 'string' ? session.payment_intent : null;
          if (paymentIntentId) {
            const paymentIntent = await this.stripe.paymentIntents.retrieve(paymentIntentId);
            await this.billingService.handleShopEbookPaymentSuccess(paymentIntent);
          }
        } else if (session.metadata?.type === 'buy_hit') {
          await this.billingService.handleBuyHitPayment(session);
        } else if (session.metadata?.type === 'fans_page_subscription') {
          await this.billingService.handleFansPageSubscriptionPayment(session);
        } else if (session.metadata?.type === 'fan_subscription_buy') {
          // console.log(`Webhook: Handling fan_subscription_buy for session ${session.id}`);
          await this.billingService.handleFanSubscriptionBuyPayment(session);
        } else if (session.metadata?.type === 'donation') {
          // console.log(`Webhook: Handling donation for session ${session.id}`);
          await this.tokenPurchaseService.handleDonationPayment(session);
        } else if (session.metadata?.type === 'MissionDonation') {
          // console.log(`Webhook: Handling mission donation for session ${session.id}`);
          await this.tokenPurchaseService.handleMissionDonationPayment(session);
        } else if (session.metadata?.type === 'marketplace_mycloset') {
          const paymentIntentId =
            typeof session.payment_intent === 'string' ? session.payment_intent : null;
          if (paymentIntentId) {
            const paymentIntent = await this.stripe.paymentIntents.retrieve(paymentIntentId);
            await this.marketPlacePaymentService.finalizeMarketplacePayment(paymentIntent);
          }
        } else if (session.metadata?.type === 'following') {
          await this.billingService.handleFollowingCheckoutSessionCompleted(session);
        } else if (session.metadata?.type === 'marketplace_battle_boost') {
          const paymentIntentId =
            typeof session.payment_intent === 'string' ? session.payment_intent : null;
          if (paymentIntentId) {
            const paymentIntent = await this.stripe.paymentIntents.retrieve(paymentIntentId);
            await this.marketplaceBattleBoostService.handleVerifiedPaymentSuccess(paymentIntent);
          }
        } else if (session.metadata?.type === 'marketplace_winner_promotion') {
          const paymentIntentId =
            typeof session.payment_intent === 'string' ? session.payment_intent : null;
          if (paymentIntentId) {
            const paymentIntent = await this.stripe.paymentIntents.retrieve(paymentIntentId);
            await this.marketplaceWinnerPromotionService.handleVerifiedPaymentSuccess(paymentIntent);
          }
        } else if (session.metadata?.type === SERVICE_BOOKING_STRIPE_TYPE) {
          await this.serviceBookingService.handleCheckoutCompleted(session);
        } else {
          await this.billingService.handleCheckoutSessionCompleted(session);
        }
        break;
      case 'invoice.paid':
        await this.billingService.handleInvoicePaid(event.data.object as Stripe.Invoice);
        break;
      case 'invoice.payment_failed':
        await this.billingService.handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
        break;
      case 'customer.subscription.deleted':
        await this.billingService.handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;
      case 'payment_intent.succeeded':
        // eslint-disable-next-line no-console
        // console.log('[Stripe Webhook] Handling payment_intent.succeeded');
        await this.handlePaymentIntentSucceeded(event.data.object as Stripe.PaymentIntent);
        break;
      case 'payment_intent.payment_failed':
        // eslint-disable-next-line no-console
        // console.log('[Stripe Webhook] Handling payment_intent.payment_failed');
        await this.handlePaymentIntentFailed(event.data.object as Stripe.PaymentIntent);
        break;
      case 'checkout.session.expired':
        await this.handleCheckoutSessionExpired(event.data.object as Stripe.Checkout.Session);
        break;
      case 'transfer.created':
        await this.billingService.handleTransferCreated(event.data.object as Stripe.Transfer);
        break;
      case 'transfer.reversed':
        await this.billingService.handleTransferFailedOrReversed(
          event.data.object as Stripe.Transfer,
          'Stripe transfer was reversed',
        );
        break;
      case 'payout.paid':
        await this.billingService.handlePayoutPaid(event.data.object as Stripe.Payout);
        break;
      case 'payout.failed':
        await this.billingService.handlePayoutFailed(event.data.object as Stripe.Payout);
        break;
      default:
        break;
    }

    return { received: true };
  }

  private async handlePaymentIntentSucceeded(paymentIntent: Stripe.PaymentIntent) {
    try {
      const type = paymentIntent.metadata?.type;
      // eslint-disable-next-line no-console
      // console.log(`[Stripe Webhook] payment_intent.succeeded — metadata.type: ${type ?? '(none)'}, id: ${paymentIntent.id}`);
      // Check if this is a token purchase by looking at metadata
      if (type === 'token_purchase') {
        await this.tokenPurchaseService.handlePaymentSuccess(paymentIntent.id);
      } else if (type === 'following') {
        // eslint-disable-next-line no-console
        // console.log('[Stripe Webhook] Routing to handleOneTimePaymentSuccess (pay-following)');
        await this.billingService.handleOneTimePaymentSuccess(paymentIntent);
      } else if (type === 'tip') {
        await this.billingService.handleTipPaymentSuccess(paymentIntent);
      } else if (type === 'ebook') {
        await this.billingService.handleEbookPaymentSuccess(paymentIntent);
      } else if (type === 'shop_ebook') {
        await this.billingService.handleShopEbookPaymentSuccess(paymentIntent);
      } else if (type === 'marketplace_mycloset') {
        await this.marketPlacePaymentService.finalizeMarketplacePayment(paymentIntent);
      } else if (type === 'marketplace_battle_boost') {
        await this.marketplaceBattleBoostService.handleVerifiedPaymentSuccess(paymentIntent);
      } else if (type === 'marketplace_winner_promotion') {
        await this.marketplaceWinnerPromotionService.handleVerifiedPaymentSuccess(paymentIntent);
      } else if (type === SERVICE_BOOKING_STRIPE_TYPE) {
        await this.serviceBookingService.handlePaymentIntentSucceeded(paymentIntent);
      } else {
        // eslint-disable-next-line no-console
        // console.log('[Stripe Webhook] payment_intent.succeeded — no handler for this type, skipping');
      }
    } catch (error) {
      this.logger.error(
        `Error handling payment_intent.succeeded for ${paymentIntent.id}: ${(error as any)?.message || error
        }`,
      );
    }
  }

  private async handlePaymentIntentFailed(paymentIntent: Stripe.PaymentIntent) {
    try {
      const type = paymentIntent.metadata?.type;
      // eslint-disable-next-line no-console
      // console.log(`[Stripe Webhook] payment_intent.payment_failed — metadata.type: ${type ?? '(none)'}, id: ${paymentIntent.id}`);
      // Check if this is a token purchase by looking at metadata
      if (type === 'token_purchase') {
        await this.tokenPurchaseService.handlePaymentFailed(paymentIntent.id);
      } else if (type === 'following') {
        // eslint-disable-next-line no-console
        // console.log('[Stripe Webhook] Routing to handleOneTimePaymentFailed (pay-following)');
        await this.billingService.handleOneTimePaymentFailed(paymentIntent);
      } else if (type === 'tip') {
        await this.billingService.handleTipPaymentFailed(paymentIntent);
      } else if (type === 'ebook') {
        await this.billingService.handleEbookPaymentFailed(paymentIntent);
      } else if (type === 'shop_ebook') {
        await this.billingService.handleShopEbookPaymentFailed(paymentIntent);
      } else if (type === 'marketplace_mycloset') {
        await this.marketPlacePaymentService.markMarketplacePaymentFailed(paymentIntent);
      } else if (type === 'marketplace_battle_boost') {
        await this.marketplaceBattleBoostService.handleVerifiedPaymentFailure(paymentIntent);
      } else if (type === 'marketplace_winner_promotion') {
        await this.marketplaceWinnerPromotionService.handleVerifiedPaymentFailure(paymentIntent);
      } else {
        // eslint-disable-next-line no-console
        // console.log('[Stripe Webhook] payment_intent.payment_failed — no handler for this type, skipping');
      }
    } catch (error) {
      this.logger.error(
        `Error handling payment_intent.payment_failed for ${paymentIntent.id}: ${(error as any)?.message || error
        }`,
      );
    }
  }

  private async handleCheckoutSessionExpired(session: Stripe.Checkout.Session) {
    try {
      // Check if this is a token purchase by looking at metadata
      if (session.metadata?.type === 'token_purchase') {
        await this.tokenPurchaseService.handleCheckoutSessionExpired(session.id);
      } else if (session.metadata?.type === 'marketplace_battle_boost') {
        await this.marketplaceBattleBoostService.handleCheckoutExpired(session);
      } else if (session.metadata?.type === 'marketplace_winner_promotion') {
        await this.marketplaceWinnerPromotionService.handleCheckoutExpired(session);
      } else if (session.metadata?.type === SERVICE_BOOKING_STRIPE_TYPE) {
        await this.serviceBookingService.handleCheckoutExpired(session);
      }
    } catch (error) {
      this.logger.error(
        `Error handling checkout.session.expired for ${session.id}: ${(error as any)?.message || error
        }`,
      );
    }
  }
}


