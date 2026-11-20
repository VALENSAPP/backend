import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsInt,
    IsOptional,
    IsString,
    Matches,
    Max,
    MaxLength,
    Min,
    ValidateNested,
} from 'class-validator';
import { LIMITS } from '../pro-services.constants';

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class AvailabilityRuleDto {
    @ApiProperty({ example: 1, description: '0 = Sunday ... 6 = Saturday' })
    @Type(() => Number)
    @IsInt()
    @Min(0)
    @Max(6)
    dayOfWeek!: number;

    @ApiProperty({ example: '09:00' })
    @IsString()
    @Matches(CLOCK, { message: 'start must be HH:mm' })
    start!: string;

    @ApiProperty({ example: '12:00', description: '24:00 is not allowed; use 23:59 for end of day' })
    @IsString()
    @Matches(CLOCK, { message: 'end must be HH:mm' })
    end!: string;
}

export class AvailabilityExceptionDto {
    @ApiProperty({ example: '2026-12-25', description: 'Day off, in the service time zone' })
    @IsString()
    @Matches(DATE, { message: 'date must be YYYY-MM-DD' })
    date!: string;

    @ApiPropertyOptional({ example: '13:00', description: 'Leave empty to block the whole day' })
    @IsOptional()
    @IsString()
    @Matches(CLOCK, { message: 'start must be HH:mm' })
    start?: string;

    @ApiPropertyOptional({ example: '15:00' })
    @IsOptional()
    @IsString()
    @Matches(CLOCK, { message: 'end must be HH:mm' })
    end?: string;

    @ApiPropertyOptional({ example: 'Holiday' })
    @IsOptional()
    @IsString()
    @MaxLength(120)
    reason?: string;
}

export class SetAvailabilityDto {
    @ApiPropertyOptional({ example: 'America/New_York', description: 'IANA time zone for these times' })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    timezone?: string;

    @ApiProperty({ type: [AvailabilityRuleDto] })
    @IsArray()
    @ArrayMaxSize(7 * LIMITS.rulesPerDayMax)
    @ValidateNested({ each: true })
    @Type(() => AvailabilityRuleDto)
    rules!: AvailabilityRuleDto[];

    @ApiPropertyOptional({ type: [AvailabilityExceptionDto] })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(LIMITS.exceptionsMax)
    @ValidateNested({ each: true })
    @Type(() => AvailabilityExceptionDto)
    exceptions?: AvailabilityExceptionDto[];
}
