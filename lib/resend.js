// lib/resend.js
const { Resend } = require('resend');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL;

if (!RESEND_API_KEY) throw new Error('Missing RESEND_API_KEY env var');
if (!RESEND_FROM_EMAIL) throw new Error('Missing RESEND_FROM_EMAIL env var');

const resend = new Resend(RESEND_API_KEY);

module.exports = { resend, RESEND_FROM_EMAIL };
