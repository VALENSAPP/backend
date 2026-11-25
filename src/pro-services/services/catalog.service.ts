import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { Prisma, ProServiceType, ServiceAttachment, ServiceAttachmentKind } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { uploadFileToS3, uploadImageToS3 } from '../../common/s3.util';
import { SetAvailabilityDto } from '../dto/availability.dto';
import { ManageServicesQueryDto } from '../dto/query.dto';
import { CreateProServiceDto, EventDetailsDto, MentorshipDetailsDto, PackageDetailsDto, UpdateProServiceDto } from '../dto/service.dto';
import { SetCohortsDto, SetTicketTypesDto } from '../dto/ticket-types.dto';
import {
    APPOINTMENT_CATEGORIES,
    EVENT_CATEGORIES,
    getServiceFeePercent,
    LIMITS,
    MENTORSHIP_GOALS,
    MENTORSHIP_PROGRAM_LENGTHS,
    MENTORSHIP_SESSION_DURATIONS,
    PRO_SERVICES_S3_FOLDERS,
    SERVICE_TYPE_LABELS,
} from '../pro-services.constants';
import {
    assertTimeZone,
    cleanStringList,
    parseClockToMinutes,
    resolveServiceCurrency,
    toMinor,
} from '../pro-services.utils';
import { ProviderService } from './provider.service';
import {
    FullService,
    presentAvailability,
    presentCard,
    presentFull,
    SERVICE_CARD_INCLUDE,
    SERVICE_FULL_INCLUDE,
} from './service-presenter';

type Tx = Prisma.TransactionClient;

const IMAGE_MIME = /^image\/(jpeg|jpg|png|webp|heic|heif)$/i;
const ATTACHMENT_MIME = /^(application\/pdf|video\/.+|image\/.+)$/i;

@Injectable()
export class CatalogService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly providerService: ProviderService,
    ) { }

    /** Screen P4: the 5 types with fees and wizard options. */
    getTypesMeta() {
        const types: ProServiceType[] = ['MENTORSHIP', 'CONSULTATION', 'APPOINTMENT', 'EVENT', 'MONTHLY_PACKAGE'];
        return {
            types: types.map((type) => ({
                type,
                label: SERVICE_TYPE_LABELS[type],
                feePercent: getServiceFeePercent(type),
            })),
            appointmentCategories: APPOINTMENT_CATEGORIES,
            eventCategories: EVENT_CATEGORIES,
            mentorship: {
                sessionDurations: MENTORSHIP_SESSION_DURATIONS,
                goals: MENTORSHIP_GOALS,
                programLengthsWeeks: MENTORSHIP_PROGRAM_LENGTHS,
                programTypes: ['ONE_SESSION', 'SHORT_PROGRAM', 'LONG_PROGRAM'],
                frequencies: ['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'CUSTOM'],
                modes: ['ONE_ON_ONE', 'GROUP'],
            },
            freeEventsHaveNoFee: true,
        };
    }

    // ------------------------------------------------------------------
    // Create / edit (screens P5-P9)
    // ------------------------------------------------------------------

    async create(userId: string, dto: CreateProServiceDto) {
        const provider = await this.providerService.assertCanManage(userId);
        this.assertDetailsMatchType(dto.type, dto);

        const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { country: true } });
        const timezone = dto.timezone ? assertTimeZone(dto.timezone) : provider.timezone;

        const created = await this.prisma.$transaction(async (tx) => {
            const service = await tx.proService.create({
                data: {
                    providerUserId: userId,
                    type: dto.type,
                    title: dto.title.trim(),
                    description: dto.description?.trim() || null,
                    includedItems: cleanStringList(dto.includedItems, LIMITS.includedItemsMax),
                    category: dto.category?.trim() || null,
                    format: dto.format ?? (dto.type === 'APPOINTMENT' || dto.type === 'EVENT' ? 'IN_PERSON' : 'ONLINE'),
                    durationMinutes: dto.type === 'EVENT' ? null : dto.durationMinutes ?? null,
                    priceMinor: dto.type === 'EVENT' ? 0 : toMinor(dto.price ?? 0),
                    currency: resolveServiceCurrency(user?.country),
                    timezone,
                    address: dto.address?.trim() || null,
                    city: dto.city?.trim() || null,
                    country: dto.country?.trim() || null,
                    contactPhone: dto.contactPhone?.trim() || null,
                },
            });
            await this.writeTypeDetails(tx, service.id, dto.type, dto, true);
            return service;
        });

        return this.getOwned(userId, created.id);
    }

    async update(userId: string, serviceId: string, dto: UpdateProServiceDto) {
        await this.providerService.assertCanManage(userId);
        const existing = await this.loadOwned(userId, serviceId);
        if (existing.status === 'ARCHIVED') throw new BadRequestException('Archived services cannot be edited');
        this.assertDetailsMatchType(existing.type, dto);

        const data: Prisma.ProServiceUpdateInput = {};
        if (dto.title !== undefined) data.title = dto.title.trim();
        if (dto.description !== undefined) data.description = dto.description.trim() || null;
        if (dto.includedItems !== undefined) data.includedItems = cleanStringList(dto.includedItems, LIMITS.includedItemsMax);
        if (dto.category !== undefined) data.category = dto.category.trim() || null;
        if (dto.format !== undefined) data.format = dto.format;
        if (dto.durationMinutes !== undefined && existing.type !== 'EVENT') data.durationMinutes = dto.durationMinutes;
        if (dto.price !== undefined && existing.type !== 'EVENT') data.priceMinor = toMinor(dto.price);
        if (dto.timezone !== undefined) data.timezone = assertTimeZone(dto.timezone);
        if (dto.address !== undefined) data.address = dto.address.trim() || null;
        if (dto.city !== undefined) data.city = dto.city.trim() || null;
        if (dto.country !== undefined) data.country = dto.country.trim() || null;
        if (dto.contactPhone !== undefined) data.contactPhone = dto.contactPhone.trim() || null;

        await this.prisma.$transaction(async (tx) => {
            if (Object.keys(data).length) {
                await tx.proService.update({ where: { id: serviceId }, data });
            }
            await this.writeTypeDetails(tx, serviceId, existing.type, dto, false);
        });

        return this.getOwned(userId, serviceId);
    }

    /** Screen P14: my services. */
    async listOwned(userId: string, query: ManageServicesQueryDto) {
        const page = query.page || 1;
        const limit = query.limit || 20;
        const where: Prisma.ProServiceWhereInput = {
            providerUserId: userId,
            ...(query.type ? { type: query.type } : {}),
            ...(query.status ? { status: query.status } : { status: { not: 'ARCHIVED' } }),
        };

        const [total, rows, byStatus] = await Promise.all([
            this.prisma.proService.count({ where }),
            this.prisma.proService.findMany({
                where,
                include: SERVICE_CARD_INCLUDE,
                orderBy: [{ updatedAt: 'desc' }],
                skip: (page - 1) * limit,
                take: limit,
            }),
            this.prisma.proService.groupBy({
                by: ['status'],
                where: { providerUserId: userId },
                _count: { _all: true },
            }),
        ]);

        const counts: Record<string, number> = {};
        for (const row of byStatus) counts[row.status] = row._count._all;

        return {
            items: rows.map((s) => presentCard(s)),
            counts,
            page,
            limit,
            total,
            hasMore: page * limit < total,
        };
    }

    /** Owner view with everything the editor needs, plus what is still missing to publish. */
    async getOwned(userId: string, serviceId: string) {
        const service = await this.loadOwnedFull(userId, serviceId);
        const problems = this.findPublishProblems(service);
        return {
            ...presentFull(service, { revealPrivate: true, isOwner: true }),
            feePercent: getServiceFeePercent(service.type),
            readiness: { canPublish: problems.length === 0, problems },
        };
    }

    // ------------------------------------------------------------------
    // Status (screen P12)
    // ------------------------------------------------------------------

    async publish(userId: string, serviceId: string) {
        await this.providerService.assertCanSell(userId);
        const service = await this.loadOwnedFull(userId, serviceId);
        if (service.status === 'ARCHIVED') throw new BadRequestException('Archived services cannot be published');
        if (service.status === 'DISABLED') {
            throw new ForbiddenException('This service was disabled by Valens. Renew your membership to enable it again.');
        }

        const problems = this.findPublishProblems(service);
        if (problems.length) {
            throw new BadRequestException({
                statusCode: 400,
                error: 'Bad Request',
                code: 'SERVICE_INCOMPLETE',
                message: problems[0].message,
                problems,
            });
        }

        await this.prisma.proService.update({
            where: { id: serviceId },
            data: { status: 'ACTIVE', publishedAt: service.publishedAt ?? new Date() },
        });
        return this.getOwned(userId, serviceId);
    }

    /** Hidden from new buyers; existing bookings stay. */
    async pause(userId: string, serviceId: string) {
        const service = await this.loadOwned(userId, serviceId);
        if (service.status !== 'ACTIVE') throw new BadRequestException('Only live services can be paused');
        await this.prisma.proService.update({ where: { id: serviceId }, data: { status: 'PAUSED' } });
        return this.getOwned(userId, serviceId);
    }

    /** Archive = delete for the provider. Blocked while anything is still owed to buyers. */
    async archive(userId: string, serviceId: string) {
        const service = await this.loadOwned(userId, serviceId);
        if (service.status === 'ARCHIVED') return { message: 'Service already archived', serviceId };

        const now = new Date();
        const [openBookings, upcomingSessions, activeSubs, validTickets] = await Promise.all([
            this.prisma.serviceBooking.count({
                where: { serviceId, status: { in: ['PENDING_PAYMENT', 'CONFIRMED', 'IN_PROGRESS'] } },
            }),
            this.prisma.serviceSession.count({
                where: { serviceId, status: { in: ['SCHEDULED', 'LIVE'] }, endAt: { gt: now } },
            }),
            this.prisma.packageSubscription.count({
                where: { serviceId, status: { in: ['ACTIVE', 'PAST_DUE'] } },
            }),
            this.prisma.eventTicket.count({ where: { serviceId, status: 'VALID' } }),
        ]);

        if (openBookings || upcomingSessions || activeSubs || (validTickets && service.type === 'EVENT')) {
            throw new ConflictException({
                statusCode: 409,
                error: 'Conflict',
                code: 'SERVICE_HAS_CLIENTS',
                message: 'This service still has clients. Pause it instead, or finish or cancel their bookings first.',
                openBookings,
                upcomingSessions,
                activeSubscriptions: activeSubs,
                validTickets,
            });
        }

        await this.prisma.proService.update({
            where: { id: serviceId },
            data: { status: 'ARCHIVED', archivedAt: now },
        });
        return { message: 'Service archived', serviceId };
    }

    // ------------------------------------------------------------------
    // Availability (screen P10)
    // ------------------------------------------------------------------

    async getAvailability(userId: string, serviceId: string) {
        const service = await this.loadOwnedFull(userId, serviceId);
        return presentAvailability(service);
    }

    async setAvailability(userId: string, serviceId: string, dto: SetAvailabilityDto) {
        await this.providerService.assertCanManage(userId);
        const service = await this.loadOwned(userId, serviceId);
        if (service.type === 'EVENT') throw new BadRequestException('Events use a date and time, not weekly availability');
        if (service.status === 'ARCHIVED') throw new BadRequestException('Archived services cannot be edited');

        const timezone = dto.timezone ? assertTimeZone(dto.timezone) : undefined;

        // Rules: valid ranges, no overlap on the same day, at most N per day
        const rules = dto.rules.map((r, i) => {
            const startMinute = parseClockToMinutes(r.start, `rules[${i}].start`);
            const endMinute = parseClockToMinutes(r.end, `rules[${i}].end`);
            if (endMinute <= startMinute) {
                throw new BadRequestException(`rules[${i}]: end must be after start`);
            }
            if (service.durationMinutes && endMinute - startMinute < service.durationMinutes) {
                throw new BadRequestException(
                    `rules[${i}]: the slot is shorter than one session (${service.durationMinutes} minutes)`,
                );
            }
            return { dayOfWeek: r.dayOfWeek, startMinute, endMinute };
        });

        for (let day = 0; day <= 6; day++) {
            const sameDay = rules.filter((r) => r.dayOfWeek === day).sort((a, b) => a.startMinute - b.startMinute);
            if (sameDay.length > LIMITS.rulesPerDayMax) {
                throw new BadRequestException(`At most ${LIMITS.rulesPerDayMax} time slots per day`);
            }
            for (let i = 1; i < sameDay.length; i++) {
                if (sameDay[i].startMinute < sameDay[i - 1].endMinute) {
                    throw new BadRequestException(`Time slots overlap on day ${day}`);
                }
            }
        }

        const exceptions = (dto.exceptions || []).map((e, i) => {
            const hasStart = Boolean(e.start);
            const hasEnd = Boolean(e.end);
            if (hasStart !== hasEnd) {
                throw new BadRequestException(`exceptions[${i}]: give both start and end, or neither for a full day off`);
            }
            const startMinute = hasStart ? parseClockToMinutes(e.start as string, `exceptions[${i}].start`) : null;
            const endMinute = hasEnd ? parseClockToMinutes(e.end as string, `exceptions[${i}].end`) : null;
            if (startMinute !== null && endMinute !== null && endMinute <= startMinute) {
                throw new BadRequestException(`exceptions[${i}]: end must be after start`);
            }
            const date = new Date(`${e.date}T00:00:00.000Z`);
            if (Number.isNaN(date.getTime())) throw new BadRequestException(`exceptions[${i}]: invalid date`);
            return { date, startMinute, endMinute, reason: e.reason?.trim() || null };
        });

        await this.prisma.$transaction(async (tx) => {
            await tx.availabilityRule.deleteMany({ where: { serviceId } });
            await tx.availabilityException.deleteMany({ where: { serviceId } });
            if (rules.length) {
                await tx.availabilityRule.createMany({ data: rules.map((r) => ({ ...r, serviceId })) });
            }
            if (exceptions.length) {
                await tx.availabilityException.createMany({ data: exceptions.map((e) => ({ ...e, serviceId })) });
            }
            if (timezone) {
                await tx.proService.update({ where: { id: serviceId }, data: { timezone } });
            }
        });

        return this.getAvailability(userId, serviceId);
    }

    // ------------------------------------------------------------------
    // Event ticket types (screen P8) and mentorship cohorts (screen P5)
    // ------------------------------------------------------------------

    async setTicketTypes(userId: string, serviceId: string, dto: SetTicketTypesDto) {
        await this.providerService.assertCanManage(userId);
        const service = await this.loadOwned(userId, serviceId);
        if (service.type !== 'EVENT') throw new BadRequestException('Ticket types are only for events');
        if (service.status === 'ARCHIVED') throw new BadRequestException('Archived services cannot be edited');

        const existing = await this.prisma.eventTicketType.findMany({ where: { serviceId } });
        const byId = new Map(existing.map((t) => [t.id, t]));
        const keepIds = new Set<string>();

        dto.ticketTypes.forEach((input, i) => {
            if (!input.id) return;
            const current = byId.get(input.id);
            if (!current) throw new BadRequestException(`ticketTypes[${i}]: ticket type not found on this event`);
            if (input.quantity < current.soldCount) {
                throw new BadRequestException(
                    `ticketTypes[${i}]: quantity can't be lower than tickets already sold (${current.soldCount})`,
                );
            }
            keepIds.add(input.id);
        });

        await this.prisma.$transaction(async (tx) => {
            for (const [index, input] of dto.ticketTypes.entries()) {
                const data = {
                    name: input.name.trim(),
                    description: input.description?.trim() || null,
                    priceMinor: toMinor(input.price),
                    quantity: input.quantity,
                    sortOrder: index,
                    isActive: input.isActive ?? true,
                };
                if (input.id) {
                    await tx.eventTicketType.update({ where: { id: input.id }, data });
                } else {
                    await tx.eventTicketType.create({ data: { ...data, serviceId } });
                }
            }

            // Removed from the list: delete if nothing sold, otherwise just stop selling it
            for (const old of existing) {
                if (keepIds.has(old.id)) continue;
                if (old.soldCount > 0) {
                    await tx.eventTicketType.update({ where: { id: old.id }, data: { isActive: false } });
                } else {
                    await tx.eventTicketType.delete({ where: { id: old.id } });
                }
            }

            await this.syncEventFromPrice(tx, serviceId);
        });

        return this.getOwned(userId, serviceId);
    }

    async setCohorts(userId: string, serviceId: string, dto: SetCohortsDto) {
        await this.providerService.assertCanManage(userId);
        const service = await this.loadOwned(userId, serviceId);
        if (service.type !== 'MENTORSHIP') throw new BadRequestException('Cohorts are only for mentorships');
        if (service.status === 'ARCHIVED') throw new BadRequestException('Archived services cannot be edited');

        const existing = await this.prisma.mentorshipCohort.findMany({ where: { serviceId } });
        const byId = new Map(existing.map((c) => [c.id, c]));
        const keepIds = new Set<string>();
        const now = Date.now();

        dto.cohorts.forEach((input, i) => {
            const startAt = new Date(input.startAt);
            if (input.id) {
                const current = byId.get(input.id);
                if (!current) throw new BadRequestException(`cohorts[${i}]: cohort not found on this mentorship`);
                if (input.seats < current.seatsTaken) {
                    throw new BadRequestException(`cohorts[${i}]: seats can't be lower than seats taken (${current.seatsTaken})`);
                }
                if (current.seatsTaken > 0 && startAt.getTime() !== current.startAt.getTime()) {
                    throw new BadRequestException(`cohorts[${i}]: can't move the start date after people joined`);
                }
                keepIds.add(input.id);
            } else if (startAt.getTime() <= now) {
                throw new BadRequestException(`cohorts[${i}]: start date must be in the future`);
            }
        });

        await this.prisma.$transaction(async (tx) => {
            for (const input of dto.cohorts) {
                const data = { startAt: new Date(input.startAt), seatsTotal: input.seats, isActive: input.isActive ?? true };
                if (input.id) {
                    await tx.mentorshipCohort.update({ where: { id: input.id }, data });
                } else {
                    await tx.mentorshipCohort.create({ data: { ...data, serviceId } });
                }
            }
            for (const old of existing) {
                if (keepIds.has(old.id)) continue;
                if (old.seatsTaken > 0) {
                    await tx.mentorshipCohort.update({ where: { id: old.id }, data: { isActive: false } });
                } else {
                    await tx.mentorshipCohort.delete({ where: { id: old.id } });
                }
            }
        });

        return this.getOwned(userId, serviceId);
    }

    // ------------------------------------------------------------------
    // Media (screen P11)
    // ------------------------------------------------------------------

    async uploadCover(userId: string, serviceId: string, file?: Express.Multer.File) {
        await this.providerService.assertCanManage(userId);
        await this.loadOwned(userId, serviceId);
        if (!file) throw new BadRequestException('cover image file is required');
        if (!IMAGE_MIME.test(file.mimetype)) throw new BadRequestException('Cover must be a JPG, PNG, WEBP or HEIC image');

        const url = await uploadImageToS3(file, PRO_SERVICES_S3_FOLDERS.cover);
        await this.prisma.proService.update({ where: { id: serviceId }, data: { coverImage: url } });
        return { coverImage: url };
    }

    async addAttachments(userId: string, serviceId: string, files: Express.Multer.File[] = []) {
        await this.providerService.assertCanManage(userId);
        const service = await this.loadOwned(userId, serviceId);
        if (!files.length) throw new BadRequestException('At least one file is required');

        const count = await this.prisma.serviceAttachment.count({ where: { serviceId } });
        if (count + files.length > LIMITS.attachmentsMax) {
            throw new BadRequestException(`A service can have at most ${LIMITS.attachmentsMax} attachments`);
        }
        for (const f of files) {
            if (!ATTACHMENT_MIME.test(f.mimetype)) {
                throw new BadRequestException(`${f.originalname}: only PDF, video or image files are allowed`);
            }
        }

        const created: ServiceAttachment[] = [];
        for (const f of files) {
            const url = await uploadFileToS3(f, `${PRO_SERVICES_S3_FOLDERS.attachments}/${service.id}`);
            created.push(
                await this.prisma.serviceAttachment.create({
                    data: {
                        serviceId,
                        kind: this.attachmentKind(f.mimetype),
                        url,
                        fileName: f.originalname?.slice(0, 200) || null,
                        mimeType: f.mimetype,
                        sizeBytes: f.size,
                    },
                }),
            );
        }
        return created.map((a) => ({ id: a.id, kind: a.kind, url: a.url, fileName: a.fileName, mimeType: a.mimeType }));
    }

    async deleteAttachment(userId: string, serviceId: string, attachmentId: string) {
        await this.loadOwned(userId, serviceId);
        const attachment = await this.prisma.serviceAttachment.findFirst({ where: { id: attachmentId, serviceId } });
        if (!attachment) throw new NotFoundException('Attachment not found');
        await this.prisma.serviceAttachment.delete({ where: { id: attachmentId } });
        return { message: 'Attachment removed', attachmentId };
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private async loadOwned(userId: string, serviceId: string) {
        const service = await this.prisma.proService.findUnique({ where: { id: serviceId } });
        if (!service || service.providerUserId !== userId) throw new NotFoundException('Service not found');
        return service;
    }

    private async loadOwnedFull(userId: string, serviceId: string): Promise<FullService> {
        const service = await this.prisma.proService.findUnique({
            where: { id: serviceId },
            include: SERVICE_FULL_INCLUDE,
        });
        if (!service || service.providerUserId !== userId) throw new NotFoundException('Service not found');
        return service;
    }

    /** Only the matching details block may be sent: mentorship for MENTORSHIP, etc. */
    private assertDetailsMatchType(
        type: ProServiceType,
        dto: { mentorship?: unknown; package?: unknown; event?: unknown },
    ) {
        if (dto.mentorship && type !== 'MENTORSHIP') throw new BadRequestException('mentorship details are only for MENTORSHIP');
        if (dto.package && type !== 'MONTHLY_PACKAGE') throw new BadRequestException('package details are only for MONTHLY_PACKAGE');
        if (dto.event && type !== 'EVENT') throw new BadRequestException('event details are only for EVENT');
    }

    private async writeTypeDetails(
        tx: Tx,
        serviceId: string,
        type: ProServiceType,
        dto: { mentorship?: MentorshipDetailsDto; package?: PackageDetailsDto; event?: EventDetailsDto },
        isCreate: boolean,
    ) {
        if (type === 'MENTORSHIP' && (isCreate || dto.mentorship)) {
            const m = dto.mentorship || {};
            const data: Prisma.MentorshipDetailUncheckedCreateInput = { serviceId };
            if (m.programType !== undefined) data.programType = m.programType;
            if (m.programLengthWeeks !== undefined) data.programLengthWeeks = m.programLengthWeeks;
            if (m.sessionsCount !== undefined) data.sessionsCount = m.sessionsCount;
            if (m.frequency !== undefined) data.frequency = m.frequency;
            if (m.mode !== undefined) data.mode = m.mode;
            if (m.maxParticipants !== undefined) data.maxParticipants = m.maxParticipants;
            if (m.goals !== undefined) data.goals = cleanStringList(m.goals, LIMITS.goalsMax);
            if (m.allowCustomStart !== undefined) data.allowCustomStart = m.allowCustomStart;

            const { serviceId: _sid, ...update } = data;
            const saved = await tx.mentorshipDetail.upsert({ where: { serviceId }, create: data, update });

            // Keep the shape consistent: one session = 1 session; 1:1 = 1 participant
            const fixes: Prisma.MentorshipDetailUpdateInput = {};
            if (saved.programType === 'ONE_SESSION') {
                if (saved.sessionsCount !== 1) fixes.sessionsCount = 1;
                if (saved.programLengthWeeks !== null) fixes.programLengthWeeks = null;
            }
            if (saved.mode === 'ONE_ON_ONE' && saved.maxParticipants !== 1) fixes.maxParticipants = 1;
            if (saved.mode === 'GROUP' && saved.maxParticipants < 2) fixes.maxParticipants = 2;
            if (Object.keys(fixes).length) {
                await tx.mentorshipDetail.update({ where: { serviceId }, data: fixes });
            }
        }

        if (type === 'MONTHLY_PACKAGE' && (isCreate || dto.package)) {
            const p = dto.package || {};
            const data: Prisma.PackageDetailUncheckedCreateInput = { serviceId };
            if (p.sessionsPerMonth !== undefined) data.sessionsPerMonth = p.sessionsPerMonth;
            if (p.maxSubscribers !== undefined) data.maxSubscribers = p.maxSubscribers;
            if (p.minNoticeHours !== undefined) data.minNoticeHours = p.minNoticeHours;
            if (p.cancelNoticeHours !== undefined) data.cancelNoticeHours = p.cancelNoticeHours;
            if (p.bufferMinutes !== undefined) data.bufferMinutes = p.bufferMinutes;
            if (p.autoHideUnavailable !== undefined) data.autoHideUnavailable = p.autoHideUnavailable;
            if (p.includesPrivateCircle !== undefined) data.includesPrivateCircle = p.includesPrivateCircle;

            if (p.maxSubscribers !== undefined && !isCreate) {
                const activeSubs = await tx.packageSubscription.count({
                    where: { serviceId, status: { in: ['ACTIVE', 'PAST_DUE'] } },
                });
                if (p.maxSubscribers < activeSubs) {
                    throw new BadRequestException(`maxSubscribers can't be lower than current subscribers (${activeSubs})`);
                }
            }

            const { serviceId: _sid, ...update } = data;
            await tx.packageDetail.upsert({ where: { serviceId }, create: data, update });
        }

        if (type === 'EVENT' && (isCreate || dto.event)) {
            const e = dto.event || {};
            const data: Prisma.EventDetailUncheckedCreateInput = { serviceId };
            if (e.startAt !== undefined) data.startAt = new Date(e.startAt);
            if (e.endAt !== undefined) data.endAt = new Date(e.endAt);
            if (e.venueName !== undefined) data.venueName = e.venueName.trim() || null;
            if (e.venueAddress !== undefined) data.venueAddress = e.venueAddress.trim() || null;
            if (e.ageRestriction !== undefined) data.ageRestriction = e.ageRestriction;
            if (e.dressCode !== undefined) data.dressCode = e.dressCode.trim() || null;
            if (e.salesStartAt !== undefined) data.salesStartAt = new Date(e.salesStartAt);
            if (e.salesEndAt !== undefined) data.salesEndAt = new Date(e.salesEndAt);

            const { serviceId: _sid, ...update } = data;
            const saved = await tx.eventDetail.upsert({ where: { serviceId }, create: data, update });
            if (saved.startAt && saved.endAt && saved.endAt <= saved.startAt) {
                throw new BadRequestException('Event end must be after its start');
            }
            if (saved.salesStartAt && saved.salesEndAt && saved.salesEndAt <= saved.salesStartAt) {
                throw new BadRequestException('Ticket sales end must be after sales start');
            }
        }
    }

    /** Events list "Tickets from $X": keep priceMinor = lowest active ticket price. */
    private async syncEventFromPrice(tx: Tx, serviceId: string) {
        const cheapest = await tx.eventTicketType.findFirst({
            where: { serviceId, isActive: true },
            orderBy: { priceMinor: 'asc' },
            select: { priceMinor: true },
        });
        await tx.proService.update({ where: { id: serviceId }, data: { priceMinor: cheapest?.priceMinor ?? 0 } });
    }

    private attachmentKind(mime: string): ServiceAttachmentKind {
        if (/^application\/pdf$/i.test(mime)) return 'PDF';
        if (/^video\//i.test(mime)) return 'VIDEO';
        if (/^image\//i.test(mime)) return 'IMAGE';
        return 'OTHER';
    }

    /** Everything a service needs before it can go live. Returned to the wizard as a checklist. */
    findPublishProblems(service: FullService): { field: string; message: string }[] {
        const problems: { field: string; message: string }[] = [];
        const add = (field: string, message: string) => problems.push({ field, message });
        const isEvent = service.type === 'EVENT';

        if (!service.title || service.title.trim().length < 3) add('title', 'Add a title');
        if (!service.description) add('description', 'Add a description');

        if (!isEvent) {
            if (!service.durationMinutes) add('durationMinutes', 'Set how long a session lasts');
            if (service.priceMinor <= 0) add('price', 'Set a price');
        }

        if (service.format === 'IN_PERSON' && !isEvent) {
            if (!service.address) add('address', 'Add the address for in-person sessions');
            if (!service.contactPhone) add('contactPhone', 'Add a contact phone for in-person sessions');
        }

        if (service.type === 'APPOINTMENT' && !service.category) add('category', 'Choose a category');

        const hasAvailability = service.availabilityRules.length > 0;
        switch (service.type) {
            case 'MENTORSHIP': {
                const m = service.mentorship;
                if (!m) {
                    add('mentorship', 'Complete the mentorship details');
                    break;
                }
                if (m.programType !== 'ONE_SESSION' && !m.programLengthWeeks) {
                    add('mentorship.programLengthWeeks', 'Set the program length');
                }
                if (m.programType !== 'ONE_SESSION' && m.sessionsCount < 2) {
                    add('mentorship.sessionsCount', 'A program needs at least 2 sessions');
                }
                const futureCohorts = service.cohorts.filter((c) => c.isActive && c.startAt.getTime() > Date.now());
                if (m.mode === 'GROUP' && futureCohorts.length === 0) {
                    add('cohorts', 'Add at least one upcoming cohort for a group mentorship');
                }
                if (m.mode === 'ONE_ON_ONE' && !hasAvailability) add('availability', 'Set your available days and times');
                if (m.mode === 'ONE_ON_ONE' && !m.allowCustomStart && futureCohorts.length === 0) {
                    add('cohorts', 'Add a start date or allow clients to choose their own');
                }
                break;
            }
            case 'CONSULTATION':
            case 'APPOINTMENT':
                if (!hasAvailability) add('availability', 'Set your available days and times');
                break;
            case 'MONTHLY_PACKAGE': {
                const p = service.packageDetail;
                if (!p) add('package', 'Complete the package details');
                if (p && p.sessionsPerMonth > 0 && !hasAvailability) add('availability', 'Set your available days and times');
                break;
            }
            case 'EVENT': {
                const e = service.eventDetail;
                if (!e?.startAt || !e?.endAt) add('event.startAt', 'Set the event date and time');
                else if (e.startAt.getTime() <= Date.now()) add('event.startAt', 'The event date must be in the future');
                if (service.format === 'IN_PERSON' && !e?.venueName && !e?.venueAddress) {
                    add('event.venue', 'Add the venue');
                }
                if (!service.ticketTypes.some((t) => t.isActive)) add('ticketTypes', 'Add at least one ticket type');
                break;
            }
        }

        return problems;
    }
}

