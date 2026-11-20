-- CreateEnum
CREATE TYPE "ProServiceType" AS ENUM ('MENTORSHIP', 'CONSULTATION', 'APPOINTMENT', 'EVENT', 'MONTHLY_PACKAGE');

-- CreateEnum
CREATE TYPE "ProServiceStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED', 'DISABLED');

-- CreateEnum
CREATE TYPE "ProServiceFormat" AS ENUM ('ONLINE', 'IN_PERSON');

-- CreateEnum
CREATE TYPE "MentorshipProgramType" AS ENUM ('ONE_SESSION', 'SHORT_PROGRAM', 'LONG_PROGRAM');

-- CreateEnum
CREATE TYPE "MentorshipMode" AS ENUM ('ONE_ON_ONE', 'GROUP');

-- CreateEnum
CREATE TYPE "SessionFrequency" AS ENUM ('WEEKLY', 'BIWEEKLY', 'MONTHLY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ServiceAttachmentKind" AS ENUM ('PDF', 'VIDEO', 'IMAGE', 'OTHER');

-- CreateEnum
CREATE TYPE "ServiceBookingStatus" AS ENUM ('PENDING_PAYMENT', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "ServicePaymentMethod" AS ENUM ('CARD', 'WALLET', 'FREE');

-- CreateEnum
CREATE TYPE "ServiceSessionStatus" AS ENUM ('SCHEDULED', 'LIVE', 'COMPLETED', 'MISSED_CLIENT', 'MISSED_PROVIDER', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SessionExtensionStatus" AS ENUM ('REQUESTED', 'APPROVED', 'DECLINED', 'PAID', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PackageSubscriptionStatus" AS ENUM ('PENDING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "TicketOrderStatus" AS ENUM ('PENDING_PAYMENT', 'PAID', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EventTicketStatus" AS ENUM ('VALID', 'CHECKED_IN', 'CANCELLED');

-- CreateTable
CREATE TABLE "serviceProviders" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "headline" VARCHAR(160),
    "about" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "ratingAvg" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "clientCount" INTEGER NOT NULL DEFAULT 0,
    "membershipGraceEndsAt" TIMESTAMP(3),
    "servicesDisabledAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "serviceProviders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proServices" (
    "id" TEXT NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "type" "ProServiceType" NOT NULL,
    "status" "ProServiceStatus" NOT NULL DEFAULT 'DRAFT',
    "title" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "includedItems" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "category" VARCHAR(60),
    "coverImage" TEXT,
    "format" "ProServiceFormat" NOT NULL DEFAULT 'ONLINE',
    "durationMinutes" INTEGER,
    "priceMinor" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "timezone" TEXT,
    "address" TEXT,
    "city" TEXT,
    "country" TEXT,
    "contactPhone" TEXT,
    "popularityScore" INTEGER NOT NULL DEFAULT 0,
    "bookingCount" INTEGER NOT NULL DEFAULT 0,
    "ratingAvg" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "proServices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mentorshipDetails" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "programType" "MentorshipProgramType" NOT NULL DEFAULT 'ONE_SESSION',
    "programLengthWeeks" INTEGER,
    "sessionsCount" INTEGER NOT NULL DEFAULT 1,
    "frequency" "SessionFrequency",
    "mode" "MentorshipMode" NOT NULL DEFAULT 'ONE_ON_ONE',
    "maxParticipants" INTEGER NOT NULL DEFAULT 1,
    "goals" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowCustomStart" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "mentorshipDetails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mentorshipCohorts" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "seatsTotal" INTEGER NOT NULL,
    "seatsTaken" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mentorshipCohorts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "packageDetails" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "sessionsPerMonth" INTEGER NOT NULL DEFAULT 1,
    "maxSubscribers" INTEGER NOT NULL DEFAULT 25,
    "minNoticeHours" INTEGER NOT NULL DEFAULT 24,
    "cancelNoticeHours" INTEGER NOT NULL DEFAULT 12,
    "bufferMinutes" INTEGER NOT NULL DEFAULT 15,
    "autoHideUnavailable" BOOLEAN NOT NULL DEFAULT true,
    "includesPrivateCircle" BOOLEAN NOT NULL DEFAULT false,
    "stripeProductId" TEXT,
    "stripePriceId" TEXT,

    CONSTRAINT "packageDetails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eventDetails" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "venueName" TEXT,
    "venueAddress" TEXT,
    "ageRestriction" INTEGER,
    "dressCode" TEXT,
    "salesStartAt" TIMESTAMP(3),
    "salesEndAt" TIMESTAMP(3),

    CONSTRAINT "eventDetails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eventTicketTypes" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "description" VARCHAR(300),
    "priceMinor" INTEGER NOT NULL DEFAULT 0,
    "quantity" INTEGER NOT NULL,
    "soldCount" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "eventTicketTypes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "serviceAttachments" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "kind" "ServiceAttachmentKind" NOT NULL,
    "url" TEXT NOT NULL,
    "fileName" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "serviceAttachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "availabilityRules" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "availabilityRules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "availabilityExceptions" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "startMinute" INTEGER,
    "endMinute" INTEGER,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "availabilityExceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "serviceBookings" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "cohortId" TEXT,
    "status" "ServiceBookingStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "paymentMethod" "ServicePaymentMethod",
    "paymentProvider" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "unitPriceMinor" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "amountMinor" INTEGER NOT NULL,
    "feePercent" DOUBLE PRECISION NOT NULL,
    "feeMinor" INTEGER NOT NULL,
    "providerNetMinor" INTEGER NOT NULL,
    "refundedMinor" INTEGER NOT NULL DEFAULT 0,
    "note" VARCHAR(500),
    "startOption" TEXT,
    "requestedStartAt" TIMESTAMP(3),
    "holdExpiresAt" TIMESTAMP(3),
    "stripeCheckoutSessionId" TEXT,
    "stripePaymentIntentId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "serviceBookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "serviceSessions" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "bookingId" TEXT,
    "packageSubscriptionId" TEXT,
    "providerUserId" TEXT NOT NULL,
    "clientUserId" TEXT,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "status" "ServiceSessionStatus" NOT NULL DEFAULT 'SCHEDULED',
    "roomName" TEXT,
    "actualStartAt" TIMESTAMP(3),
    "actualEndAt" TIMESTAMP(3),
    "extraMinutes" INTEGER NOT NULL DEFAULT 0,
    "reminderStartSentAt" TIMESTAMP(3),
    "reminder10SentAt" TIMESTAMP(3),
    "reminder2SentAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "serviceSessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessionParticipants" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3),
    "leftAt" TIMESTAMP(3),
    "totalSeconds" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sessionParticipants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessionExtensions" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "payerId" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "priceMinor" INTEGER NOT NULL,
    "feeMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "status" "SessionExtensionStatus" NOT NULL DEFAULT 'REQUESTED',
    "paymentMethod" "ServicePaymentMethod",
    "stripeCheckoutSessionId" TEXT,
    "respondedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessionExtensions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "packageSubscriptions" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "status" "PackageSubscriptionStatus" NOT NULL DEFAULT 'PENDING',
    "stripeSubscriptionId" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "priceMinor" INTEGER NOT NULL,
    "feePercent" DOUBLE PRECISION NOT NULL,
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "sessionsAllowance" INTEGER NOT NULL DEFAULT 0,
    "sessionsUsed" INTEGER NOT NULL DEFAULT 0,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "canceledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "packageSubscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticketOrders" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "ticketTypeId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceMinor" INTEGER NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "feePercent" DOUBLE PRECISION NOT NULL,
    "feeMinor" INTEGER NOT NULL,
    "providerNetMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "status" "TicketOrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "paymentMethod" "ServicePaymentMethod",
    "paymentProvider" TEXT,
    "stripeCheckoutSessionId" TEXT,
    "holdExpiresAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticketOrders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eventTickets" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "ticketTypeId" TEXT NOT NULL,
    "holderUserId" TEXT NOT NULL,
    "ticketNumber" TEXT NOT NULL,
    "qrSecret" TEXT NOT NULL,
    "status" "EventTicketStatus" NOT NULL DEFAULT 'VALID',
    "checkedInAt" TIMESTAMP(3),
    "checkedInById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eventTickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "serviceReviews" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "bookingId" TEXT,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "serviceReviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "serviceFavorites" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "serviceFavorites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendarFeedTokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendarFeedTokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "serviceProviders_userId_key" ON "serviceProviders"("userId");

-- CreateIndex
CREATE INDEX "proServices_providerUserId_status_idx" ON "proServices"("providerUserId", "status");

-- CreateIndex
CREATE INDEX "proServices_type_status_idx" ON "proServices"("type", "status");

-- CreateIndex
CREATE INDEX "proServices_status_popularityScore_idx" ON "proServices"("status", "popularityScore");

-- CreateIndex
CREATE UNIQUE INDEX "mentorshipDetails_serviceId_key" ON "mentorshipDetails"("serviceId");

-- CreateIndex
CREATE INDEX "mentorshipCohorts_serviceId_startAt_idx" ON "mentorshipCohorts"("serviceId", "startAt");

-- CreateIndex
CREATE UNIQUE INDEX "packageDetails_serviceId_key" ON "packageDetails"("serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "eventDetails_serviceId_key" ON "eventDetails"("serviceId");

-- CreateIndex
CREATE INDEX "eventDetails_startAt_idx" ON "eventDetails"("startAt");

-- CreateIndex
CREATE INDEX "eventTicketTypes_serviceId_idx" ON "eventTicketTypes"("serviceId");

-- CreateIndex
CREATE INDEX "serviceAttachments_serviceId_idx" ON "serviceAttachments"("serviceId");

-- CreateIndex
CREATE INDEX "availabilityRules_serviceId_dayOfWeek_idx" ON "availabilityRules"("serviceId", "dayOfWeek");

-- CreateIndex
CREATE INDEX "availabilityExceptions_serviceId_date_idx" ON "availabilityExceptions"("serviceId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "serviceBookings_stripeCheckoutSessionId_key" ON "serviceBookings"("stripeCheckoutSessionId");

-- CreateIndex
CREATE INDEX "serviceBookings_buyerId_status_idx" ON "serviceBookings"("buyerId", "status");

-- CreateIndex
CREATE INDEX "serviceBookings_providerUserId_status_idx" ON "serviceBookings"("providerUserId", "status");

-- CreateIndex
CREATE INDEX "serviceBookings_serviceId_idx" ON "serviceBookings"("serviceId");

-- CreateIndex
CREATE INDEX "serviceBookings_status_holdExpiresAt_idx" ON "serviceBookings"("status", "holdExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "serviceSessions_roomName_key" ON "serviceSessions"("roomName");

-- CreateIndex
CREATE INDEX "serviceSessions_providerUserId_startAt_idx" ON "serviceSessions"("providerUserId", "startAt");

-- CreateIndex
CREATE INDEX "serviceSessions_clientUserId_startAt_idx" ON "serviceSessions"("clientUserId", "startAt");

-- CreateIndex
CREATE INDEX "serviceSessions_status_startAt_idx" ON "serviceSessions"("status", "startAt");

-- CreateIndex
CREATE INDEX "serviceSessions_bookingId_idx" ON "serviceSessions"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "sessionParticipants_sessionId_userId_key" ON "sessionParticipants"("sessionId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "sessionExtensions_stripeCheckoutSessionId_key" ON "sessionExtensions"("stripeCheckoutSessionId");

-- CreateIndex
CREATE INDEX "sessionExtensions_sessionId_idx" ON "sessionExtensions"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "packageSubscriptions_stripeSubscriptionId_key" ON "packageSubscriptions"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "packageSubscriptions_serviceId_status_idx" ON "packageSubscriptions"("serviceId", "status");

-- CreateIndex
CREATE INDEX "packageSubscriptions_subscriberId_status_idx" ON "packageSubscriptions"("subscriberId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ticketOrders_stripeCheckoutSessionId_key" ON "ticketOrders"("stripeCheckoutSessionId");

-- CreateIndex
CREATE INDEX "ticketOrders_serviceId_status_idx" ON "ticketOrders"("serviceId", "status");

-- CreateIndex
CREATE INDEX "ticketOrders_buyerId_idx" ON "ticketOrders"("buyerId");

-- CreateIndex
CREATE INDEX "ticketOrders_status_holdExpiresAt_idx" ON "ticketOrders"("status", "holdExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "eventTickets_ticketNumber_key" ON "eventTickets"("ticketNumber");

-- CreateIndex
CREATE INDEX "eventTickets_serviceId_status_idx" ON "eventTickets"("serviceId", "status");

-- CreateIndex
CREATE INDEX "eventTickets_holderUserId_idx" ON "eventTickets"("holderUserId");

-- CreateIndex
CREATE UNIQUE INDEX "serviceReviews_bookingId_key" ON "serviceReviews"("bookingId");

-- CreateIndex
CREATE INDEX "serviceReviews_serviceId_createdAt_idx" ON "serviceReviews"("serviceId", "createdAt");

-- CreateIndex
CREATE INDEX "serviceReviews_providerUserId_idx" ON "serviceReviews"("providerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "serviceFavorites_userId_serviceId_key" ON "serviceFavorites"("userId", "serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "calendarFeedTokens_userId_key" ON "calendarFeedTokens"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "calendarFeedTokens_token_key" ON "calendarFeedTokens"("token");

-- AddForeignKey
ALTER TABLE "serviceProviders" ADD CONSTRAINT "serviceProviders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proServices" ADD CONSTRAINT "proServices_providerUserId_fkey" FOREIGN KEY ("providerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentorshipDetails" ADD CONSTRAINT "mentorshipDetails_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "proServices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentorshipCohorts" ADD CONSTRAINT "mentorshipCohorts_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "proServices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packageDetails" ADD CONSTRAINT "packageDetails_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "proServices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eventDetails" ADD CONSTRAINT "eventDetails_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "proServices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eventTicketTypes" ADD CONSTRAINT "eventTicketTypes_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "proServices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serviceAttachments" ADD CONSTRAINT "serviceAttachments_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "proServices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availabilityRules" ADD CONSTRAINT "availabilityRules_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "proServices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availabilityExceptions" ADD CONSTRAINT "availabilityExceptions_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "proServices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serviceBookings" ADD CONSTRAINT "serviceBookings_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "proServices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serviceBookings" ADD CONSTRAINT "serviceBookings_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serviceBookings" ADD CONSTRAINT "serviceBookings_providerUserId_fkey" FOREIGN KEY ("providerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serviceBookings" ADD CONSTRAINT "serviceBookings_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "mentorshipCohorts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serviceSessions" ADD CONSTRAINT "serviceSessions_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "proServices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serviceSessions" ADD CONSTRAINT "serviceSessions_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "serviceBookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serviceSessions" ADD CONSTRAINT "serviceSessions_packageSubscriptionId_fkey" FOREIGN KEY ("packageSubscriptionId") REFERENCES "packageSubscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serviceSessions" ADD CONSTRAINT "serviceSessions_providerUserId_fkey" FOREIGN KEY ("providerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessionParticipants" ADD CONSTRAINT "sessionParticipants_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "serviceSessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessionParticipants" ADD CONSTRAINT "sessionParticipants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessionExtensions" ADD CONSTRAINT "sessionExtensions_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "serviceSessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packageSubscriptions" ADD CONSTRAINT "packageSubscriptions_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "proServices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packageSubscriptions" ADD CONSTRAINT "packageSubscriptions_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packageSubscriptions" ADD CONSTRAINT "packageSubscriptions_providerUserId_fkey" FOREIGN KEY ("providerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticketOrders" ADD CONSTRAINT "ticketOrders_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "proServices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticketOrders" ADD CONSTRAINT "ticketOrders_ticketTypeId_fkey" FOREIGN KEY ("ticketTypeId") REFERENCES "eventTicketTypes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticketOrders" ADD CONSTRAINT "ticketOrders_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticketOrders" ADD CONSTRAINT "ticketOrders_providerUserId_fkey" FOREIGN KEY ("providerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eventTickets" ADD CONSTRAINT "eventTickets_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ticketOrders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eventTickets" ADD CONSTRAINT "eventTickets_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "proServices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eventTickets" ADD CONSTRAINT "eventTickets_ticketTypeId_fkey" FOREIGN KEY ("ticketTypeId") REFERENCES "eventTicketTypes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eventTickets" ADD CONSTRAINT "eventTickets_holderUserId_fkey" FOREIGN KEY ("holderUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serviceReviews" ADD CONSTRAINT "serviceReviews_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "proServices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serviceReviews" ADD CONSTRAINT "serviceReviews_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "serviceBookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serviceReviews" ADD CONSTRAINT "serviceReviews_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serviceReviews" ADD CONSTRAINT "serviceReviews_providerUserId_fkey" FOREIGN KEY ("providerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serviceFavorites" ADD CONSTRAINT "serviceFavorites_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serviceFavorites" ADD CONSTRAINT "serviceFavorites_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "proServices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendarFeedTokens" ADD CONSTRAINT "calendarFeedTokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
