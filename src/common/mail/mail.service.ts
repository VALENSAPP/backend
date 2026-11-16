import { Injectable } from '@nestjs/common';
import * as sgMail from '@sendgrid/mail';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class MailService {
    /** Reads an HTML template from /public, replaces {{placeholders}}, and sends it via SendGrid. */
    async sendTemplateEmail(params: {
        to: string;
        subject: string;
        templateFile: string;
        replacements: Record<string, string>;
        text?: string;
    }) {
        const { to, subject, templateFile, replacements, text } = params;

        const apiKey = process.env.SENDGRID_API_KEY;
        const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'noreply@valens.com';

        if (!apiKey) {
            console.warn(`[MailService] SENDGRID_API_KEY is not set. Skipping email to ${to}`);
            return;
        }

        sgMail.setApiKey(apiKey);

        // Check possible paths for the template
        const candidatePaths = [
            path.join(process.cwd(), 'public', templateFile),
            path.join(process.cwd(), 'coin_backend', 'public', templateFile),
            path.join(__dirname, '..', '..', '..', 'public', templateFile),
        ];

        let templatePath = candidatePaths.find(p => fs.existsSync(p));
        if (!templatePath) {
            console.error(`[MailService] Template file not found: ${templateFile}. Checked paths:`, candidatePaths);
            throw new Error(`Template file not found: ${templateFile}`);
        }

        let htmlTemplate = fs.readFileSync(templatePath, 'utf8');

        const appRedirectUrl =
            process.env.APP_REDIRECT_URL ||
            (process.env.BASE_URL ? `${process.env.BASE_URL.replace(/\/$/, '')}/open-app` : '') ||
            (process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL.replace(/\/$/, '')}/open-app` : '') ||
            'https://prod-api.valens.app/open-app';

        const defaultLogoUrl =
            process.env.APP_LOGO_URL ||
            'https://valens-s3-2026.s3.us-west-1.amazonaws.com/assets/valens-logo.png';

        const defaultReplacements: Record<string, string> = {
            appUrl: appRedirectUrl,
            app_url: appRedirectUrl,
            logoUrl: defaultLogoUrl,
            logo_url: defaultLogoUrl,
            profileUrl: appRedirectUrl,
            profile_url: appRedirectUrl,
            companyName: 'Valens Technologies INC.',
            company_name: 'Valens Technologies INC.',
        };

        const mergedReplacements = { ...defaultReplacements, ...replacements };

        for (const [key, value] of Object.entries(mergedReplacements)) {
            htmlTemplate = htmlTemplate.replace(new RegExp(`{{${key}}}`, 'g'), value);
        }

        await sgMail.send({
            to,
            from: fromEmail,
            subject,
            html: htmlTemplate,
            text: text || subject,
        });
        console.log(`[MailService] Successfully sent email "${subject}" to ${to}`);
    }

    /** Sends a permanent account suspension notification email. */
    async sendAccountPermanentlyBannedEmail(params: {
        to: string;
        userName?: string;
        reason?: string;
    }) {
        const { to, userName = 'User', reason = 'Violation of community guidelines' } = params;
        const apiKey = process.env.SENDGRID_API_KEY;
        const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'noreply@valens.com';

        if (!apiKey) {
            console.warn(`[MailService] SENDGRID_API_KEY is not set. Skipping permanent ban email to ${to}`);
            return;
        }

        sgMail.setApiKey(apiKey);

        const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Account Permanently Suspended</title>
</head>
<body style="font-family: Arial, sans-serif; background-color: #f7fafc; padding: 30px; margin: 0;">
  <div style="max-width: 580px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; padding: 32px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); border-top: 4px solid #e53e3e;">
    <h2 style="color: #e53e3e; margin-top: 0;">Account Permanently Suspended</h2>
    <p style="color: #4a5568; font-size: 15px; line-height: 1.6;">Hello <strong>${userName}</strong>,</p>
    <p style="color: #4a5568; font-size: 15px; line-height: 1.6;">
      Your Valens account has been permanently suspended due to severe or repeated violations of our Community Guidelines and Terms of Service.
    </p>
    <div style="background-color: #fff5f5; border-left: 3px solid #e53e3e; padding: 12px 16px; margin: 20px 0;">
      <p style="margin: 0; color: #742a2a; font-size: 14px;"><strong>Reason:</strong> ${reason}</p>
    </div>
    <p style="color: #4a5568; font-size: 14px; line-height: 1.6;">
      As a result of this action, you will no longer be able to log in, access your profile, or use Valens services.
    </p>
    <hr style="border: none; border-top: 1px solid #edf2f7; margin: 24px 0;" />
    <p style="color: #a0aec0; font-size: 12px; margin: 0;">Valens Trust & Safety Team</p>
  </div>
</body>
</html>`;

        try {
            await sgMail.send({
                to,
                from: fromEmail,
                subject: 'Your account has been permanently suspended - Valens',
                html,
                text: `Hello ${userName},\n\nYour Valens account has been permanently suspended due to severe or repeated violations of our Community Guidelines.\nReason: ${reason}\n\nValens Trust & Safety Team`,
            });
            console.log(`[MailService] Permanent suspension email sent to ${to}`);
        } catch (err: any) {
            console.error(`[MailService] Failed to send permanent suspension email to ${to}:`, err.message);
        }
    }
}
