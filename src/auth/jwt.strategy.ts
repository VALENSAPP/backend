import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';
import { log } from 'node:console';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'valens_secret',
    });
  }
  async validate(payload: any) {
    // console.log('JWT payload:', payload);

    // Check if user exists and is not deleted
    const user = await this.prisma.user.findFirst({
      where: {
        id: payload.sub,
        isDeleted: 0,
      },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if ((user as any).isBlocked) {
      throw new UnauthorizedException(
        `Account has been blocked by administrator${(user as any).blockedReason ? ': ' + (user as any).blockedReason : '.'}`,
      );
    }

    if (user.bannedUntil && user.bannedUntil > new Date()) {
      const remainingMs = user.bannedUntil.getTime() - Date.now();
      const remainingHours = Math.max(1, Math.ceil(remainingMs / (1000 * 60 * 60)));
      throw new UnauthorizedException(
        `Account is temporarily suspended until ${user.bannedUntil.toUTCString()} (approx. ${remainingHours}h remaining) due to security policy violations.`,
      );
    }

    return {
      userId: payload.sub,
      email: payload.email,
      registrationType: payload.registrationType,
      profile: user.profile,
      sessionId: payload.sessionId,
      kyc: Boolean(user.kyc),
    };
  }
}
