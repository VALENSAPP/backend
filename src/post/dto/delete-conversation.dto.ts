import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsString } from 'class-validator';
import { Transform } from 'class-transformer';

export enum ChatConversationType {
  NORMAL = 'NORMAL',
  CLOSET = 'CLOSET',
}

export class DeleteConversationDto {
  @ApiProperty({
    description: 'The conversation ID (chatBox id for NORMAL, thread id for CLOSET)',
    example: 'd9b2b62b-98f2-45e0-949f-b31a38a7cfa1',
  })
  @IsString()
  @IsNotEmpty()
  conversationId: string;

  @ApiProperty({
    description: 'The type of conversation: NORMAL or CLOSET',
    enum: ChatConversationType,
    example: 'NORMAL',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase().trim() : value))
  @IsEnum(ChatConversationType, {
    message: 'type must be either NORMAL or CLOSET',
  })
  @IsNotEmpty()
  type: ChatConversationType;
}

