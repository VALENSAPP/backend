import { Body, Controller, Get, Param, Post, Req, UseGuards, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { CreateMarketplacePaymentDto } from './dto/create-marketplace-payment.dto';
import { PaymentService } from './payment.service';
import { KycGuard } from '../../common/guards/kyc.guard';

@ApiTags('payment')
@Controller('payment')
export class PaymentController {
    constructor(private readonly paymentService: PaymentService) { }

    @Post('create')
    @UseGuards(AuthGuard('jwt'), KycGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Create Stripe Checkout Session for My Closet cart checkout' })
    async createCheckoutSession(
        @Req() req: Request,
        @Body(new ValidationPipe({ whitelist: true, transform: true })) dto: CreateMarketplacePaymentDto,
    ) {
        const userId = (req.user as any)?.userId;
        return this.paymentService.createCheckoutSessionForCart(userId, dto);
    }

    @Get('me/list')
    @UseGuards(AuthGuard('jwt'))
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get marketplace payment details for authenticated user' })
    async getMyPaymentDetails(@Req() req: Request) {
        const userId = (req.user as any)?.userId;
        return this.paymentService.getPaymentDetailsForUser(userId);
    }

    @Get('me/list/recent')
    @UseGuards(AuthGuard('jwt'))
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get recent marketplace payment details for authenticated user' })
    async getMyRecentPaymentDetails(@Req() req: Request) {
        const userId = (req.user as any)?.userId;
        return this.paymentService.getRecentPaymentDetailsForUser(userId);
    }


    @Get(':paymentId')
    @UseGuards(AuthGuard('jwt'))
    @ApiBearerAuth()
    @ApiParam({ name: 'paymentId', description: 'Marketplace payment ID' })
    @ApiOperation({ summary: 'Get marketplace payment details by paymentId' })
    async getPaymentDetails(
        @Req() req: Request,
        @Param('paymentId') paymentId: string,
    ) {
        const userId = (req.user as any)?.userId;
        return this.paymentService.getPaymentDetailsById(userId, paymentId);
    }
}
