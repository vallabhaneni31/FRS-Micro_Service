import nodemailer from 'nodemailer';
import logger from '../utils/logger.js';
import { env } from '../config/env.js';

function normalizePassword(password) {
  return (password || '').replace(/\s+/g, '');
}

function createTransporter(config = {}) {
  const service = config.service || process.env.SMTP_SERVICE || 'gmail';
  const host = config.host || process.env.SMTP_HOST;
  const port = Number(config.port || process.env.SMTP_PORT || 587);
  const user = config.user || process.env.SMTP_USER;
  const pass = normalizePassword(config.pass || process.env.SMTP_PASSWORD);

  // Bulk enrollment sends await one email at a time in a loop (EnrollmentService.js's
  // sendInvitations). Without pooling, nodemailer opens a fresh SMTP connection
  // (full TCP+TLS+auth handshake) per send — against Gmail that's ~1-3s each,
  // so a batch of 20-30 employees can exceed nginx's 60s proxy_read_timeout on
  // /api/, surfacing as "Failed to send invitations" even though the backend
  // keeps sending in the background. Pooling reuses connections across sends.
  if (host) {
    return nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: user && pass ? { user, pass } : undefined,
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
    });
  }

  return nodemailer.createTransport({
    service,
    auth: { user, pass },
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
  });
}

function getFromAddress(config = {}) {
  const fromName = config.fromName || process.env.SMTP_FROM_NAME || 'HR Team';
  const fromUser = config.user || process.env.SMTP_USER;
  return `"${fromName}" <${fromUser}>`;
}

// Create transporter (configured once, reused for env-based emails)
const transporter = createTransporter();

// Verify connection on startup
transporter.verify((error, success) => {
  if (error) {
    logger.error({ err: error }, '[emailService] Email service connection failed');
  } else {
    logger.info('[emailService] Email service ready');
  }
});

/**
 * Send enrollment invitation email to employee
 */


export async function sendEnrollmentInvitation({ employeeName, employeeEmail, enrollmentLink, expiresAt, visitDetails }) {
  const expiryDate = new Date(expiresAt).toLocaleDateString('en-US', { 
    month: 'long', 
    day: 'numeric', 
    year: 'numeric' 
  });

  let detailsHtml = '';
  let detailsText = '';

  if (visitDetails) {
    detailsHtml = `
      <div style="background-color: #f8fafc; border-left: 4px solid #3b82f6; padding: 20px; margin: 25px 0;">
        <p style="color: #1e293b; font-size: 14px; font-weight: 600; margin: 0 0 12px 0;">📅 Visit Invitation Details:</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="color: #475569; font-size: 14px; line-height: 1.8;">
          ${visitDetails.hostName ? `
          <tr>
            <td style="font-weight: 600; width: 140px; vertical-align: top;">Invited By (Host):</td>
            <td>${visitDetails.hostName}</td>
          </tr>` : ''}
          ${visitDetails.visitDate ? `
          <tr>
            <td style="font-weight: 600; vertical-align: top;">Date of Visit:</td>
            <td>${visitDetails.visitDate}</td>
          </tr>` : ''}
          ${visitDetails.visitTimeRange ? `
          <tr>
            <td style="font-weight: 600; vertical-align: top;">Timings:</td>
            <td>${visitDetails.visitTimeRange}</td>
          </tr>` : ''}
          ${visitDetails.visitPurpose ? `
          <tr>
            <td style="font-weight: 600; vertical-align: top;">Purpose:</td>
            <td>${visitDetails.visitPurpose}</td>
          </tr>` : ''}
        </table>
      </div>
    `;
    detailsText = `
Visit Invitation Details:
${visitDetails.hostName ? `- Invited By (Host): ${visitDetails.hostName}\n` : ''}${visitDetails.visitDate ? `- Date of Visit: ${visitDetails.visitDate}\n` : ''}${visitDetails.visitTimeRange ? `- Timings: ${visitDetails.visitTimeRange}\n` : ''}${visitDetails.visitPurpose ? `- Purpose: ${visitDetails.visitPurpose}\n` : ''}
`;
  }

  const mailOptions = {
    from: `"${process.env.SMTP_FROM_NAME || 'HR Team'}" <${process.env.SMTP_USER}>`,
    to: employeeEmail,
    subject: 'Complete Your Face Enrollment - Action Required',
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f1f5f9;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; margin: 0 auto; background-color: #ffffff;">
    <!-- Header -->
    <tr>
      <td style="background-color: #0f172a; padding: 30px 20px; text-align: center;">
        <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: 600;">Face Enrollment</h1>
        <p style="color: #cbd5e1; margin: 8px 0 0 0; font-size: 14px;">Attendance Management System</p>
      </td>
    </tr>
    
    <!-- Body -->
    <tr>
      <td style="padding: 40px 30px;">
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin: 0 0 20px 0;">
          Hi <strong>${employeeName}</strong>,
        </p>
        
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin: 0 0 20px 0;">
          You've been invited to complete your face enrollment for our attendance system.
        </p>
        
        ${detailsHtml}
        
        <div style="background-color: #f8fafc; border-left: 4px solid #3b82f6; padding: 20px; margin: 25px 0;">
          <p style="color: #1e293b; font-size: 14px; font-weight: 600; margin: 0 0 12px 0;">📸 What you'll need:</p>
          <ul style="color: #475569; font-size: 14px; line-height: 1.8; margin: 0; padding-left: 20px;">
            <li>A device with camera (phone or laptop)</li>
            <li>2-3 minutes in a well-lit area</li>
            <li>Remove glasses/mask temporarily</li>
          </ul>
        </div>
        
        <div style="background-color: #f8fafc; border-left: 4px solid #10b981; padding: 20px; margin: 25px 0;">
          <p style="color: #1e293b; font-size: 14px; font-weight: 600; margin: 0 0 12px 0;">🎯 The process:</p>
          <p style="color: #475569; font-size: 14px; line-height: 1.6; margin: 0;">
            We'll guide you through capturing 8 photos from different angles:<br>
            <strong>Front, Left, Right, Up, Up High, Left-Up, Right-Up, Down</strong>
          </p>
          <p style="color: #64748b; font-size: 13px; line-height: 1.6; margin: 10px 0 0 0;">
            This takes about 3 minutes and ensures accurate recognition.
          </p>
        </div>
        
        <!-- CTA Button -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin: 35px 0;">
          <tr>
            <td align="center">
              <a href="${enrollmentLink}" 
                 style="display: inline-block; background-color: #3b82f6; color: #ffffff; text-decoration: none; padding: 16px 40px; border-radius: 8px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
                Start Enrollment →
              </a>
            </td>
          </tr>
        </table>
        
        <!-- Expiry Notice -->
        <div style="background-color: #fef3c7; border: 1px solid #fcd34d; border-radius: 6px; padding: 15px; margin: 25px 0;">
          <p style="color: #92400e; font-size: 13px; margin: 0; text-align: center;">
            ⏰ This link expires on <strong>${expiryDate}</strong>
          </p>
        </div>
        
        <!-- Help -->
        <p style="color: #64748b; font-size: 13px; line-height: 1.6; margin: 25px 0 0 0;">
          <strong>Need help?</strong> Contact HR at 
          <a href="mailto:${process.env.SMTP_USER}" style="color: #3b82f6; text-decoration: none;">${process.env.SMTP_USER}</a>
        </p>
      </td>
    </tr>
    
    <!-- Footer -->
    <tr>
      <td style="background-color: #f8fafc; padding: 25px 30px; border-top: 1px solid #e2e8f0;">
        <p style="color: #64748b; font-size: 12px; line-height: 1.6; margin: 0; text-align: center;">
          This is an automated message. Please do not reply to this email.
        </p>
        <p style="color: #94a3b8; font-size: 11px; margin: 10px 0 0 0; text-align: center;">
          © 2026 Motivity Labs. All rights reserved.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
    `,
    // Plain text fallback
    text: `
Hi ${employeeName},

You've been invited to complete your face enrollment for our attendance system.

${detailsText}

What you'll need:
- A device with camera (phone or laptop)
- 2-3 minutes in a well-lit area
- Remove glasses/mask temporarily

The process:
We'll guide you through capturing 8 photos from different angles: Front, Left, Right, Up, Up High, Left-Up, Right-Up, Down.
This takes about 3 minutes and ensures accurate recognition.

Start Enrollment:
${enrollmentLink}

This link expires on ${expiryDate}.

Need help? Contact HR at ${process.env.SMTP_USER}

---
This is an automated message. Please do not reply to this email.
© 2026 Motivity Labs. All rights reserved.
    `
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    logger.info({ messageId: info.messageId }, `[emailService] Enrollment email sent to ${employeeEmail}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    logger.error({ err: error }, `[emailService] Failed to send enrollment email to ${employeeEmail}`);
    // Development / Default placeholder bypass
    if (process.env.NODE_ENV === 'development' || !process.env.SMTP_USER || process.env.SMTP_USER.includes('your_email')) {
      logger.warn('[emailService] DEV MODE: SMTP dispatch failed but bypassing error to allow offline testing');
      return { success: true, mocked: true, messageId: 'dev-mock-id' };
    }
    throw error;
  }
}

/**
 * Send a reminder email to an employee whose enrollment invitation is still
 * pending/incomplete. Reuses the same invitation link as the original
 * invitation email (see sendEnrollmentInvitation) — this is a nudge, not a
 * new invitation.
 */
export async function sendEnrollmentReminder({ employeeName, employeeEmail, enrollmentLink, expiresAt }) {
  const expiryDate = new Date(expiresAt).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  });

  const mailOptions = {
    from: `"${process.env.SMTP_FROM_NAME || 'HR Team'}" <${process.env.SMTP_USER}>`,
    to: employeeEmail,
    subject: 'Reminder: Complete Your Face Enrollment',
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f1f5f9;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; margin: 0 auto; background-color: #ffffff;">
    <tr>
      <td style="background-color: #0f172a; padding: 30px 20px; text-align: center;">
        <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: 600;">⏰ Enrollment Reminder</h1>
        <p style="color: #cbd5e1; margin: 8px 0 0 0; font-size: 14px;">Attendance Management System</p>
      </td>
    </tr>
    <tr>
      <td style="padding: 40px 30px;">
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin: 0 0 20px 0;">
          Hi <strong>${employeeName}</strong>,
        </p>
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin: 0 0 20px 0;">
          This is a friendly reminder that your face enrollment is still incomplete. It only takes about 3 minutes — please finish it at your earliest convenience.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin: 35px 0;">
          <tr>
            <td align="center">
              <a href="${enrollmentLink}"
                 style="display: inline-block; background-color: #3b82f6; color: #ffffff; text-decoration: none; padding: 16px 40px; border-radius: 8px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
                Complete Enrollment →
              </a>
            </td>
          </tr>
        </table>
        <div style="background-color: #fef3c7; border: 1px solid #fcd34d; border-radius: 6px; padding: 15px; margin: 25px 0;">
          <p style="color: #92400e; font-size: 13px; margin: 0; text-align: center;">
            ⏰ This link expires on <strong>${expiryDate}</strong>
          </p>
        </div>
        <p style="color: #64748b; font-size: 13px; line-height: 1.6; margin: 25px 0 0 0;">
          <strong>Need help?</strong> Contact HR at
          <a href="mailto:${process.env.SMTP_USER}" style="color: #3b82f6; text-decoration: none;">${process.env.SMTP_USER}</a>
        </p>
      </td>
    </tr>
    <tr>
      <td style="background-color: #f8fafc; padding: 25px 30px; border-top: 1px solid #e2e8f0;">
        <p style="color: #64748b; font-size: 12px; line-height: 1.6; margin: 0; text-align: center;">
          This is an automated message. Please do not reply to this email.
        </p>
        <p style="color: #94a3b8; font-size: 11px; margin: 10px 0 0 0; text-align: center;">
          © 2026 Motivity Labs. All rights reserved.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
    `,
    text: `
Hi ${employeeName},

This is a friendly reminder that your face enrollment is still incomplete. It only takes about 3 minutes — please finish it at your earliest convenience.

Complete Enrollment:
${enrollmentLink}

This link expires on ${expiryDate}.

Need help? Contact HR at ${process.env.SMTP_USER}

---
This is an automated message. Please do not reply to this email.
© 2026 Motivity Labs. All rights reserved.
    `
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    logger.info({ messageId: info.messageId }, `[emailService] Enrollment reminder sent to ${employeeEmail}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    logger.error({ err: error }, `[emailService] Failed to send enrollment reminder to ${employeeEmail}`);
    if (process.env.NODE_ENV === 'development' || !process.env.SMTP_USER || process.env.SMTP_USER.includes('your_email')) {
      logger.warn('[emailService] DEV MODE: SMTP dispatch failed but bypassing error to allow offline testing');
      return { success: true, mocked: true, messageId: 'dev-mock-id' };
    }
    throw error;
  }
}

/**
 * Send enrollment completion notification to HR
 */
export async function sendEnrollmentCompleteNotification({ employeeName, employeeCode, averageQuality, hrEmail }) {
  const mailOptions = {
    from: `"${process.env.SMTP_FROM_NAME || 'HR Team'}" <${process.env.SMTP_USER}>`,
    to: hrEmail,
    subject: `Face Enrollment Completed - ${employeeName} (${employeeCode})`,
    html: `
<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #10b981;">✓ Enrollment Completed</h2>
  <p><strong>${employeeName}</strong> (${employeeCode}) has completed their face enrollment.</p>
  <p><strong>Average Quality:</strong> ${averageQuality}%</p>
  <p>Review and approve in the HR Dashboard → Remote Enrollment section.</p>
</body>
</html>
    `,
    text: `
Enrollment Completed

${employeeName} (${employeeCode}) has completed their face enrollment.
Average Quality: ${averageQuality}%

Review and approve in the HR Dashboard → Remote Enrollment section.
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    logger.info(`[emailService] Completion notification sent to ${hrEmail}`);
  } catch (error) {
    logger.error({ err: error }, `[emailService] Failed to send completion notification to ${hrEmail}`);
  }
}

/**
 * Send enrollment rejection notification with re-enrollment link
 */
export async function sendEnrollmentRejection({ employeeName, employeeEmail, reason, enrollmentLink }) {
  const mailOptions = {
    from: `"${process.env.SMTP_FROM_NAME || 'HR Team'}" <${process.env.SMTP_USER}>`,
    to: employeeEmail,
    subject: 'Action Required: Please Re-Submit Your Face Enrollment',
    html: `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background-color: #667eea; color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
    .content { background: #f9fafb; padding: 30px; border-radius: 0 0 10px 10px; }
    .alert-box { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; border-radius: 5px; }
    .tips { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e5e7eb; }
    .button { display: inline-block; background: #667eea; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; margin: 20px 0; }
    .footer { text-align: center; margin-top: 30px; color: #6b7280; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin: 0; font-size: 28px;">📸 Please Re-Submit Your Enrollment</h1>
    </div>
    <div class="content">
      <p style="font-size: 16px;">Hi <strong>${employeeName}</strong>,</p>
      <div class="alert-box">
        <p style="margin: 0; font-weight: 600; color: #92400e;">⚠️ Your previous enrollment submission was not approved</p>
        <p style="margin: 10px 0 0 0; color: #78350f;"><strong>Reason:</strong> ${reason}</p>
      </div>
      <p>Don't worry! You can re-submit your face enrollment photos at any time. We've prepared some tips to help you get better quality photos this time.</p>
      <div class="tips">
        <h3 style="margin-top: 0; color: #667eea;">📋 Tips for Better Photos:</h3>
        <ul style="margin: 10px 0; padding-left: 20px;">
          <li><strong>Good lighting:</strong> Face a window or light source, avoid backlighting</li>
          <li><strong>Remove accessories:</strong> Take off glasses, masks, hats temporarily</li>
          <li><strong>Neutral background:</strong> Stand against a plain wall if possible</li>
          <li><strong>Look directly at camera:</strong> Keep your face centered in the guide</li>
          <li><strong>Stay still:</strong> Hold steady for 1-2 seconds when capturing</li>
        </ul>
      </div>
      <p style="text-align: center;">
        <a href="${enrollmentLink}" class="button">🔄 Re-Submit Enrollment</a>
      </p>
      <p style="font-size: 14px; color: #6b7280; margin-top: 30px;">
        This link will remain active for 7 days. If you need assistance, please contact HR.
      </p>
    </div>
    <div class="footer">
      <p>This is an automated message from the HR Attendance System</p>
    </div>
  </div>
</body>
</html>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    logger.info(`[emailService] Rejection email sent to ${employeeEmail}`);
  } catch (error) {
    logger.error({ err: error }, '[emailService] Failed to send rejection email');
    throw error;
  }
}

/**
 * Send welcome + credentials email to a newly created tenant admin
 */
export async function sendTenantAdminWelcome({ adminName, adminEmail, tenantName, realmSlug, password, loginUrl }) {
  const mailOptions = {
    from: `"${process.env.SMTP_FROM_NAME || 'FRS Platform'}" <${process.env.SMTP_USER}>`,
    to: adminEmail,
    subject: `Welcome to FRS — Your admin account for ${tenantName} is ready`,
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background-color:#f1f5f9;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;">
    <!-- Header -->
    <tr>
      <td style="background-color: #4f46e5; padding:32px 24px;text-align:center;">
        <h1 style="color:#ffffff;margin:0;font-size:26px;font-weight:700;letter-spacing:-0.5px;">FRS Platform</h1>
        <p style="color:#c7d2fe;margin:8px 0 0;font-size:14px;">Face Recognition &amp; Attendance System</p>
      </td>
    </tr>

    <!-- Body -->
    <tr>
      <td style="padding:40px 32px;">
        <p style="color:#334155;font-size:16px;line-height:1.6;margin:0 0 8px;">Hi <strong>${adminName}</strong>,</p>
        <p style="color:#334155;font-size:16px;line-height:1.6;margin:0 0 28px;">
          Your tenant workspace on FRS has been provisioned. You've been assigned as the
          <strong>Tenant Administrator</strong> for <strong>${tenantName}</strong>.
        </p>

        <!-- Tenant info box -->
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:20px 24px;margin-bottom:28px;">
          <p style="color:#64748b;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;margin:0 0 14px;">Your Workspace</p>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="color:#64748b;font-size:13px;padding:5px 0;width:130px;">Tenant</td>
              <td style="color:#1e293b;font-size:13px;font-weight:600;padding:5px 0;">${tenantName}</td>
            </tr>
            <tr>
              <td style="color:#64748b;font-size:13px;padding:5px 0;">Realm</td>
              <td style="padding:5px 0;"><code style="background:#ede9fe;color:#5b21b6;font-size:12px;padding:2px 8px;border-radius:4px;font-family:monospace;">${realmSlug}</code></td>
            </tr>
            <tr>
              <td style="color:#64748b;font-size:13px;padding:5px 0;">Your Role</td>
              <td style="padding:5px 0;"><span style="background:#dcfce7;color:#166534;font-size:12px;font-weight:600;padding:2px 8px;border-radius:4px;">Tenant Admin</span></td>
            </tr>
          </table>
        </div>

        <!-- Credentials box -->
        <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:10px;padding:20px 24px;margin-bottom:28px;">
          <p style="color:#92400e;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;margin:0 0 14px;">🔐 Login Credentials</p>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="color:#78350f;font-size:13px;padding:5px 0;width:130px;">Email</td>
              <td style="color:#1e293b;font-size:13px;font-weight:600;padding:5px 0;">${adminEmail}</td>
            </tr>
            <tr>
              <td style="color:#78350f;font-size:13px;padding:5px 0;">Password</td>
              <td style="padding:5px 0;"><code style="background:#fef3c7;color:#92400e;font-size:13px;font-weight:700;padding:3px 10px;border-radius:4px;font-family:monospace;letter-spacing:0.05em;">${password}</code></td>
            </tr>
          </table>
          <p style="color:#b45309;font-size:12px;margin:14px 0 0;">⚠️ Please change your password immediately after your first login.</p>
        </div>

        <!-- CTA -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:32px 0 0;">
          <tr>
            <td align="center">
              <a href="${loginUrl}"
                 style="display:inline-block;background-color:#4f46e5;color:#ffffff;text-decoration:none;padding:14px 40px;border-radius:8px;font-weight:600;font-size:15px;box-shadow:0 4px 6px -1px rgba(79,70,229,0.3);">
                Sign in to FRS →
              </a>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- Footer -->
    <tr>
      <td style="background:#f8fafc;padding:24px 32px;border-top:1px solid #e2e8f0;">
        <p style="color:#94a3b8;font-size:12px;margin:0;text-align:center;line-height:1.6;">
          This is an automated message. Do not reply to this email.<br>
          © 2026 Motivity Labs. All rights reserved.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
    `,
    text: `
Hi ${adminName},

Your tenant workspace on FRS has been provisioned. You've been assigned as Tenant Administrator for ${tenantName}.

WORKSPACE
Tenant : ${tenantName}
Realm  : ${realmSlug}
Role   : Tenant Admin

LOGIN CREDENTIALS
Email    : ${adminEmail}
Password : ${password}

Please change your password immediately after your first login.

Sign in at: ${loginUrl}

---
This is an automated message. Do not reply.
© 2026 Motivity Labs. All rights reserved.
    `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    logger.info({ messageId: info.messageId }, `[emailService] Tenant admin welcome email sent to ${adminEmail}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    logger.error({ err: error }, `[emailService] Failed to send welcome email to ${adminEmail}`);
    throw error;
  }
}

export async function verifyEmailService(config = {}) {
  const testTransporter = Object.keys(config).length ? createTransporter(config) : transporter;
  await testTransporter.verify();
  return { success: true };
}

export async function sendTestEmail({ recipients, config = {} }) {
  const to = Array.isArray(recipients)
    ? recipients
    : String(recipients || '')
      .split(',')
      .map((email) => email.trim())
      .filter(Boolean);

  if (!to.length) {
    throw new Error('At least one recipient is required');
  }

  const testTransporter = Object.keys(config).length ? createTransporter(config) : transporter;
  const info = await testTransporter.sendMail({
    from: getFromAddress(config),
    to,
    subject: 'FRS Notification Test',
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a">
        <h2 style="margin:0 0 12px">Notification email is working</h2>
        <p>This is a test message from the FRS notification settings page.</p>
        <p style="color:#64748b;font-size:12px">Sent at ${new Date().toISOString()}</p>
      </div>
    `,
    text: `Notification email is working.\n\nThis is a test message from FRS.\nSent at ${new Date().toISOString()}`,
  });

  return { success: true, messageId: info.messageId };
}

/**
 * Send welcome email to a newly created user (HR / admin / viewer).
 */
export async function sendUserWelcome({ name, email, role, password, loginUrl }) {
  const roleLabel = role === 'admin' ? 'Administrator'
    : role === 'hr' ? 'HR Personnel'
    : role === 'hr_manager' ? 'HR Manager'
    : role === 'viewer' ? 'Viewer'
    : role;

  const info = await transporter.sendMail({
    from: `"${process.env.SMTP_FROM_NAME || 'FRS Platform'}" <${process.env.SMTP_USER}>`,
    to: email,
    subject: `Welcome to FRS — Your ${roleLabel} account is ready`,
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;background:#f1f5f9;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;">
  <tr>
    <td style="background-color:#0f172a;padding:32px 24px;text-align:center;">
      <h1 style="color:#ffffff;margin:0;font-size:26px;font-weight:700;">FRS Platform</h1>
      <p style="color:#93c5fd;margin:8px 0 0;font-size:14px;">Face Recognition &amp; Attendance System</p>
    </td>
  </tr>
  <tr>
    <td style="padding:40px 32px;">
      <p style="color:#334155;font-size:16px;line-height:1.6;margin:0 0 8px;">Hi <strong>${name}</strong>,</p>
      <p style="color:#334155;font-size:16px;line-height:1.6;margin:0 0 28px;">
        Your account has been created. You can now sign in to FRS as <strong>${roleLabel}</strong>.
      </p>
      <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:10px;padding:20px 24px;margin-bottom:28px;">
        <p style="color:#92400e;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;margin:0 0 14px;">🔐 Login Credentials</p>
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="color:#78350f;font-size:13px;padding:5px 0;width:130px;">Email</td>
            <td style="color:#1e293b;font-size:13px;font-weight:600;padding:5px 0;">${email}</td>
          </tr>
          <tr>
            <td style="color:#78350f;font-size:13px;padding:5px 0;">Temporary Password</td>
            <td style="padding:5px 0;">
              <code style="background:#fef3c7;color:#92400e;font-size:13px;font-weight:700;padding:3px 10px;border-radius:4px;font-family:monospace;">${password}</code>
            </td>
          </tr>
          <tr>
            <td style="color:#78350f;font-size:13px;padding:5px 0;">Role</td>
            <td style="padding:5px 0;">
              <span style="background:#dbeafe;color:#1e40af;font-size:12px;font-weight:600;padding:2px 8px;border-radius:4px;">${roleLabel}</span>
            </td>
          </tr>
        </table>
        <p style="color:#b45309;font-size:12px;margin:14px 0 0;">⚠️ Please change your password after your first login.</p>
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:32px 0 0;">
        <tr>
          <td align="center">
            <a href="${loginUrl}"
               style="display:inline-block;background-color:#1e40af;color:#ffffff;text-decoration:none;padding:14px 40px;border-radius:8px;font-weight:600;font-size:15px;">
              Sign In to FRS →
            </a>
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td style="background:#f8fafc;padding:20px 32px;text-align:center;border-top:1px solid #e2e8f0;">
      <p style="color:#94a3b8;font-size:12px;margin:0;">This is an automated message from FRS Platform. Do not reply.</p>
    </td>
  </tr>
</table>
</body>
</html>`,
    text: `Welcome to FRS, ${name}!\n\nYour ${roleLabel} account is ready.\n\nEmail: ${email}\nPassword: ${password}\n\nSign in at: ${loginUrl}\n\nPlease change your password after first login.`,
  });

  return { success: true, messageId: info.messageId };
}

/**
 * Send a token-based invite to a newly created user so they can set their own password.
 * Called when creating Tenant Admin, Site Admin, or HR Manager accounts.
 *
 * @param {object} opts
 * @param {string} opts.toEmail       - recipient email
 * @param {string} opts.toName        - recipient display name
 * @param {string} opts.invitedByName - name of the admin who created this account
 * @param {string} opts.roleName      - human label: "Tenant Admin" / "Site Admin" / "HR Manager"
 * @param {string} [opts.tenantName]  - tenant the user belongs to
 * @param {string} [opts.siteName]    - site the user is scoped to (if applicable)
 * @param {string} opts.setupLink     - full URL to the /setup-password/:token page
 * @param {Date|string} opts.expiresAt - when the link expires
 */
export async function sendUserInvite({
  toEmail, toName, invitedByName, roleName,
  tenantName, siteName, setupLink, expiresAt,
}) {
  const expiryStr = new Date(expiresAt).toLocaleString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });

  // Role badge colour
  const roleColors = {
    'Tenant Admin': { bg: '#ede9fe', text: '#5b21b6' },
    'Site Admin':   { bg: '#dbeafe', text: '#1e40af' },
    'HR Manager':   { bg: '#dcfce7', text: '#166534' },
  };
  const roleColor = roleColors[roleName] ?? { bg: '#f1f5f9', text: '#475569' };

  const contextRows = [
    tenantName && `<tr>
      <td style="color:#64748b;font-size:13px;padding:5px 0;width:110px;">Organisation</td>
      <td style="color:#1e293b;font-size:13px;font-weight:600;padding:5px 0;">${tenantName}</td>
    </tr>`,
    siteName && `<tr>
      <td style="color:#64748b;font-size:13px;padding:5px 0;">Site</td>
      <td style="color:#1e293b;font-size:13px;font-weight:600;padding:5px 0;">${siteName}</td>
    </tr>`,
  ].filter(Boolean).join('\n');

  const isPasswordReset = roleName === 'Password Reset';

  const subject = isPasswordReset
    ? `FRS Account Password Reset Request`
    : `You've been invited to join FRS as ${roleName}`;

  const greetingHtml = isPasswordReset
    ? `A password reset request was initiated for your <strong>FRS</strong> account. Please set a new password below.`
    : `Welcome to <strong>FRS</strong>. Your account has been created and is waiting for you to set a password.`;

  const ctaText = isPasswordReset
    ? `Reset My Password →`
    : `Set Up My Password →`;

  const expiryNotice = isPasswordReset
    ? `If you didn't request a password reset, you can safely ignore this email.`
    : `If you didn't expect this invitation, you can safely ignore this email.`;

  const mailOptions = {
    from: `"${process.env.SMTP_FROM_NAME || 'FRS Platform'}" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject,
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background-color:#f1f5f9;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;">

  <!-- Header -->
  <tr>
    <td style="background-color:#0f172a;padding:32px 24px;text-align:center;">
      <h1 style="color:#ffffff;margin:0;font-size:26px;font-weight:700;letter-spacing:-0.5px;">FRS Platform</h1>
      <p style="color:#94a3b8;margin:8px 0 0;font-size:14px;">Face Recognition &amp; Attendance System</p>
    </td>
  </tr>

  <!-- Body -->
  <tr>
    <td style="padding:40px 32px;">

      <!-- Greeting -->
      <p style="color:#334155;font-size:16px;line-height:1.6;margin:0 0 6px;">
        👋 Hi <strong>${toName}</strong>,
      </p>
      <p style="color:#334155;font-size:16px;line-height:1.6;margin:0 0 28px;">
        ${greetingHtml}
      </p>

      <!-- Role + context card -->
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:20px 24px;margin-bottom:28px;">
        <p style="color:#64748b;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;margin:0 0 14px;">Your Account</p>
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="color:#64748b;font-size:13px;padding:5px 0;width:110px;">Email</td>
            <td style="color:#1e293b;font-size:13px;font-weight:600;padding:5px 0;">${toEmail}</td>
          </tr>
          <tr>
            <td style="color:#64748b;font-size:13px;padding:5px 0;">Request Type</td>
            <td style="padding:5px 0;">
              <span style="background:${roleColor.bg};color:${roleColor.text};font-size:12px;font-weight:700;padding:3px 10px;border-radius:20px;">
                ${roleName}
              </span>
            </td>
          </tr>
          ${contextRows}
        </table>
      </div>

      <!-- What to do -->
      <div style="background:#eff6ff;border-left:4px solid #3b82f6;border-radius:0 8px 8px 0;padding:16px 20px;margin-bottom:28px;">
        <p style="color:#1e40af;font-size:14px;font-weight:600;margin:0 0 6px;">What you need to do</p>
        <p style="color:#1e3a8a;font-size:13px;line-height:1.6;margin:0;">
          Click the button below to choose your password. Once set, you can sign in
          to FRS using your email and that password — no further steps required.
        </p>
      </div>

      <!-- CTA -->
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:32px 0;">
        <tr>
          <td align="center">
            <a href="${setupLink}"
               style="display:inline-block;background-color:#4f46e5;color:#ffffff;text-decoration:none;padding:15px 44px;border-radius:8px;font-weight:700;font-size:16px;letter-spacing:0.01em;box-shadow:0 4px 14px -2px rgba(79,70,229,0.4);">
              ${ctaText}
            </a>
          </td>
        </tr>
      </table>

      <!-- Expiry warning -->
      <div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:14px 18px;margin-bottom:28px;text-align:center;">
        <p style="color:#92400e;font-size:13px;font-weight:600;margin:0;">
          ⏰ This link expires on <strong>${expiryStr}</strong>
        </p>
        <p style="color:#b45309;font-size:12px;margin:6px 0 0;">
          ${expiryNotice}
        </p>
      </div>

      <!-- Fallback link -->
      <p style="color:#94a3b8;font-size:12px;line-height:1.6;margin:0;">
        Button not working? Copy and paste this link into your browser:<br>
        <a href="${setupLink}" style="color:#6366f1;word-break:break-all;">${setupLink}</a>
      </p>

    </td>
  </tr>

  <!-- Footer -->
  <tr>
    <td style="background:#f8fafc;padding:24px 32px;border-top:1px solid #e2e8f0;text-align:center;">
      <p style="color:#94a3b8;font-size:12px;margin:0;line-height:1.6;">
        This is an automated message from FRS Platform. Do not reply.<br>
        © 2026 Motivity Labs. All rights reserved.
      </p>
    </td>
  </tr>

</table>
</body>
</html>
    `,
    text: isPasswordReset
      ? `Hi ${toName},\n\nA password reset request was initiated for your FRS account.\n\nReset your password here:\n${setupLink}\n\nThis link expires on ${expiryStr}.\n\nIf you didn't request a password reset, you can safely ignore this email.\n\n---\nThis is an automated message from FRS Platform. Do not reply.\n© 2026 Motivity Labs. All rights reserved.`
      : `Hi ${toName},\n\nWelcome to FRS. You have been invited to join as ${roleName}.\n\nYour account details:\n  Email : ${toEmail}\n  Role  : ${roleName}${tenantName ? `\n  Org   : ${tenantName}` : ''}${siteName ? `\n  Site  : ${siteName}` : ''}\n\nSet up your password here:\n${setupLink}\n\nThis link expires on ${expiryStr}.\n\nIf you didn't expect this invitation, you can safely ignore this email.\n\n---\nThis is an automated message from FRS Platform. Do not reply.\n© 2026 Motivity Labs. All rights reserved.`,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    logger.info({ messageId: info.messageId, roleName }, `[emailService] Invite email sent to ${toEmail}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    logger.error({ err: error }, `[emailService] Failed to send invite email to ${toEmail}`);
    if (
      process.env.NODE_ENV === 'development' ||
      !process.env.SMTP_USER ||
      process.env.SMTP_USER.includes('your_email')
    ) {
      logger.warn('[emailService] DEV MODE: SMTP failed — bypassing for offline testing');
      return { success: true, mocked: true, messageId: 'dev-mock-invite' };
    }
    throw error;
  }
}

/**
 * Send account deletion & access revocation email notification to deleted user
 */
export async function sendAccountDeletionNotification({ toEmail, toName, roleName, tenantName, contactEmail = 'support@motivitylabs.com' }) {
  const mailOptions = {
    from: getFromAddress(),
    to: toEmail,
    subject: 'Notification: Your FRS Account Access Has Been Revoked',
    html: `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"></head>
      <body style="font-family: Arial, sans-serif; background-color: #f4f6f8; margin: 0; padding: 20px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
          <tr>
            <td style="background-color: #ef4444; padding: 24px; text-align: center;">
              <h1 style="color: #ffffff; margin: 0; font-size: 20px; font-weight: bold;">Account Deletion Notification</h1>
            </td>
          </tr>
          <tr>
            <td style="padding: 32px 24px;">
              <p style="color: #334155; font-size: 16px; margin: 0 0 16px;">Hello ${toName || 'User'},</p>
              <p style="color: #475569; font-size: 14px; line-height: 1.6; margin: 0 0 24px;">
                This email is to notify you that your <strong>FRS (Face Recognition System)</strong> user account associated with <strong>${toEmail}</strong> has been deleted by an administrator and your application access has been revoked.
              </p>
              <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 16px; margin-bottom: 24px;">
                <p style="color: #64748b; font-size: 12px; font-weight: bold; text-transform: uppercase; margin: 0 0 8px;">Revoked Account Details</p>
                <p style="color: #1e293b; font-size: 14px; margin: 4px 0;"><strong>Email:</strong> ${toEmail}</p>
                ${roleName ? `<p style="color: #1e293b; font-size: 14px; margin: 4px 0;"><strong>Role:</strong> ${roleName}</p>` : ''}
                ${tenantName ? `<p style="color: #1e293b; font-size: 14px; margin: 4px 0;"><strong>Organization:</strong> ${tenantName}</p>` : ''}
              </div>
              <p style="color: #475569; font-size: 14px; line-height: 1.6; margin: 0 0 16px;">
                If you believe this was done in error or need further assistance, please contact your system administrator or email us at <a href="mailto:${contactEmail}" style="color: #2563eb;">${contactEmail}</a>.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color: #f8fafc; padding: 16px; text-align: center; border-top: 1px solid #e2e8f0;">
              <p style="color: #94a3b8; font-size: 12px; margin: 0;">This is an automated system notification from FRS Platform.</p>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `,
    text: `Hello ${toName || 'User'},\n\nThis email is to notify you that your FRS (Face Recognition System) user account (${toEmail}) has been deleted by an administrator and your application access has been revoked.\n\nIf you believe this was done in error, please contact your administrator or email ${contactEmail}.\n\n--- FRS Platform`,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    logger.info({ messageId: info.messageId }, `[emailService] Account deletion email sent to ${toEmail}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    logger.error({ err: error }, `[emailService] Failed to send account deletion email to ${toEmail}`);
    if (process.env.NODE_ENV === 'development' || !process.env.SMTP_USER || process.env.SMTP_USER.includes('your_email')) {
      logger.warn('[emailService] DEV MODE: SMTP failed — bypassing for offline testing');
      return { success: true, mocked: true, messageId: 'dev-mock-deletion' };
    }
    throw error;
  }
}

export default {
  sendEnrollmentInvitation,
  sendEnrollmentReminder,
  sendEnrollmentCompleteNotification,
  sendEnrollmentRejection,
  sendTenantAdminWelcome,
  sendUserWelcome,
  sendUserInvite,
  sendAccountDeletionNotification,
  verifyEmailService,
  sendTestEmail,
};

