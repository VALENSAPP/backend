import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class CheckUserNameDto {
  @ApiPropertyOptional({
    description: 'Username to check for availability (camelCase)',
    example: 'john_doe',
  })
  @IsOptional()
  @IsString()
  userName?: string;

  @ApiPropertyOptional({
    description: 'Username to check for availability (lowercase alias)',
    example: 'john_doe',
  })
  @IsOptional()
  @IsString()
  username?: string;

  @ApiPropertyOptional({
    description: 'Optional User ID to exclude (useful when editing own profile so current username is not marked as taken)',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({
    description: 'Optional email to check if username belongs to the same unverified user for re-registration',
    example: 'user@example.com',
  })
  @IsOptional()
  @IsString()
  email?: string;
}
