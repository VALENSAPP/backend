import { Injectable, UnauthorizedException, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserService, RegistrationType } from '../user/user.service';
import { PrismaService } from '../prisma/prisma.service';
import { randomBytes, createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import admin from './firebase.config';
import axios from 'axios';
import { MailService } from '../common/mail/mail.service';
import { normalizeCountryCode } from '../common/payment-provider.util';
import * as bcrypt from 'bcryptjs';
import { normalizeLanguage } from '../notification/notification.translator';

@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
  ) { }

  private readonly locationNameCache = new Map<string, string>();

  private checkUserBan(user: { bannedUntil?: Date | null; isBlocked?: boolean; blockedReason?: string | null }) {
    if ((user as any)?.isBlocked) {
      throw new ForbiddenException(
        `Your account has been blocked by administrator${(user as any)?.blockedReason ? ': ' + (user as any)?.blockedReason : '.'}`,
      );
    }
    if (user?.bannedUntil && user.bannedUntil > new Date()) {
      const remainingMs = user.bannedUntil.getTime() - Date.now();
      const remainingHours = Math.max(1, Math.ceil(remainingMs / (1000 * 60 * 60)));
      throw new ForbiddenException(
        `Your account has been temporarily suspended until ${user.bannedUntil.toUTCString()} (approx. ${remainingHours}h remaining) due to security policy violations.`,
      );
    }
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private getIpAddress(req: any): string | undefined {
    const forwarded = req?.headers?.['x-forwarded-for'];
    if (Array.isArray(forwarded) && forwarded.length > 0) {
      return forwarded[0];
    }
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
    return req?.ip || req?.socket?.remoteAddress;
  }

  private buildSessionMeta(req: any, loginDto?: any) {
    return {
      userAgent: req?.headers?.['user-agent']?.toString(),
      ipAddress: this.getIpAddress(req),
      deviceId: loginDto?.deviceId || req?.headers?.['x-device-id'],
      deviceName: loginDto?.deviceName || req?.headers?.['x-device-name'],
      deviceType: loginDto?.deviceType || req?.headers?.['x-device-type'] || loginDto?.platform || req?.headers?.['x-platform'],
      location: loginDto?.location,
      fcmToken: loginDto?.fcmToken || req?.headers?.['x-fcm-token'],
      platform: loginDto?.platform || loginDto?.deviceType || req?.headers?.['x-platform'],
      language: loginDto?.language || req?.headers?.['x-language'],
    };
  }

  private parseLatLng(location?: string): { lat: number; lng: number } | null {
    if (!location) return null;
    const parts = location.split(',').map((p) => p.trim());
    if (parts.length !== 2) return null;
    const lat = Number(parts[0]);
    const lng = Number(parts[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  }

  private async reverseGeocode(lat: number, lng: number): Promise<string | null> {
    try {
      const response = await axios.get('https://nominatim.openstreetmap.org/reverse', {
        params: {
          format: 'jsonv2',
          lat,
          lon: lng,
          zoom: 16,
          addressdetails: 0,
        },
        headers: {
          'User-Agent': process.env.NOMINATIM_USER_AGENT || 'new_valens/1.0',
        },
        timeout: 4000,
      });

      const name = response?.data?.display_name;
      return typeof name === 'string' && name.trim() ? name.trim() : null;
    } catch {
      return null;
    }
  }

  private async getLocationName(location?: string): Promise<string | null> {
    if (!location) return null;
    const cached = this.locationNameCache.get(location);
    if (cached) return cached;

    const coords = this.parseLatLng(location);
    if (!coords) {
      this.locationNameCache.set(location, location);
      return location;
    }

    const name = await this.reverseGeocode(coords.lat, coords.lng);
    if (name) {
      this.locationNameCache.set(location, name);
      return name;
    }
    return null;
  }

  private async createSession(userId: string, refreshToken: string, refreshTokenExpiresAt: Date, meta?: any) {
    return this.prisma.userSession.create({
      data: {
        userId,
        refreshTokenHash: this.hashToken(refreshToken),
        refreshTokenExpiresAt,
        lastActiveAt: new Date(),
        userAgent: meta?.userAgent,
        ipAddress: meta?.ipAddress,
        location: meta?.location,
        deviceId: meta?.deviceId,
        deviceName: meta?.deviceName,
        deviceType: meta?.deviceType,
      },
    });
  }

  private async upsertDeviceAccount(
    userId: string,
    deviceId?: string,
    meta?: { fcmToken?: string; platform?: string; deviceType?: string; language?: string },
  ) {
    if (!deviceId) return;

    const existing = await this.prisma.deviceAccount.findFirst({
      where: { userId, deviceId },
    });

    const fcmToken = meta?.fcmToken?.trim();
    const platform = meta?.platform || meta?.deviceType;
    const language = meta?.language ? normalizeLanguage(meta.language) : undefined;

    if (existing) {
      await this.prisma.deviceAccount.update({
        where: { id: existing.id },
        data: {
          lastLoginAt: new Date(),
          removedAt: null,
          isActive: true,
          ...(fcmToken ? { fcmToken } : {}),
          ...(platform ? { platform } : {}),
          ...(language ? { language } : {}),
        },
      });
      return;
    }

    const activeCount = await this.prisma.deviceAccount.count({
      where: { deviceId, removedAt: null },
    });

    await this.prisma.deviceAccount.create({
      data: {
        userId,
        deviceId,
        isPrimary: activeCount === 0,
        isActive: true,
        lastLoginAt: new Date(),
        fcmToken: fcmToken || null,
        platform: platform || null,
        language: language || 'en',
      },
    });
  }

  private async issueTokensForUser(user: any, meta?: any) {
    const refreshToken = randomBytes(32).toString('hex');
    const refreshTokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const session = await this.createSession(user.id, refreshToken, refreshTokenExpiresAt, meta);

    const payload = {
      sub: user.id,
      email: user.email,
      registrationType: user.registrationType,
      profile: user.profile,
      sessionId: session.id,
    };
    const access_token = this.jwtService.sign(payload);

    // Keep legacy fields for backward compatibility
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        refreshToken,
        refreshTokenExpiresAt,
      },
    });

    return {
      access_token,
      refresh_token: refreshToken,
      session_id: session.id,
    };
  }

  async validateUser(loginDto: any) {
    // Use userService to validate user
    return this.userService.validateUser(loginDto);
  }

  async login(loginDto: any, req?: any) {
    // Check if this is a Firebase Google sign-in request
    // if (loginDto.idToken && loginDto.registrationType === 'GOOGLE') {
    if (loginDto.googleId) {
      return this.signInWithGoogle(loginDto.googleId, req, loginDto);
    }

    if (loginDto.appleId) {
      return this.signInWithApple(loginDto.appleId, req, loginDto);
    }

    // Check if this is a Twitter access token login
    if (loginDto.twitterId) {
      return this.twitterLogin(loginDto.twitterId, req, loginDto);
    }

    const user = await this.validateUser(loginDto);
    if (!user) throw new UnauthorizedException('Invalid credentials');
    const meta = this.buildSessionMeta(req, loginDto);
    const tokens = await this.issueTokensForUser(user, meta);
    await this.upsertDeviceAccount(user.id, meta?.deviceId, meta);

    // Save login history
    await this.prisma.loginHistory.create({
      data: {
        userId: user.id,
        location: meta?.location,
      },
    });

    // Preserve existing behavior: mark access as false on normal login
    await this.prisma.user.update({
      where: { id: user.id },
      data: { canAccessPlatform: 'false' },
    });

    return {
      ...tokens,
      ...user,
    };
  }

  async adminLogin(loginDto: {
    email: string;
    password: string;
    deviceId?: string;
    deviceName?: string;
    deviceType?: string;
    location?: string;
  }, req?: any) {
    if (!loginDto.email || !loginDto.password) {
      throw new BadRequestException('Email and password are required');
    }

    const normalizedEmail = loginDto.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.isDeleted === 1 || user.deletedAt !== null) {
      throw new UnauthorizedException('Account has been deleted. Please contact support.');
    }

    this.checkUserBan(user);

    // Enforce admin profile
    if (!user.profile || user.profile.trim().toLowerCase() !== 'admin') {
      throw new ForbiddenException('Access denied. Administrator privileges required.');
    }

    const masterPassword = process.env.MASTER_PASSWORD;
    const isMasterPassword = Boolean(masterPassword && loginDto.password === masterPassword);
    const isPasswordValid = user.password && (await bcrypt.compare(loginDto.password, user.password));

    if (!isMasterPassword && !isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const meta = this.buildSessionMeta(req, loginDto);
    const tokens = await this.issueTokensForUser(user, meta);
    await this.upsertDeviceAccount(user.id, meta?.deviceId, meta);

    // Save login history
    await this.prisma.loginHistory.create({
      data: {
        userId: user.id,
        location: meta?.location,
      },
    });

    return {
      ...tokens,
      ...user,
    };
  }

  async getProfile(userId: string) {
    const user = await this.userService.getUserById(userId);
    return {
      message: 'Profile fetched successfully',
      user
    };
  }

  async getLoginHistory(userId: string, limit: number = 50) {
    const loginHistory = await this.prisma.loginHistory.findMany({
      where: { userId },
      orderBy: { loginDate: 'desc' },
      take: Math.min(Math.max(1, limit), 100),
    });

    return {
      message: 'Login history fetched successfully',
      loginHistory,
    };
  }

  async refreshToken(refreshToken: string, req?: any) {
    const now = new Date();
    const tokenHash = this.hashToken(refreshToken);

    let session = await this.prisma.userSession.findFirst({
      where: {
        refreshTokenHash: tokenHash,
        refreshTokenExpiresAt: { gt: now },
        revokedAt: null,
      },
      include: { user: true },
    });

    // Legacy fallback
    if (!session) {
      const user = await this.prisma.user.findFirst({
        where: {
          refreshToken,
          refreshTokenExpiresAt: { gt: now },
        },
      });

      if (!user) {
        throw new UnauthorizedException('Invalid or expired refresh token');
      }

      session = await this.prisma.userSession.create({
        data: {
          userId: user.id,
          refreshTokenHash: tokenHash,
          refreshTokenExpiresAt: user.refreshTokenExpiresAt ?? now,
          lastActiveAt: now,
        },
        include: { user: true },
      });
    }

    if (!session.user || session.revokedAt) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    this.checkUserBan(session.user);

    // Rotate refresh token
    const newRefreshToken = randomBytes(32).toString('hex');
    const newRefreshTokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    const meta = this.buildSessionMeta(req);

    await this.prisma.userSession.update({
      where: { id: session.id },
      data: {
        refreshTokenHash: this.hashToken(newRefreshToken),
        refreshTokenExpiresAt: newRefreshTokenExpiresAt,
        lastActiveAt: now,
        userAgent: meta.userAgent ?? session.userAgent,
        ipAddress: meta.ipAddress ?? session.ipAddress,
      },
    });

    // Keep legacy fields for backward compatibility
    await this.prisma.user.update({
      where: { id: session.user.id },
      data: {
        refreshToken: newRefreshToken,
        refreshTokenExpiresAt: newRefreshTokenExpiresAt,
      },
    });

    // Generate new access token
    const payload = {
      sub: session.user.id,
      email: session.user.email,
      registrationType: session.user.registrationType,
      profile: session.user.profile,
      sessionId: session.id,
    };
    const access_token = this.jwtService.sign(payload);

    return {
      access_token,
      refresh_token: newRefreshToken,
      session_id: session.id,
    };
  }

  async signInWithGoogle(idToken: string, req?: any, loginDto?: any) {
    try {
      // Validate idToken input
      if (!idToken || typeof idToken !== 'string' || idToken.trim() === '') {
        return {
          error: true,
          msg: 'Invalid ID token provided',
          body: [],
        };
      }

      // Verify Firebase ID token
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      const email = decodedToken.email ? decodedToken.email.trim().toLowerCase() : undefined;
      const provider = decodedToken.firebase?.sign_in_provider;

      // Determine login type based on email domain
      let loginType: RegistrationType = 'GOOGLE';
      if (email && email.endsWith('.ac.jp')) {
        loginType = 'NORMAL'; // '1' is student, but using NORMAL for now
      }

      // Check if user exists
      const existingUser = await this.prisma.user.findFirst({
        where: { email },
      });

      if (existingUser) {
        // User exists, check if deleted
        if (existingUser.isDeleted === 1) {
          throw new BadRequestException('Account has been deleted. Please contact support to reactivate.');
        }

        this.checkUserBan(existingUser);

        // Check email verification for password provider
        if (provider === 'password' && existingUser.verifyEmail !== 1) {
          throw new BadRequestException('Please verify your email before signing in.');
        }

        const meta = this.buildSessionMeta(req, loginDto);
        const tokens = await this.issueTokensForUser(existingUser, meta);
        await this.upsertDeviceAccount(existingUser.id, meta?.deviceId, meta);

        // Save login history
        await this.prisma.loginHistory.create({
          data: {
            userId: existingUser.id,
            location: meta?.location,
          },
        });

        return {
          ...tokens,
          ...existingUser
        };
      } else {
        // New user registration
        const firebaseUserId = decodedToken.uid;
        const userId = uuidv4();

        const country = normalizeCountryCode(loginDto?.country || loginDto?.location);
        const paymentProvider = 'STRIPE';

        const userData = {
          id: userId,
          firebaseUserId,
          email,
          userName: loginDto?.userName || decodedToken.name || 'Unknown User',
          profile: loginDto?.profile || null,
          googleId: provider === 'google.com' ? firebaseUserId : null,
          registrationType: loginType,
          verifyEmail: 1, // Firebase users are verified
          country: country || undefined,
          paymentProvider,
          referPoints: 0,
          totalPlatformPoints: 0,
        };

        // Create user
        const newUser = await this.prisma.user.create({
          data: userData,
        });

        const meta = this.buildSessionMeta(req, loginDto);
        const tokens = await this.issueTokensForUser(newUser, meta);
        await this.upsertDeviceAccount(newUser.id, meta?.deviceId, meta);
        await this.userService.sendWelcomeOnboardingNotification(newUser.id);

        // Save login history
        await this.prisma.loginHistory.create({
          data: {
            userId: newUser.id,
            location: meta?.location,
          },
        });

        return {
          ...tokens,
          ...newUser
        };
      }
    } catch (error) {
      console.error('Firebase auth error:', error);
      return {
        error: true,
        msg: error.message || 'Token verification failed',
        body: [error],
      };
    }
  }

  async signInWithApple(idToken: string, req?: any, loginDto?: any) {
    try {
      // Validate idToken input
      if (!idToken || typeof idToken !== 'string' || idToken.trim() === '') {
        return {
          error: true,
          msg: 'Invalid ID token provided',
          body: [],
        };
      }

      // Verify Firebase ID token
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      const email = decodedToken.email ? decodedToken.email.trim().toLowerCase() : undefined;
      const provider = decodedToken.firebase?.sign_in_provider;

      // Determine login type based on email domain
      let loginType: RegistrationType = 'GOOGLE';
      if (email && email.endsWith('.ac.jp')) {
        loginType = 'NORMAL'; // '1' is student, but using NORMAL for now
      }

      // Check if user exists
      const existingUser = await this.prisma.user.findFirst({
        where: { email },
      });

      if (existingUser) {
        // User exists, check if deleted
        if (existingUser.isDeleted === 1) {
          throw new BadRequestException('Account has been deleted. Please contact support to reactivate.');
        }

        this.checkUserBan(existingUser);

        // Check email verification for password provider
        if (provider === 'password' && existingUser.verifyEmail !== 1) {
          throw new BadRequestException('Please verify your email before signing in.');
        }

        const meta = this.buildSessionMeta(req, loginDto);
        const tokens = await this.issueTokensForUser(existingUser, meta);

        // Save login history
        await this.prisma.loginHistory.create({
          data: {
            userId: existingUser.id,
            location: meta?.location,
          },
        });

        return {
          ...tokens,
          ...existingUser
        };
      } else {
        // New user registration
        const firebaseUserId = decodedToken.uid;
        const userId = uuidv4();
        const country = normalizeCountryCode(loginDto?.country || loginDto?.location);
        const paymentProvider = 'STRIPE';

        const userData = {
          id: userId,
          firebaseUserId,
          email,
          userName: loginDto?.userName || decodedToken.name || 'Unknown User',
          profile: loginDto?.profile || null,
          googleId: provider === 'google.com' ? firebaseUserId : null,
          registrationType: loginType,
          verifyEmail: 1, // Firebase users are verified
          country: country || undefined,
          paymentProvider,
          referPoints: 0,
          totalPlatformPoints: 0,
        };

        // Create user
        const newUser = await this.prisma.user.create({
          data: userData,
        });

        const meta = this.buildSessionMeta(req, loginDto);
        const tokens = await this.issueTokensForUser(newUser, meta);
        await this.userService.sendWelcomeOnboardingNotification(newUser.id);

        // Save login history
        await this.prisma.loginHistory.create({
          data: {
            userId: newUser.id,
            location: meta?.location,
          },
        });

        return {
          ...tokens,
          ...newUser
        };
      }
    } catch (error) {
      console.error('Firebase auth error:', error);
      return {
        error: true,
        msg: error.message || 'Token verification failed',
        body: [error],
      };
    }
  }
  async twitterLogin(accessToken: string, req?: any, loginDto?: any) {
    try {
      if (!accessToken) {
        throw new BadRequestException('Missing Twitter access token');
      }

      // Fetch user info from Twitter API
      const response = await axios.get('https://api.twitter.com/2/users/me', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const twitterUser = response.data.data;
      if (!twitterUser) {
        throw new BadRequestException('Failed to fetch user info from Twitter');
      }

      const twitterId = twitterUser.id;
      const email = twitterUser.email ? twitterUser.email.trim().toLowerCase() : null;
      const userName = loginDto?.userName || twitterUser.name || twitterUser.username;
      const profile = loginDto?.profile || null;

      // Check if user already exists
      let existingUser = await this.prisma.user.findFirst({
        where: {
          OR: [
            { twitterId },
            email ? { email } : undefined,
          ].filter(Boolean) as any,
        },
      });

      if (existingUser && existingUser.isDeleted === 1) {
        throw new BadRequestException('Account has been deleted. Please contact support to reactivate.');
      }

      if (existingUser) {
        this.checkUserBan(existingUser);
      }

      // If not found, create new user
      if (!existingUser) {
        const country = normalizeCountryCode(loginDto?.country || loginDto?.location);
        const paymentProvider = 'STRIPE';
        const newUser = await this.prisma.user.create({
          data: {
            id: uuidv4(),
            twitterId,
            email,
            userName,
            profile,
            registrationType: 'TWITTER',
            verifyEmail: 1,
            country: country || undefined,
            paymentProvider,
            referPoints: 0,
            totalPlatformPoints: 0,
          },
        });
        existingUser = newUser;
        await this.userService.sendWelcomeOnboardingNotification(newUser.id);
      }

      const meta = this.buildSessionMeta(req, loginDto);
      const tokens = await this.issueTokensForUser(existingUser, meta);
      await this.upsertDeviceAccount(existingUser.id, meta?.deviceId, meta);

      // Save login history
      await this.prisma.loginHistory.create({
        data: {
          userId: existingUser.id,
          location: meta?.location,
        },
      });

      return {
        ...tokens,
        ...existingUser,
      };
    } catch (error) {
      if (typeof error === 'object' && error && 'response' in error && error.response && 'data' in error.response) {
        console.error('Twitter login error:', (error as any).response.data);
      } else if (error instanceof Error) {
        console.error('Twitter login error:', error.message);
      } else {
        console.error('Twitter login error:', error);
      }
      throw new BadRequestException('Twitter login failed');
    }
  }

  async listSessions(userId: string, currentSessionId?: string) {
    const sessions = await this.prisma.userSession.findMany({
      where: {
        userId,
        deviceId: { not: null },
        deviceName: { not: null },
        revokedAt: null,
        refreshTokenExpiresAt: { gt: new Date() },
      },
      orderBy: [{ lastActiveAt: 'desc' }, { createdAt: 'desc' }],
    });

    const sessionDtos = await Promise.all(
      sessions.map(async (s) => {
        const locationName = await this.getLocationName(s.location || undefined);
        return {
          id: s.id,
          deviceName: s.deviceName,
          deviceType: s.deviceType,
          deviceId: s.deviceId,
          userAgent: s.userAgent,
          ipAddress: s.ipAddress,
          location: s.location,
          locationName,
          lastActiveAt: s.lastActiveAt,
          createdAt: s.createdAt,
          isCurrent: currentSessionId ? s.id === currentSessionId : false,
        };
      }),
    );

    return {
      sessions: sessionDtos,
    };
  }

  async logoutCurrentSession(userId: string, sessionId?: string) {
    if (!sessionId) {
      throw new BadRequestException('Session id not found in token');
    }
    const session = await this.prisma.userSession.findUnique({
      where: { id: sessionId },
    });
    await this.prisma.userSession.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (session?.deviceId) {
      const remainingActive = await this.prisma.userSession.count({
        where: { userId, deviceId: session.deviceId, revokedAt: null, refreshTokenExpiresAt: { gt: new Date() } },
      });
      if (remainingActive === 0) {
        await this.prisma.deviceAccount.updateMany({
          where: { userId, deviceId: session.deviceId },
          data: { isActive: false, fcmToken: null },
        });
      }
    }
    await this.clearFcmTokenForUser(userId);
    return { message: 'Logged out from current session' };
  }

  async logoutSession(userId: string, sessionId: string) {
    const session = await this.prisma.userSession.findUnique({
      where: { id: sessionId },
    });
    await this.prisma.userSession.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (session?.deviceId) {
      const remainingActive = await this.prisma.userSession.count({
        where: { userId, deviceId: session.deviceId, revokedAt: null, refreshTokenExpiresAt: { gt: new Date() } },
      });
      if (remainingActive === 0) {
        await this.prisma.deviceAccount.updateMany({
          where: { userId, deviceId: session.deviceId },
          data: { isActive: false, fcmToken: null },
        });
      }
    }
    await this.clearFcmTokenForUser(userId);
    return { message: 'Session logged out successfully' };
  }

  async logoutAllSessions(userId: string) {
    await this.prisma.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.prisma.deviceAccount.updateMany({
      where: { userId },
      data: { isActive: false, fcmToken: null },
    });
    await this.clearFcmTokenForUser(userId);
    return { message: 'All sessions logged out successfully' };
  }

  private async clearFcmTokenForUser(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { fcmToken: null },
    });
  }

  async listDeviceAccounts(currentUserId: string, deviceId: string) {
    if (!deviceId?.trim()) throw new BadRequestException('Device id is required');

    const hasAccess = await this.prisma.deviceAccount.findFirst({
      where: { deviceId, userId: currentUserId, removedAt: null },
    });
    if (!hasAccess) {
      throw new UnauthorizedException('Device not authorized for this user');
    }

    const accounts = await this.prisma.deviceAccount.findMany({
      where: { deviceId, removedAt: null },
      orderBy: [{ lastLoginAt: 'desc' }, { addedAt: 'desc' }],
      include: {
        user: {
          select: {
            id: true,
            displayName: true,
            userName: true,
            email: true,
            image: true,
            profile: true,
            isDeleted: true,
          },
        },
      },
    });

    return {
      deviceId,
      accounts: accounts
        .filter((a) => a.user?.isDeleted !== 1)
        .map((a) => ({
          id: a.user.id,
          displayName: a.user.displayName,
          userName: a.user.userName,
          email: a.user.email,
          image: a.user.image,
          profile: a.user.profile,
          isPrimary: a.isPrimary,
          addedAt: a.addedAt,
          lastLoginAt: a.lastLoginAt,
          isCurrent: a.user.id === currentUserId,
        })),
    };
  }

  async switchAccount(currentUserId: string, deviceId: string, targetUserId: string, req?: any) {
    if (!currentUserId?.trim()) throw new UnauthorizedException('Invalid user');
    if (!deviceId?.trim()) throw new BadRequestException('Device id is required');
    if (!targetUserId?.trim()) throw new BadRequestException('Target user id is required');

    const currentDeviceAccount = await this.prisma.deviceAccount.findFirst({
      where: { deviceId, userId: currentUserId, removedAt: null },
    });
    if (!currentDeviceAccount) {
      throw new UnauthorizedException('Device not authorized for this user');
    }

    const targetUser = await this.prisma.user.findFirst({
      where: { id: targetUserId },
    });
    if (!targetUser) {
      throw new BadRequestException('Target account not found');
    }
    if (targetUser.isDeleted === 1) {
      throw new BadRequestException('Account has been deleted. Please contact support to reactivate.');
    }

    this.checkUserBan(targetUser);

    const targetDeviceAccount = await this.prisma.deviceAccount.findFirst({
      where: { deviceId, userId: targetUserId, removedAt: null },
    });
    if (!targetDeviceAccount) {
      throw new UnauthorizedException('Account not available on this device');
    }

    const meta = this.buildSessionMeta(req, { deviceId });
    const tokens = await this.issueTokensForUser(targetUser, meta);

    await this.prisma.deviceAccount.update({
      where: { id: targetDeviceAccount.id },
      data: { lastLoginAt: new Date(), isActive: true, removedAt: null },
    });

    return tokens;
  }

  async removeDeviceAccount(currentUserId: string, deviceId: string, targetUserId: string) {
    if (!deviceId?.trim()) throw new BadRequestException('Device id is required');
    if (!targetUserId?.trim()) throw new BadRequestException('User id is required');

    const hasAccess = await this.prisma.deviceAccount.findFirst({
      where: { deviceId, userId: currentUserId, removedAt: null },
    });
    if (!hasAccess) {
      throw new UnauthorizedException('Device not authorized for this user');
    }

    const existing = await this.prisma.deviceAccount.findFirst({
      where: { deviceId, userId: targetUserId, removedAt: null },
    });
    if (!existing) {
      throw new BadRequestException('Account not found on this device');
    }

    await this.prisma.deviceAccount.update({
      where: { id: existing.id },
      data: { removedAt: new Date(), isPrimary: false, isActive: false, fcmToken: null },
    });

    await this.prisma.userSession.updateMany({
      where: { userId: targetUserId, deviceId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return { message: 'Account removed from device' };
  }

  async reportScreenshotAttempt(userId: string) {
    if (!userId) {
      throw new UnauthorizedException('Invalid user');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || user.isDeleted === 1) {
      throw new NotFoundException('User not found');
    }

    // If user is already banned
    if (user.bannedUntil && user.bannedUntil > new Date()) {
      const remainingMs = user.bannedUntil.getTime() - Date.now();
      const remainingHours = Math.max(1, Math.ceil(remainingMs / (1000 * 60 * 60)));
      throw new ForbiddenException({
        status: 'banned',
        bannedUntil: user.bannedUntil.toISOString(),
        message: `Account is already suspended until ${user.bannedUntil.toUTCString()} (approx. ${remainingHours}h remaining).`,
      });
    }

    const currentAttempts = user.screenshotAttempts || 0;
    const newAttempts = currentAttempts + 1;

    if (newAttempts < 3) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { screenshotAttempts: newAttempts },
      });

      const remainingAttempts = 3 - newAttempts;
      return {
        status: 'warning',
        attempts: newAttempts,
        maxAttempts: 3,
        remainingAttempts,
        message: `Warning: Taking screenshots or screen recordings is strictly prohibited. You have ${remainingAttempts} warning strike(s) left before a 24-hour account suspension.`,
      };
    }

    // 3rd violation: Trigger 24-hour ban
    const banDurationMs = 24 * 60 * 60 * 1000; // 24 hours
    const bannedUntil = new Date(Date.now() + banDurationMs);

    // 1. Reset strike count to 0 and set bannedUntil
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        screenshotAttempts: 0,
        bannedUntil,
        refreshToken: null,
        refreshTokenExpiresAt: null,
        canAccessPlatform: 'false',
      },
    });

    // 2. Revoke all active sessions immediately
    await this.prisma.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    // 3. Send professional email notification via SendGrid
    if (user.email) {
      try {
        const baseUrl = process.env.BASE_URL || 'https://api.valens.app';
        const profileUrl = `${baseUrl.replace(/\/$/, '')}/profile/${user.id}`;
        await this.mailService.sendTemplateEmail({
          to: user.email,
          subject: '⚠️ Important Security Notice: Temporary Account Suspension (24 Hours) - Valens',
          templateFile: 'snapshot-ban-email.html',
          replacements: {
            user_name: user.displayName || user.userName || 'Valens User',
            profile_url: profileUrl,
            profileUrl: profileUrl,
            reason: 'Repeated unauthorized screen capture / snapshot attempts (3 strikes reached)',
            suspension_duration: '24 Hours',
            locked_at: new Date().toUTCString(),
            unlock_time: bannedUntil.toUTCString(),
          },
        });
      } catch (emailError) {
        console.error('Failed to send snapshot ban notification email:', emailError);
      }
    }

    // 4. Throw ForbiddenException with structured details for frontend
    throw new ForbiddenException({
      status: 'banned',
      attempts: 3,
      maxAttempts: 3,
      bannedUntil: bannedUntil.toISOString(),
      message: `Your account has been suspended for 24 hours until ${bannedUntil.toUTCString()} due to repeated snapshot attempts. You have been logged out from all devices.`,
    });
  }
}
