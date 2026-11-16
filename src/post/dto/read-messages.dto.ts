import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { Transform } from 'class-transformer';
import { ChatConversationType } from './delete-conversation.dto';

export class ReadMessagesDto {
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

  @ApiPropertyOptional({
    description:
      'The conversation ID (chatBox id/chatId for NORMAL, thread id for CLOSET). If omitted, all unread messages of this type for the authenticated user will be marked as read.',
    example: 'd9b2b62b-98f2-45e0-949f-b31a38a7cfa1',
  })
  @IsString()
  @IsOptional()
  conversationId?: string;

  @ApiPropertyOptional({
    description: 'Alternative alias for conversationId (chatId for NORMAL or threadId for CLOSET)',
    example: 'd9b2b62b-98f2-45e0-949f-b31a38a7cfa1',
  })
  @IsString()
  @IsOptional()
  chatId?: string;
}
