import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

export class SubscribeDto {
  @ApiPropertyOptional({
    description: 'Subscription billing interval',
    enum: ['monthly', 'yearly'],
    default: 'monthly',
    example: 'yearly',
  })
  @IsOptional()
  @IsString()
  @IsIn(['monthly', 'yearly'])
  interval?: 'monthly' | 'yearly' = 'monthly';
}

