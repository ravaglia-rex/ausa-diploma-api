// email/sendAdminInviteEmail.js
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

module.exports = async function sendAdminInviteEmail({ toEmail, setPasswordUrl }) {
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM) {
    throw new Error('Resend not configured (missing RESEND_API_KEY or RESEND_FROM)');
  }

  const adminUrl = process.env.ADMIN_PORTAL_URL || 'https://ausa.io/admin';
  const diplomaAdminUrl = process.env.DIPLOMA_ADMIN_URL || 'https://ausa.io/diploma/admin';

  const subject = 'You have been granted Access USA admin access';

  const hasTicket = typeof setPasswordUrl === 'string' && setPasswordUrl.trim().length > 0;

  const text =
    `You have been granted Access USA administrator access.\n\n` +
    (hasTicket
      ? `Step 1: Set your password (required)\n${setPasswordUrl}\n\n`
      : `Step 1: Sign in (if you don't already have an account, you may need to create one)\n${adminUrl}\n\n`) +
    `Admin Portal:\n${adminUrl}\n\n` +
    `Diploma Admin (shortcut):\n${diplomaAdminUrl}\n\n` +
    `Sign in using this email address:\n${toEmail}\n`;

  const html =
    `<p>You have been granted <strong>Access USA administrator access</strong>.</p>` +
    (hasTicket
      ? `<p><strong>Step 1 (required):</strong> Set your password:<br/>` +
        `<a href="${setPasswordUrl}">${setPasswordUrl}</a></p>`
      : `<p><strong>Step 1:</strong> Sign in here:<br/>` +
        `<a href="${adminUrl}">${adminUrl}</a></p>`) +
    `<p><strong>Admin Portal:</strong> <a href="${adminUrl}">${adminUrl}</a></p>` +
    `<p><strong>Diploma Admin (shortcut):</strong> <a href="${diplomaAdminUrl}">${diplomaAdminUrl}</a></p>` +
    `<p>Sign in using this email address: <strong>${toEmail}</strong></p>` +
    (hasTicket
      ? `<p style="color:#555;font-size:12px;">For security, passwords are never emailed. The link above lets you set your password securely.</p>`
      : ``);

  const result = await resend.emails.send({
    from: process.env.RESEND_FROM,
    to: toEmail,
    subject,
    text,
    html,
  });

  return result?.data || result;
};
