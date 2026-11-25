import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ClosetItemCondition } from '@prisma/client';

export const PRIORITY_PRODUCT_SORT_FIELDS = ['priority', 'createdAt', 'price', 'boostedAt', 'promotedAt'] as const;
export type PriorityProductSortField = (typeof PRIORITY_PRODUCT_SORT_FIELDS)[number];

export const PRIORITY_PRODUCT_SORT_ORDERS = ['asc', 'desc'] as const;
export type PriorityProductSortOrder = (typeof PRIORITY_PRODUCT_SORT_ORDERS)[number];

const isEmpty = (value: any) =>
  value === null || value === undefined || (typeof value === 'string' && value.trim() === '');

const trimToUndefined = ({ value }: { value: any }) => {
  if (isEmpty(value)) return undefined;
  return String(value).trim();
};

// '' -> undefined (no filter), otherwise a number (NaN fails @IsNumber)
const toOptionalNumber = ({ value }: { value: any }) => {
  if (isEmpty(value)) return undefined;
  return Number(value);
};

// Case-insensitive match against a list of allowed values; unknown values are returned as-is so validation rejects them
const matchAllowed =
  (allowed: readonly string[]) =>
  ({ value }: { value: any }) => {
    if (isEmpty(value)) return undefined;
    const normalized = String(value).trim().toLowerCase();
    return allowed.find((option) => option.toLowerCase() === normalized) ?? String(value).trim();
  };

// Accepts 'new', 'NEW', 'good condition', 'Good-Condition', 'good_condition' ...
const toCondition = ({ value }: { value: any }) => {
  if (isEmpty(value)) return undefined;
  const normalized = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  const match = (Object.values(ClosetItemCondition) as string[]).find(
    (option) => option.toLowerCase() === normalized,
  );
  return match ?? String(value).trim();
};

export class ListPriorityProductsQueryDto {
  @ApiPropertyOptional({
    description:
      'Search words. Every word must match at least one of: product name, brand, category, description, shop name, shop username, seller username or seller display name',
    example: 'vintage jacket',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(trimToUndefined)
  search?: string;

  @ApiPropertyOptional({
    description: 'Filter by product category (case-insensitive, matches categories starting with this text)',
    example: 'Fashion',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(trimToUndefined)
  category?: string;

  @ApiPropertyOptional({
    description: 'Filter by item condition (case-insensitive; spaces or underscores allowed)',
    enum: ClosetItemCondition,
  })
  @IsOptional()
  @Transform(toCondition)
  @IsEnum(ClosetItemCondition)
  condition?: ClosetItemCondition;

  @ApiPropertyOptional({
    description: 'Minimum price, applied to the price shown to the user (after any active discount)',
    example: 10,
  })
  @IsOptional()
  @Transform(toOptionalNumber)
  @IsNumber()
  @Min(0)
  minPrice?: number;

  @ApiPropertyOptional({
    description: 'Maximum price, applied to the price shown to the user (after any active discount)',
    example: 500,
  })
  @IsOptional()
  @Transform(toOptionalNumber)
  @IsNumber()
  @Min(0)
  maxPrice?: number;

  @ApiPropertyOptional({
    description: 'Page number',
    example: 1,
    default: 1,
  })
  @Transform(toOptionalNumber)
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
  @Transform(toOptionalNumber)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number = 20;

  @ApiPropertyOptional({
    description:
      'priority (default): pinned, then free shipping, then percentage off, then standard items. price / createdAt: the whole list is sorted by that field. boostedAt / promotedAt: boosted or promoted items first, sorted by that date.',
    enum: [...PRIORITY_PRODUCT_SORT_FIELDS],
    default: 'priority',
  })
  @IsOptional()
  @Transform(matchAllowed(PRIORITY_PRODUCT_SORT_FIELDS))
  @IsIn([...PRIORITY_PRODUCT_SORT_FIELDS])
  sortBy?: PriorityProductSortField = 'priority';

  @ApiPropertyOptional({
    description: 'Sort order (case-insensitive)',
    enum: [...PRIORITY_PRODUCT_SORT_ORDERS],
    default: 'desc',
  })
  @IsOptional()
  @Transform(matchAllowed(PRIORITY_PRODUCT_SORT_ORDERS))
  @IsIn([...PRIORITY_PRODUCT_SORT_ORDERS])
  sortOrder?: PriorityProductSortOrder = 'desc';
}
