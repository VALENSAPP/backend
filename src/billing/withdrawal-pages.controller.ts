import { Controller, Get, Logger, Query, Res } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { Response } from 'express';
import { join } from 'path';
import { StripeConnectService } from './stripe-connect.service';

/**
 * Browser pages Stripe redirects to after hosted onboarding.
 * The app keeps opening the onboarding URL and polling GET /billing/onboarding-status as before.
 */
@Controller('withdrawal')
export class WithdrawalPagesController {
  private readonly logger = new Logger(WithdrawalPagesController.name);

  constructor(private readonly stripeConnectService: StripeConnectService) { }

  /** Stripe return_url: sync the account status immediately, then show the existing success page. */
  @Get('success')
  @ApiExcludeEndpoint()
  async getOnboardingSuccess(@Query('token') token: string | undefined, @Res() res: Response) {
    if (token) {
      try {
        await this.stripeConnectService.syncFromToken(token);
      } catch (error: any) {
        this.logger.warn(`Onboarding return sync failed: ${error?.message}`);
      }
    }
    const path = join(process.cwd(), 'public', 'withdrawal', 'success.html');
    return res.sendFile(path);
  }

  /** Stripe refresh_url: the onboarding link expired — create a fresh one and send the user back to Stripe. */
  @Get('reauth')
  @ApiExcludeEndpoint()
  async getOnboardingRefresh(@Query('token') token: string | undefined, @Res() res: Response) {
    try {
      const url = await this.stripeConnectService.refreshLinkFromToken(token);
      if (url) {
        return res.redirect(302, url);
      }
    } catch (error: any) {
      this.logger.warn(`Onboarding refresh failed: ${error?.message}`);
    }
    const path = join(process.cwd(), 'public', 'withdrawal', 'reauth.html');
    return res.sendFile(path);
  }
}
