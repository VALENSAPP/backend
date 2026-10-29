import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export async function assertUserKyc(
  prisma: PrismaService,
  userId: string,
  role: 'PAYER' | 'RECEIVER' = 'PAYER',
): Promise<void> {
  if (!userId) {
    throw new NotFoundException('User not found');
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, kyc: true },
  });

  if (!user) {
    throw new NotFoundException(`User ${userId} not found`);
  }

  if (!user.kyc) {
    if (role === 'RECEIVER') {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: 'The creator or seller has not completed KYC verification yet and cannot receive payments.',
        code: 'KYC_REQUIRED',
        target: 'RECEIVER',
      });
    } else {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: 'KYC verification is required before making payments or transactions.',
        code: 'KYC_REQUIRED',
        target: 'PAYER',
      });
    }
  }
}

