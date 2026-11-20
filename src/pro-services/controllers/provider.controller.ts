import { Body, Controller, Get, Patch, Post, Req, UseGuards, ValidationPipe } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { ActivateProviderDto, UpdateProviderDto } from '../dto/provider.dto';
import { getUserId } from '../pro-services.utils';
import { ProviderService } from '../services/provider.service';

const bodyPipe = new ValidationPipe({ whitelist: true, transform: true });

@ApiTags('pro-services: provider')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('pro-services/provider')
export class ProviderController {
    constructor(private readonly providerService: ProviderService) { }

    @Get('eligibility')
    @ApiOperation({
        summary: 'P1/P2/P18 - Can I sell services? (membership, KYC, payout account, activated)',
        description: 'upgradeRequired=true -> show the Valens Membership pop-up. missing[] lists what is left.',
    })
    getEligibility(@Req() req: Request) {
        return this.providerService.getEligibility(getUserId(req));
    }

    @Post('activate')
    @ApiOperation({ summary: 'P3 - Activate Services (needs an active Valens Membership)' })
    activate(@Req() req: Request, @Body(bodyPipe) dto: ActivateProviderDto) {
        return this.providerService.activate(getUserId(req), dto);
    }

    @Get('me')
    @ApiOperation({ summary: 'My Services provider profile (headline, about, time zone, rating)' })
    getMe(@Req() req: Request) {
        return this.providerService.getMyProfile(getUserId(req));
    }

    @Patch('me')
    @ApiOperation({ summary: 'Update my Services provider profile' })
    updateMe(@Req() req: Request, @Body(bodyPipe) dto: UpdateProviderDto) {
        return this.providerService.updateMyProfile(getUserId(req), dto);
    }
}
