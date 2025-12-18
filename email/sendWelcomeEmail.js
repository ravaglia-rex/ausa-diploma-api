// email/sendWelcomeEmail.js
const { getResendClient } = require('./resendClient');

function escapeHtml(s = '') {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function buildHtml({ firstName, email, portalUrl, supportEmail }) {
  const hi = firstName ? `Hi ${escapeHtml(firstName)},` : 'Hello,';
  return `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.45">
    <p>${hi}</p>
    <p>Welcome to the <strong>Access USA Diploma Portal</strong>.</p>
    <p>You can access your binder, announcements, and next steps here:</p>
    <p>
      <a href="${escapeHtml(portalUrl)}"
         style="display:inline-block;padding:10px 14px;border-radius:10px;text-decoration:none;border:1px solid #ddd">
        Open Diploma Portal
      </a>
    </p>
    <p><strong>Sign in with:</strong> ${escapeHtml(email)}</p>
    <p>If you run into any issues, contact <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a>.</p>
    <p style="color:#666;font-size:12px;margin-top:18px">If you did not expect this email, you can ignore it.</p>
  </div>`;
}

function buildText({ firstName, email, portalUrl, supportEmail }) {
  const hi = firstName ? `Hi ${firstName},` : 'Hello,';
  return [
    hi,
    '',
    'Welcome to the Access USA Diploma Portal.',
    '',
    `Open: ${portalUrl}`,
    `Sign in with: ${email}`,
    '',
    `Help: ${supportEmail}`,
  ].join('\n');
}

async function sendWelcomeToDiplomaPortal({ toEmail, firstName }) {
  const resend = getResendClient();
  if (!resend) throw new Error('RESEND_API_KEY is not configured on the API service.');

  const from = process.env.RESEND_FROM;
  if (!from) throw new Error('RESEND_FROM is not configured on the API service.');

  const cleanToEmail = String(toEmail || '').trim().toLowerCase();
  if (!cleanToEmail || !cleanToEmail.includes('@')) {
    throw new Error('Invalid recipient email');
  }

  const cleanFirstName = String(firstName || '').trim();

  const portalUrl = process.env.DIPLOMA_PORTAL_URL || 'https://ausa.io/diploma';
  const supportEmail = process.env.DIPLOMA_SUPPORT_EMAIL || 'support@ausa.io';

  const subject = 'Welcome to the Diploma Portal';
  const html = buildHtml({ firstName: cleanFirstName, email: cleanToEmail, portalUrl, supportEmail });
  const text = buildText({
    firstName: cleanFirstName, // (text doesn't HTML-escape, but we already trimmed)
    email: cleanToEmail,
    portalUrl,
    supportEmail,
  });

  const { data, error } = await resend.emails.send({
    from,
    to: cleanToEmail,
    subject,
    html,
    text,
  });

  if (error) {
    const msg = error?.message || (typeof error === 'string' ? error : JSON.stringify(error));
    throw new Error(`Resend send failed: ${msg}`);
  }

  return data;
}


module.exports = { sendWelcomeToDiplomaPortal };
