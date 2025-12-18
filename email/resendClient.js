// email/resendClient.js
const { Resend } = require('resend');

function getResendClient() {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  return new Resend(key);
}

module.exports = { getResendClient };
