import { Controller, Post, Get, Body, Req, UseGuards, HttpStatus, Query, Headers } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiBody, ApiHeader } from '@nestjs/swagger';
import { TokenPurchaseService } from './token-purchase.service';
import { PurchaseTokensDto, TokenPurchaseResponseDto, BuyTokenDto, GetTokenPriceDto, SellTokenDto, GetVendorTokenAmountDto, GetTokenHistoryDto, GetPostDonationTotalDto, PostDonationTotalResponseDto, DonationResponseDto, MissionDonationDto } from './dto/purchase-tokens.dto';
import { TokenService } from '../token/token.service';
import { AuthGuard } from '@nestjs/passport';
import { KycGuard } from '../common/guards/kyc.guard';
import { Request } from 'express';

/** Token purchase/sale/balance endpoints disabled per Valens requirements. Donation (Stripe) remains. */
@ApiTags('token-purchase')
@Controller('token-purchase')
export class TokenPurchaseController {
  constructor(
    private readonly tokenPurchaseService: TokenPurchaseService,
    private readonly tokenService: TokenService
  ) { }

  @Get('getTotaltoken')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get total token amount and price for authenticated user',
    description: 'Returns token price from contract, total tokens received from purchases, and total token amount (price * amount)'
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Total token data retrieved successfully ',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tokenAddress: { type: 'string', example: '0x123...' },
          tokenAmount: { type: 'number', example: 1500 },
          tokenPrice: { type: 'number', example: 0.001 },
          totalTokenAmount: { type: 'number', example: 1.5 },
          vendorName: { type: 'string', example: 'john_doe' },
          vendorId: { type: 'string', example: 'user123' }
        }
      }
    }
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Unauthorized - Invalid JWT token'
  })
  async getTotaltoken(@Req() req: Request) {
    const userId = (req.user as any).userId;
    return this.tokenPurchaseService.getTotalTokenData(userId);
  }

  @Post('purchase')
  @UseGuards(AuthGuard('jwt'), KycGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Purchase tokens with USD payment',
    description: 'Creates a Stripe checkout session for token purchase. Rate: 1 USD = 100 tokens. All fee parameters (platformFee, vendorFee, restAmount, tokensReceived) are provided by the frontend. Returns session URL for payment redirect.'
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Checkout session created successfully',
    type: TokenPurchaseResponseDto
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid request or user not found'
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Unauthorized - Invalid JWT token'
  })
  async purchaseTokens(
    @Body() dto: PurchaseTokensDto,
    @Req() req: Request
  ): Promise<TokenPurchaseResponseDto> {
    const userId = (req.user as any).userId;
    return this.tokenPurchaseService.createTokenPurchase(userId, dto);
  }

  @Get('balance')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get user token balance',
    description: 'Returns the current token balance for the authenticated user'
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Token balance retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        balance: { type: 'number', example: 1500.50 }
      }
    }
  })
  async getTokenBalance(@Req() req: Request) {
    const userId = (req.user as any).userId;
    const balance = await this.tokenPurchaseService.getUserTokenBalance(userId);
    return { balance };
  }

  @Get('history')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get token purchase history',
    description: 'Returns the purchase history for the authenticated user'
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Purchase history retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        purchases: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              amount: { type: 'number' },
              platformFee: { type: 'number' },
              vendorFee: { type: 'number' },
              restAmount: { type: 'number' },
              tokensReceived: { type: 'number' },
              status: { type: 'string' },
              createdAt: { type: 'string', format: 'date-time' },
              completedAt: { type: 'string', format: 'date-time' }
            }
          }
        }
      }
    }
  })
  async getPurchaseHistory(@Req() req: Request) {
    const userId = (req.user as any).userId;
    const purchases = await this.tokenPurchaseService.getUserTokenPurchases(userId);
    return { purchases };
  }

  @Post('buy-token')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Buy tokens using blockchain smart contract',
    description: 'Calls the buyFor method on the smart contract to purchase tokens. Requires userId (whose token to buy) and tokenAmount.'
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Token purchase successful',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        transactionHash: { type: 'string', example: '0x123...' },
        tokenAddress: { type: 'string', example: '0x456...' },
        buyerAddress: { type: 'string', example: '0x789...' },
        tokenAmount: { type: 'number', example: 10.00 },
        blockNumber: { type: 'number', example: 123456 }
      }
    }
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid request or user/token not found'
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Unauthorized - Invalid JWT token'
  })
  async buyToken(
    @Body() dto: BuyTokenDto,
    @Req() req: Request
  ) {
    const buyerUserId = (req.user as any).userId;
    return this.tokenPurchaseService.buyToken(buyerUserId, dto);
  }

  @Post('get-token-price')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get token price in USD',
    description: 'Calls the smart contract to get the current price per token in USD for a given token address'
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Token price retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        tokenAddress: { type: 'string', example: '0x123...' },
        priceInUsd: { type: 'number', example: 0.0001 },
        priceInWei: { type: 'string', example: '100000000000000' }
      }
    }
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid token address or contract error'
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Unauthorized - Invalid JWT token'
  })
  async getTokenPrice(@Body() dto: GetTokenPriceDto) {
    return this.tokenService.getPricePerTokenUsd(dto.tokenAddress);
  }

  @Post('sell-token')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Sell tokens using blockchain smart contract with permit',
    description: 'Calls the sellWithPermit method on the smart contract to sell tokens. Permit signature is generated server-side using user\'s wallet. Requires tokenAddress and amountTokens.'
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Token sale successful',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        transactionHash: { type: 'string', example: '0x123...' },
        tokenAddress: { type: 'string', example: '0x456...' },
        sellerAddress: { type: 'string', example: '0x789...' },
        amountSold: { type: 'number', example: 100.00 },
        remainingTokens: { type: 'number', example: 0.00 },
        blockNumber: { type: 'number', example: 123456 }
      }
    }
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid request or insufficient token balance'
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Unauthorized - Invalid JWT token'
  })
  async sellToken(
    @Body() dto: SellTokenDto,
    @Req() req: Request
  ) {
    const sellerUserId = (req.user as any).userId;
    return this.tokenPurchaseService.sellToken(sellerUserId, dto);
  }

  @Get('token-history')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get user token transaction history',
    description: 'Returns combined history of token purchases and sales with running balance. Optionally filter by token address and/or time period (week/month/year).'
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Token history retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        tokenAddress: { type: 'string', nullable: true, example: '0x123...' },
        period: { type: 'string', nullable: true, example: 'week' },
        totalTransactions: { type: 'number', example: 5 },
        currentBalance: { type: 'number', example: 100.50 },
        history: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              type: { type: 'string', enum: ['purchase', 'sale'] },
              tokenAddress: { type: 'string' },
              tokenName: { type: 'string' },
              vendorId: { type: 'string' },
              amount: { type: 'number', description: 'Positive for purchases, negative for sales' },
              date: { type: 'string', format: 'date-time' },
              transactionHash: { type: 'string', nullable: true },
              balanceAfter: { type: 'number', description: 'Running balance after this transaction' }
            }
          }
        }
      }
    }
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid token address or period'
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Unauthorized - Invalid JWT token'
  })
  async getTokenHistory(@Req() req: Request, @Query() query: GetTokenHistoryDto) {
    const userId = (req.user as any).userId;
    return this.tokenPurchaseService.getUserTokenHistory(userId, query.tokenAddress, query.period);
  }

  @Get('vendor-token-amount')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get total tokens purchased by authenticated user from a specific vendor',
    description: 'Returns the total amount of tokens the authenticated user has purchased from the specified vendor'
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Vendor token amount retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        vendorTokenAmount: { type: 'number', example: 1500.50 }
      }
    }
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid vendor ID or user not found'
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Unauthorized - Invalid JWT token'
  })
  async getVendorTokenAmount(@Req() req: Request, @Query() dto: GetVendorTokenAmountDto) {
    const userId = (req.user as any).userId;
    const vendorTokenAmount = await this.tokenPurchaseService.getVendorTokenAmount(userId, dto.vendorId);
    return { vendorTokenAmount };
  }

  @Get('top-creators')
  @ApiOperation({
    summary: 'Get top creators based on latest token purchases',
    description: 'Returns the latest token purchase details for each vendor with their username'
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Top creators retrieved successfully',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          username: { type: 'string', example: 'john_doe' },
          vendorId: { type: 'string', example: 'user123' },
          purchaseTokenPrice: { type: 'number', example: 0.001 }
        }
      }
    }
  })
  async getTopCreators() {
    return this.tokenPurchaseService.getTopCreators();
  }

  @Post('mission-donation')
  @UseGuards(AuthGuard('jwt'), KycGuard)
  @ApiBearerAuth()
  @ApiBody({ type: MissionDonationDto })
  @ApiOperation({
    summary: 'Create a mission donation session',
    description: 'Creates a Stripe checkout session for mission donation. 5% goes to platform, 95% to vendor (vendorId). Vendor must have Stripe Connect onboarding complete. Returns session URL for payment redirect.'
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Donation session created successfully',
    type: DonationResponseDto
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid request or user not found'
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Unauthorized - Invalid JWT token'
  })
  async createMissionDonation(
    @Body() dto: MissionDonationDto,
    @Req() req: Request
  ): Promise<DonationResponseDto> {
    const userId = (req.user as any).userId;
    return this.tokenPurchaseService.missionPostDonation(userId, dto);
  }

  @Post('mission-donation/external')
  @ApiBody({ type: MissionDonationDto })
  @ApiHeader({
    name: 'x-external-donation-key',
    required: true,
    description: 'External donation API key configured on backend environment',
    schema: { type: 'string' },
  })
  @ApiOperation({
    summary: 'Create an external mission donation session',
    description: 'Creates a Stripe checkout session for mission donation without JWT auth. Requires x-external-donation-key header. Donor is stored as Unknown User.'
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'External donation session created successfully',
    type: DonationResponseDto
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Unauthorized - Invalid or missing external donation key'
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid request, mission post, or vendor configuration'
  })
  async createExternalMissionDonation(
    @Body() dto: MissionDonationDto,
    @Headers('x-external-donation-key') externalDonationKey?: string,
  ): Promise<DonationResponseDto> {
    return this.tokenPurchaseService.externalMissionPostDonation(dto, externalDonationKey);
  }

  @Get('mission-donation/received')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get total received mission donations and latest transactions',
    description: 'Returns total amount (USD), active mission/support post count, and latest completed mission donation transactions for the authenticated user.'
  })
  async getMissionDonationReceived(@Req() req: Request, @Query('page') page?: string) {
    const userId = (req.user as any).userId;
    const pageNum = Math.max(1, parseInt(page || '1', 10) || 1);
    return this.tokenPurchaseService.getMissionDonationReceivedSummary(userId, pageNum, 10);
  }

  @Post('post-donation-total')
  @ApiOperation({
    summary: 'Get total donation amount for a post',
    description: 'Returns the total amount of donations received for a specific post'
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Total donation amount retrieved successfully',
    type: PostDonationTotalResponseDto
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid post ID'
  })
  async getPostDonationTotal(@Body() dto: GetPostDonationTotalDto): Promise<PostDonationTotalResponseDto> {
    return this.tokenPurchaseService.getPostDonationTotal(dto.postId);
  }
}
