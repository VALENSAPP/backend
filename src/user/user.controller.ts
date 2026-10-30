import { Body, Controller, Post, Patch, Get, Param, Delete, UseInterceptors, UploadedFile, Req, UseGuards, Query, ParseUUIDPipe, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { UserService } from './user.service';
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsEnum, IsOptional, IsNotEmpty, IsEmail, IsInt, IsUUID } from 'class-validator';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiBody, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { Request } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { AdminAuthGuard } from '../common/guards/admin-auth.guard';
import { FollowPersonDto, UnfollowDto, BlockUserDto, UnblockUserDto } from './dto/follow.dto';
import { RecentActivitiesDto } from './dto/recent-activities.dto';
import { AddSearchHistoryDto, GetSearchHistoryDto } from './dto/search-history.dto';
import { CreateUserSubscriptionDto, UpdateUserSubscriptionDto, UserSubscriptionStatus } from './dto/user-subscription.dto';
import { SendPlatformPointsDto, GetPointTransfersDto } from './dto/send-points.dto';
import { GetPriceUpdateSubscribersQueryDto } from './dto/get-price-update-subscribers.dto';
import { CheckUserNameDto } from './dto/check-username.dto';

export enum RegistrationType {
  NORMAL = 'NORMAL',
  GOOGLE = 'GOOGLE',
  TWITTER = 'TWITTER',
  WALLET = 'WALLET',
}

export enum Gender {
  MALE = 'MALE',
  FEMALE = 'FEMALE',
  OTHER = 'OTHER',
}

export class RegisterDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  userName?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  profile?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  password?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  googleId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  appleId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  twitterId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  walletAddress?: string;

  @ApiProperty({ required: false, description: 'Client-reported location (e.g., city/country or lat,lng)' })
  @IsOptional()
  @IsString()
  location?: string;

  @ApiProperty({
    required: false,
    description: 'User origin country code or name (e.g. BR, Brazil). Brazil → PagBank; others → Stripe.',
    example: 'BR',
  })
  @IsOptional()
  @IsString()
  country?: string;

  @ApiProperty({ enum: RegistrationType, required: true })
  @IsEnum(RegistrationType)
  @IsNotEmpty()
  registrationType: RegistrationType;

  @ApiProperty({ required: false, description: 'Referral code of the user who referred this new user' })
  @IsOptional()
  @IsString()
  referrerCode?: string;

  @ApiProperty({ required: false, description: 'Device identifier from client (stable per device if possible)' })
  @IsOptional()
  @IsString()
  deviceId?: string;

  @ApiProperty({ required: false, description: 'Friendly device name (e.g., iPhone 15, Pixel 8)' })
  @IsOptional()
  @IsString()
  deviceName?: string;

  @ApiProperty({ required: false, description: 'Device type (e.g., ios, android, web)' })
  @IsOptional()
  @IsString()
  deviceType?: string;

  // location already defined above
}

export class LoginDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  password?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  googleId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  twitterId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  walletAddress?: string;

  @ApiProperty({ enum: RegistrationType, required: true })
  @IsEnum(RegistrationType)
  @IsNotEmpty()
  registrationType: RegistrationType;
}

export class ProfileEditDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  userName?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  displayName?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  bio?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  walletAddress?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  website_link?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @ApiProperty({
    enum: Gender,
    required: false,
    description: 'Must be MALE, FEMALE, or OTHER'
  })
  @IsOptional()
  @IsEnum(Gender, { message: 'Gender must be MALE, FEMALE, or OTHER' })
  gender?: Gender;

  @ApiProperty({ required: false, type: 'string', format: 'binary' })
  @IsOptional()
  image?: any; // File upload

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  age?: number;

  @ApiProperty({
    required: false,
    description: 'Array of social media links. In multipart/form-data can be sent as JSON string, e.g. [{"platform":"twitter","url":"..."}] or ["url1","url2"]',
    isArray: true,
  })
  @IsOptional()
  social_media_links?: string | Record<string, unknown>[];
}

export class ForgotPasswordDto {
  @ApiProperty()
  @IsEmail()
  email: string;
}

export class VerifyOtpDto {
  @ApiProperty()
  @IsEmail()
  email: string;

  @ApiProperty()
  @IsString()
  otp: string;
}

export class SendEmailOtpDto {
  @ApiProperty()
  @IsEmail()
  email: string;
}

export class VerifyEmailOtpDto {
  @ApiProperty()
  @IsEmail()
  email: string;

  @ApiProperty()
  @IsString()
  otp: string;
}

export class ResetPasswordDto {
  @ApiProperty()
  @IsEmail()
  email: string;

  @ApiProperty()
  @IsString()
  newPassword: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  oldPassword: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  newPassword: string;
}

export class UpdateWalletAddressDto {
  @ApiProperty({ description: 'Wallet address to set for the authenticated user' })
  @IsString()
  @IsNotEmpty()
  walletAddress: string;
}

export class CheckDisplayNameDto {
  @ApiProperty({
    description: 'Display name to check for availability',
    example: 'john_doe'
  })
  @IsString()
  @IsNotEmpty()
  displayName: string;
}

export class GetProfileDto {
  @ApiProperty({
    description: 'User ID to get profile for',
    required: true,
    example: '123e4567-e89b-12d3-a456-426614174000'
  })
  @IsUUID()
  @IsNotEmpty()
  userId: string;
}

export class GetUserDashboardDto {
  @ApiProperty({
    description: 'User ID to get dashboard data for',
    required: true,
    example: '123e4567-e89b-12d3-a456-426614174000'
  })
  @IsUUID()
  @IsNotEmpty()
  userId: string;
}


export class GetAllUsersDto {
  @ApiProperty({
    description: 'Search by email',
    required: false,
    example: 'user@example.com'
  })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiProperty({
    description: 'Search by userName',
    required: false,
    example: 'john_doe'
  })
  @IsOptional()
  @IsString()
  userName?: string;

  @ApiProperty({
    description: 'Search by googleId',
    required: false,
    example: '123456789'
  })
  @IsOptional()
  @IsString()
  googleId?: string;

  @ApiProperty({
    description: 'Search by twitterId',
    required: false,
    example: '123456789'
  })
  @IsOptional()
  @IsString()
  twitterId?: string;

  @ApiProperty({
    description: 'Search by phoneNumber',
    required: false,
    example: '+1234567890'
  })
  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @ApiProperty({
    description: 'Search by displayName',
    required: false,
    example: 'user1'
  })
  @IsOptional()
  @IsString()
  displayName?: string;

  @ApiProperty({
    description: 'Filter by blocked status (true or false)',
    required: false,
    example: false,
  })
  @IsOptional()
  isBlocked?: boolean | string;
}

export class ProfileStatusSetDto {
  @ApiProperty({
    description: 'Profile status to set',
    required: true,
    example: 'public'
  })
  @IsString()
  @IsNotEmpty()
  profileStatus: string;
}

export class ReactivateAccountDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  googleId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  twitterId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  appleId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  walletAddress?: string;

  @ApiProperty({ enum: RegistrationType, required: true })
  @IsEnum(RegistrationType)
  @IsNotEmpty()
  registrationType: RegistrationType;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  fcmToken?: string;
}

export class DeviceLanguageUpdateDto {
  @ApiProperty({ required: true, description: 'Unique device identifier', example: 'd3b07384d113edec49eaa6238ad5ff00' })
  @IsString()
  @IsNotEmpty()
  deviceId: string;

  @ApiProperty({ required: true, description: 'Language code (e.g. en, pt, es, fr, de, zh, etc.)', example: 'en' })
  @IsString()
  @IsNotEmpty()
  language: string;
}

@ApiTags('user')
@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) { }

  @Post('register')
  async register(@Body() dto: RegisterDto) {
    const result = await this.userService.register(dto);

    // Handle Firebase Google registration response format
    if ('error' in result) {
      return result;
    }

    // Handle normal registration response format
    return result;
  }

  @Get('profile')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get user profile by userId' })
  @ApiQuery({ name: 'userId', type: 'string', description: 'User ID to get profile for' })
  async getProfile(@Req() req: Request, @Query() query: GetProfileDto) {
    const viewerId = (req.user as any).userId;
    const user = await this.userService.getUserById(query.userId);
    const isFollow = await this.userService.isFollowing(viewerId, query.userId);
    return { ...user, isFollow };
  }

  @Patch('editProfile')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Edit user profile',
    description: 'Update user profile fields. All fields are optional. If wallet address already exists, it cannot be updated (contact admin).'
  })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('image'))
  async editProfile(
    @Req() req: Request,
    @Body() dto: ProfileEditDto,
    @UploadedFile() image: Express.Multer.File,
  ) {
    const userId = (req.user as any).userId;
    // console.log("LLLLLLLLLLLLLLLLLLLL", req.user, userId);

    const user = await this.userService.editProfile(userId, dto, image);
    return { message: 'Profile updated' };
  }

  @Patch('first-log/after-kyc')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update first_log after KYC',
    description: 'If kyc=true and first_log=true, set first_log=false. Otherwise no-op.',
  })
  async updateFirstLogAfterKyc(@Req() req: Request) {
    const userId = (req.user as any).userId;
    return this.userService.updateFirstLogAfterKyc(userId);
  }

  @Get('profileLock')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get profile lock status based on KYC and last KYC attempt age',
  })
  async getProfileLock(@Req() req: Request) {
    const userId = (req.user as any).userId;
    return this.userService.getProfileLockStatus(userId);
  }

  @Post('forgot-password')
  @ApiOperation({ summary: 'Send OTP to email for password reset' })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.userService.forgotPassword(dto.email);
    return { message: 'OTP sent to email' };
  }

  @Post('verify-otp')
  @ApiOperation({ summary: 'Verify OTP for password reset' })
  async verifyOtp(@Body() dto: VerifyOtpDto) {
    await this.userService.verifyOtp(dto.email, dto.otp);
    return { message: 'OTP verified' };
  }

  @Post('send-email-otp')
  @ApiOperation({ summary: 'Send OTP to email for email verification' })
  async sendEmailOtp(@Body() dto: SendEmailOtpDto) {
    await this.userService.sendEmailOtp(dto.email.toLowerCase());
    return { message: 'OTP sent to email' };
  }

  @Post('verify-email-otp')
  @ApiOperation({ summary: 'Verify OTP for email verification' })
  async verifyEmailOtp(@Body() dto: VerifyEmailOtpDto) {
    await this.userService.verifyEmailOtp(dto.email, dto.otp);
    return { message: 'Email verified' };
  }

  @Post('reset-password')
  @ApiOperation({ summary: 'Reset password after OTP verification' })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.userService.resetPassword(dto.email, dto.newPassword);
    return { message: 'Password reset successful' };
  }

  @Post('change-password')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change password for authenticated user' })
  async changePassword(@Req() req: Request, @Body() dto: ChangePasswordDto) {
    const userId = (req.user as any).userId;
    await this.userService.changePassword(userId, dto.oldPassword, dto.newPassword);
    return { message: 'Password changed successfully' };
  }

  @Post('follow')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiBody({ type: FollowPersonDto })
  @ApiOperation({
    summary: 'Follow a user',
    description: 'Follow a user directly (followerId is automatically extracted from JWT token)'
  })
  async followPerson(@Req() req: Request, @Body() dto: FollowPersonDto) {
    const followerId = (req.user as any).userId; // Use 'userId' instead of 'id'
    return this.userService.followPerson(followerId, dto.followingId);
  }

  @Post('unfollow')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiBody({ type: UnfollowDto })
  @ApiOperation({
    summary: 'Unfollow a user',
    description: 'Unfollow a user (followerId is automatically extracted from JWT token)'
  })
  async unfollow(@Req() req: Request, @Body() dto: UnfollowDto) {
    const followerId = (req.user as any).userId; // Use 'userId' instead of 'id'
    return this.userService.unfollow(followerId, dto.followingId);
  }

  @Post('block-user')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiBody({ type: BlockUserDto })
  @ApiOperation({
    summary: 'Block a user',
    description: 'Block a user (blockerId is automatically extracted from JWT token)'
  })
  async blockUser(@Req() req: Request, @Body() dto: BlockUserDto) {
    const blockerId = (req.user as any).userId; // Use 'userId' instead of 'id'
    return this.userService.blockUser(blockerId, dto.blockedId);
  }

  @Post('unblock-user')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiBody({ type: UnblockUserDto })
  @ApiOperation({
    summary: 'Unblock a user',
    description: 'Unblock a user (blockerId is automatically extracted from JWT token)'
  })
  async unblockUser(@Req() req: Request, @Body() dto: UnblockUserDto) {
    const blockerId = (req.user as any).userId; // Use 'userId' instead of 'id'
    return this.userService.unblockUser(blockerId, dto.blockedId);
  }

  @Get('pending-requests')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get pending follow requests',
    description: 'Returns empty array since follow requests are now direct (userId is automatically extracted from JWT token)'
  })
  async getPendingFollowRequests(@Req() req: Request) {
    const userId = (req.user as any).userId; // Use 'userId' instead of 'id'
    return this.userService.getPendingFollowRequests(userId);
  }

  @Get('followers/:userId')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  async getFollowersList(@Param('userId') userId: string) {
    return this.userService.getFollowersList(userId);
  }

  @Get('followers-graph')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get follower count graph data for a user' })
  @ApiQuery({ name: 'userId', type: 'string', required: true, description: 'User ID to get follower graph for' })
  @ApiQuery({ name: 'range', type: 'string', required: false, enum: ['daily', 'weekly'], description: 'daily = last 24 hours, weekly = last 7 days' })
  async getFollowersGraph(
    @Query('userId') userId: string,
    @Query('range') range?: 'daily' | 'weekly',
  ) {
    return this.userService.getFollowersGraph(userId, range || 'weekly');
  }

  @Get('following/:userId')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  async getFollowingList(@Param('userId') userId: string) {
    return this.userService.getFollowingList(userId);
  }

  @Get('blocked-users')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get blocked users for the authenticated user',
    description: 'Returns list of users blocked by the authenticated user (blockerId is automatically extracted from JWT token)'
  })
  async getBlockedUsers(@Req() req: Request) {
    const blockerId = (req.user as any).userId; // Use 'userId' instead of 'id'
    return this.userService.getBlockedUsers(blockerId);
  }

  @Get('all')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all users (excluding soft-deleted) with optional search filters' })
  @ApiQuery({ name: 'email', type: String, required: false, description: 'Search by email' })
  @ApiQuery({ name: 'userName', type: String, required: false, description: 'Search by userName' })
  @ApiQuery({ name: 'googleId', type: String, required: false, description: 'Search by googleId' })
  @ApiQuery({ name: 'twitterId', type: String, required: false, description: 'Search by twitterId' })
  @ApiQuery({ name: 'phoneNumber', type: String, required: false, description: 'Search by phoneNumber' })
  @ApiQuery({ name: 'displayName', type: String, required: false, description: 'Search by displayName' })
  @ApiQuery({ name: 'isBlocked', type: Boolean, required: false, description: 'Filter by blocked status (true / false)' })
  async getAllUsers(@Query() query: GetAllUsersDto) {
    const users = await this.userService.getAllUsers(query);
    return { users };
  }

  @Get('display-names')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get all display names of all users',
    description: 'Retrieves display names, user names, emails, and IDs of all users (excluding soft-deleted users)'
  })
  async getDisplayNames() {
    const users = await this.userService.getDisplayNames();
    return { users };
  }

  @Get('stats/count')
  @UseGuards(AdminAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get user statistics count (Admin)',
    description:
      'Returns aggregate counts of total users, active users, temporary banned users, and blocked users.',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns aggregated user status counts',
    schema: {
      type: 'object',
      properties: {
        totalUsers: { type: 'number', example: 1250 },
        activeUsers: { type: 'number', example: 1200 },
        temporaryBannedUsers: { type: 'number', example: 15 },
        blockedUsers: { type: 'number', example: 35 },
      },
    },
  })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin privileges required' })
  async getUserStatsCount() {
    return this.userService.getUserStatsCount();
  }

  @Post('check-display-name')
  @ApiOperation({
    summary: 'Check display name availability',
    description: 'Check if a display name is available. If taken, returns 4 similar suggestions.'
  })
  @ApiBody({ type: CheckDisplayNameDto })
  @ApiResponse({
    status: 200,
    description: 'Display name check result',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['approved', 'taken'] },
        message: { type: 'string' },
        displayName: { type: 'string' },
        suggestions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of 4 suggested display names (only if status is "taken")'
        }
      }
    }
  })
  async checkDisplayName(@Body() dto: CheckDisplayNameDto) {
    const result = await this.userService.checkDisplayNameAvailability(dto.displayName);
    return result;
  }

  @Post('check-username')
  @ApiOperation({
    summary: 'Check username availability',
    description: 'Check if a username is available. If taken, returns 4 similar suggestions.'
  })
  @ApiBody({ type: CheckUserNameDto })
  @ApiResponse({
    status: 200,
    description: 'Username check result',
    schema: {
      type: 'object',
      properties: {
        isAvailable: { type: 'boolean' },
        status: { type: 'string', enum: ['approved', 'taken'] },
        message: { type: 'string' },
        userName: { type: 'string' },
        suggestions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of 4 suggested usernames (only if status is "taken")'
        }
      }
    }
  })
  async checkUserName(@Body() dto: CheckUserNameDto) {
    const targetUserName = dto.userName || dto.username;
    if (!targetUserName) {
      throw new BadRequestException('Username is required');
    }
    return this.userService.checkUserNameAvailability(targetUserName, dto.userId, dto.email);
  }

  @Get('check-username')
  @ApiOperation({
    summary: 'Check username availability via GET',
    description: 'Check if a username is available via query parameter. If taken, returns 4 similar suggestions.'
  })
  @ApiQuery({ name: 'userName', required: false, description: 'Username to check' })
  @ApiQuery({ name: 'username', required: false, description: 'Username to check (alias)' })
  @ApiQuery({ name: 'userId', required: false, description: 'Optional User ID to exclude' })
  @ApiQuery({ name: 'email', required: false, description: 'Optional email to check unverified ownership' })
  async checkUserNameGet(
    @Query('userName') userName?: string,
    @Query('username') username?: string,
    @Query('userId') userId?: string,
    @Query('email') email?: string,
  ) {
    const targetUserName = userName || username;
    if (!targetUserName) {
      throw new BadRequestException('Username is required');
    }
    return this.userService.checkUserNameAvailability(targetUserName, userId, email);
  }

  @Get('dashboard')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get user dashboard data' })
  @ApiQuery({ name: 'userId', type: 'string', description: 'User ID to get dashboard data for' })
  @ApiResponse({
    status: 200,
    description: 'User dashboard data retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        dashboardData: {
          type: 'object',
          properties: {
            totalPosts: { type: 'number', description: 'Total number of posts by the user' },
            totalFollowing: { type: 'number', description: 'Total number of users the user is following' },
            totalFollowers: { type: 'number', description: 'Total number of users following the user' }
          }
        }
      }
    }
  })
  async getUserDashboard(@Query() query: GetUserDashboardDto) {
    const dashboardData = await this.userService.getUserDashboard(query.userId);
    return { dashboardData };
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Get('search')
  @ApiOperation({ summary: 'Search users by display name, user name, or email' })
  @ApiQuery({ name: 'query', type: String, description: 'Search term', required: true })
  async searchUser(@Query('query') query: string) {
    const users = await this.userService.searchUser(query);
    return { users };
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Get('search/history')
  @ApiOperation({ summary: 'Get recent search history for the authenticated user' })
  async getSearchHistory(@Req() req: Request, @Query() query: GetSearchHistoryDto) {
    const userId = (req.user as any)?.userId;
    const history = await this.userService.getSearchHistory(userId, query?.limit);
    return { history };
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('search/history')
  @ApiOperation({ summary: 'Record a search history entry (query or clicked user profile)' })
  async addSearchHistory(@Req() req: Request, @Body() body: AddSearchHistoryDto) {
    const userId = (req.user as any)?.userId;
    const history = await this.userService.addSearchHistory(userId, body);
    return { success: true, history };
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Delete('search/history/clear-all')
  @ApiOperation({ summary: 'Clear all search history for the authenticated user' })
  async clearAllSearchHistoryAlt(@Req() req: Request) {
    const userId = (req.user as any)?.userId;
    return await this.userService.clearAllSearchHistory(userId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Delete('search/history/:id')
  @ApiOperation({ summary: 'Delete a single search history item' })
  @ApiParam({ name: 'id', type: String, description: 'Search history record ID' })
  async deleteSearchHistoryItem(@Req() req: Request, @Param('id') id: string) {
    const userId = (req.user as any)?.userId;
    return await this.userService.deleteSearchHistoryItem(userId, id);
  }

  // @UseGuards(AuthGuard('jwt'))
  // @ApiBearerAuth()
  // @Delete('search/history')
  // @ApiOperation({ summary: 'Clear all search history for the authenticated user' })
  // async clearAllSearchHistory(@Req() req: Request) {
  //   const userId = (req.user as any)?.userId;
  //   return await this.userService.clearAllSearchHistory(userId);
  // }


  @Get('recent-activities')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get recent activities for the authenticated user' })
  @ApiQuery({ name: 'type', type: String, required: false, description: 'Filter by activity type: all, following, unfollowing, drops, flips, posts' })
  @ApiQuery({ name: 'lang', required: false, type: String, enum: ['en', 'pt', 'it', 'es', 'fr', 'hi'], description: 'Override preferred language' })
  @ApiQuery({ name: 'deviceId', required: false, type: String, description: 'Device ID for device-level language preference' })
  async getRecentActivities(@Req() req: Request, @Query() query: RecentActivitiesDto) {
    const userId = (req.user as any).userId;
    const deviceId = query.deviceId || (req?.headers as any)?.['x-device-id'] || undefined;
    const activities = await this.userService.recentActivities(userId, query.type, query.lang, deviceId);
    return { activities };
  }


  @Get('suggested-users')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get suggested users based on common followers and following' })
  @ApiQuery({ name: 'limit', type: Number, required: false, description: 'Number of suggested users to return (default: 10)' })
  async getSuggestedUsers(@Req() req: Request, @Query('limit') limit?: string) {
    const userId = (req.user as any).userId;
    const limitNum = limit ? parseInt(limit, 10) : 10;
    const suggestedUsers = await this.userService.getSuggestedUsers(userId, limitNum);
    return { suggestedUsers };
  }

  // Place static route before dynamic ":id" to avoid conflicts
  @Get('getHitLeft')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get user hit left and post count' })
  async getHitLeft(@Req() req: Request) {
    const userId = (req.user as any).userId;
    const result = await this.userService.getHitLeft(userId);
    return result;
  }

  @Get('refer-points')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get referral points for the authenticated user' })
  async getReferPoints(@Req() req: Request) {
    const userId = (req.user as any).userId;
    return this.userService.getReferPoints(userId);
  }

  @Get('shop-platform-points')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get shop platform points earned by authenticated user' })
  async getShopPlatformPoints(@Req() req: Request) {
    const userId = (req.user as any).userId;
    return this.userService.getShopPlatformPoints(userId);
  }

  @Get('totalplatfrompoints')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get total platform points summary for authenticated user' })
  async getTotalPlatformPoints(@Req() req: Request) {
    const userId = (req.user as any).userId;
    return this.userService.getTotalPlatformPointsSummary(userId);
  }

  @Post('platform-points/send')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Send platform points to another user' })
  @ApiBody({ type: SendPlatformPointsDto })
  async sendPlatformPoints(@Req() req: Request, @Body() dto: SendPlatformPointsDto) {
    const userId = (req.user as any).userId;
    return this.userService.sendPlatformPoints(userId, dto);
  }

  @Get('platform-points/transfers')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get history of platform point transfers (sent and received)' })
  async getPlatformPointTransfers(@Req() req: Request, @Query() query: GetPointTransfersDto) {
    const userId = (req.user as any).userId;
    return this.userService.getPlatformPointTransfers(userId, query);
  }

  @Post('profileStatusSet')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Set user profile status' })
  @ApiBody({ type: ProfileStatusSetDto })
  async setProfileStatus(@Req() req: Request, @Body() dto: ProfileStatusSetDto) {
    const userId = (req.user as any).userId;
    return this.userService.setProfileStatus(userId, dto.profileStatus);
  }

  @Post('accountDelete')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Hard delete user account and store snapshot in deleted_users table' })
  async accountDelete(@Req() req: Request) {
    const userId = (req.user as any).userId;
    return this.userService.accountDelete(userId);
  }

  @Post('reactivateAccount')
  @ApiOperation({ summary: 'Reactivate deleted user account (set isDeleted = 0)' })
  @ApiBody({ type: ReactivateAccountDto })
  async reactivateAccount(@Body() dto: ReactivateAccountDto) {
    return this.userService.reactivateAccount(dto);
  }

  // UserSubscription CRUD Endpoints

  @Post('subscription')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new user subscription' })
  @ApiBody({ type: CreateUserSubscriptionDto })
  @ApiResponse({ status: 201, description: 'User subscription created successfully' })
  async createUserSubscription(@Req() req: Request, @Body() dto: CreateUserSubscriptionDto) {
    const userId = (req.user as any).userId;
    const subscription = await this.userService.createUserSubscription(userId, dto);
    return { message: 'User subscription created successfully', subscription };
  }

  // ✅ STATIC ROUTE FIRST (no :id parameter)
  @Get('subscription/price-update-summary')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get creator subscription price update summary and subscriber responses' })
  @ApiResponse({ status: 200, description: 'Price update summary retrieved successfully' })
  async getSubscriptionPriceUpdateSummary(@Req() req: Request) {
    const creatorId = (req.user as any).userId;
    return this.userService.getSubscriptionPriceUpdateSummary(creatorId);
  }

  @Get('subscription/price-update-subscribers')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get list of users who accepted, declined, or are pending for creator subscription price update' })
  @ApiResponse({ status: 200, description: 'Price update subscribers retrieved successfully' })
  async getSubscriptionPriceUpdateSubscribers(
    @Req() req: Request,
    @Query() query: GetPriceUpdateSubscribersQueryDto,
  ) {
    const creatorId = (req.user as any).userId;
    return this.userService.getSubscriptionPriceUpdateSubscribers(creatorId, query);
  }

  @Get('subscription/price-update-users')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get list of users who accepted, declined, or are pending for creator subscription price update (alias)' })
  @ApiResponse({ status: 200, description: 'Price update users retrieved successfully' })
  async getSubscriptionPriceUpdateUsers(
    @Req() req: Request,
    @Query() query: GetPriceUpdateSubscribersQueryDto,
  ) {
    const creatorId = (req.user as any).userId;
    return this.userService.getSubscriptionPriceUpdateSubscribers(creatorId, query);
  }

  @Get('getSubscriptionByUserID/:userId')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get user subscriptions' })
  @ApiParam({ name: 'userId', type: String, description: 'User ID' })
  @ApiResponse({ status: 200, description: 'User subscriptions retrieved successfully' })
  async getSubscriptionByUserID(@Param('userId') userId: string) {
    // console.log('[getUserSubscriptions] userId:', userId);

    const subscriptions = await this.userService.getUserSubscriptions(userId);
    return { subscriptions };
  }

  // ✅ DYNAMIC ROUTE SECOND (with :id parameter)
  @Get('subscription/:id')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get user subscription by ID' })
  @ApiParam({ name: 'id', type: String, description: 'User subscription ID' })
  @ApiResponse({ status: 200, description: 'User subscription retrieved successfully' })
  async getUserSubscriptionById(@Param('id') id: string) {
    const subscription = await this.userService.getUserSubscriptionById(id);
    return { subscription };
  }

  @Patch('subscription/:id')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update user subscription' })
  @ApiParam({ name: 'id', type: String, description: 'User subscription ID' })
  @ApiBody({ type: UpdateUserSubscriptionDto })
  @ApiResponse({ status: 200, description: 'User subscription updated successfully' })
  async updateUserSubscription(@Param('id') id: string, @Body() dto: UpdateUserSubscriptionDto) {
    const subscription = await this.userService.updateUserSubscription(id, dto);
    return { message: 'User subscription updated successfully', subscription };
  }

  @Delete('subscription/:id')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Soft delete user subscription' })
  @ApiParam({ name: 'id', type: String, description: 'User subscription ID' })
  @ApiResponse({ status: 200, description: 'User subscription deleted successfully' })
  async deleteUserSubscription(@Param('id') id: string) {
    await this.userService.deleteUserSubscription(id);
    return { message: 'User subscription deleted successfully' };
  }

  @Post('enable-two-factor')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Enable two-factor authentication' })
  async enableTwoFactor(@Req() req: Request) {
    const userId = (req.user as any).userId;
    return this.userService.enableTwoFactor(userId);
  }

  @Post('verify-two-factor')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Verify and enable two-factor authentication' })
  @ApiBody({ schema: { type: 'object', properties: { token: { type: 'string' } } } })
  async verifyAndEnableTwoFactor(@Req() req: Request, @Body() dto: { token: string }) {
    const userId = (req.user as any).userId;
    return this.userService.verifyAndEnableTwoFactor(userId, dto.token);
  }

  @Post('disable-two-factor')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Disable two-factor authentication' })
  @ApiBody({ schema: { type: 'object', properties: { token: { type: 'string' } } } })
  async disableTwoFactor(@Req() req: Request, @Body() dto: { token: string }) {
    const userId = (req.user as any).userId;
    return this.userService.disableTwoFactor(userId, dto.token);
  }

  @Post('update-fcm-token')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update FCM token for push notifications per device' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        fcmToken: { type: 'string' },
        deviceId: { type: 'string' },
        platform: { type: 'string' },
        language: { type: 'string' },
      },
      required: ['fcmToken'],
    },
  })
  async updateFcmToken(
    @Req() req: Request,
    @Body() dto: { fcmToken: string; deviceId?: string; platform?: string; language?: string },
  ) {
    const userId = (req.user as any)?.userId || (req.user as any)?.sub;
    const deviceId = dto.deviceId || (req?.headers as any)?.['x-device-id'] || undefined;
    const platform = dto.platform || (req?.headers as any)?.['x-platform'] || undefined;
    const language = dto.language || (req?.headers as any)?.['x-language'] || undefined;
    return this.userService.updateFcmToken(userId, dto.fcmToken, { deviceId, platform, language });
  }

  @Post('update-language')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update preferred language for notifications and responses (per device or user fallback)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        language: { type: 'string' },
        deviceId: { type: 'string' },
      },
      required: ['language'],
    },
  })
  async updateLanguage(@Req() req: Request, @Body() dto: { language: string; deviceId?: string }) {
    const userId = (req.user as any)?.userId || (req.user as any)?.sub;
    const deviceId = dto.deviceId || (req?.headers as any)?.['x-device-id'] || undefined;
    return this.userService.updateLanguage(userId, dto.language, deviceId);
  }

  @Patch('language')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update preferred language (per device or user fallback)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        language: { type: 'string' },
        deviceId: { type: 'string' },
      },
      required: ['language'],
    },
  })
  async patchLanguage(@Req() req: Request, @Body() dto: { language: string; deviceId?: string }) {
    const userId = (req.user as any)?.userId || (req.user as any)?.sub;
    const deviceId = dto.deviceId || (req?.headers as any)?.['x-device-id'] || undefined;
    return this.userService.updateLanguage(userId, dto.language, deviceId);
  }

  @Get('language')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get preferred language for authenticated user (matched by deviceId and userId from token)' })
  @ApiQuery({ name: 'deviceId', required: false, type: String, description: 'Unique device identifier' })
  @ApiResponse({ status: 200, description: 'Returns preferred language preference' })
  async getLanguage(@Req() req: Request, @Query('deviceId') queryDeviceId?: string) {
    const userId = (req.user as any)?.userId || (req.user as any)?.sub;
    const deviceId = queryDeviceId || (req?.headers as any)?.['x-device-id'] || undefined;
    return this.userService.getLanguage(userId, deviceId);
  }

  @Get('get-language')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Alias to get preferred language (matched by deviceId and userId from token)' })
  @ApiQuery({ name: 'deviceId', required: false, type: String, description: 'Unique device identifier' })
  @ApiResponse({ status: 200, description: 'Returns preferred language preference' })
  async getLanguageAlias(@Req() req: Request, @Query('deviceId') queryDeviceId?: string) {
    const userId = (req.user as any)?.userId || (req.user as any)?.sub;
    const deviceId = queryDeviceId || (req?.headers as any)?.['x-device-id'] || undefined;
    return this.userService.getLanguage(userId, deviceId);
  }

  @Post('deviceLanguageUpdate')
  @ApiOperation({ summary: 'Update preferred language for all accounts associated with a device ID (Public)' })
  @ApiBody({ type: DeviceLanguageUpdateDto })
  @ApiResponse({ status: 200, description: 'Device language updated successfully' })
  async deviceLanguageUpdate(@Req() req: Request, @Body() dto: DeviceLanguageUpdateDto) {
    const deviceId = dto.deviceId || (req?.headers as any)?.['x-device-id'] || undefined;
    return this.userService.updateDeviceLanguage(deviceId, dto.language);
  }


  @Get('deviceLanguage')
  @ApiOperation({ summary: 'Get preferred language for a device ID (Public)' })
  @ApiQuery({ name: 'deviceId', required: false, type: String, description: 'Unique device identifier' })
  @ApiResponse({ status: 200, description: 'Returns preferred language preference for the device' })
  async getDeviceLanguage(@Req() req: Request, @Query('deviceId') queryDeviceId?: string) {
    const deviceId = queryDeviceId || (req?.headers as any)?.['x-device-id'] || undefined;
    return this.userService.getDeviceLanguage(deviceId);
  }



  @Patch('updateWalletAddress')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update wallet address for the authenticated user' })
  @ApiBody({ type: UpdateWalletAddressDto })
  @ApiResponse({ status: 200, description: 'Wallet address updated successfully' })
  async updateWalletAddress(@Req() req: Request, @Body() dto: UpdateWalletAddressDto) {
    const userId = (req.user as any).userId;
    return this.userService.updateWalletAddress(userId, dto.walletAddress);
  }

  // Dynamic parameterized routes (placed at the bottom to avoid shadowing static routes)
  @Get(':id')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get user by ID' })
  @ApiParam({ name: 'id', type: 'string', description: 'User ID (UUID format)' })
  async getUserById(@Param('id', new ParseUUIDPipe()) id: string) {
    const user = await this.userService.getUserById(id);
    return { user };
  }

  @Delete(':id')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Soft delete user by ID' })
  @ApiParam({ name: 'id', type: String })
  async softDeleteUser(@Param('id') id: string) {
    await this.userService.softDeleteUser(id);
    return { message: 'User soft deleted' };
  }
}
