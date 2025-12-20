// routes/websiteAdminStaff.js
const express = require('express');
const sendAdminInviteEmail = require('../email/sendAdminInviteEmail');

function normalizeEmail(v) {
  if (!v || typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return s ? s : null;
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
      // If your constraint is different, change this to an allowed value.
      const DEFAULT_STAFF_ROLE = 'admin';

      // Try insert first
      let inserted = null;

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
        inserted = created;
      }

      // If insert failed due to unique violation on email, update existing row to active=true (and update email casing)
      if (insErr) {
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
          .update({ active: true, email })
          .eq('email', email)
          .select('user_id, auth0_sub, email, role, active, created_at')
          .single();

        if (updErr) {
          return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to re-activate existing admin', { detail: updErr.message });
        }

        inserted = updated;
      }

      // Send invite email (idempotent behavior: always send on invite)
      const inviteSend = await sendAdminInviteEmail({ toEmail: email });

      return res.status(201).json({ ok: true, staff: inserted, inviteSend });
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
