import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ManageController } from './controllers/manage.controller';
import { ProviderController } from './controllers/provider.controller';
import { PublicController } from './controllers/public.controller';
import { CatalogService } from './services/catalog.service';
import { ProviderService } from './services/provider.service';
import { PublicService } from './services/public.service';

/**
 * Valens Services: mentorships, consultations, appointments, events and monthly packages.
 * All routes live under /pro-services.
 */
@Module({
    imports: [PrismaModule],
    // Order matters: fixed paths (provider/*, manage/*) must be registered before PublicController's ':id'
    controllers: [ProviderController, ManageController, PublicController],
    providers: [ProviderService, CatalogService, PublicService],
    exports: [ProviderService, CatalogService, PublicService],
})
export class ProServicesModule { }
