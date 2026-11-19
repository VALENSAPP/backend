-- AlterTable
ALTER TABLE "DonationData" ADD COLUMN     "fxConvertedAt" TIMESTAMP(3),
ADD COLUMN     "fxQuoteId" TEXT,
ADD COLUMN     "fxRate" DOUBLE PRECISION,
ADD COLUMN     "fxSource" TEXT,
ADD COLUMN     "receivedAmountMinor" INTEGER,
ADD COLUMN     "receivedCurrency" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "fxConvertedAt" TIMESTAMP(3),
ADD COLUMN     "fxQuoteId" TEXT,
ADD COLUMN     "fxRate" DOUBLE PRECISION,
ADD COLUMN     "fxSource" TEXT,
ADD COLUMN     "receivedAmountMinor" INTEGER,
ADD COLUMN     "receivedCurrency" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "kycCountry" TEXT,
ADD COLUMN     "stripeAccountCountry" TEXT,
ADD COLUMN     "stripeAccountEmail" TEXT,
ADD COLUMN     "stripeAccountStatus" TEXT,
ADD COLUMN     "stripeAccountSyncedAt" TIMESTAMP(3),
ADD COLUMN     "stripeBankCurrency" TEXT,
ADD COLUMN     "stripeBankLast4" TEXT,
ADD COLUMN     "stripeBankName" TEXT,
ADD COLUMN     "stripeDetailsSubmitted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stripePayoutsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "WithdrawalRecord" ADD COLUMN     "failedAt" TIMESTAMP(3),
ADD COLUMN     "fxQuoteId" TEXT,
ADD COLUMN     "fxRate" DOUBLE PRECISION,
ADD COLUMN     "isAutomatic" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "payoutAmountMinor" INTEGER,
ADD COLUMN     "payoutArrivalDate" TIMESTAMP(3),
ADD COLUMN     "payoutAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "payoutCurrency" TEXT,
ADD COLUMN     "payoutId" TEXT,
ADD COLUMN     "payoutStatus" TEXT,
ADD COLUMN     "transferAmountMinor" INTEGER,
ADD COLUMN     "transferCurrency" TEXT,
ADD COLUMN     "transferredAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "walletLedgerEntries" ADD COLUMN     "fxQuoteId" TEXT,
ADD COLUMN     "fxRate" DOUBLE PRECISION,
ADD COLUMN     "originalAmountMinor" INTEGER,
ADD COLUMN     "originalCurrency" TEXT;

-- CreateTable
CREATE TABLE "PendingWalletCredit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "refType" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "sourceAmountMinor" INTEGER NOT NULL,
    "sourceCurrency" TEXT NOT NULL,
    "targetCurrency" TEXT NOT NULL,
    "rateType" TEXT NOT NULL,
    "note" TEXT,
    "receiptType" TEXT,
    "receiptId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingWalletCredit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "autoPayoutEnabled" BOOLEAN NOT NULL DEFAULT false,
    "intervalDays" INTEGER NOT NULL DEFAULT 7,
    "minimumAmountMinor" INTEGER NOT NULL DEFAULT 2000,
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayoutSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PendingWalletCredit_status_idx" ON "PendingWalletCredit"("status");

-- CreateIndex
CREATE INDEX "PendingWalletCredit_userId_idx" ON "PendingWalletCredit"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PendingWalletCredit_refType_refId_mode_key" ON "PendingWalletCredit"("refType", "refId", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutSettings_userId_key" ON "PayoutSettings"("userId");

-- CreateIndex
CREATE INDEX "PayoutSettings_autoPayoutEnabled_nextRunAt_idx" ON "PayoutSettings"("autoPayoutEnabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "WithdrawalRecord_payoutId_idx" ON "WithdrawalRecord"("payoutId");

-- CreateIndex
CREATE INDEX "WithdrawalRecord_payoutStatus_idx" ON "WithdrawalRecord"("payoutStatus");

-- AddForeignKey
ALTER TABLE "PendingWalletCredit" ADD CONSTRAINT "PendingWalletCredit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutSettings" ADD CONSTRAINT "PayoutSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
