import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ClosetItemCondition } from '@prisma/client';

export class ListPriorityProductsQueryDto {
  @ApiPropertyOptional({
    description: 'Search by product name, category, brand, description, shop name, or username',
    example: 'vintage jacket',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }: { value: any }) => {
    if (value === null || value === undefined) return undefined;
    const normalized = String(value).trim();
    return normalized.length ? normalized : undefined;
  })
  search?: string;

  @ApiPropertyOptional({
    description: 'Filter by product category',
    example: 'Fashion',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(({ value }: { value: any }) => {
    if (value === null || value === undefined) return undefined;
    const normalized = String(value).trim();
    return normalized.length ? normalized : undefined;
  })
  category?: string;

  @ApiPropertyOptional({
    description: 'Filter by item condition',
    enum: ClosetItemCondition,
  })
  @IsOptional()
  @IsEnum(ClosetItemCondition)
  condition?: ClosetItemCondition;

  @ApiPropertyOptional({
    description: 'Minimum price filter',
    example: 10,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minPrice?: number;

  @ApiPropertyOptional({
    description: 'Maximum price filter',
    example: 500,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  maxPrice?: number;

  @ApiPropertyOptional({
    description: 'Page number',
    example: 1,
    default: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Items per page',
    example: 20,
    default: 20,
    maximum: 100,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number = 20;

  @ApiPropertyOptional({
    description: 'Sort field within tiers or general ordering',
    enum: ['priority', 'createdAt', 'price'],
    default: 'priority',
  })
  @IsOptional()
  @IsString()
  sortBy?: 'priority' | 'createdAt' | 'price' = 'priority';

  @ApiPropertyOptional({
    description: 'Sort order',
    enum: ['asc', 'desc'],
    default: 'desc',
  })
  @IsOptional()
  @IsString()
  sortOrder?: 'asc' | 'desc' = 'desc';
}

