import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import {
    MarketplaceBattleBoostStatus,
    MarketplaceBattleOutcome,
    MarketplaceBattleStatus,
    Prisma,
} from '@prisma/client';
import Stripe from 'stripe';
import { PrismaService } from '../../prisma/prisma.service';
import { assertUserKyc } from '../../common/kyc.util';
import { PagBankService } from '../../pagbank/pagbank.service';
import { PaymentProviderResolver } from '../payment/payment-provider.resolver';
import { CreateMarketplaceBattleBoostDto } from './dto/create-marketplace-battle-boost.dto';
import {
    MARKETPLACE_BATTLE_BOOST_SORT_FIELDS,
    MarketplaceBattleBoostListQueryDto,
} from './dto/marketplace-battle-boost-list-query.dto';
import { MarketplaceBattleBoostActiveQueryDto } from './dto/marketplace-battle-boost-active-query.dto';

const BOOST_PAYMENT_TYPE = 'marketplace_battle_boost';

@Injectable()
export class MarketplaceBattleBoostService {
    private readonly stripe: Stripe;

    constructor(
        private readonly prisma: PrismaService,
        private readonly paymentProviderResolver: PaymentProviderResolver,
        private readonly pagBankService: PagBankService,
    ) {
        this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
            apiVersion: '2024-06-20',
        });
    }

    private assertUserId(userId?: string): string {
        if (!userId) throw new UnauthorizedException('User not authenticated');
        return userId;
    }

    private toMinorUnits(amount: Prisma.Decimal): number {
        const asFixed = amount.toFixed(2);
        return Math.round(Number(asFixed) * 100);
    }

    private normalizeCurrency(value: string): string {
        return String(value || '').trim().toUpperCase();
    }

    private isBattleEligibleForBoost(battle: {
        status: MarketplaceBattleStatus;
        startAt: Date | null;
        endAt: Date | null;
    }, now: Date): boolean {
        if (!battle.startAt || !battle.endAt) return false;

        if (battle.status === MarketplaceBattleStatus.LIVE) {
            return battle.startAt <= now && battle.endAt > now;
        }

        if (battle.status === MarketplaceBattleStatus.SCHEDULED) {
            return battle.startAt > now && battle.endAt > now;
        }

        return false;
    }

    async getActiveBoostPackages() {
        return this.prisma.marketplaceBattleBoostPackage.findMany({
            where: { isActive: true },
            orderBy: [{ createdAt: 'asc' }],
            select: {
                id: true,
                name: true,
                description: true,
                price: true,
                currency: true,
                durationHours: true,
            },
        });
    }

    async getBoostByBattleId(battleId: string) {
        const now = new Date();

        // Prefer a currently active boost, otherwise an unpaid pending intent.
        const boost =
            (await this.prisma.marketplaceBattleBoost.findFirst({
                where: {
                    battleId,
                    status: MarketplaceBattleBoostStatus.ACTIVE,
                    endAt: { gt: now },
                },
                orderBy: [{ createdAt: 'desc' }],
                select: {
                    id: true,
                    status: true,
                    createdAt: true,
                    endAt: true,
                },
            })) ||
            (await this.prisma.marketplaceBattleBoost.findFirst({
                where: {
                    battleId,
                    status: MarketplaceBattleBoostStatus.PENDING_PAYMENT,
                },
                orderBy: [{ createdAt: 'desc' }],
                select: {
                    id: true,
                    status: true,
                    createdAt: true,
                    endAt: true,
                },
            }));

        return {
            battleId,
            hasBoost: Boolean(boost),
            boostId: boost?.id ?? null,
            status: boost?.status ?? null,
            boostCreatedAt: boost?.createdAt ?? null,
            boostEndAt: boost?.endAt ?? null,
        };
    }

    async createBoostIntent(userId: string, battleId: string, dto: CreateMarketplaceBattleBoostDto) {
        const sellerId = this.assertUserId(userId);
        await assertUserKyc(this.prisma, sellerId, 'PAYER');
        const now = new Date();

        return this.prisma.$transaction(
            async (tx) => {
                await tx.$queryRaw`
          SELECT id
          FROM "MarketplaceBattle"
          WHERE id = ${battleId}
          FOR UPDATE
        `;

                const battle = await tx.marketplaceBattle.findUnique({
                    where: { id: battleId },
                    select: {
                        id: true,
                        sellerId: true,
                        closetId: true,
                        status: true,
                        startAt: true,
                        endAt: true,
                    },
                });

                if (!battle) {
                    throw new NotFoundException('Marketplace battle not found');
                }

                if (battle.sellerId !== sellerId) {
                    throw new ForbiddenException('Forbidden: you do not own this marketplace battle');
                }

                if (
                    battle.status !== MarketplaceBattleStatus.LIVE &&
                    battle.status !== MarketplaceBattleStatus.SCHEDULED &&
                    battle.status !== MarketplaceBattleStatus.COMPLETED
                ) {
                    throw new BadRequestException('Marketplace battle is not eligible for boost');
                }

                const boostPackage = await tx.marketplaceBattleBoostPackage.findUnique({
                    where: { id: dto.packageId },
                    select: {
                        id: true,
                        isActive: true,
                        price: true,
                        currency: true,
                    },
                });

                if (!boostPackage || !boostPackage.isActive) {
                    throw new BadRequestException('Marketplace battle boost package is not available');
                }

                if (!dto.pinOnTop && !dto.winnerBadge) {
                    throw new BadRequestException('At least one boost feature must be enabled');
                }

                if (boostPackage.price.lte(0)) {
                    throw new BadRequestException('Invalid boost package price');
                }

                const normalizedCurrency = this.normalizeCurrency(boostPackage.currency);
                if (!normalizedCurrency) {
                    throw new BadRequestException('Invalid boost package currency');
                }

                // Clear unpaid intents so seller can start a fresh boost checkout
                const pendingBoosts = await tx.marketplaceBattleBoost.findMany({
                    where: {
                        battleId: battle.id,
                        status: MarketplaceBattleBoostStatus.PENDING_PAYMENT,
                    },
                    select: { id: true, paymentId: true },
                });

                if (pendingBoosts.length > 0) {
                    const pendingPaymentIds = pendingBoosts
                        .map((boost) => boost.paymentId)
                        .filter((paymentId): paymentId is string => Boolean(paymentId));

                    if (pendingPaymentIds.length > 0) {
                        await tx.marketPlacePayments.updateMany({
                            where: {
                                id: { in: pendingPaymentIds },
                                status: 'PENDING',
                            },
                            data: { status: 'CANCELLED' },
                        });
                    }

                    await tx.marketplaceBattleBoost.updateMany({
                        where: {
                            id: { in: pendingBoosts.map((boost) => boost.id) },
                            status: MarketplaceBattleBoostStatus.PENDING_PAYMENT,
                        },
                        data: {
                            status: MarketplaceBattleBoostStatus.CANCELLED,
                            cancelledAt: now,
                        },
                    });
                }

                const existingActive = await tx.marketplaceBattleBoost.findFirst({
                    where: {
                        battleId: battle.id,
                        status: MarketplaceBattleBoostStatus.ACTIVE,
                        endAt: { gt: now },
                    },
                    select: { id: true, status: true },
                });

                if (existingActive) {
                    throw new ConflictException('already boosted');
                }

                const boost = await tx.marketplaceBattleBoost.create({
                    data: {
                        sellerId,
                        closetId: battle.closetId,
                        battleId: battle.id,
                        packageId: boostPackage.id,
                        status: MarketplaceBattleBoostStatus.PENDING_PAYMENT,
                        amount: boostPackage.price,
                        currency: normalizedCurrency,
                        pinOnTop: dto.pinOnTop,
                        winnerBadge: dto.winnerBadge,
                    },
                    select: {
                        id: true,
                        sellerId: true,
                        closetId: true,
                        battleId: true,
                        packageId: true,
                        paymentId: true,
                        status: true,
                        amount: true,
                        currency: true,
                        pinOnTop: true,
                        winnerBadge: true,
                        paymentProvider: true,
                        startAt: true,
                        endAt: true,
                        pinStartAt: true,
                        pinEndAt: true,
                        badgeStartAt: true,
                        badgeEndAt: true,
                        activatedAt: true,
                        expiredAt: true,
                        cancelledAt: true,
                        failedAt: true,
                        createdAt: true,
                        updatedAt: true,
                    },
                });

                return boost;
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
    }

    async createOrReuseBoostPayment(userId: string, boostId: string) {
        const sellerId = this.assertUserId(userId);

        const boost = await this.prisma.marketplaceBattleBoost.findUnique({
            where: { id: boostId },
            include: {
                payment: true,
            },
        });

        if (!boost) {
            throw new NotFoundException('Marketplace battle boost not found');
        }

        if (boost.sellerId !== sellerId) {
            throw new ForbiddenException('Forbidden: you do not own this boost');
        }

        if (boost.status === MarketplaceBattleBoostStatus.ACTIVE) {
            const stillActive = boost.endAt && boost.endAt.getTime() > Date.now();
            if (stillActive) {
                throw new ConflictException('already boosted');
            }
            throw new BadRequestException(
                'This boost has ended. Create a new boost intent, then create payment.',
            );
        }

        if (boost.status !== MarketplaceBattleBoostStatus.PENDING_PAYMENT) {
            throw new BadRequestException(
                `Boost payment can be created only when status is PENDING_PAYMENT (current: ${boost.status}). Create a new boost intent first, then call payment with the new boostId.`,
            );
        }

        const provider = await this.paymentProviderResolver.resolveProviderForMarketplaceBoost(sellerId);

        const successUrl = process.env.STRIPE_SUCCESS_URL as string;
        const cancelUrl = process.env.STRIPE_CANCEL_URL as string;
        if (provider === 'STRIPE' && (!successUrl || !cancelUrl)) {
            throw new BadRequestException('Missing STRIPE_SUCCESS_URL/STRIPE_CANCEL_URL env vars');
        }

        if (boost.paymentId && boost.payment) {
            const metadata = (boost.payment.metadata as Prisma.JsonObject | null) || null;
            const checkoutUrl = typeof metadata?.checkoutUrl === 'string' ? metadata.checkoutUrl : null;
            const checkoutSessionId = typeof metadata?.checkoutSessionId === 'string' ? metadata.checkoutSessionId : null;
            const qrCode = typeof metadata?.qrCode === 'string' ? metadata.qrCode : null;
            const pixCopyPaste = typeof metadata?.pixCopyPaste === 'string' ? metadata.pixCopyPaste : null;

            if (
                boost.payment.status === 'PENDING' &&
                (checkoutUrl || pixCopyPaste) &&
                (checkoutSessionId || boost.payment.paymentIntentId)
            ) {
                return {
                    boostId: boost.id,
                    status: boost.status,
                    payment: {
                        provider: provider,
                        paymentId: boost.payment.id,
                        checkoutUrl,
                        checkoutSessionId: checkoutSessionId || boost.payment.paymentIntentId,
                        clientSecret: null,
                        qrCode,
                        pixCopyPaste,
                    },
                };
            }
        }

        const amountMinor = this.toMinorUnits(boost.amount);
        const currencyLower =
            provider === 'PAGBANK' ? 'brl' : this.normalizeCurrency(boost.currency).toLowerCase();

        const payment = await this.prisma.marketPlacePayments.create({
            data: {
                userId: sellerId,
                amount: amountMinor,
                currency: currencyLower,
                provider,
                status: 'PENDING',
                metadata: {
                    type: BOOST_PAYMENT_TYPE,
                    domain: 'MARKETPLACE_BATTLE_BOOST',
                    boostId: boost.id,
                    battleId: boost.battleId,
                    sellerId,
                    pinOnTop: boost.pinOnTop,
                    winnerBadge: boost.winnerBadge,
                    idempotencyKey: `marketplace-battle-boost:${boost.id}:payment`,
                },
            },
        });

        if (provider === 'PAGBANK') {
            const seller = await this.prisma.user.findUnique({
                where: { id: sellerId },
                select: { email: true, displayName: true, userName: true },
            });
            const checkout = await this.pagBankService.createPixCheckout({
                referenceId: payment.id,
                amountMinor,
                description: 'Marketplace Battle Boost',
                customerEmail: seller?.email || undefined,
                customerName: seller?.displayName || seller?.userName || undefined,
            });

            await this.prisma.$transaction(async (tx) => {
                await tx.marketPlacePayments.update({
                    where: { id: payment.id },
                    data: {
                        paymentIntentId: checkout.orderId,
                        metadata: {
                            type: BOOST_PAYMENT_TYPE,
                            domain: 'MARKETPLACE_BATTLE_BOOST',
                            boostId: boost.id,
                            battleId: boost.battleId,
                            sellerId,
                            pinOnTop: boost.pinOnTop,
                            winnerBadge: boost.winnerBadge,
                            idempotencyKey: `marketplace-battle-boost:${boost.id}:payment`,
                            checkoutSessionId: checkout.orderId,
                            checkoutUrl: checkout.checkoutUrl,
                            qrCode: checkout.qrCode,
                            pixCopyPaste: checkout.pixCopyPaste,
                        },
                    },
                });

                await tx.marketplaceBattleBoost.update({
                    where: { id: boost.id },
                    data: {
                        paymentId: payment.id,
                        paymentProvider: provider,
                    },
                });
            });

            return {
                boostId: boost.id,
                status: MarketplaceBattleBoostStatus.PENDING_PAYMENT,
                payment: {
                    provider,
                    paymentId: payment.id,
                    checkoutUrl: checkout.checkoutUrl,
                    checkoutSessionId: checkout.orderId,
                    clientSecret: null,
                    qrCode: checkout.qrCode,
                    pixCopyPaste: checkout.pixCopyPaste,
                },
            };
        }

        const session = await this.stripe.checkout.sessions.create({
            mode: 'payment',
            success_url: successUrl,
            cancel_url: cancelUrl,
            line_items: [
                {
                    quantity: 1,
                    price_data: {
                        currency: currencyLower,
                        unit_amount: amountMinor,
                        product_data: {
                            name: 'Marketplace Battle Boost',
                        },
                    },
                },
            ],
            metadata: {
                type: BOOST_PAYMENT_TYPE,
                paymentId: payment.id,
                boostId: boost.id,
                battleId: boost.battleId,
                sellerId,
                pinOnTop: String(Boolean(boost.pinOnTop)),
                winnerBadge: String(Boolean(boost.winnerBadge)),
            },
            payment_intent_data: {
                metadata: {
                    type: BOOST_PAYMENT_TYPE,
                    paymentId: payment.id,
                    boostId: boost.id,
                    battleId: boost.battleId,
                    sellerId,
                    pinOnTop: String(Boolean(boost.pinOnTop)),
                    winnerBadge: String(Boolean(boost.winnerBadge)),
                },
            },
        });

        await this.prisma.$transaction(async (tx) => {
            await tx.marketPlacePayments.update({
                where: { id: payment.id },
                data: {
                    paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
                    metadata: {
                        type: BOOST_PAYMENT_TYPE,
                        domain: 'MARKETPLACE_BATTLE_BOOST',
                        boostId: boost.id,
                        battleId: boost.battleId,
                        sellerId,
                        pinOnTop: boost.pinOnTop,
                        winnerBadge: boost.winnerBadge,
                        idempotencyKey: `marketplace-battle-boost:${boost.id}:payment`,
                        checkoutSessionId: session.id,
                        checkoutUrl: session.url,
                    },
                },
            });

            await tx.marketplaceBattleBoost.update({
                where: { id: boost.id },
                data: {
                    paymentId: payment.id,
                    paymentProvider: provider,
                },
            });
        });

        return {
            boostId: boost.id,
            status: MarketplaceBattleBoostStatus.PENDING_PAYMENT,
            payment: {
                provider,
                paymentId: payment.id,
                checkoutUrl: session.url,
                checkoutSessionId: session.id,
                clientSecret: null,
                qrCode: null,
                pixCopyPaste: null,
            },
        };
    }

    async getMyBoosts(userId: string, query: MarketplaceBattleBoostListQueryDto) {
        const sellerId = this.assertUserId(userId);

        const page = query.page ?? 1;
        const limit = query.limit ?? 10;
        const skip = (page - 1) * limit;

        const safeSortBy =
            query.sortBy && MARKETPLACE_BATTLE_BOOST_SORT_FIELDS.includes(query.sortBy)
                ? query.sortBy
                : 'createdAt';
        const safeSortOrder: 'asc' | 'desc' = query.sortOrder === 'asc' ? 'asc' : 'desc';

        const where: Prisma.MarketplaceBattleBoostWhereInput = {
            sellerId,
            ...(query.status ? { status: query.status } : {}),
            ...(query.battleId ? { battleId: query.battleId } : {}),
        };

        const [total, boosts] = await this.prisma.$transaction([
            this.prisma.marketplaceBattleBoost.count({ where }),
            this.prisma.marketplaceBattleBoost.findMany({
                where,
                skip,
                take: limit,
                orderBy: { [safeSortBy]: safeSortOrder },
                include: {
                    package: {
                        select: {
                            id: true,
                            name: true,
                            durationHours: true,
                        },
                    },
                    battle: {
                        select: {
                            id: true,
                            title: true,
                            status: true,
                            startAt: true,
                            endAt: true,
                        },
                    },
                    payment: {
                        select: {
                            id: true,
                            status: true,
                            provider: true,
                            createdAt: true,
                        },
                    },
                },
            }),
        ]);

        return {
            boosts,
            total,
            page,
            limit,
            totalPages: total === 0 ? 0 : Math.ceil(total / limit),
        };
    }

    async getMyBoostById(userId: string, boostId: string) {
        const sellerId = this.assertUserId(userId);

        const boost = await this.prisma.marketplaceBattleBoost.findUnique({
            where: { id: boostId },
            include: {
                package: true,
                battle: {
                    select: {
                        id: true,
                        title: true,
                        status: true,
                        startAt: true,
                        endAt: true,
                    },
                },
                payment: {
                    select: {
                        id: true,
                        status: true,
                        provider: true,
                        createdAt: true,
                        updatedAt: true,
                    },
                },
            },
        });

        if (!boost) {
            throw new NotFoundException('Marketplace battle boost not found');
        }

        if (boost.sellerId !== sellerId) {
            throw new ForbiddenException('Forbidden: you do not own this boost');
        }

        return boost;
    }

    async getActiveBoostsPublic(query: MarketplaceBattleBoostActiveQueryDto) {
        const now = new Date();

        const boosts = await this.prisma.marketplaceBattleBoost.findMany({
            where: {
                status: MarketplaceBattleBoostStatus.ACTIVE,
                pinOnTop: true,
                pinStartAt: { lte: now },
                pinEndAt: { gt: now },
                battle: {
                    status: MarketplaceBattleStatus.LIVE,
                    startAt: { lte: now },
                    endAt: { gt: now },
                },
            },
            orderBy: [{ activatedAt: 'desc' }, { createdAt: 'desc' }],
            include: {
                battle: {
                    select: {
                        id: true,
                        title: true,
                        category: true,
                        status: true,
                        startAt: true,
                        endAt: true,
                        totalVotes: true,
                        totalComments: true,
                        seller: {
                            select: {
                                id: true,
                                displayName: true,
                                userName: true,
                                image: true,
                            },
                        },
                        closet: {
                            select: {
                                id: true,
                                shopName: true,
                                shopUsername: true,
                                shopLogo: true,
                            },
                        },
                    },
                },
            },
        });

        const deduped = new Map<string, (typeof boosts)[number]>();
        for (const boost of boosts) {
            if (!deduped.has(boost.battleId)) {
                deduped.set(boost.battleId, boost);
            }
        }

        const page = query.page ?? 1;
        const limit = query.limit ?? 10;
        const all = Array.from(deduped.values());
        const total = all.length;
        const skip = (page - 1) * limit;

        const data = all.slice(skip, skip + limit).map((boost) => ({
            boostId: boost.id,
            boostEndAt: boost.endAt,
            pinOnTop: boost.pinOnTop,
            winnerBadge: boost.winnerBadge,
            remainingBoostSeconds: Math.max(
                0,
                Math.floor(((boost.endAt as Date).getTime() - now.getTime()) / 1000),
            ),
            battle: {
                id: boost.battle.id,
                title: boost.battle.title,
                category: boost.battle.category,
                status: boost.battle.status,
                startAt: boost.battle.startAt,
                endAt: boost.battle.endAt,
                totalVotes: boost.battle.totalVotes,
                totalComments: boost.battle.totalComments,
                seller: {
                    id: boost.battle.seller.id,
                    name: boost.battle.seller.displayName || boost.battle.seller.userName || 'Unknown Seller',
                    profileImage: boost.battle.seller.image,
                },
                closet: boost.battle.closet,
            },
        }));

        return {
            boosts: data,
            total,
            page,
            limit,
            totalPages: total === 0 ? 0 : Math.ceil(total / limit),
        };
    }

    private async activateBoostFromPayment(
        paymentId: string,
        provider: string,
        paymentAmountMinor: number,
        paymentCurrency: string,
    ) {
        const now = new Date();

        await this.prisma.$transaction(
            async (tx) => {
                const boost = await tx.marketplaceBattleBoost.findFirst({
                    where: { paymentId },
                    include: {
                        package: {
                            select: {
                                durationHours: true,
                            },
                        },
                        battle: {
                            select: {
                                id: true,
                                status: true,
                                outcome: true,
                                startAt: true,
                                endAt: true,
                            },
                        },
                    },
                });

                if (!boost) return;

                await tx.$queryRaw`
          SELECT id
          FROM "MarketplaceBattleBoost"
          WHERE id = ${boost.id}
          FOR UPDATE
        `;

                const lockedBoost = await tx.marketplaceBattleBoost.findUnique({
                    where: { id: boost.id },
                    include: {
                        package: {
                            select: { durationHours: true },
                        },
                        battle: {
                            select: {
                                id: true,
                                status: true,
                                outcome: true,
                                startAt: true,
                                endAt: true,
                            },
                        },
                        payment: {
                            select: {
                                id: true,
                                amount: true,
                                currency: true,
                                provider: true,
                                status: true,
                            },
                        },
                    },
                });

                if (!lockedBoost) return;

                if (lockedBoost.status === MarketplaceBattleBoostStatus.ACTIVE) return;

                if (
                    lockedBoost.status === MarketplaceBattleBoostStatus.EXPIRED ||
                    lockedBoost.status === MarketplaceBattleBoostStatus.CANCELLED ||
                    lockedBoost.status === MarketplaceBattleBoostStatus.FAILED
                ) {
                    return;
                }

                if (lockedBoost.status !== MarketplaceBattleBoostStatus.PENDING_PAYMENT) {
                    return;
                }

                if (!lockedBoost.payment || lockedBoost.payment.id !== paymentId) {
                    return;
                }

                const expectedMinor = this.toMinorUnits(lockedBoost.amount);
                if (expectedMinor !== paymentAmountMinor) {
                    await tx.marketplaceBattleBoost.update({
                        where: { id: lockedBoost.id },
                        data: {
                            status: MarketplaceBattleBoostStatus.FAILED,
                            failedAt: now,
                        },
                    });
                    return;
                }

                if (this.normalizeCurrency(lockedBoost.currency) !== this.normalizeCurrency(paymentCurrency)) {
                    await tx.marketplaceBattleBoost.update({
                        where: { id: lockedBoost.id },
                        data: {
                            status: MarketplaceBattleBoostStatus.FAILED,
                            failedAt: now,
                        },
                    });
                    return;
                }

                if (this.normalizeCurrency(lockedBoost.payment.provider) !== this.normalizeCurrency(provider)) {
                    await tx.marketplaceBattleBoost.update({
                        where: { id: lockedBoost.id },
                        data: {
                            status: MarketplaceBattleBoostStatus.FAILED,
                            failedAt: now,
                        },
                    });
                    return;
                }

                if (lockedBoost.payment.status !== 'PAID') {
                    return;
                }

                const canActivateForCompletedBattle =
                    lockedBoost.battle.status === MarketplaceBattleStatus.COMPLETED;

                if (
                    !this.isBattleEligibleForBoost(lockedBoost.battle, now) &&
                    !canActivateForCompletedBattle
                ) {
                    await tx.marketplaceBattleBoost.update({
                        where: { id: lockedBoost.id },
                        data: {
                            status: MarketplaceBattleBoostStatus.FAILED,
                            failedAt: now,
                        },
                    });
                    return;
                }

                const overlappingActive = await tx.marketplaceBattleBoost.findFirst({
                    where: {
                        battleId: lockedBoost.battleId,
                        id: { not: lockedBoost.id },
                        status: MarketplaceBattleBoostStatus.ACTIVE,
                        endAt: { gt: now },
                    },
                    select: { id: true },
                });

                if (overlappingActive) {
                    await tx.marketplaceBattleBoost.update({
                        where: { id: lockedBoost.id },
                        data: {
                            status: MarketplaceBattleBoostStatus.FAILED,
                            failedAt: now,
                        },
                    });
                    return;
                }

                const computedEndAtByPackage = new Date(
                    now.getTime() + lockedBoost.package.durationHours * 60 * 60 * 1000,
                );
                const computedEndAt = computedEndAtByPackage;

                if (computedEndAt <= now) {
                    await tx.marketplaceBattleBoost.update({
                        where: { id: lockedBoost.id },
                        data: {
                            status: MarketplaceBattleBoostStatus.FAILED,
                            failedAt: now,
                        },
                    });
                    return;
                }

                await tx.marketplaceBattleBoost.updateMany({
                    where: {
                        id: lockedBoost.id,
                        status: MarketplaceBattleBoostStatus.PENDING_PAYMENT,
                    },
                    data: {
                        status: MarketplaceBattleBoostStatus.ACTIVE,
                        paymentProvider: provider,
                        startAt: now,
                        endAt: computedEndAt,
                        pinStartAt: lockedBoost.pinOnTop ? now : null,
                        pinEndAt: lockedBoost.pinOnTop ? computedEndAt : null,
                        badgeStartAt:
                            lockedBoost.winnerBadge &&
                                lockedBoost.battle.status === MarketplaceBattleStatus.COMPLETED &&
                                lockedBoost.battle.outcome === MarketplaceBattleOutcome.WINNER
                                ? now
                                : null,
                        badgeEndAt: lockedBoost.winnerBadge ? computedEndAt : null,
                        activatedAt: now,
                    },
                });
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
    }

    /**
     * Activate boost after PagBank (or other non-Stripe) payment is marked PAID.
     */
    async handlePagBankBoostPaid(paymentId: string) {
        const payment = await this.prisma.marketPlacePayments.findUnique({
            where: { id: paymentId },
            select: {
                id: true,
                provider: true,
                amount: true,
                currency: true,
                status: true,
                metadata: true,
            },
        });
        if (!payment) return { activated: false, reason: 'payment_not_found' };

        const metadata = (payment.metadata as Prisma.JsonObject | null) || null;
        if (metadata?.type !== BOOST_PAYMENT_TYPE && metadata?.domain !== 'MARKETPLACE_BATTLE_BOOST') {
            return { activated: false, reason: 'not_boost_payment' };
        }

        if (payment.status !== 'PAID') {
            await this.prisma.marketPlacePayments.update({
                where: { id: payment.id },
                data: { status: 'PAID' },
            });
        }

        await this.activateBoostFromPayment(
            payment.id,
            payment.provider,
            payment.amount,
            payment.currency,
        );
        return { activated: true, paymentId: payment.id };
    }

    async handleVerifiedPaymentSuccess(paymentIntent: Stripe.PaymentIntent) {
        if (paymentIntent.metadata?.type !== BOOST_PAYMENT_TYPE) return;

        const payment = await this.prisma.marketPlacePayments.findFirst({
            where: {
                OR: [
                    { paymentIntentId: paymentIntent.id },
                    ...(paymentIntent.metadata?.paymentId ? [{ id: paymentIntent.metadata.paymentId }] : []),
                ],
            },
            select: {
                id: true,
                provider: true,
            },
        });

        if (!payment) return;

        await this.prisma.marketPlacePayments.update({
            where: { id: payment.id },
            data: {
                status: 'PAID',
                paymentIntentId: paymentIntent.id,
            },
        });

        await this.activateBoostFromPayment(
            payment.id,
            payment.provider,
            paymentIntent.amount,
            paymentIntent.currency,
        );
    }

    async handleVerifiedPaymentFailure(paymentIntent: Stripe.PaymentIntent) {
        if (paymentIntent.metadata?.type !== BOOST_PAYMENT_TYPE) return;

        const payment = await this.prisma.marketPlacePayments.findFirst({
            where: {
                OR: [
                    { paymentIntentId: paymentIntent.id },
                    ...(paymentIntent.metadata?.paymentId ? [{ id: paymentIntent.metadata.paymentId }] : []),
                ],
            },
            select: { id: true },
        });

        if (!payment) return;

        await this.prisma.$transaction(async (tx) => {
            await tx.marketPlacePayments.update({
                where: { id: payment.id },
                data: { status: 'FAILED', paymentIntentId: paymentIntent.id },
            });

            await tx.marketplaceBattleBoost.updateMany({
                where: {
                    paymentId: payment.id,
                    status: MarketplaceBattleBoostStatus.PENDING_PAYMENT,
                },
                data: {
                    status: MarketplaceBattleBoostStatus.FAILED,
                    failedAt: new Date(),
                },
            });
        });
    }

    async handleCheckoutExpired(session: Stripe.Checkout.Session) {
        if (session.metadata?.type !== BOOST_PAYMENT_TYPE) return;
        const paymentId = session.metadata?.paymentId;
        if (!paymentId) return;

        await this.prisma.$transaction(async (tx) => {
            await tx.marketPlacePayments.updateMany({
                where: { id: paymentId, status: 'PENDING' },
                data: { status: 'CANCELLED' },
            });

            await tx.marketplaceBattleBoost.updateMany({
                where: {
                    paymentId,
                    status: MarketplaceBattleBoostStatus.PENDING_PAYMENT,
                },
                data: {
                    status: MarketplaceBattleBoostStatus.CANCELLED,
                    cancelledAt: new Date(),
                },
            });
        });
    }
}
