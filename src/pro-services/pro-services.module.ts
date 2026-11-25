import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WalletModule } from '../wallet/wallet.module';
import { BookingController } from './controllers/booking.controller';
import { ManageController } from './controllers/manage.controller';
import { ProviderController } from './controllers/provider.controller';
import { PublicController } from './controllers/public.controller';
import { BookingLifecycleService } from './services/booking-lifecycle.service';
import { BookingService } from './services/booking.service';
import { CatalogService } from './services/catalog.service';
import { ProviderService } from './services/provider.service';
import { PublicService } from './services/public.service';
import { SchedulingService } from './services/scheduling.service';

/**
 * Valens Services: mentorships, consultations, appointments, events and monthly packages.
 * All routes live under /pro-services.
 */
@Module({
    imports: [PrismaModule, WalletModule],
    // Order matters: fixed paths (provider/*, manage/*, bookings/*) must be registered before PublicController's ':id'
    controllers: [ProviderController, ManageController, BookingController, PublicController],
    providers: [ProviderService, CatalogService, PublicService, SchedulingService, BookingService, BookingLifecycleService],
    exports: [ProviderService, CatalogService, PublicService, SchedulingService, BookingService],
})
export class ProServicesModule { }
