import { Controller, Post, Body, Get, Query, Delete, UseGuards, Req, UseInterceptors, UploadedFiles, ValidationPipe, Param, BadRequestException } from '@nestjs/common';
import { PostService } from './post.service';
import { CreatePostDto } from './dto/create-post.dto';
import { GetPostByUserDto } from './dto/get-post-by-user.dto';
import { GetPostByIdDto } from './dto/get-post-by-id.dto';
import { DeletePostDto } from './dto/delete-post.dto';
import { EditPostDto } from './dto/edit-post.dto';
import { SharePostDto, DeleteSharedPostDto } from './dto/share-post.dto';
import { PostLikeByUserDto, PostLikeListDto, SavePostDto, UnsavePostDto } from './dto/post-like.dto';
import { PostReportDto } from './dto/post-report.dto';
import { FileFieldsInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { Request } from 'express';
import { ApiConsumes, ApiBody, ApiBearerAuth, ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { CommentOnPostDto, GetCommentListOnPostDto, CommentDeleteDto, ReactOnCommentDto } from './dto/post-comment.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { ChatStatusUpdateDto } from './dto/chat-status-update.dto';
import { HideChatDto } from './dto/hide-chat.dto';
import { DeleteConversationDto } from './dto/delete-conversation.dto';
import { PinPostDto, UnpinPostDto } from './dto/pin-post.dto';
import { GetPostTrustScoreDto, PostTrustVoteDto, RemovePostTrustVoteDto } from './dto/post-trust-vote.dto';
import { POST_TYPES } from './dto/post-types';
import { GetMarketPlaceEbookDto } from './dto/get-marketplace-ebook.dto';
import { log } from 'console';

@Controller('post')
export class PostController {
  constructor(private readonly postService: PostService) { }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('create')
  @UseInterceptors(FileFieldsInterceptor([
    { name: 'images', maxCount: 20 },
    { name: 'ebookpdf', maxCount: 1 },
  ]))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text content of the post' },
        caption: { type: 'string', description: 'Caption for the post' },
        hashtag: { type: 'array', items: { type: 'string' }, description: 'Hashtags for the post' },
        location: { type: 'string', description: 'Location for the post' },
        music: { type: 'string', description: 'Music for the post' },
        youtubeMusicMeta: { type: 'string', description: 'YouTube Music metadata as JSON string' },
        link: { type: 'string', description: 'Link for the post' },
        visibleTo: { type: 'string', description: 'Visibility setting for the post' },
        taggedPeople: { type: 'array', items: { type: 'string' }, description: 'Tagged people user IDs' },
        images: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
          description: 'Array of image/video files',
        },
        ebookpdf: {
          type: 'string',
          format: 'binary',
          description: 'Ebook PDF file when format is ebook',
        },
        tableContents: {
          type: 'array',
          items: { type: 'string' },
          description: 'Table of contents entries for ebook posts',
        },
        allowDownload: {
          type: 'boolean',
          description: 'Whether ebook can be downloaded',
          default: true,
        },
        amount: { type: 'number', description: 'Optional ebook amount' },
        promoCode: { type: 'string', description: 'Optional seller promo code for ebook posts' },
        type: { type: 'string', enum: [...POST_TYPES], description: 'Type of post' },
        format: { type: 'string', enum: ['image', 'video', 'reel', 'ebook'], description: 'Format of the post' },
        raiseAmount: { type: 'number', description: 'Raise amount for crowdfunding posts' },
        start_time: { type: 'string', format: 'date-time', description: 'Start time for crowdfunding posts' },
        end_time: { type: 'string', format: 'date-time', description: 'End time for crowdfunding posts' },
        isTrustPost: { type: 'boolean', description: 'Whether this is a trust post', default: false },
        videoText: { type: 'boolean', description: 'Enable text overlay rendering for uploaded video files', default: false },
        videoTextItems: {
          type: 'array',
          description: 'Text overlays rendered onto uploaded videos when videoText=true',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'Text to display' },
              xPercent: { type: 'number', description: 'Horizontal position from 0 to 1' },
              yPercent: { type: 'number', description: 'Vertical position from 0 to 1' },
              fontSize: { type: 'number', description: 'Font size in px' },
              color: { type: 'string', description: 'Text color, e.g. white or #FFFFFF' },
            },
          },
        },
      },
    },
  })
  async createPost(
    @Req() req: Request,
    @Body(new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
      exceptionFactory: (errors) => new BadRequestException(errors)
    })) body: CreatePostDto,
    @UploadedFiles() files?: { images?: any[]; ebookpdf?: any[] },
  ) {
    const userId = (req.user as any).userId; // Use 'sub' instead of 'userId'
    const rawVideoTextItems = (req as any)?.body?.videoTextItems;
    const resolvedVideoTextItems =
      Array.isArray(body.videoTextItems) && body.videoTextItems.length > 0
        ? body.videoTextItems
        : rawVideoTextItems;

    return this.postService.createPost(
      userId,
      body.text,
      undefined,
      body.caption,
      body.hashtag,
      body.location,
      body.music,
      body.youtubeMusicMeta,
      body.link,
      body.visibleTo,
      body.taggedPeople,
      body.type,
      body.format,
      body.allowDownload,
      body.tableContents,
      body.amount,
      body.promoCode,
      files?.ebookpdf?.[0],
      body.raiseAmount,
      body.start_time,
      body.end_time,
      body.isTrustPost,
      body.videoText,
      resolvedVideoTextItems,
      (req as any)?.body,
      files?.images,
    );
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('edit/:postId')
  @UseInterceptors(FilesInterceptor('images'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text content of the post' },
        caption: { type: 'string', description: 'Caption for the post' },
        hashtag: { type: 'array', items: { type: 'string' }, description: 'Hashtags for the post' },
        location: { type: 'string', description: 'Location for the post' },
        music: { type: 'string', description: 'Music for the post' },
        youtubeMusicMeta: { type: 'string', description: 'YouTube Music metadata as JSON string' },
        link: { type: 'string', description: 'Link for the post' },
        visibleTo: { type: 'string', description: 'Visibility setting for the post' },
        taggedPeople: { type: 'array', items: { type: 'string' }, description: 'Tagged people user IDs' },
        images: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
          description: 'Array of image files',
        },
        videoText: {
          type: 'boolean',
          description: 'When true, replace existing media with newly uploaded video media',
          default: false,
        },
        videoTextItems: {
          type: 'array',
          description: 'Text overlays rendered onto uploaded videos when videoText=true',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'Text to display' },
              xPercent: { type: 'number', description: 'Horizontal position from 0 to 1' },
              yPercent: { type: 'number', description: 'Vertical position from 0 to 1' },
              fontSize: { type: 'number', description: 'Font size in px' },
              color: { type: 'string', description: 'Text color, e.g. white or #FFFFFF' },
            },
          },
        },
        type: { type: 'string', enum: [...POST_TYPES], description: 'Type of post' },
        raiseAmount: { type: 'number', description: 'Raise amount for crowdfunding posts' },
        start_time: { type: 'string', format: 'date-time', description: 'Start time for crowdfunding posts' },
        end_time: { type: 'string', format: 'date-time', description: 'End time for crowdfunding posts' },
      },
    },
  })
  async editPost(
    @Req() req: Request,
    @Param('postId') postId: string,
    @Body(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false })) body: EditPostDto,
    @UploadedFiles() files?: any[],
  ) {
    // console.log(">>>>>>>>>>>>>>>>>>>>>", req.user);

    const userId = (req.user as any).userId; // Use 'sub' instead of 'userId'
    // console.log(">>>>>>>>>>>>>>>>>>>>>", userId);

    return this.postService.editPost(postId, userId, body, files);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Get('by-user')
  async getPostByUserId(
    @Req() req: Request,
    @Query(new ValidationPipe({ whitelist: true, transform: true })) query: GetPostByUserDto
  ) {
    // console.log('Query received:', query);
    // console.log('User from JWT:', req.user);

    // Use userId from query if provided, otherwise use the authenticated user's ID
    const targetUserId = query.userId || (req.user as any)?.userId; // Use 'sub' instead of 'userId'
    // console.log('Target user ID:', targetUserId);

    const viewerUserId = (req.user as any)?.userId;
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const type = (query.type === 'private' || query.type === 'private_circle' ? query.type : 'normal') as 'normal' | 'private' | 'private_circle';
    return this.postService.getPostByUserId(targetUserId, viewerUserId, page, limit, type);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Get('all')
  @ApiQuery({ name: 'page', type: Number, required: false, description: 'Page (default 1)' })
  @ApiQuery({ name: 'limit', type: Number, required: false, description: 'Items per page, max 50 (default 20)' })
  async getAllPost(@Req() req: Request, @Query('page') page?: string, @Query('limit') limit?: string) {
    const viewerUserId = (req.user as any)?.userId;
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 20;
    return this.postService.getAllPost(viewerUserId, pageNum, limitNum);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Get('searchPagePosts')
  @ApiQuery({ name: 'page', type: Number, required: false, description: 'Page (default 1)' })
  @ApiQuery({ name: 'limit', type: Number, required: false, description: 'Items per page, max 50 (default 20)' })
  async getAllPostSearchPage(@Req() req: Request, @Query('page') page?: string, @Query('limit') limit?: string) {
    const viewerUserId = (req.user as any)?.userId;
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 20;
    return this.postService.getAllPostSearchPage(viewerUserId, pageNum, limitNum);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Get('getMissionpost')
  @ApiQuery({ name: 'status', required: false, type: 'string', description: "Filter by status: 'active' | 'completed' | 'all' (default 'all')" })
  async getMissionpost(@Req() req: Request, @Query('status') status?: string) {
    const userId = (req.user as any)?.userId;
    const normalized = (status || 'all').toString().trim().toLowerCase();
    const parsedStatus = (normalized === 'active' || normalized === 'completed' || normalized === 'all') ? (normalized as any) : 'all';
    return this.postService.getMissionpost(userId, parsedStatus);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Get('searchAll')
  @ApiQuery({ name: 'search', type: String, required: false, description: 'Search query for users or posts' })
  async searchAllPost(@Req() req: Request, @Query('search') search?: string) {
    const viewerUserId = (req.user as any)?.userId;
    return this.postService.searchAllPost(viewerUserId, search);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Get('hashtags/search')
  @ApiQuery({ name: 'q', type: String, required: false, description: 'Hashtag prefix query (with or without #)' })
  @ApiQuery({ name: 'limit', type: Number, required: false, description: 'Result limit, max 50 (default 20)' })
  async searchHashtags(@Query('q') q?: string, @Query('limit') limit?: string) {
    const limitNum = limit ? parseInt(limit, 10) : 20;
    return this.postService.searchHashtags(q, limitNum);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Get('hashtags/trending')
  @ApiQuery({ name: 'limit', type: Number, required: false, description: 'Result limit, max 50 (default 20)' })
  @ApiQuery({ name: 'days', type: Number, required: false, description: 'Lookback in days, max 90 (default 7)' })
  async trendingHashtags(@Query('limit') limit?: string, @Query('days') days?: string) {
    const limitNum = limit ? parseInt(limit, 10) : 20;
    const daysNum = days ? parseInt(days, 10) : 7;
    return this.postService.getTrendingHashtags(limitNum, daysNum);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Get('by-hashtag/:tag')
  @ApiParam({ name: 'tag', type: String, description: 'Hashtag tag value with or without # prefix' })
  @ApiQuery({ name: 'page', type: Number, required: false, description: 'Page number (default 1)' })
  @ApiQuery({ name: 'limit', type: Number, required: false, description: 'Result limit, max 50 (default 20)' })
  async getPostsByHashtag(
    @Req() req: Request,
    @Param('tag') tag: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const viewerUserId = (req.user as any)?.userId;
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 20;
    return this.postService.getPostsByHashtag(tag, viewerUserId, pageNum, limitNum);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Get('getAllReel')
  async getAllReel(@Req() req: Request) {
    const viewerUserId = (req.user as any)?.userId;
    return this.postService.getAllReel(viewerUserId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Get('getMarketPlaceEbook')
  @ApiQuery({ name: 'userId', type: String, required: true, description: 'Target user ID to fetch marketplace ebook posts' })
  async getMarketPlaceEbook(
    @Req() req: Request,
    @Query(new ValidationPipe({ whitelist: true, transform: true })) query: GetMarketPlaceEbookDto,
  ) {
    const viewerUserId = (req.user as any)?.userId;
    return this.postService.getMarketPlaceEbook(query.userId, viewerUserId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Get('getMarketPlaceEbookById/:postId')
  @ApiOperation({ summary: 'Get marketplace ebook by post ID with purchase state for authenticated viewer' })
  @ApiParam({ name: 'postId', type: 'string', description: 'Marketplace ebook post ID' })
  async getMarketPlaceEbookById(
    @Req() req: Request,
    @Param(new ValidationPipe({ whitelist: true })) params: GetPostByIdDto,
  ) {
    const viewerUserId = (req.user as any)?.userId;
    return this.postService.getMarketPlaceEbookById(params.postId, viewerUserId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Get('myEbookLibrary')
  @ApiOperation({ summary: 'Get purchased ebooks library for authenticated user' })
  async myEbookLibrary(@Req() req: Request) {
    const viewerUserId = (req.user as any)?.userId;
    return this.postService.myEbookLibrary(viewerUserId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Delete('delete')
  async deletePost(@Req() req: Request, @Query(new ValidationPipe({ whitelist: true })) query: DeletePostDto) {
    const userId = (req.user as any).userId; // Use 'sub' instead of 'userId'
    return this.postService.deletePost(query.postId, userId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('like')
  @ApiOperation({ summary: 'Like or unlike a post' })
  @ApiBody({ type: PostLikeByUserDto })
  async postLikeByUser(
    @Req() req: Request,
    @Body(new ValidationPipe({ whitelist: true })) body: PostLikeByUserDto
  ) {
    const userId = (req.user as any).userId;
    return this.postService.postLikeByUser(body.postId, userId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('postTrustVote')
  @ApiOperation({ summary: 'Create trust vote on a trust post (one vote per user)' })
  @ApiBody({ type: PostTrustVoteDto })
  async postTrustVote(
    @Req() req: Request,
    @Body(new ValidationPipe({ whitelist: true })) body: PostTrustVoteDto,
  ) {
    const userId = (req.user as any).userId;
    return this.postService.postTrustVote(body.postId, userId, body.voteType, body.comment);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('getPostTrustScore')
  @ApiOperation({ summary: 'Get trust vote score and percentages for a trust post' })
  @ApiBody({ type: GetPostTrustScoreDto })
  async getPostTrustScore(
    @Body(new ValidationPipe({ whitelist: true })) body: GetPostTrustScoreDto,
  ) {
    return this.postService.getPostTrustScore(body.postId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('getTrustVoteBypostId')
  @ApiOperation({ summary: 'Check whether logged-in user has submitted trust vote for a post' })
  @ApiBody({ type: GetPostTrustScoreDto })
  async getTrustVoteBypostId(
    @Req() req: Request,
    @Body(new ValidationPipe({ whitelist: true })) body: GetPostTrustScoreDto,
  ) {
    const userId = (req.user as any).userId;
    return this.postService.getTrustVoteBypostId(body.postId, userId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('removePostTrustVote')
  @ApiOperation({ summary: 'Remove trust vote of logged-in user for a post' })
  @ApiBody({ type: RemovePostTrustVoteDto })
  async removePostTrustVote(
    @Req() req: Request,
    @Body(new ValidationPipe({ whitelist: true })) body: RemovePostTrustVoteDto,
  ) {
    const userId = (req.user as any).userId;
    return this.postService.removePostTrustVote(body.postId, userId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('pin')
  @ApiOperation({ summary: 'Pin a post (newer pins appear first)' })
  @ApiBody({ type: PinPostDto })
  async pinPost(
    @Req() req: Request,
    @Body(new ValidationPipe({ whitelist: true })) body: PinPostDto,
  ) {
    const userId = (req.user as any).userId;
    return this.postService.pinPost(body.postId, userId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('unpin')
  @ApiOperation({ summary: 'Unpin a post' })
  @ApiBody({ type: UnpinPostDto })
  async unpinPost(
    @Req() req: Request,
    @Body(new ValidationPipe({ whitelist: true })) body: UnpinPostDto,
  ) {
    const userId = (req.user as any).userId;
    return this.postService.unpinPost(body.postId, userId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('report')
  @ApiOperation({ summary: 'Report a post' })
  @ApiBody({ type: PostReportDto })
  async reportPost(
    @Req() req: Request,
    @Body(new ValidationPipe({ whitelist: true })) dto: PostReportDto,
  ) {
    const userId = (req.user as any).userId;
    return this.postService.reportPost(dto.postId, userId, dto.reason);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Get('like/list')
  @ApiOperation({ summary: 'Get list of users who liked a post' })
  async postLikeList(
    @Req() req: Request,
    @Query(new ValidationPipe({ whitelist: true })) query: PostLikeListDto
  ) {
    const viewerUserId = (req.user as any).userId;
    return this.postService.postLikeList(query.postId, viewerUserId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('comment')
  @ApiBody({ type: CommentOnPostDto })
  async commentOnPost(@Req() req: Request, @Body(new ValidationPipe({ whitelist: true })) dto: CommentOnPostDto) {
    const userId = (req.user as any).userId;
    return this.postService.commentOnPost(dto.postId, userId, dto.comment, dto.parentCommentId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('editComment')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        commentId: { type: 'string', description: 'ID of the comment to edit' },
        comment: { type: 'string', description: 'New comment text' },
      },
      required: ['commentId', 'comment'],
    }
  })
  async editComment(
    @Req() req: Request,
    @Body(new ValidationPipe({ whitelist: true })) dto: { commentId: string; comment: string }
  ) {
    const userId = (req.user as any).userId;
    return this.postService.editComment(dto.commentId, userId, dto.comment);
  }


  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('comment/reaction')
  @ApiOperation({ summary: 'Like, dislike, or remove reaction on a comment/reply' })
  @ApiBody({ type: ReactOnCommentDto })
  async reactOnComment(
    @Req() req: Request,
    @Body(new ValidationPipe({ whitelist: true })) dto: ReactOnCommentDto,
  ) {
    const userId = (req.user as any).userId;
    return this.postService.reactOnComment(dto.commentId, userId, dto.reaction);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Get('comment/list')
  @ApiQuery({ name: 'postId', type: String, required: true })
  async getCommentListOnPost(@Req() req: Request, @Query(new ValidationPipe({ whitelist: true })) dto: GetCommentListOnPostDto) {
    const userId = (req.user as any).userId;
    return this.postService.getCommentListOnPost(dto.postId, userId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Delete('deleteComment')
  @ApiQuery({ name: 'postId', type: String, required: true })
  @ApiQuery({ name: 'commentId', type: String, required: true })
  async deleteComment(@Req() req: Request, @Query(new ValidationPipe({ whitelist: true })) dto: CommentDeleteDto) {
    const userId = (req.user as any).userId;
    return this.postService.commentDelete(dto.postId, dto.commentId, userId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('save')
  @ApiOperation({ summary: 'Save a post for the authenticated user' })
  async savePost(@Req() req: Request, @Body(new ValidationPipe({ whitelist: true })) dto: SavePostDto) {
    const userId = (req.user as any).userId;
    return this.postService.savePost(dto.postId, userId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('unsave')
  @ApiOperation({ summary: 'Unsave a post for the authenticated user' })
  async unsavePost(@Req() req: Request, @Body(new ValidationPipe({ whitelist: true })) dto: UnsavePostDto) {
    const userId = (req.user as any).userId;
    return this.postService.unsavePost(dto.postId, userId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Get('getSavedPost')
  @ApiOperation({ summary: 'Get saved posts for the authenticated user' })
  async getSavedPosts(@Req() req: Request) {
    // console.log(">>>>>>>>>>>>>>>>>>>>>", req.user);

    const userId = (req.user as any).userId;
    return this.postService.getSavedPostsByUser(userId, userId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Get('by-id/:postId')
  @ApiOperation({ summary: 'Get a post by ID' })
  @ApiParam({ name: 'postId', type: 'string', description: 'Post ID' })
  async getPostById(@Req() req: Request, @Param(new ValidationPipe({ whitelist: true })) params: GetPostByIdDto) {
    const viewerId = (req.user as any)?.userId;
    return this.postService.getPostById(params.postId, viewerId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('sharePost')
  @ApiOperation({ summary: 'Share media to user' })
  @ApiBody({ type: SharePostDto })
  async sharePostToUser(@Body() body: SharePostDto) {
    if (!body.receiverUserId || body.receiverUserId.length === 0) {
      throw new BadRequestException('receiverUserId is required');
    }

    return this.postService.sharePostToUsers(
      body.mediaId,
      body.mediaType,
      body.conversationType,
      body.sharedUserId,
      body.receiverUserId,
    );
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Get('getShareList')
  @ApiOperation({ summary: 'Get a sharedPostList by ID' })
  async getSharedPostList(@Req() req: Request) {
    const userId = (req.user as any)?.userId;
    return this.postService.getSharedPostList(userId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Delete('deleteSharedPost')
  @ApiOperation({ summary: 'Delete multiple shared posts by IDs' })
  @ApiBody({ type: DeleteSharedPostDto })
  async deleteSharedPost(
    @Req() req: Request,
    @Body(new ValidationPipe({ whitelist: true })) dto: DeleteSharedPostDto
  ) {
    const userId = (req.user as any).userId;
    return this.postService.deleteSharedPosts(dto.shareIds, userId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('hide')
  @ApiOperation({ summary: 'Hide a post for the authenticated user' })
  @ApiBody({ schema: { type: 'object', properties: { postId: { type: 'string', description: 'Post ID to hide' } }, required: ['postId'] } })
  async hidePost(@Req() req: Request, @Body('postId') postId: string) {
    const userId = (req.user as any).userId;
    return this.postService.hidePost(postId, userId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('unhide')
  @ApiOperation({ summary: 'Unhide a post for the authenticated user' })
  @ApiBody({ schema: { type: 'object', properties: { postId: { type: 'string', description: 'Post ID to unhide' } }, required: ['postId'] } })
  async unhidePost(@Req() req: Request, @Body('postId') postId: string) {
    const userId = (req.user as any).userId;
    return this.postService.unhidePost(postId, userId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Get('getHidePost')
  @ApiOperation({ summary: 'Get all hidden posts for the authenticated user' })
  async getHidePost(@Req() req: Request) {
    const userId = (req.user as any).userId;
    return this.postService.getHidePost(userId);
  }

  // Chat functionality endpoints
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('sendMessage')
  @ApiOperation({ summary: 'Send a message to another user' })
  @ApiBody({ type: SendMessageDto })
  async sendMessage(@Req() req: Request, @Body(new ValidationPipe({ whitelist: true })) dto: SendMessageDto) {
    const senderId = (req.user as any).userId;
    return this.postService.sendMessage(senderId, dto.receiverId, dto.message);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Get('conversations')
  @ApiOperation({ summary: 'Get all conversations for the authenticated user' })
  async getConversations(@Req() req: Request) {
    const userId = (req.user as any).userId;
    return this.postService.getConversations(userId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Get('conversation/:otherUserId')
  @ApiOperation({ summary: 'Get conversation with a specific user' })
  @ApiParam({ name: 'otherUserId', type: 'string', description: 'ID of the other user' })
  async getConversationWithUser(@Req() req: Request, @Param('otherUserId') otherUserId: string) {
    const userId = (req.user as any).userId;
    return this.postService.getConversationWithUser(userId, otherUserId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Get('getUserChatBox')
  @ApiOperation({ summary: 'Get all chat boxes for the authenticated user with conversation details' })
  async getUserChatBox(@Req() req: Request) {
    const userId = (req.user as any).userId;
    return this.postService.getUserChatBox(userId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('chatStatusUpdate')
  @ApiOperation({ summary: 'Update chat status to mark messages as seen' })
  @ApiBody({ type: ChatStatusUpdateDto })
  async chatStatusUpdate(@Body(new ValidationPipe({ whitelist: true })) dto: ChatStatusUpdateDto) {
    return this.postService.chatStatusUpdate(dto.chatId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('hideChat')
  @ApiOperation({ summary: 'Hide a chat for the authenticated user' })
  @ApiBody({ type: HideChatDto })
  async hideChat(@Req() req: Request, @Body(new ValidationPipe({ whitelist: true })) dto: HideChatDto) {
    const userId = (req.user as any).userId;
    return this.postService.hideChat(dto.chatId, userId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('unhideChat')
  @ApiOperation({ summary: 'Unhide a chat for the authenticated user' })
  @ApiBody({ type: HideChatDto })
  async unhideChat(@Req() req: Request, @Body(new ValidationPipe({ whitelist: true })) dto: HideChatDto) {
    const userId = (req.user as any).userId;
    return this.postService.unhideChat(dto.chatId, userId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post('deleteConversation')
  @ApiOperation({ summary: 'Delete conversation for current user (soft delete; permanently deletes when both users delete)' })
  @ApiBody({ type: DeleteConversationDto })
  async deleteConversation(
    @Req() req: Request,
    @Body(new ValidationPipe({ whitelist: true, transform: true })) dto: DeleteConversationDto,
  ) {
    const userId = (req.user as any).userId;
    return this.postService.deleteConversation(userId, dto.conversationId, dto.type);
  }

}
