import { Module } from '@nestjs/common';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';
import { BillingWebhookController } from './billing.webhook.controller';
import { WithdrawalPagesController } from './withdrawal-pages.controller';
import { StripeConnectWebhookController } from './stripe-connect.webhook.controller';
import { PayoutsController } from './payouts.controller';
import { StripeConnectService } from './stripe-connect.service';
import { PayoutsService } from './payouts.service';
import { PrismaModule } from '../prisma/prisma.module';
import { TokenPurchaseModule } from '../token-purchase/token-purchase.module';
import { NotificationModule } from '../notification/notification.module';
import { MarketplaceBattlesModule } from '../marketPlace/marketplace-battles/marketplace-battles.module';
import { PaymentModule } from '../marketPlace/payment/payment.module';
import { WalletModule } from '../wallet/wallet.module';
import { PagBankModule } from '../pagbank/pagbank.module';
import { MailModule } from '../common/mail/mail.module';
import { CurrencyModule } from '../common/currency/currency.module';

@Module({
  imports: [
    PrismaModule,
    TokenPurchaseModule,
    NotificationModule,
    PaymentModule,
    MarketplaceBattlesModule,
    WalletModule,
    PagBankModule,
    MailModule,
    CurrencyModule,
  ],
  controllers: [
    BillingController,
    BillingWebhookController,
    WithdrawalPagesController,
    StripeConnectWebhookController,
    PayoutsController,
  ],
  providers: [BillingService, StripeConnectService, PayoutsService],
  exports: [BillingService, StripeConnectService, PayoutsService],
})
export class BillingModule { }


