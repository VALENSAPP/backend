/**
 * One-time backfill after the Stripe FX / payouts migration.
 *
 * 1. Payment / DonationData: copy what the receiver actually got (from wallet ledger credits) into
 *    receivedAmountMinor / receivedCurrency, so receiver totals and lists match their wallet.
 * 2. (optional, --kyc-country) Set User.kycCountry for already-verified users from their stored country.
 *
 * Run:  npx ts-node prisma/backfill-received-amounts.ts            (dry run, prints counts)
 *       npx ts-node prisma/backfill-received-amounts.ts --apply    (writes)
 *       npx ts-node prisma/backfill-received-amounts.ts --apply --kyc-country
 */
import { PrismaClient } from '@prisma/client';
import { toIsoAlpha2 } from '../src/common/country.util';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const KYC_COUNTRY = process.argv.includes('--kyc-country');

async function backfillReceivedAmounts() {
  const credits = await prisma.walletLedgerEntry.findMany({
    where: { refType: 'PAYMENT', entryType: 'AVAILABLE_CREDIT', refId: { not: null } },
    select: { userId: true, refId: true, amountMinor: true, currency: true, source: true },
  });
  console.log(`Ledger credits to match: ${credits.length}`);

  let payments = 0;
  let donations = 0;

  for (const credit of credits) {
    const refId = credit.refId as string;
    const data = {
      receivedAmountMinor: credit.amountMinor,
      receivedCurrency: credit.currency,
      fxSource: 'legacy_ledger',
    };

    if (credit.source === 'MISSION_DONATION') {
      const where = { vendorId: credit.userId, stripeCheckoutSessionId: refId, receivedAmountMinor: null };
      const count = await prisma.donationData.count({ where });
      if (count > 0) {
        donations += count;
        if (APPLY) await prisma.donationData.updateMany({ where, data });
      }
      continue;
    }

    // Tips / pay-following / fan subscriptions: the ledger refId is the PaymentIntent, invoice or custom id.
    const where = {
      receiverId: credit.userId,
      receivedAmountMinor: null,
      OR: [{ stripePaymentIntentId: refId }, { stripeInvoiceId: refId }],
    };
    const count = await prisma.payment.count({ where });
    if (count > 0) {
      payments += count;
      if (APPLY) await prisma.payment.updateMany({ where, data });
    }
  }

  console.log(`${APPLY ? 'Updated' : 'Would update'} Payment rows: ${payments}`);
  console.log(`${APPLY ? 'Updated' : 'Would update'} DonationData rows: ${donations}`);
}

async function backfillKycCountry() {
  const users = await prisma.user.findMany({
    where: { kyc: true, kycCountry: null, country: { not: null } },
    select: { id: true, country: true },
  });
  let updated = 0;
  for (const user of users) {
    const kycCountry = toIsoAlpha2(user.country);
    if (!kycCountry) continue;
    updated += 1;
    if (APPLY) await prisma.user.update({ where: { id: user.id }, data: { kycCountry } });
  }
  console.log(`${APPLY ? 'Updated' : 'Would update'} User.kycCountry: ${updated} (of ${users.length} verified users without it)`);
}

async function main() {
  console.log(APPLY ? 'Mode: APPLY' : 'Mode: DRY RUN (add --apply to write)');
  await backfillReceivedAmounts();
  if (KYC_COUNTRY) await backfillKycCountry();
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
