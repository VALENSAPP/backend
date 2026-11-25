import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

export class SlotsQueryDto {
    @ApiPropertyOptional({ example: '2026-12-01', description: 'First local date (service time zone). Defaults to today.' })
    @IsOptional()
    @IsString()
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' })
    from?: string;

    @ApiPropertyOptional({ example: 14, default: 14, description: 'How many days to return (max 60)' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(60)
    days?: number;
}

export class CreateBookingDto {
    @ApiPropertyOptional({
        example: '2026-12-02T15:00:00.000Z',
        description: 'Chosen slot startAt from the slots API (1:1 services). Leave out when booking a cohort.',
    })
    @IsOptional()
    @IsDateString()
    startAt?: string;

    @ApiPropertyOptional({ description: 'Chosen cohort id (group or cohort-based mentorships)' })
    @IsOptional()
    @IsUUID()
    cohortId?: string;

    @ApiPropertyOptional({ example: 'I want to focus on pricing strategy.', maxLength: 500 })
    @IsOptional()
    @IsString()
    @MaxLength(500)
    note?: string;
}

export const PAY_METHODS = ['CARD', 'WALLET'] as const;
export type PayMethod = (typeof PAY_METHODS)[number];

export class PayBookingDto {
    @ApiProperty({ enum: PAY_METHODS, example: 'CARD', description: 'CARD = Stripe checkout; WALLET = available earnings' })
    @IsIn(PAY_METHODS as unknown as string[])
    method!: PayMethod;
}
