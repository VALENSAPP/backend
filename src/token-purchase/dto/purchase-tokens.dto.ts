import { IsNumber, IsOptional, IsString, IsUUID, Min, IsNotEmpty, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PurchaseTokensDto {
  @ApiProperty({
    description: 'Type of purchase',
    example: 'token_purchase',
    enum: ['token_purchase', 'donation']
  })
  @IsString()
  @IsIn(['token_purchase', 'donation'])
  type: string;

  @ApiProperty({
    description: 'Amount in USD to spend on tokens or donate',
    example: 10.00,
    minimum: 0.01
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount: number;

  @ApiProperty({
    description: 'Platform fee provided by frontend (required for token_purchase)',
    example: 0.02,
    minimum: 0,
    required: false
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  platformFee?: number;

  @ApiProperty({
    description: 'Vendor fee provided by frontend (required for token_purchase)',
    example: 0.05,
    minimum: 0,
    required: false
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  vendorFee?: number;

  @ApiProperty({
    description: 'Amount after deducting fees provided by frontend (required for token_purchase)',
    example: 9.93,
    minimum: 0,
    required: false
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  restAmount?: number;

  @ApiProperty({
    description: 'Tokens to be received provided by frontend (required for token_purchase)',
    example: 993,
    minimum: 0,
    required: false
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tokensReceived?: number;

  @ApiProperty({
    description: 'Token price at the time of purchase',
    example: 0.01,
    minimum: 0
  })
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  purchaseTokenPrice: number;

  @ApiProperty({
    description: 'Vendor user ID (whose tokens are being purchased). Optional - if not provided, platform tokens.',
    example: '123e4567-e89b-12d3-a456-426614174000',
    required: false
  })
  @IsOptional()
  @IsUUID()
  vendorId?: string;

  @ApiProperty({
    description: 'Post ID for which the donation is made (required for donations)',
    example: '123e4567-e89b-12d3-a456-426614174000',
    required: false
  })
  @IsOptional()
  @IsUUID()
  postId?: string;
}

export class BuyTokenDto {
  @ApiProperty({
    description: 'User ID whose token is being purchased',
    example: '123e4567-e89b-12d3-a456-426614174000'
  })
  @IsUUID()
  userId: string;

  @ApiProperty({
    description: 'Amount of tokens to purchase (in USD)',
    example: 10.00,
    minimum: 0.01
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  userPaid: number;
}

export class GetTokenPriceDto {
  @ApiProperty({
    description: 'Token contract address to get price for',
    example: '0x1234567890123456789012345678901234567890'
  })
  @IsString()
  @IsNotEmpty()
  tokenAddress: string;
}

export class SellTokenDto {
  @ApiProperty({
    description: 'Token contract address to sell',
    example: '0x1234567890123456789012345678901234567890'
  })
  @IsString()
  @IsNotEmpty()
  tokenAddress: string;

  @ApiProperty({
    description: 'Amount of tokens to sell (in wei, e.g., 100 tokens = 100000000000000000000)',
    example: '100000000000000000000'
  })
  @IsString()
  @IsNotEmpty()
  amountTokens: string;
}

export class GetVendorTokenAmountDto {
  @ApiProperty({
    description: 'Vendor user ID whose tokens were purchased by the authenticated user',
    example: '123e4567-e89b-12d3-a456-426614174000'
  })
  @IsUUID()
  @IsNotEmpty()
  vendorId: string;
}

export class TokenPurchaseResponseDto {
  @ApiProperty({
    description: 'Purchase ID',
    example: '123e4567-e89b-12d3-a456-426614174000'
  })
  id: string;

  @ApiProperty({
    description: 'Original payment amount',
    example: 10.00
  })
  amount: number;

  @ApiProperty({
    description: 'Platform fee (0.2%)',
    example: 0.02
  })
  platformFee: number;

  @ApiProperty({
    description: 'Vendor fee (0.5%)',
    example: 0.05
  })
  vendorFee: number;

  @ApiProperty({
    description: 'Amount after fees',
    example: 9.33
  })
  restAmount: number;

  @ApiProperty({
    description: 'Tokens to be received (restAmount * 100)',
    example: 933
  })
  tokensReceived: number;

  @ApiProperty({
    description: 'Token price at the time of purchase',
    example: 0.01
  })
  purchaseTokenPrice: number;

  @ApiProperty({
    description: 'Payment status',
    example: 'pending'
  })
  status: string;

  @ApiProperty({
    description: 'Stripe checkout session URL for payment',
    example: 'https://checkout.stripe.com/pay/cs_test_...'
  })
  sessionUrl?: string;
}

export class GetTokenHistoryDto {
  @ApiProperty({
    description: 'Token contract address to filter history by. Optional.',
    example: '0x1234567890123456789012345678901234567890',
    required: false
  })
  @IsOptional()
  @IsString()
  tokenAddress?: string;

  @ApiProperty({
    description: 'Time period to filter history: week (last 7 days), month (last 30 days), year (last 365 days). Optional - if not provided, returns all history.',
    example: 'week',
    enum: ['week', 'month', 'year'],
    required: false
  })
  @IsOptional()
  @IsIn(['week', 'month', 'year'])
  period?: 'week' | 'month' | 'year';
}

export class GetPostDonationTotalDto {
  @ApiProperty({
    description: 'Post ID to get total donation amount for',
    example: '123e4567-e89b-12d3-a456-426614174000'
  })
  @IsUUID()
  postId: string;
}

export class MissionDonationDto {
  @ApiProperty({
    description: 'Donation amount in USD',
    example: 10.0,
    minimum: 0.01
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount: number;

  @ApiProperty({
    description: 'User ID who receives 95% (must have Stripe Connect onboarding complete)',
    example: '123e4567-e89b-12d3-a456-426614174000'
  })
  @IsUUID()
  vendorId: string;

  @ApiProperty({
    description: 'Post ID for which the donation is made',
    example: '123e4567-e89b-12d3-a456-426614174000'
  })
  @IsUUID()
  postId: string;

    @ApiPropertyOptional({ description: 'Note for the donation', example: 'We feel good to help!' })
    @IsOptional()
    @IsString()
    note?: string;
}

export class PostDonationTotalResponseDto {
  @ApiProperty({
    description: 'Total donation amount for the post',
    example: 150.50
  })
  totalDonation: number;
}

export class DonationResponseDto {
  @ApiProperty({
    description: 'Donation ID',
    example: '123e4567-e89b-12d3-a456-426614174000'
  })
  id: string;

  @ApiProperty({
    description: 'Amount received by the vendor after platform fee',
    example: 10.00
  })
  amount: number;

  @ApiProperty({
    description: 'Original donation amount paid by the donor before platform fee',
    example: 10.00
  })
  totalAmount?: number;

  @ApiProperty({
    description: 'Platform fee deducted from the donation',
    example: 0.50
  })
  platformFees?: number;

  @ApiProperty({
    description: 'Currency code (e.g. BRL, USD)',
    example: 'BRL',
    required: false
  })
  currency?: string;

  @ApiProperty({
    description: 'Currency symbol (e.g. R$, $)',
    example: 'R$',
    required: false
  })
  currencySymbol?: string;

  @ApiProperty({
    description: 'Payment status',
    example: 'pending'
  })
  status: string;

  @ApiProperty({
    description: 'Stripe checkout session URL for payment',
    example: 'https://checkout.stripe.com/pay/cs_test_...'
  })
  sessionUrl?: string;

  @ApiProperty({
    description: 'Token price at the time of donation (optional)',
    example: 0.01,
    required: false
  })
  purchaseTokenPrice?: number;
}
