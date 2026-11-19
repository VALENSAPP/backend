import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { FxModule } from '../common/fx/fx.module';
import { WalletService } from './wallet.service';
import { EarningsCreditService } from './earnings-credit.service';

@Module({
    imports: [PrismaModule, FxModule],
    providers: [WalletService, EarningsCreditService],
    exports: [WalletService, EarningsCreditService, FxModule],
})
export class WalletModule { }
