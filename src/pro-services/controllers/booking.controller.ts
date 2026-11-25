import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards, ValidationPipe } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { CreateBookingDto, PayBookingDto, SlotsQueryDto } from '../dto/booking.dto';
import { getUserId } from '../pro-services.utils';
import { BookingService } from '../services/booking.service';
import { SchedulingService } from '../services/scheduling.service';

const pipe = new ValidationPipe({ whitelist: true, transform: true });

/**
 * Buyer booking flow (screens C5-C10).
 * Registered before PublicController so 'bookings/...' is matched here, not as ':id'.
 */
@ApiTags('pro-services: booking')
@Controller('pro-services')
export class BookingController {
    constructor(
        private readonly scheduling: SchedulingService,
        private readonly bookings: BookingService,
    ) { }

    @Get(':id/slots')
    @ApiOperation({
        summary: 'C5 - Free start times by date (1:1 mentorship, consultation, appointment, package)',
        description: 'Times are UTC instants; `time` is the local HH:mm in `timezone`. Up to 60 days per call.',
    })
    getSlots(@Param('id', ParseUUIDPipe) id: string, @Query(pipe) query: SlotsQueryDto) {
        return this.scheduling.getAvailableSlots(id, query);
    }

    @Get(':id/cohorts')
    @ApiOperation({ summary: 'C5 - Upcoming cohorts with seats left (group / cohort mentorships)' })
    getCohorts(@Param('id', ParseUUIDPipe) id: string) {
        return this.scheduling.getCohorts(id);
    }

    @Post(':id/book')
    @UseGuards(AuthGuard('jwt'))
    @ApiBearerAuth()
    @ApiOperation({
        summary: 'C6/C7 - Hold a time or cohort seat and get the order summary',
        description: 'Send startAt (a slot from the slots API) or cohortId, plus an optional note. The hold lasts 15 minutes.',
    })
    book(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body(pipe) dto: CreateBookingDto) {
        return this.bookings.createBooking(getUserId(req), id, dto);
    }

    @Post('bookings/:bookingId/pay')
    @UseGuards(AuthGuard('jwt'))
    @ApiBearerAuth()
    @ApiOperation({
        summary: 'C8 - Pay a held booking',
        description: 'WALLET pays from available earnings and confirms at once. CARD returns a Stripe checkoutUrl; the booking is confirmed by the Stripe webhook.',
    })
    pay(@Req() req: Request, @Param('bookingId', ParseUUIDPipe) bookingId: string, @Body(pipe) dto: PayBookingDto) {
        return this.bookings.payBooking(getUserId(req), bookingId, dto);
    }

    @Get('bookings/:bookingId')
    @UseGuards(AuthGuard('jwt'))
    @ApiBearerAuth()
    @ApiOperation({ summary: 'C9/C10 - Booking status and details (poll after card payment until CONFIRMED)' })
    getBooking(@Req() req: Request, @Param('bookingId', ParseUUIDPipe) bookingId: string) {
        return this.bookings.getBooking(getUserId(req), bookingId);
    }
}
