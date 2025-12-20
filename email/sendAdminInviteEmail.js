// email/sendAdminInviteEmail.js
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

module.exports = async function sendAdminInviteEmail({ toEmail }) {
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM) {
    throw new Error('Resend not configured (missing RESEND_API_KEY or RESEND_FROM)');
  }

  const adminUrl = process.env.ADMIN_PORTAL_URL || 'https://ausa.io/admin';
  const diplomaAdminUrl = process.env.DIPLOMA_ADMIN_URL || 'https://ausa.io/diploma/admin';

  const subject = 'Access USA Admin Access';
  const text =
    `You have been granted Access USA administrator access.\n\n` +
    `Admin Portal:\n${adminUrl}\n\n` +
    `Diploma Admin (shortcut):\n${diplomaAdminUrl}\n\n` +
    `Sign in using this email address: ${toEmail}\n`;

  const html =
    `<p>You have been granted <strong>Access USA administrator access</strong>.</p>` +
    `<p><strong>Admin Portal:</strong> <a href="${adminUrl}">${adminUrl}</a></p>` +
    `<p><strong>Diploma Admin (shortcut):</strong> <a href="${diplomaAdminUrl}">${diplomaAdminUrl}</a></p>` +
    `<p>Sign in using this email address: <strong>${toEmail}</strong></p>`;

  const result = await resend.emails.send({
    from: process.env.RESEND_FROM,
    to: toEmail,
    subject,
    text,
    html,
  });

  return result?.data || result;
};
