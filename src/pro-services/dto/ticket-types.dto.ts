import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsBoolean,
    IsDateString,
    IsInt,
    IsNumber,
    IsOptional,
    IsString,
    IsUUID,
    Max,
    MaxLength,
    Min,
    MinLength,
    ValidateNested,
} from 'class-validator';
import { LIMITS } from '../pro-services.constants';

export class TicketTypeInputDto {
    @ApiPropertyOptional({ description: 'Existing ticket type id; omit to create a new one' })
    @IsOptional()
    @IsUUID()
    id?: string;

    @ApiProperty({ example: 'General Admission' })
    @IsString()
    @MinLength(1)
    @MaxLength(80)
    name!: string;

    @ApiPropertyOptional({ example: 'Access to all sessions' })
    @IsOptional()
    @IsString()
    @MaxLength(300)
    description?: string;

    @ApiProperty({ example: 49, description: 'Price in major units; 0 = free' })
    @Type(() => Number)
    @IsNumber({ maxDecimalPlaces: 2 })
    @Min(0)
    @Max(LIMITS.maxPriceMinor / 100)
    price!: number;

    @ApiProperty({ example: 500 })
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(100000)
    quantity!: number;

    @ApiPropertyOptional({ example: true })
    @IsOptional()
    @IsBoolean()
    isActive?: boolean;
}

export class SetTicketTypesDto {
    @ApiProperty({ type: [TicketTypeInputDto] })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(LIMITS.ticketTypesMax)
    @ValidateNested({ each: true })
    @Type(() => TicketTypeInputDto)
    ticketTypes!: TicketTypeInputDto[];
}

export class CohortInputDto {
    @ApiPropertyOptional({ description: 'Existing cohort id; omit to create a new one' })
    @IsOptional()
    @IsUUID()
    id?: string;

    @ApiProperty({ example: '2027-01-27T15:00:00.000Z', description: 'First session date and time' })
    @IsDateString()
    startAt!: string;

    @ApiProperty({ example: 10, description: 'Seats in this cohort' })
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(500)
    seats!: number;

    @ApiPropertyOptional({ example: true })
    @IsOptional()
    @IsBoolean()
    isActive?: boolean;
}

export class SetCohortsDto {
    @ApiProperty({ type: [CohortInputDto] })
    @IsArray()
    @ArrayMaxSize(LIMITS.cohortsMax)
    @ValidateNested({ each: true })
    @Type(() => CohortInputDto)
    cohorts!: CohortInputDto[];
}
