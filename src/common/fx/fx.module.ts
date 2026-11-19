import { Module } from '@nestjs/common';
import { StripeFxService } from './stripe-fx.service';

@Module({
    providers: [StripeFxService],
    exports: [StripeFxService],
})
export class FxModule { }
