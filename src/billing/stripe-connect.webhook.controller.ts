import { BadRequestException, Controller, Headers, HttpCode, Logger, Post, Req } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { Request } from 'express';
import Stripe from 'stripe';
import { StripeConnectService } from './stripe-connect.service';
import { PayoutsService } from './payouts.service';

/**
 * Webhook for events that happen ON connected accounts (Stripe Dashboard → Developers → Webhooks →
 * "Events on Connected accounts"). Uses its own signing secret: STRIPE_CONNECT_WEBHOOK_SECRET.
 *
 * Events: account.updated, account.external_account.created/updated/deleted,
 *         payout.created/updated/paid/failed/canceled
 */
@Controller('billing')
export class StripeConnectWebhookController {
    private readonly logger = new Logger(StripeConnectWebhookController.name);

    constructor(
        private readonly stripeConnectService: StripeConnectService,
        private readonly payoutsService: PayoutsService,
    ) { }

    @Post('connect-webhook')
    @HttpCode(200)
    @ApiExcludeEndpoint()
    async handleConnectWebhook(@Req() req: Request, @Headers('stripe-signature') signature: string) {
        const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
        if (!secret) {
            this.logger.error('STRIPE_CONNECT_WEBHOOK_SECRET is not configured');
            throw new BadRequestException('Connect webhook not configured');
        }

        let event: Stripe.Event;
        try {
            event = this.stripeConnectService.client.webhooks.constructEvent((req as any).body, signature, secret);
        } catch (err: any) {
            this.logger.warn(`Connect webhook signature verification failed: ${err?.message || 'unknown_error'}`);
            throw new BadRequestException('Invalid webhook signature');
        }

        const accountId = event.account;

        switch (event.type) {
            case 'account.updated': {
                const account = event.data.object as Stripe.Account;
                await this.stripeConnectService.syncAccount(account);
                if (account.payouts_enabled) {
                    await this.payoutsService.retryFailedPayoutsForAccount(account.id);
                }
                break;
            }
            case 'account.external_account.created':
            case 'account.external_account.updated':
            case 'account.external_account.deleted': {
                if (accountId) {
                    await this.stripeConnectService.syncAccountById(accountId);
                    if (event.type !== 'account.external_account.deleted') {
                        await this.payoutsService.retryFailedPayoutsForAccount(accountId);
                    }
                }
                break;
            }
            case 'payout.created':
            case 'payout.updated':
            case 'payout.paid':
            case 'payout.failed':
            case 'payout.canceled': {
                if (accountId) {
                    await this.payoutsService.handleConnectPayoutEvent(event.data.object as Stripe.Payout, event.type);
                }
                break;
            }
            default:
                break;
        }

        return { received: true };
    }
}
