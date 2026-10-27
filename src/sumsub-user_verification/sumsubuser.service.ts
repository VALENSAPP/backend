
import { BadRequestException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import axios, { AxiosRequestConfig } from 'axios';
import { createHmac } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { resolveKycPaymentProvider } from '../common/payment-provider.util';

const SUMSUB_KYC_LEVEL_NAME = process.env.SUMSUB_KYC_LEVEL_NAME || process.env.SUMSUB_LEVEL_NAME || 'basic-kyc-level';
const SUMSUB_TTL_SEC = 600;

@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);

  // Veriff (commented out - kept for reference)
  private veriffBase = process.env.VERIFF_BASE_URL;
  private veriffKey = process.env.VERIFF_API_KEY;

  // Sumsub
  private readonly sumsubBaseUrl: string;
  private readonly sumsubAppToken: string;
  private readonly sumsubSecretKey: string;

  constructor(private prisma: PrismaService) {
    this.sumsubBaseUrl = (process.env.SUMSUB_BASE_URL || 'https://api.sumsub.com').replace(/\/$/, '');
    this.sumsubAppToken = process.env.SUMSUB_APP_TOKEN || '';
    this.sumsubSecretKey = process.env.SUMSUB_SECRET_KEY || '';
  }

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



  /* --------------- Sumsub API helpers --------------- */

  private createSumsubSignature(ts: number, method: string, path: string, body = ''): string {
    const data = `${ts}${method.toUpperCase()}${path}${body}`;
    return createHmac('sha256', this.sumsubSecretKey).update(data).digest('hex');
  }

  private async sumsubRequest<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: object,
  ): Promise<T> {
    if (!this.sumsubAppToken || !this.sumsubSecretKey) {
      throw new BadRequestException('Sumsub credentials are missing (SUMSUB_APP_TOKEN, SUMSUB_SECRET_KEY).');
    }
    const ts = Math.floor(Date.now() / 1000);
    const bodyStr = body ? JSON.stringify(body) : '';
    const signature = this.createSumsubSignature(ts, method, path, bodyStr);
    const config: AxiosRequestConfig = {
      method,
      url: `${this.sumsubBaseUrl}${path}`,
      headers: {
        'Content-Type': 'application/json',
        'X-App-Token': this.sumsubAppToken,
        'X-App-Access-Ts': ts.toString(),
        'X-App-Access-Sig': signature,
      },
      data: bodyStr || undefined,
    };
    try {
      const response = await axios(config);
      return response.data;
    } catch (error: any) {
      this.logger.error('Sumsub API Error:', error?.response?.data || error.message);
      throw new BadRequestException(
        error?.response?.data?.description || 'Sumsub request failed',
      );
    }
  }

  /**
   * Create KYC session (Sumsub). Returns { sessionId, url } so frontend contract is unchanged.
   * Old Veriff code is commented below.
   */
  async createVeriffSession(
    userId: string,
    documentType: 'DRIVERS_LICENSE' | 'PASSPORT' | 'ID_CARD',
    firstName: string,
    lastName: string,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
    if (!user) throw new HttpException('User not found', HttpStatus.NOT_FOUND);

    // --------------- NEW: Sumsub flow ---------------
    const externalUserId = userId;
    const tokenResponse = await this.sumsubRequest<{ token: string; userId: string }>(
      'POST',
      '/resources/accessTokens/sdk',
      {
        userId: externalUserId,
        levelName: SUMSUB_KYC_LEVEL_NAME,
        ttlInSecs: SUMSUB_TTL_SEC,
        applicantIdentifiers: user.email ? { email: user.email } : undefined,
      },
    );

    let applicantId: string | null = null;
    try {
      const applicant = await this.sumsubRequest<any>(
        'GET',
        `/resources/applicants/-;externalUserId=${encodeURIComponent(externalUserId)}`,
      );
      applicantId = applicant?.id ?? null;
    } catch {
      this.logger.warn('Applicant not found yet (will be created on first SDK use).');
    }

    const sessionId = applicantId ?? tokenResponse.userId ?? externalUserId;
    const kycPageUrl = process.env.KYC_PAGE_URL || (process.env.BASE_URL ? `${process.env.BASE_URL}/kyc` : '/kyc');

    await this.prisma.kyc.create({
      data: {
        userId,
        veriffSessionId: sessionId,
        veriffUrl: kycPageUrl,
        sumsubApplicantId: applicantId ?? undefined,
        status: 'PENDING',
        documentType,
      },
    });

    return { sessionId, url: kycPageUrl };
  }

  // --------------- OLD: Veriff flow (commented) ---------------
  // async createVeriffSession(
  //   userId: string,
  //   documentType: 'DRIVERS_LICENSE' | 'PASSPORT' | 'ID_CARD',
  //   firstName: string,
  //   lastName: string,
  // ) {
  //   const user = await this.prisma.user.findUnique({ where: { id: userId } });
  //   if (!user) throw new HttpException('User not found', HttpStatus.NOT_FOUND);
  //   const personDetails = { firstName, lastName };
  //   try {
  //     const { data } = await axios.post(
  //       `${this.veriffBase}/v1/sessions`,
  //       {
  //         verification: {
  //           person: personDetails,
  //           document: { type: documentType },
  //           vendorData: userId,
  //           callback: `${process.env.BASE_URL}/veriff.html`,
  //         },
  //       },
  //       {
  //         headers: {
  //           'X-AUTH-CLIENT': this.veriffKey,
  //           'Content-Type': 'application/json',
  //         },
  //       },
  //     );
  //     const sessionId = data.verification.id;
  //     const url = data.verification.url;
  //     await this.prisma.kyc.create({
  //       data: {
  //         userId,
  //         veriffSessionId: sessionId,
  //         veriffUrl: url,
  //         status: 'PENDING',
  //         documentType,
  //       },
  //     });
  //     return { sessionId, url };
  //   } catch (error) {
  //     console.error(error.response?.data || error);
  //     throw new HttpException('Failed to create KYC session', HttpStatus.BAD_REQUEST);
  //   }
  // }

  /**
   * Handle webhook: if Sumsub payload, delegate to handleSumsubWebhook; else (Veriff) use commented logic.
   */
  async handleWebhook(verification: any) {
    if (verification?.reviewResult?.reviewAnswer != null) {
      await this.handleSumsubWebhook(verification);
      return;
    }

    // --------------- OLD: Veriff webhook (commented) ---------------
    // const { id, action, code } = verification;
    // console.log(`🔍 Processing webhook for session ${id} with action: ${action}, code: ${code}`);
    // const kycRecord = await this.prisma.kyc.findFirst({
    //   where: { veriffSessionId: id, status: { in: ['PENDING', 'SUBMITTED'] } },
    // });
    // if (!kycRecord) {
    //   console.log(`ℹ️ Skipping webhook for session ${id} - not found or already processed`);
    //   return;
    // }
    // let mappedStatus: 'PENDING' | 'SUBMITTED' | 'APPROVED' | 'DECLINED' = 'PENDING';
    // if (action === 'approved' || code === 7003) mappedStatus = 'APPROVED';
    // else if (action === 'declined' || code === 7004 || action === 'decision') mappedStatus = 'DECLINED';
    // else if (action === 'submitted' || code === 7002) mappedStatus = 'SUBMITTED';
    // else if (action === 'started' || code === 7001) mappedStatus = 'PENDING';
    // else if (action === 'expired' || action === 'abandoned' || action === 'reviewed') mappedStatus = 'DECLINED';
    // await this.prisma.kyc.update({
    //   where: { id: kycRecord.id },
    //   data: { status: mappedStatus, webhookData: verification },
    // });
    // if (mappedStatus === 'APPROVED') {
    //   await this.prisma.user.update({
    //     where: { id: kycRecord.userId },
    //     data: { kyc: true },
    //   });
    //   console.log(`✅ User KYC status updated to true for user ${kycRecord.userId}`);
    // }
    // console.log(`✅ KYC record updated: ${id} → ${mappedStatus}`);
  }

  /** Sumsub webhook: update Kyc by applicantId and set user.kyc when approved. */
  async handleSumsubWebhook(payload: any) {
    const applicantId = payload?.applicantId;
    const externalUserId = payload?.externalUserId;
    const reviewAnswer = payload?.reviewResult?.reviewAnswer;

    if (!applicantId || !reviewAnswer) return;

    let kycRecord = await this.prisma.kyc.findFirst({
      where: { sumsubApplicantId: applicantId, status: { in: ['PENDING', 'SUBMITTED'] } },
    });
    if (!kycRecord && externalUserId) {
      kycRecord = await this.prisma.kyc.findFirst({
        where: { userId: externalUserId, veriffSessionId: applicantId, status: { in: ['PENDING', 'SUBMITTED'] } },
      });
    }
    // Fallback: match by userId only (most recent pending) when applicantId wasn't stored at session start
    if (!kycRecord && externalUserId) {
      kycRecord = await this.prisma.kyc.findFirst({
        where: { userId: externalUserId, status: { in: ['PENDING', 'SUBMITTED'] } },
        orderBy: { createdAt: 'desc' },
      });
    }
    if (!kycRecord) {
      this.logger.warn(`Sumsub webhook: no KYC record for applicantId=${applicantId}, externalUserId=${externalUserId}`);
      return;
    }

    const status: 'APPROVED' | 'DECLINED' =
      reviewAnswer === 'GREEN' ? 'APPROVED' : reviewAnswer === 'RED' ? 'DECLINED' : (null as any);
    if (!status) return;

    await this.prisma.kyc.update({
      where: { id: kycRecord.id },
      data: {
        sumsubApplicantId: applicantId,
        status,
        webhookData: payload,
      },
    });

    if (status === 'APPROVED') {
      let docCountry =
        payload?.info?.country ||
        payload?.applicant?.info?.country ||
        payload?.applicant?.country ||
        payload?.reviewResult?.applicantData?.country;

      if (!docCountry && applicantId) {
        try {
          const applicant = await this.sumsubRequest<any>(
            'GET',
            `/resources/applicants/${encodeURIComponent(applicantId)}/one`,
          );
          docCountry =
            applicant?.info?.country ||
            applicant?.info?.idDocs?.[0]?.country ||
            applicant?.fixedInfo?.country;
        } catch (err: any) {
          this.logger.warn(`Could not fetch applicant ${applicantId} info from Sumsub: ${err?.message}`);
        }
      }

      await this.markUserKycApproved(kycRecord.userId, docCountry);
      this.logger.log(`User KYC set to true for user ${kycRecord.userId}`);
    }
    this.logger.log(`KYC record ${kycRecord.id} updated to ${status}`);
  }

  /**
   * Get latest KYC status for a user (unchanged contract).
   */
  async getKycStatus(userId: string) {
    return this.prisma.kyc.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Get Sumsub SDK access token for the current user's pending KYC (for frontend KYC page).
   */
  async getSumsubAccessToken(userId: string): Promise<{ token: string; userId: string }> {
    const kycRecord = await this.prisma.kyc.findFirst({
      where: { userId, status: { in: ['PENDING', 'SUBMITTED'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!kycRecord) {
      throw new HttpException('No pending KYC session found for user', HttpStatus.NOT_FOUND);
    }

    const externalUserId = userId;
    const tokenResponse = await this.sumsubRequest<{ token: string; userId: string }>(
      'POST',
      '/resources/accessTokens/sdk',
      {
        userId: externalUserId,
        levelName: SUMSUB_KYC_LEVEL_NAME,
        ttlInSecs: SUMSUB_TTL_SEC,
      },
    );
    return { token: tokenResponse.token, userId: tokenResponse.userId };
  }

  /** Resolve Sumsub applicant id by external userId (for sync when sumsubApplicantId not yet set). */
  private async getApplicantIdByUserId(userId: string): Promise<string | null> {
    try {
      const applicant = await this.sumsubRequest<{ id: string }>(
        'GET',
        `/resources/applicants/-;externalUserId=${encodeURIComponent(userId)}`,
      );
      return applicant?.id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch KYC status from Sumsub API (for sync). Old Veriff fetch is commented.
   */
  async fetchSumsubStatus(applicantId: string): Promise<{ status: string; reason?: string; country?: string | null } | null> {
    try {
      const data = await this.sumsubRequest<any>(
        'GET',
        `/resources/applicants/${encodeURIComponent(applicantId)}/status`,
      );
      const reviewAnswer = data?.reviewResult?.reviewAnswer;
      const reviewStatus = data?.reviewStatus;
      if (reviewAnswer === 'GREEN') {
        let country: string | null = null;
        try {
          const applicant = await this.sumsubRequest<any>(
            'GET',
            `/resources/applicants/${encodeURIComponent(applicantId)}/one`,
          );
          country =
            applicant?.info?.country ||
            applicant?.info?.idDocs?.[0]?.country ||
            applicant?.fixedInfo?.country ||
            null;
        } catch (err: any) {
          this.logger.warn(`Could not fetch applicant details for ${applicantId}: ${err?.message}`);
        }
        return { status: 'approved', country };
      }
      if (reviewAnswer === 'RED') {
        const reason = data?.reviewResult?.rejectLabels?.[0] || data?.reviewResult?.reviewRejectType || 'Rejected';
        return { status: 'declined', reason };
      }
      if (reviewStatus === 'pending' || reviewStatus === 'prechecked') return { status: 'pending' };
      return { status: reviewStatus || 'pending' };
    } catch (error: any) {
      this.logger.warn(`Failed to fetch Sumsub status for applicant ${applicantId}:`, error?.response?.data || error.message);
      return null;
    }
  }

  // --------------- OLD: Veriff fetch (commented) ---------------
  // async fetchVeriffStatus(sessionId: string) {
  //   try {
  //     const signature = createHmac('sha256', process.env.VERIFF_SECRET_KEY || '')
  //       .update(sessionId)
  //       .digest('hex')
  //       .toLowerCase();
  //     const headers = {
  //       'X-AUTH-CLIENT': this.veriffKey,
  //       'X-HMAC-SIGNATURE': signature,
  //       'Content-Type': 'application/json',
  //     };
  //     let response;
  //     try {
  //       response = await axios.get(`${this.veriffBase}/v1/sessions/${sessionId}`, { headers });
  //     } catch (err) {
  //       response = await axios.get(`${this.veriffBase}/v1/sessions/${sessionId}/attempts`, { headers });
  //     }
  //     const verificationData = response.data?.verification || response.data?.verifications?.[0];
  //     if (!verificationData) return null;
  //     const veriffStatus = verificationData.status;
  //     let reason = null;
  //     if (veriffStatus === 'declined') {
  //       try {
  //         const decisionResponse = await axios.get(`${this.veriffBase}/v1/sessions/${sessionId}/decision`, { headers });
  //         const decisionData = decisionResponse.data;
  //         reason = decisionData?.verification?.decision?.reason || decisionData?.reason || 'Unknown reason';
  //       } catch { reason = 'Reason not available'; }
  //     }
  //     return { status: veriffStatus, reason };
  //   } catch (error) {
  //     console.error('❌ Failed to fetch Veriff status:', error.response?.data || error);
  //     return null;
  //   }
  // }

  /**
   * Sync KYC status with Sumsub for one user. Uses Sumsub when record has sumsubApplicantId.
   */
  async syncKycStatus(userId: string) {
    const kycRecord = await this.prisma.kyc.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    if (!kycRecord) {
      throw new HttpException('KYC record not found', HttpStatus.NOT_FOUND);
    }

    let applicantId = kycRecord.sumsubApplicantId ?? null;
    if (!applicantId) {
      applicantId = await this.getApplicantIdByUserId(kycRecord.userId);
    }
    if (!applicantId) {
      return { success: false, message: 'Could not resolve Sumsub applicant for this KYC record' };
    }
    const sumsubData = await this.fetchSumsubStatus(applicantId);
    if (!sumsubData) {
      return { success: false, message: 'Could not fetch status from Sumsub' };
    }

    const sumsubStatus = sumsubData.status;
    const reason = sumsubData.reason;

    let mappedStatus: 'PENDING' | 'SUBMITTED' | 'APPROVED' | 'DECLINED' = kycRecord.status;
    if (sumsubStatus === 'approved') mappedStatus = 'APPROVED';
    else if (sumsubStatus === 'declined') mappedStatus = 'DECLINED';
    else if (sumsubStatus === 'submitted' || sumsubStatus === 'pending') mappedStatus = sumsubStatus === 'submitted' ? 'SUBMITTED' : 'PENDING';

    if (mappedStatus !== kycRecord.status) {
      await this.prisma.kyc.update({
        where: { id: kycRecord.id },
        data: { status: mappedStatus },
      });

      if (mappedStatus === 'APPROVED') {
        await this.markUserKycApproved(userId, sumsubData?.country);
      }

      this.logger.log(`Synced KYC status: ${applicantId} → ${mappedStatus}`);
      return { success: true, status: mappedStatus, updated: true, reason: mappedStatus === 'DECLINED' ? reason : null };
    }

    return { success: true, status: mappedStatus, updated: false, reason: mappedStatus === 'DECLINED' ? reason : null };
  }

  /**
   * Sync all pending/submitted KYC records with Sumsub.
   */
  async syncAllPendingKyc() {
    const pendingRecords = await this.prisma.kyc.findMany({
      where: { status: { in: ['PENDING', 'SUBMITTED'] } },
    });

    this.logger.log(`Found ${pendingRecords.length} pending/submitted KYC records to sync`);

    let updated = 0;
    let errors = 0;

    for (const record of pendingRecords) {
      try {
        let applicantId = record.sumsubApplicantId ?? await this.getApplicantIdByUserId(record.userId);
        if (!applicantId) {
          this.logger.warn(`Could not resolve applicant for user ${record.userId}`);
          errors++;
          continue;
        }
        const sumsubData = await this.fetchSumsubStatus(applicantId);
        if (!sumsubData) {
          this.logger.warn(`Could not fetch status for session ${applicantId}`);
          errors++;
          continue;
        }

        const sumsubStatus = sumsubData.status;
        let mappedStatus: 'PENDING' | 'SUBMITTED' | 'APPROVED' | 'DECLINED' = record.status;
        if (sumsubStatus === 'approved') mappedStatus = 'APPROVED';
        else if (sumsubStatus === 'declined') mappedStatus = 'DECLINED';
        else if (sumsubStatus === 'submitted') mappedStatus = 'SUBMITTED';
        else if (sumsubStatus === 'pending') mappedStatus = 'PENDING';

        if (mappedStatus !== record.status) {
          await this.prisma.kyc.update({
            where: { id: record.id },
            data: { status: mappedStatus },
          });

          if (mappedStatus === 'APPROVED') {
            await this.markUserKycApproved(record.userId, sumsubData?.country);
          }

          this.logger.log(`Updated KYC ${applicantId}: ${record.status} → ${mappedStatus}`);
          updated++;
        }
      } catch (error) {
        this.logger.error(`Error syncing KYC ${record.veriffSessionId}:`, error);
        errors++;
      }
    }

    this.logger.log(`Sync completed: ${updated} updated, ${errors} errors`);

    return {
      success: true,
      total: pendingRecords.length,
      updated,
      errors,
      unchanged: pendingRecords.length - updated - errors,
    };
  }
}
