// routes/websiteAdminStaff.js
const express = require('express');
const sendAdminInviteEmail = require('../email/sendAdminInviteEmail');
const { randomBytes } = require('crypto');

function normalizeEmail(v) {
  if (!v || typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return s ? s : null;
}

// ---- Auth0 Management API helpers (no external deps) ----
async function getAuth0MgmtToken() {
  const domain = process.env.AUTH0_DOMAIN;
  const clientId = process.env.AUTH0_MGMT_CLIENT_ID;
  const clientSecret = process.env.AUTH0_MGMT_CLIENT_SECRET;

  if (!domain || !clientId || !clientSecret) {
    throw new Error('Auth0 Management API not configured (AUTH0_DOMAIN, AUTH0_MGMT_CLIENT_ID, AUTH0_MGMT_CLIENT_SECRET required)');
  }

  const res = await fetch(`https://${domain}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      audience: `https://${domain}/api/v2/`,
    }),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(json?.error_description || json?.error || 'Failed to get Auth0 management token');
  }
  return json.access_token;
}

async function auth0MgmtFetch(path, { method = 'GET', token, body } = {}) {
  const domain = process.env.AUTH0_DOMAIN;
  const res = await fetch(`https://${domain}/api/v2${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    // Auth0 returns useful message fields
    const msg = json?.message || json?.error || `Auth0 request failed (${res.status})`;
    throw new Error(msg);
  }
  return json;
}

function randomTempPassword() {
  // Not emailed. Used only to create the user, then we send a password-reset ticket.
  return `Tmp-${randomBytes(18).toString('hex')}!aA1`;
}

async function getOrCreateAuth0UserByEmail(email) {
  const token = await getAuth0MgmtToken();

  // Find by email
  const users = await auth0MgmtFetch(`/users-by-email?email=${encodeURIComponent(email)}`, { token });
  if (Array.isArray(users) && users.length > 0) return users[0];

  // Create user in DB connection
  const connection = process.env.AUTH0_DB_CONNECTION || 'Username-Password-Authentication';

  const user = await auth0MgmtFetch('/users', {
    method: 'POST',
    token,
    body: {
      connection,
      email,
      password: randomTempPassword(),
      email_verified: false,
      verify_email: false,
    },
  });

  return user;
}

async function createPasswordChangeTicket(auth0UserId) {
  const token = await getAuth0MgmtToken();

  // Where to send them after they set password (admin login page)
  const resultUrl = process.env.ADMIN_APP_URL || process.env.APP_BASE_URL || 'https://ausa.io/admin';

  const ticket = await auth0MgmtFetch('/tickets/password-change', {
    method: 'POST',
    token,
    body: {
      user_id: auth0UserId,
      result_url: resultUrl,
      ttl_sec: 60 * 60 * 24 * 3, // 3 days
      mark_email_as_verified: false,
    },
  });

  // { ticket: "https://..." }
  if (!ticket?.ticket) throw new Error('Auth0 did not return a password-change ticket');
  return ticket.ticket;
}

module.exports = function createWebsiteAdminStaffRouter({ supabase, sendError }) {
  const router = express.Router();

  // GET /api/admin/staff
  router.get('/staff', async (req, res) => {
    const { data, error } = await supabase
      .from('staff')
      .select('user_id, auth0_sub, email, role, active, created_at')
      .order('created_at', { ascending: false });

    if (error) return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to list staff', { detail: error.message });
    return res.json(data || []);
  });

  // POST /api/admin/staff/invite
  // body: { email, active? }
  router.post('/staff/invite', async (req, res) => {
    try {
      const email = normalizeEmail(req.body?.email);
      const active = req.body?.active === undefined ? true : !!req.body.active;

      if (!email) return sendError(res, 400, 'BAD_REQUEST', 'email is required');

      // Must satisfy staff_role_check constraint in your DB.
      const DEFAULT_STAFF_ROLE = 'admin';

      // 1) Create or reactivate staff row
      let staffRow = null;

      const { data: created, error: insErr } = await supabase
        .from('staff')
        .insert({
          email,
          role: DEFAULT_STAFF_ROLE,
          active,
          auth0_sub: null,
        })
        .select('user_id, auth0_sub, email, role, active, created_at')
        .single();

      if (!insErr) {
        staffRow = created;
      } else {
        const msg = String(insErr.message || '');
        const looksLikeDuplicate =
          msg.toLowerCase().includes('duplicate') ||
          msg.toLowerCase().includes('unique') ||
          msg.toLowerCase().includes('staff_email_unique');

        if (!looksLikeDuplicate) {
          return sendError(res, 400, 'SUPABASE_ERROR', 'Failed to create staff record', { detail: insErr.message });
        }

        const { data: updated, error: updErr } = await supabase
          .from('staff')
          .update({ active, email })
          .eq('email', email)
          .select('user_id, auth0_sub, email, role, active, created_at')
          .single();

        if (updErr) {
          return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to re-activate existing admin', { detail: updErr.message });
        }

        staffRow = updated;
      }

      // 2) Ensure Auth0 user exists + store auth0_sub in staff table
      //    This makes admin access work immediately after first login.
      let auth0User = null;
      let setPasswordUrl = null;

      try {
        auth0User = await getOrCreateAuth0UserByEmail(email);
        setPasswordUrl = await createPasswordChangeTicket(auth0User.user_id);

        // Persist auth0_sub for reliable matching
        const { data: patched, error: patchErr } = await supabase
          .from('staff')
          .update({ auth0_sub: auth0User.user_id })
          .eq('user_id', staffRow.user_id)
          .select('user_id, auth0_sub, email, role, active, created_at')
          .single();

        if (!patchErr && patched) staffRow = patched;
      } catch (e) {
        // If Auth0 provisioning fails, keep staff row but return clear error.
        return sendError(res, 500, 'AUTH0_PROVISION_FAILED', 'Failed to provision Auth0 user for invite', {
          detail: e?.message || String(e),
        });
      }

      // 3) Send invite email with set-password ticket link
      const inviteSend = await sendAdminInviteEmail({
        toEmail: email,
        setPasswordUrl,
      });

      return res.status(201).json({
        ok: true,
        staff: staffRow,
        auth0_sub: auth0User?.user_id || null,
        setPasswordUrl, // useful for debugging; remove later if you prefer
        inviteSend,
      });
    } catch (e) {
      return sendError(res, 500, 'SERVER_ERROR', 'Invite failed', { detail: e?.message });
    }
  });

  // PATCH /api/admin/staff/:user_id
  // body: { active?, email? }
  router.patch('/staff/:user_id', async (req, res) => {
    try {
      const user_id = req.params.user_id;

      const patch = {};
      if (req.body?.active !== undefined) patch.active = !!req.body.active;
      if (req.body?.email !== undefined) patch.email = normalizeEmail(req.body.email);

      if (Object.keys(patch).length === 0) {
        return sendError(res, 400, 'BAD_REQUEST', 'No fields to update');
      }

      // Guard: prevent disabling the last active admin
      if (patch.active === false) {
        const { count, error: countErr } = await supabase
          .from('staff')
          .select('user_id', { count: 'exact', head: true })
          .eq('active', true);

        if (countErr) {
          return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to validate active admin count', { detail: countErr.message });
        }

        if ((count || 0) <= 1) {
          return sendError(res, 400, 'BAD_REQUEST', 'Cannot deactivate the last active admin.');
        }
      }

      const { data, error } = await supabase
        .from('staff')
        .update(patch)
        .eq('user_id', user_id)
        .select('user_id, auth0_sub, email, role, active, created_at')
        .single();

      if (error) return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to update staff', { detail: error.message });

      return res.json({ ok: true, staff: data });
    } catch (e) {
      return sendError(res, 500, 'SERVER_ERROR', 'Patch failed', { detail: e?.message });
    }
  });

  return router;
};
