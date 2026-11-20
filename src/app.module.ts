import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { UserModule } from './user/user.module';
import { AuthModule } from './auth/auth.module';
import { PostModule } from './post/post.module';
import { StoryModule } from './story/story.module';
import { ScheduleModule } from '@nestjs/schedule';
import { BillingModule } from './billing/billing.module';
import { TokenModule } from './token/token.module';
import { TokenPurchaseModule } from './token-purchase/token-purchase.module';
import { KycModule } from './kyc/kyc.module';
import { CompanyProfileModule } from './company-profile/company-profile.module';
import { SumsubVerificationModule } from './sumsub-verification/sumsub-verification.module';
import { SumsubUserVerificationModule } from './sumsub-user_verification/sumsub-user_verification.module';
import { NotificationModule } from './notification/notification.module';
import { BattleModule } from './battle/battle.module';
import { PrivateCircleModule } from './private-circle/private-circle.module';
import { MyclosetModule } from './marketPlace/mycloset/mycloset.module';
import { CartModule } from './marketPlace/cart/cart.module';
import { WishlistModule } from './marketPlace/wishlist/wishlist.module';
import { ShopEbookModule } from './marketPlace/shop-ebook/shop-ebook.module';
import { AddressModule } from './marketPlace/address/address.module';
import { PaymentModule } from './marketPlace/payment/payment.module';
import { OrderModule } from './marketPlace/order/order.module';
import { DashboardModule } from './marketPlace/dashboard/dashboard.module';
import { EarningsModule } from './marketPlace/earnings/earnings.module';
import { MarketplaceBattlesModule } from './marketPlace/marketplace-battles/marketplace-battles.module';
import { ClosetChatModule } from './marketPlace/closet-chat/closet-chat.module';
import { ShippingModule } from './marketPlace/shipping/shipping.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DeepLinkModule } from './deep-link/deep-link.module';
import { PostMessageModule } from './post-message/post-message.module';
import { RewardsModule } from './rewards/rewards.module';
import { ModerationModule } from './moderation/moderation.module';
import { TranslationModule } from './translation/translation.module';
import { CurrencyModule } from './common/currency/currency.module';
import { ProServicesModule } from './pro-services/pro-services.module';

import * as path from 'path';
import {
  I18nModule,
  AcceptLanguageResolver,
  HeaderResolver,
  QueryResolver,
  I18nJsonLoader,
} from 'nestjs-i18n';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    ScheduleModule.forRoot(),
    I18nModule.forRoot({
      fallbackLanguage: 'en',
      fallbacks: {
        'pt-*': 'pt',
        'it-*': 'it',
        'es-*': 'es',
        'fr-*': 'fr',
        'en-*': 'en',
      },
      loader: I18nJsonLoader,
      loaderOptions: {
        path: path.join(__dirname, '/i18n/'),
        watch: true,
      },
      resolvers: [
        new HeaderResolver(['x-custom-lang', 'x-lang']),
        AcceptLanguageResolver,
        new QueryResolver(['lang', 'locale']),
      ],
    }),
    PostModule,
    UserModule,
    AuthModule,
    StoryModule,
    BillingModule,
    TokenModule,
    TokenPurchaseModule,
    KycModule,
    CompanyProfileModule,
    SumsubVerificationModule,
    SumsubUserVerificationModule,
    NotificationModule,
    BattleModule,
    PrivateCircleModule,
    MyclosetModule,
    CartModule,
    WishlistModule,
    ShopEbookModule,
    AddressModule,
    PaymentModule,
    OrderModule,
    ShippingModule,
    DashboardModule,
    EarningsModule,
    MarketplaceBattlesModule,
    ClosetChatModule,
    DeepLinkModule,
    PostMessageModule,
    RewardsModule,
    ModerationModule,
    TranslationModule,
    CurrencyModule,
    ProServicesModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
