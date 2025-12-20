// lib/supabase.js
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE || !ANON_KEY) {
  throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY env vars');
}

// Server-side privileged client (bypasses RLS)
const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

// Public client used ONLY to validate access tokens (auth.getUser)
const supabaseAuth = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { persistSession: false },
});

module.exports = { supabaseAdmin, supabaseAuth };
