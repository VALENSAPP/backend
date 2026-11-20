import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ProServiceStatus, ProServiceType } from '@prisma/client';

export class PageQueryDto {
    @ApiPropertyOptional({ example: 1, default: 1 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    page?: number = 1;

    @ApiPropertyOptional({ example: 20, default: 20 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(50)
    limit?: number = 20;
}

export const PUBLIC_SORTS = ['popular', 'newest', 'price_asc', 'price_desc', 'rating'] as const;
export type PublicSort = (typeof PUBLIC_SORTS)[number];

export class UserServicesQueryDto extends PageQueryDto {
    @ApiPropertyOptional({ enum: ProServiceType, description: 'Filter chip: Mentorships, Consultations, ...' })
    @IsOptional()
    @IsEnum(ProServiceType)
    type?: ProServiceType;

    @ApiPropertyOptional({ enum: PUBLIC_SORTS, default: 'popular' })
    @IsOptional()
    @IsIn(PUBLIC_SORTS as unknown as string[])
    sort?: PublicSort = 'popular';
}

export class ManageServicesQueryDto extends PageQueryDto {
    @ApiPropertyOptional({ enum: ProServiceType })
    @IsOptional()
    @IsEnum(ProServiceType)
    type?: ProServiceType;

    @ApiPropertyOptional({ enum: ProServiceStatus })
    @IsOptional()
    @IsEnum(ProServiceStatus)
    status?: ProServiceStatus;
}
