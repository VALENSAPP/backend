import { Injectable, CanActivate, ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';

@Injectable()
export class KycGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    const userId = user?.userId || user?.sub || user?.id;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    if (user?.kyc !== true) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: 'KYC verification is required before initiating payments or transactions.',
        code: 'KYC_REQUIRED',
        target: 'PAYER',
      });
    }

    return true;
  }
}

