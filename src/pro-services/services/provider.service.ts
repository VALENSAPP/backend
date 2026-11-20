import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ServiceProvider } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ActivateProviderDto, UpdateProviderDto } from '../dto/provider.dto';
import { assertTimeZone, isBusinessAccount } from '../pro-services.utils';

export type EligibilityCode = 'MEMBERSHIP_REQUIRED' | 'KYC_REQUIRED' | 'PAYOUT_ACCOUNT_REQUIRED' | 'NOT_ACTIVATED';

export interface ServicesEligibility {
    accountType: 'PERSONA' | 'BUSINESS';
    isActivated: boolean;
    /** Can open the wizards and save drafts */
    canCreateServices: boolean;
    /** Can publish and receive bookings */
    canSell: boolean;
    /** Show the "upgrade to Valens Membership" pop-up */
    upgradeRequired: boolean;
    checks: {
        membershipActive: boolean;
        kycVerified: boolean;
        payoutAccountReady: boolean;
    };
    missing: EligibilityCode[];
    paymentProvider: string;
    membershipGraceEndsAt: Date | null;
    servicesDisabledAt: Date | null;
}

@Injectable()
export class ProviderService {
    constructor(private readonly prisma: PrismaService) { }

    /** Screen P1 / P2 / P18: can this user sell services, and if not, why. */
    async getEligibility(userId: string): Promise<ServicesEligibility> {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                profile: true,
                kyc: true,
                subscriptionStatus: true,
                subscriptionEnd: true,
                currentPeriodEnd: true,
                paymentProvider: true,
                stripeAccountId: true,
                pagbankAccountId: true,
                companyProfile: { select: { id: true } },
                serviceProvider: true,
            },
        });
        if (!user) throw new NotFoundException('User not found');

        const membershipActive = this.isMembershipActive(user);
        const kycVerified = Boolean(user.kyc);
        const paymentProvider = (user.paymentProvider || 'STRIPE').toUpperCase();
        const payoutAccountReady =
            paymentProvider === 'PAGBANK' ? Boolean(user.pagbankAccountId) : Boolean(user.stripeAccountId);
        const isActivated = Boolean(user.serviceProvider?.isActive);

        const missing: EligibilityCode[] = [];
        if (!membershipActive) missing.push('MEMBERSHIP_REQUIRED');
        if (!kycVerified) missing.push('KYC_REQUIRED');
        if (!payoutAccountReady) missing.push('PAYOUT_ACCOUNT_REQUIRED');
        if (!isActivated) missing.push('NOT_ACTIVATED');

        return {
            accountType: isBusinessAccount(user.profile, Boolean(user.companyProfile)) ? 'BUSINESS' : 'PERSONA',
            isActivated,
            canCreateServices: membershipActive && isActivated,
            canSell: missing.length === 0,
            upgradeRequired: !membershipActive,
            checks: { membershipActive, kycVerified, payoutAccountReady },
            missing,
            paymentProvider,
            membershipGraceEndsAt: user.serviceProvider?.membershipGraceEndsAt ?? null,
            servicesDisabledAt: user.serviceProvider?.servicesDisabledAt ?? null,
        };
    }

    /** Screen P3: "Activate Services". Needs an active Valens Membership (Persona and Business). */
    async activate(userId: string, dto: ActivateProviderDto) {
        const eligibility = await this.getEligibility(userId);
        if (!eligibility.checks.membershipActive) {
            throw new ForbiddenException({
                statusCode: 403,
                error: 'Forbidden',
                code: 'MEMBERSHIP_REQUIRED',
                accountType: eligibility.accountType,
                message: 'An active Valens Membership is required to activate Services.',
            });
        }

        const timezone = dto.timezone ? assertTimeZone(dto.timezone) : undefined;
        const provider = await this.prisma.serviceProvider.upsert({
            where: { userId },
            create: {
                userId,
                headline: dto.headline?.trim() || null,
                about: dto.about?.trim() || null,
                timezone: timezone || 'UTC',
            },
            update: {
                isActive: true,
                ...(dto.headline !== undefined ? { headline: dto.headline.trim() || null } : {}),
                ...(dto.about !== undefined ? { about: dto.about.trim() || null } : {}),
                ...(timezone ? { timezone } : {}),
            },
        });

        return {
            message: 'Services activated',
            provider: this.present(provider),
            eligibility: await this.getEligibility(userId),
        };
    }

    async getMyProfile(userId: string) {
        const provider = await this.prisma.serviceProvider.findUnique({ where: { userId } });
        if (!provider) throw new NotFoundException('Services are not activated for this account');
        return this.present(provider);
    }

    async updateMyProfile(userId: string, dto: UpdateProviderDto) {
        await this.getMyProfile(userId);
        const timezone = dto.timezone ? assertTimeZone(dto.timezone) : undefined;
        const provider = await this.prisma.serviceProvider.update({
            where: { userId },
            data: {
                ...(dto.headline !== undefined ? { headline: dto.headline.trim() || null } : {}),
                ...(dto.about !== undefined ? { about: dto.about.trim() || null } : {}),
                ...(timezone ? { timezone } : {}),
            },
        });
        return this.present(provider);
    }

    /** Used by the create / edit routes: activated + active membership (drafts allowed without KYC). */
    async assertCanManage(userId: string): Promise<ServiceProvider> {
        const eligibility = await this.getEligibility(userId);
        if (!eligibility.isActivated) {
            throw new ForbiddenException({
                statusCode: 403,
                error: 'Forbidden',
                code: 'NOT_ACTIVATED',
                message: 'Activate Services before creating a service.',
            });
        }
        if (!eligibility.checks.membershipActive) {
            throw new ForbiddenException({
                statusCode: 403,
                error: 'Forbidden',
                code: 'MEMBERSHIP_REQUIRED',
                accountType: eligibility.accountType,
                message: 'An active Valens Membership is required to manage Services.',
            });
        }
        const provider = await this.prisma.serviceProvider.findUnique({ where: { userId } });
        return provider as ServiceProvider;
    }

    /** Used by publish / resume: everything must be in place to take money. */
    async assertCanSell(userId: string): Promise<ServicesEligibility> {
        const eligibility = await this.getEligibility(userId);
        if (!eligibility.canSell) {
            const first = eligibility.missing[0];
            const messages: Record<EligibilityCode, string> = {
                MEMBERSHIP_REQUIRED: 'An active Valens Membership is required to publish services.',
                KYC_REQUIRED: 'Complete KYC verification before publishing services.',
                PAYOUT_ACCOUNT_REQUIRED: 'Connect a payout account before publishing services.',
                NOT_ACTIVATED: 'Activate Services before publishing.',
            };
            throw new ForbiddenException({
                statusCode: 403,
                error: 'Forbidden',
                code: first,
                missing: eligibility.missing,
                message: messages[first],
            });
        }
        return eligibility;
    }

    /**
     * Active membership = Stripe/PagBank status ACTIVE or PAST_DUE (billing retry window),
     * or CANCELED but still inside the paid period.
     */
    private isMembershipActive(user: {
        subscriptionStatus: string | null;
        subscriptionEnd: Date | null;
        currentPeriodEnd: Date | null;
    }): boolean {
        const status = (user.subscriptionStatus || '').toUpperCase();
        if (status === 'ACTIVE' || status === 'PAST_DUE') return true;
        const paidUntil = user.currentPeriodEnd || user.subscriptionEnd;
        return status === 'CANCELED' && Boolean(paidUntil && paidUntil.getTime() > Date.now());
    }

    private present(provider: ServiceProvider) {
        return {
            id: provider.id,
            userId: provider.userId,
            headline: provider.headline,
            about: provider.about,
            timezone: provider.timezone,
            isActive: provider.isActive,
            ratingAvg: Number(provider.ratingAvg.toFixed(1)),
            reviewCount: provider.reviewCount,
            clientCount: provider.clientCount,
            activatedAt: provider.activatedAt,
        };
    }
}
