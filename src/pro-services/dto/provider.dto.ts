import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ActivateProviderDto {
    @ApiPropertyOptional({ example: 'CEO | Mentor | Business Consultant', maxLength: 160 })
    @IsOptional()
    @IsString()
    @MaxLength(160)
    headline?: string;

    @ApiPropertyOptional({ example: 'I help founders grow their business and personal brand.' })
    @IsOptional()
    @IsString()
    @MaxLength(5000)
    about?: string;

    @ApiPropertyOptional({ example: 'America/New_York', description: 'IANA time zone. Defaults to UTC.' })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    timezone?: string;
}

export class UpdateProviderDto extends PartialType(ActivateProviderDto) { }
