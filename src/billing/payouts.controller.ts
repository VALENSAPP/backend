import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsNumber, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { Request } from 'express';
import { PayoutsService } from './payouts.service';
import { StripeConnectService } from './stripe-connect.service';

export class UpdatePayoutSettingsDto {
    @ApiPropertyOptional({ description: 'Turn automatic payouts on/off', example: true })
    @IsOptional()
    @IsBoolean()
    autoPayoutEnabled?: boolean;

    @ApiPropertyOptional({ description: 'Days between automatic payouts', enum: [1, 7, 14, 30], example: 7 })
    @IsOptional()
    @Type(() => Number)
    @IsIn([1, 7, 14, 30])
    intervalDays?: number;

    @ApiPropertyOptional({ description: 'Only pay out when the available balance is at least this amount (wallet currency)', example: 20 })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    @Min(0)
    minimumAmount?: number;
}

/**
 * Endpoints for the new payout screens (Wallet, Earnings, Transactions, Payout Method,
 * Transfer to Bank, Funds on the way). Values come pre-formatted for display.
 * Existing endpoints (/billing/balance, /billing/request-withdrawal, …) are unchanged.
 */
@ApiTags('Payouts')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('billing/payouts')
export class PayoutsController {
    constructor(
        private readonly payoutsService: PayoutsService,
        private readonly stripeConnectService: StripeConnectService,
    ) { }

    @Get('summary')
    @ApiOperation({ summary: 'Wallet screen: balances, total earned/withdrawn, in transit, payout account, recent earnings' })
    async getSummary(@Req() req: Request) {
        return this.payoutsService.getWalletSummary((req.user as any).userId);
    }

    @Get('transactions')
    @ApiOperation({ summary: 'Transactions screen: earnings and payouts, newest first' })
    @ApiQuery({ name: 'filter', required: false, enum: ['all', 'earned', 'withdrawn', 'pending'] })
    @ApiQuery({ name: 'source', required: false, description: 'MARKETPLACE | TIP | MISSION_DONATION | FOLLOWING | FAN_SUBSCRIPTION | EBOOK | SHOP_EBOOK' })
    @ApiQuery({ name: 'page', required: false, type: Number })
    @ApiQuery({ name: 'limit', required: false, type: Number })
    async getTransactions(
        @Req() req: Request,
        @Query('filter') filter?: string,
        @Query('source') source?: string,
        @Query('page') page?: string,
        @Query('limit') limit?: string,
    ) {
        return this.payoutsService.getLedgerFeed((req.user as any).userId, {
            filter,
            source,
            page: page ? Number(page) : undefined,
            limit: limit ? Number(limit) : undefined,
        });
    }

    @Get('quote')
    @ApiOperation({ summary: 'Transfer to Bank screen: fee, you will receive, estimated bank amount, arrival, minimum' })
    @ApiQuery({ name: 'amount', required: false, type: Number, description: 'Amount in wallet currency; defaults to the full available balance (Max)' })
    async getQuote(@Req() req: Request, @Query('amount') amount?: string) {
        return this.payoutsService.getWithdrawalQuote(
            (req.user as any).userId,
            amount !== undefined && amount !== '' ? Number(amount) : undefined,
        );
    }

    @Get('withdrawals/:id')
    @ApiOperation({ summary: 'Funds on the way screen: withdrawal status timeline' })
    async getWithdrawal(@Req() req: Request, @Param('id') id: string) {
        return this.payoutsService.getWithdrawalDetail((req.user as any).userId, id);
    }

    @Get('settings')
    @ApiOperation({ summary: 'Payout Method screen: automatic payout settings' })
    async getSettings(@Req() req: Request) {
        return this.payoutsService.getPayoutSettings((req.user as any).userId);
    }

    @Put('settings')
    @ApiOperation({ summary: 'Update automatic payout settings' })
    async updateSettings(@Req() req: Request, @Body() dto: UpdatePayoutSettingsDto) {
        return this.payoutsService.updatePayoutSettings((req.user as any).userId, dto);
    }

    @Post('dashboard-link')
    @ApiOperation({ summary: 'Link to the Stripe Express dashboard (change bank account, see payouts)' })
    async getDashboardLink(@Req() req: Request) {
        return this.stripeConnectService.createDashboardLink((req.user as any).userId);
    }

    @Get('tip-estimate')
    @ApiOperation({ summary: 'Optional: estimate what the receiver gets for a tip (Stripe rate, 0% fee)' })
    @ApiQuery({ name: 'receiverId', required: true })
    @ApiQuery({ name: 'amount', required: true, type: Number })
    async getTipEstimate(@Req() req: Request, @Query('receiverId') receiverId: string, @Query('amount') amount: string) {
        return this.payoutsService.estimateTipReceived((req.user as any).userId, receiverId, Number(amount));
    }
}
