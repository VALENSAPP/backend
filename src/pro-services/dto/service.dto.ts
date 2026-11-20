import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsBoolean,
    IsDateString,
    IsEnum,
    IsInt,
    IsNumber,
    IsOptional,
    IsString,
    Max,
    MaxLength,
    Min,
    MinLength,
    ValidateNested,
} from 'class-validator';
import {
    MentorshipMode,
    MentorshipProgramType,
    ProServiceFormat,
    ProServiceType,
    SessionFrequency,
} from '@prisma/client';
import { LIMITS } from '../pro-services.constants';

export class MentorshipDetailsDto {
    @ApiPropertyOptional({ enum: MentorshipProgramType, example: 'LONG_PROGRAM' })
    @IsOptional()
    @IsEnum(MentorshipProgramType)
    programType?: MentorshipProgramType;

    @ApiPropertyOptional({ example: 12, description: 'Program length in weeks (2, 4, 12, 24, 52 or custom)' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(104)
    programLengthWeeks?: number;

    @ApiPropertyOptional({ example: 6, description: 'Number of sessions in the program (1 for a single session)' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(104)
    sessionsCount?: number;

    @ApiPropertyOptional({ enum: SessionFrequency, example: 'BIWEEKLY' })
    @IsOptional()
    @IsEnum(SessionFrequency)
    frequency?: SessionFrequency;

    @ApiPropertyOptional({ enum: MentorshipMode, example: 'GROUP' })
    @IsOptional()
    @IsEnum(MentorshipMode)
    mode?: MentorshipMode;

    @ApiPropertyOptional({ example: 10, description: 'Max people per session (group only; 1 for 1:1)' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(500)
    maxParticipants?: number;

    @ApiPropertyOptional({ example: ['Grow revenue', 'Leadership'] })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(LIMITS.goalsMax)
    @IsString({ each: true })
    @MaxLength(80, { each: true })
    goals?: string[];

    @ApiPropertyOptional({ example: true, description: 'Let clients pick their own start date' })
    @IsOptional()
    @IsBoolean()
    allowCustomStart?: boolean;
}

export class PackageDetailsDto {
    @ApiPropertyOptional({ example: 2, description: 'Sessions each subscriber gets per month' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    @Max(60)
    sessionsPerMonth?: number;

    @ApiPropertyOptional({ example: 25 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(10000)
    maxSubscribers?: number;

    @ApiPropertyOptional({ example: 24, description: 'Book at least this many hours ahead' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    @Max(720)
    minNoticeHours?: number;

    @ApiPropertyOptional({ example: 12, description: 'Cancel up to this many hours before' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    @Max(720)
    cancelNoticeHours?: number;

    @ApiPropertyOptional({ example: 15, description: 'Minutes kept free between sessions' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    @Max(240)
    bufferMinutes?: number;

    @ApiPropertyOptional({ example: true })
    @IsOptional()
    @IsBoolean()
    autoHideUnavailable?: boolean;

    @ApiPropertyOptional({ example: true, description: 'Subscribers join the provider Private Circle' })
    @IsOptional()
    @IsBoolean()
    includesPrivateCircle?: boolean;
}

export class EventDetailsDto {
    @ApiPropertyOptional({ example: '2027-01-27T14:00:00.000Z' })
    @IsOptional()
    @IsDateString()
    startAt?: string;

    @ApiPropertyOptional({ example: '2027-01-27T22:00:00.000Z' })
    @IsOptional()
    @IsDateString()
    endAt?: string;

    @ApiPropertyOptional({ example: 'Faena Forum' })
    @IsOptional()
    @IsString()
    @MaxLength(160)
    venueName?: string;

    @ApiPropertyOptional({ example: '3300 Collins Ave, Miami, FL' })
    @IsOptional()
    @IsString()
    @MaxLength(300)
    venueAddress?: string;

    @ApiPropertyOptional({ example: 18, description: 'Minimum age, shown only' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    @Max(99)
    ageRestriction?: number;

    @ApiPropertyOptional({ example: 'Business casual' })
    @IsOptional()
    @IsString()
    @MaxLength(120)
    dressCode?: string;

    @ApiPropertyOptional({ example: '2026-12-01T00:00:00.000Z' })
    @IsOptional()
    @IsDateString()
    salesStartAt?: string;

    @ApiPropertyOptional({ example: '2027-01-27T12:00:00.000Z' })
    @IsOptional()
    @IsDateString()
    salesEndAt?: string;
}

export class CreateProServiceDto {
    @ApiProperty({ enum: ProServiceType, example: 'MENTORSHIP' })
    @IsEnum(ProServiceType)
    type!: ProServiceType;

    @ApiProperty({ example: 'Business Growth Mentorship', maxLength: LIMITS.titleMax })
    @IsString()
    @MinLength(3)
    @MaxLength(LIMITS.titleMax)
    title!: string;

    @ApiPropertyOptional({ example: 'A structured mentorship to help you grow your business.' })
    @IsOptional()
    @IsString()
    @MaxLength(5000)
    description?: string;

    @ApiPropertyOptional({ example: ['6 live mentorship sessions', 'Personalized business strategy'] })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(LIMITS.includedItemsMax)
    @IsString({ each: true })
    @MaxLength(160, { each: true })
    includedItems?: string[];

    @ApiPropertyOptional({ example: 'Hair', description: 'Appointment or event category' })
    @IsOptional()
    @IsString()
    @MaxLength(60)
    category?: string;

    @ApiPropertyOptional({ enum: ProServiceFormat, example: 'ONLINE' })
    @IsOptional()
    @IsEnum(ProServiceFormat)
    format?: ProServiceFormat;

    @ApiPropertyOptional({ example: 60, description: 'Length of one session in minutes' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(5)
    @Max(600)
    durationMinutes?: number;

    @ApiPropertyOptional({
        example: 150,
        description: 'Price in major units: per session (mentorship, consultation, appointment) or per month (package). Not used for events.',
    })
    @IsOptional()
    @Type(() => Number)
    @IsNumber({ maxDecimalPlaces: 2 })
    @Min(0)
    @Max(LIMITS.maxPriceMinor / 100)
    price?: number;

    @ApiPropertyOptional({ example: 'America/New_York', description: 'IANA time zone; defaults to the provider time zone' })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    timezone?: string;

    @ApiPropertyOptional({ example: '120 Ocean Dr, Suite 4', description: 'In-person only; shown after payment' })
    @IsOptional()
    @IsString()
    @MaxLength(300)
    address?: string;

    @ApiPropertyOptional({ example: 'Miami' })
    @IsOptional()
    @IsString()
    @MaxLength(120)
    city?: string;

    @ApiPropertyOptional({ example: 'US' })
    @IsOptional()
    @IsString()
    @MaxLength(60)
    country?: string;

    @ApiPropertyOptional({ example: '+1 305 555 0100', description: 'In-person only; shown after payment' })
    @IsOptional()
    @IsString()
    @MaxLength(40)
    contactPhone?: string;

    @ApiPropertyOptional({ type: MentorshipDetailsDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => MentorshipDetailsDto)
    mentorship?: MentorshipDetailsDto;

    @ApiPropertyOptional({ type: PackageDetailsDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => PackageDetailsDto)
    package?: PackageDetailsDto;

    @ApiPropertyOptional({ type: EventDetailsDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => EventDetailsDto)
    event?: EventDetailsDto;
}

/** Every wizard step sends only the fields it changes. The type can't change after creation. */
export class UpdateProServiceDto extends PartialType(OmitType(CreateProServiceDto, ['type'] as const)) { }
