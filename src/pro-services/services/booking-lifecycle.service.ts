import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BookingService } from './booking.service';

/** Background jobs for service bookings. */
@Injectable()
export class BookingLifecycleService {
    private readonly logger = new Logger(BookingLifecycleService.name);
    private isRunning = false;

    constructor(private readonly bookingService: BookingService) { }

    /** Every minute: release slots that were held but never paid. */
    @Cron('*/1 * * * *')
    async releaseExpiredHolds() {
        if (this.isRunning) return;
        this.isRunning = true;
        try {
            const released = await this.bookingService.expireDueHolds(100);
            if (released > 0) this.logger.log(`Services: released ${released} unpaid booking hold(s)`);
        } catch (error: any) {
            this.logger.error(`Services hold cron failed: ${error?.message || error}`, error?.stack);
        } finally {
            this.isRunning = false;
        }
    }
}
