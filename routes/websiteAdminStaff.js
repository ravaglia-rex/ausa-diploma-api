// routes/websiteAdminStaff.js
const express = require('express');
const sendAdminInviteEmail = require('../email/sendAdminInviteEmail');

function normalizeEmail(v) {
  if (!v || typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return s ? s : null;
}

/**
 * Factory router.
 * Mounted behind:
 *   authenticateJwt,
 *   requireAnyAdmin (staff.active === true)
 *
 * Simplified rules:
 * - Any active admin can list/invite/deactivate other admins
 * - invite accepts only: { email, active? }
 * - role is hardcoded to whatever your DB constraint allows (usually 'admin')
 */
module.exports = function createWebsiteAdminStaffRouter({ supabase, sendError }) {
  const router = express.Router();

  // GET /api/admin/staff
  router.get('/staff', async (req, res) => {
    const { data, error } = await supabase
      .from('staff')
      .select('user_id, auth0_sub, email, role, active, created_at')
      .order('created_at', { ascending: false });

    if (error) {
      return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to list staff', { detail: error.message });
    }
    return res.json(data || []);
  });

  // POST /api/admin/staff/invite
  // body: { email, active? }
  router.post('/staff/invite', async (req, res) => {
    try {
      const email = normalizeEmail(req.body?.email);
      const active = req.body?.active === undefined ? true : !!req.body.active;

      if (!email) return sendError(res, 400, 'BAD_REQUEST', 'email is required');

      // IMPORTANT: this must satisfy your staff_role_check constraint.
      // In most setups this is 'admin'. If your constraint only allows something else,
      // change this constant to an allowed value.
      const DEFAULT_STAFF_ROLE = 'admin';

      // Insert (auth0_sub will be linked automatically on first login by middleware)
      const { data, error } = await supabase
        .from('staff')
        .insert({
          email,
          role: DEFAULT_STAFF_ROLE,
          active,
          auth0_sub: null,
        })
        .select('user_id, auth0_sub, email, role, active, created_at')
        .single();

      if (error) {
        return sendError(res, 400, 'SUPABASE_ERROR', 'Failed to create staff record', { detail: error.message });
      }

      // Send invite email with /admin + /diploma/admin links
      const inviteSend = await sendAdminInviteEmail({ toEmail: email });

      return res.status(201).json({ ok: true, staff: data, inviteSend });
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

      const { data, error } = await supabase
        .from('staff')
        .update(patch)
        .eq('user_id', user_id)
        .select('user_id, auth0_sub, email, role, active, created_at')
        .single();

      if (error) {
        return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to update staff', { detail: error.message });
      }

      return res.json({ ok: true, staff: data });
    } catch (e) {
      return sendError(res, 500, 'SERVER_ERROR', 'Patch failed', { detail: e?.message });
    }
  });

  return router;
};
