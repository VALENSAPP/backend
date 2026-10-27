
import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHmac } from 'node:crypto';
import { resolveKycPaymentProvider } from '../common/payment-provider.util';

@Injectable()
export class KycService {
  private veriffBase = process.env.VERIFF_BASE_URL;
  private veriffKey = process.env.VERIFF_API_KEY;

  constructor(private prisma: PrismaService) { }

  private async markUserKycApproved(userId: string, rawDocCountry?: string | null) {
    const { normalizedCountry, paymentProvider } = resolveKycPaymentProvider(rawDocCountry);
    const updateData: any = {
      kyc: true,
      canAccessPlatform: 'true',
      paymentProvider,
    };
    if (normalizedCountry) {
      updateData.country = normalizedCountry;
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: updateData,
    });
  }



  private firstNonEmptyString(values: any[]): string | null {
    for (const value of values) {
      if (typeof value === 'string' && value.trim() !== '') {
        return value.trim();
      }
    }
    return null;
  }

  private extractDeclineReason(payload: any): string {
    if (!payload) return 'Unknown reason';

    const verification = payload.verification || payload;
    const decision = verification?.decision || payload?.decision;

    const directReason = this.firstNonEmptyString([
      decision?.reason,
      decision?.label,
      verification?.reason,
      payload?.reason,
      verification?.message,
      payload?.message,
      verification?.code,
      decision?.code,
      payload?.code,
    ]);
    if (directReason) return directReason;

    const reasonArray = Array.isArray(decision?.reasons) ? decision.reasons : [];
    for (const item of reasonArray) {
      const fromArray = this.firstNonEmptyString([
        item?.reason,
        item?.label,
        item?.message,
        item?.code,
      ]);
      if (fromArray) return fromArray;
    }

    const checksArray = Array.isArray(decision?.checks) ? decision.checks : [];
    for (const check of checksArray) {
      const fromChecks = this.firstNonEmptyString([
        check?.reason,
        check?.label,
        check?.message,
        check?.code,
        check?.status,
      ]);
      if (fromChecks) return fromChecks;
    }

    return 'Unknown reason';
  }

  /**
   * Create Veriff session for a user with manual first and last name
   */
  async createVeriffSession(
    userId: string,
    documentType: 'DRIVERS_LICENSE' | 'PASSPORT' | 'ID_CARD',
    firstName: string,
    lastName: string,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new HttpException('User not found', HttpStatus.NOT_FOUND);

    // Person details passed manually
    const personDetails = {
      firstName,
      lastName,
    };

    try {
      const { data } = await axios.post(
        `${this.veriffBase}/v1/sessions`,
        {
          verification: {
            person: personDetails,
            document: { type: documentType },
            vendorData: userId,
            callback: `${process.env.BASE_URL}/kyc/callback?userId=${encodeURIComponent(userId)}`,
          },
        },
        {
          headers: {
            'X-AUTH-CLIENT': this.veriffKey,
            'Content-Type': 'application/json',
          },
        },
      );

      const sessionId = data.verification.id;
      const url = data.verification.url;

      // Store only session info, no names
      await this.prisma.kyc.create({
        data: {
          userId,
          veriffSessionId: sessionId,
          veriffUrl: url,
          status: 'PENDING',
          documentType,
        },
      });

      return { sessionId, url };
    } catch (error) {
      console.error(error.response?.data || error);
      throw new HttpException('Failed to create KYC session', HttpStatus.BAD_REQUEST);
    }
  }


  async handleWebhook(verification: any) {
    const { id, action, code } = verification;

    // console.log(`🔍 Processing webhook for session ${id} with action: ${action}, code: ${code}`);

    const kycRecord = await this.prisma.kyc.findFirst({
      where: {
        veriffSessionId: id,
        status: { in: ['PENDING', 'SUBMITTED'] }
      },
    });

    if (!kycRecord) {
      // console.log(`ℹ️ Skipping webhook for session ${id} - not found or already processed`);
      return;
    }

    // Map Veriff action/code to our enum
    let mappedStatus: 'PENDING' | 'SUBMITTED' | 'APPROVED' | 'DECLINED' = 'PENDING';

    if (action === 'approved' || code === 7003) mappedStatus = 'APPROVED';
    else if (action === 'declined' || code === 7004 || action === 'decision') mappedStatus = 'DECLINED';
    else if (action === 'submitted' || code === 7002) mappedStatus = 'SUBMITTED';
    else if (action === 'started' || code === 7001) mappedStatus = 'PENDING';
    else if (action === 'expired' || action === 'abandoned' || action === 'reviewed') mappedStatus = 'DECLINED';

    // console.log(`🔄 Mapping action '${action}' (code: ${code}) to '${mappedStatus}'`);

    await this.prisma.kyc.update({
      where: { id: kycRecord.id },
      data: { status: mappedStatus, webhookData: verification },
    });

    // Update user.kyc field if approved
    if (mappedStatus === 'APPROVED') {
      const docCountry =
        verification?.document?.country ||
        verification?.verification?.document?.country ||
        verification?.person?.country ||
        verification?.verification?.person?.country ||
        verification?.person?.nationality ||
        verification?.verification?.person?.nationality;

      await this.markUserKycApproved(kycRecord.userId, docCountry);
    }


    // console.log(`✅ KYC record updated: ${id} → ${mappedStatus}`);
  }



  /**
   * Get latest KYC status for a user
   */
  async getKycStatus(userId: string) {
    return this.prisma.kyc.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Fetch KYC status from Veriff API (fallback when webhook fails)
   */
  async fetchVeriffStatus(sessionId: string) {
    try {
      // Generate HMAC signature like in the working example
      const signature = createHmac('sha256', process.env.VERIFF_SECRET_KEY || '')
        .update(sessionId)
        .digest('hex')
        .toLowerCase();

      const headers = {
        'X-AUTH-CLIENT': this.veriffKey,
        'X-HMAC-SIGNATURE': signature,
        'Content-Type': 'application/json',
      };

      let response;

      try {
        // Try main session endpoint first
        response = await axios.get(`${this.veriffBase}/v1/sessions/${sessionId}`, { headers });
      } catch (err) {
        console.warn('Full session fetch failed, falling back to attempts endpoint...');
        // Fallback to attempts endpoint
        response = await axios.get(`${this.veriffBase}/v1/sessions/${sessionId}/attempts`, { headers });
      }

      const verificationData = response.data?.verification || response.data?.verifications?.[0];

      if (!verificationData) {
        console.error('No verification data found in response');
        return null;
      }

      const veriffStatus = verificationData.status;

      let country =
        verificationData?.document?.country ||
        verificationData?.person?.country ||
        verificationData?.person?.nationality ||
        null;

      if (veriffStatus === 'approved' && !country) {
        try {
          const decisionResponse = await axios.get(`${this.veriffBase}/v1/sessions/${sessionId}/decision`, { headers });
          const decisionData = decisionResponse.data;
          country =
            decisionData?.verification?.document?.country ||
            decisionData?.verification?.person?.country ||
            decisionData?.verification?.person?.nationality ||
            decisionData?.document?.country ||
            null;
        } catch {}
      }

      let reason = null;
      if (veriffStatus === 'declined') {
        // Try to fetch decision for declined status
        try {
          const decisionResponse = await axios.get(`${this.veriffBase}/v1/sessions/${sessionId}/decision`, { headers });
          const decisionData = decisionResponse.data;
          reason = this.extractDeclineReason(decisionData);
          // console.log(`📋 Fetched decline reason for ${sessionId}: ${reason}`);
        } catch (decisionError) {
          console.warn(`Could not fetch decision for declined session ${sessionId}:`, decisionError.message);
          reason = this.extractDeclineReason(verificationData);
        }
      }

      return { status: veriffStatus, reason, country };
    } catch (error) {
      console.error('❌ Failed to fetch Veriff status:', error.response?.data || error);
      return null;
    }
  }

  /**
   * Sync KYC status with Veriff (manual sync for specific user)
   */
  async syncKycStatus(userId: string) {
    const kycRecord = await this.prisma.kyc.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    if (!kycRecord) {
      throw new HttpException('KYC record not found', HttpStatus.NOT_FOUND);
    }

    const veriffData = await this.fetchVeriffStatus(kycRecord.veriffSessionId);
    if (!veriffData) {
      return { success: false, message: 'Could not fetch status from Veriff' };
    }

    const veriffStatus = veriffData.status;
    const reason = veriffData.reason;

    // Map Veriff status to our enum
    let mappedStatus: 'PENDING' | 'SUBMITTED' | 'APPROVED' | 'DECLINED' = kycRecord.status;
    if (veriffStatus === 'approved') mappedStatus = 'APPROVED';
    else if (veriffStatus === 'declined') mappedStatus = 'DECLINED';
    else if (veriffStatus === 'submitted') mappedStatus = 'SUBMITTED';
    else if (veriffStatus === 'expired') mappedStatus = 'DECLINED';

    // Update if status changed
    if (mappedStatus !== kycRecord.status) {
      await this.prisma.kyc.update({
        where: { id: kycRecord.id },
        data: { status: mappedStatus },
      });

      if (mappedStatus === 'APPROVED') {
        await this.markUserKycApproved(userId, veriffData?.country);
      }

      // console.log(`✅ Synced KYC status: ${kycRecord.veriffSessionId} → ${mappedStatus}`);
      return { success: true, status: mappedStatus, updated: true, reason: mappedStatus === 'DECLINED' ? reason : null };
    }

    return { success: true, status: mappedStatus, updated: false, reason: mappedStatus === 'DECLINED' ? reason : null };
  }

  /**
   * Cron job: Sync all pending/submitted KYC records every 5 minutes
   */
  // @Cron('*/2 * * * * *') // Every 2 minutes
  // async syncPendingKycCron() {
  //   // console.log('⏰ Cron: Starting scheduled KYC status sync...');
  //   await this.syncAllPendingKyc();
  // }

  /**
   * Auto-decline stale KYC records:
   * If status is PENDING for more than 48 hours, mark as DECLINED.
   */
  // @Cron(CronExpression.EVERY_HOUR)
  // async autoDeclineStalePendingKyc() {
  //   const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);

  //   const result = await this.prisma.kyc.updateMany({
  //     where: {
  //       status: 'PENDING',
  //       createdAt: { lte: cutoff },
  //     },
  //     data: {
  //       status: 'DECLINED',
  //     },
  //   });

  //   if (result.count > 0) {
  //     console.log(`⏱️ Auto-declined ${result.count} stale PENDING KYC records (older than 48h).`);
  //   }
  // }

  /**
   * Sync all pending/submitted KYC records with Veriff
   */
  async syncAllPendingKyc() {
    // console.log('🔄 Starting sync for all pending/submitted KYC records...');

    const pendingRecords = await this.prisma.kyc.findMany({
      where: {
        status: { in: ['PENDING', 'SUBMITTED'] }
      }
    });

    // console.log(`📋 Found ${pendingRecords.length} pending/submitted KYC records to sync`);

    let updated = 0;
    let errors = 0;

    for (const record of pendingRecords) {
      try {
        // console.log(`🔍 Syncing KYC for user ${record.userId}, session ${record.veriffSessionId}`);

        const veriffData = await this.fetchVeriffStatus(record.veriffSessionId);
        if (!veriffData) {
          // console.log(`⚠️ Could not fetch status for session ${record.veriffSessionId}`);
          errors++;
          continue;
        }

        const veriffStatus = veriffData.status;

        // Map Veriff status to our enum
        let mappedStatus: 'PENDING' | 'SUBMITTED' | 'APPROVED' | 'DECLINED' = record.status;
        if (veriffStatus === 'approved') mappedStatus = 'APPROVED';
        else if (veriffStatus === 'declined') mappedStatus = 'DECLINED';
        else if (veriffStatus === 'submitted') mappedStatus = 'SUBMITTED';
        else if (veriffStatus === 'expired') mappedStatus = 'DECLINED';

        // Update if status changed
        if (mappedStatus !== record.status) {
          await this.prisma.kyc.update({
            where: { id: record.id },
            data: { status: mappedStatus },
          });

          if (mappedStatus === 'APPROVED') {
            await this.markUserKycApproved(record.userId, veriffData?.country);
          }

          // console.log(`✅ Updated KYC ${record.veriffSessionId}: ${record.status} → ${mappedStatus}`);
          updated++;
        } else {
          // console.log(`ℹ️ KYC ${record.veriffSessionId} status unchanged: ${mappedStatus}`);
        }
      } catch (error) {
        console.error(`❌ Error syncing KYC ${record.veriffSessionId}:`, error);
        errors++;
      }
    }

    // console.log(`🎯 Sync completed: ${updated} updated, ${errors} errors, ${pendingRecords.length - updated - errors} unchanged`);

    return {
      success: true,
      total: pendingRecords.length,
      updated,
      errors,
      unchanged: pendingRecords.length - updated - errors
    };
  }

}
