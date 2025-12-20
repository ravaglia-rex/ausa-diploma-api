// routes/adminStaff.js
const express = require('express');
const { z } = require('zod');
const { supabaseAdmin } = require('../lib/supabase');
const { requireSuperAdmin } = require('../middleware/requireStaff');

const router = express.Router();

router.get('/staff', requireSuperAdmin, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('staff')
    .select('user_id, email, role, active, created_at')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ data });
});

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['viewer', 'admin', 'super_admin']).default('admin'),
  active: z.boolean().default(true),
});

router.post('/staff/invite', requireSuperAdmin, async (req, res) => {
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  // Invite user via Supabase Auth Admin API
  const { data: inviteData, error: inviteErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(
    parsed.data.email,
    { redirectTo: process.env.ADMIN_APP_URL || undefined }
  );

  if (inviteErr) return res.status(500).json({ error: inviteErr.message });

  const userId = inviteData?.user?.id;
  if (!userId) return res.status(500).json({ error: 'Invite succeeded but no user id returned' });

  // Upsert staff row
  const { error: staffErr } = await supabaseAdmin
    .from('staff')
    .upsert(
      {
        user_id: userId,
        email: parsed.data.email,
        role: parsed.data.role,
        active: parsed.data.active,
      },
      { onConflict: 'user_id' }
    );

  if (staffErr) return res.status(500).json({ error: staffErr.message });

  return res.json({ ok: true, user_id: userId });
});

const patchSchema = z.object({
  role: z.enum(['viewer', 'admin', 'super_admin']).optional(),
  active: z.boolean().optional(),
  email: z.string().email().optional(),
});

router.patch('/staff/:user_id', requireSuperAdmin, async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { user_id } = req.params;

  const { data, error } = await supabaseAdmin
    .from('staff')
    .update(parsed.data)
    .eq('user_id', user_id)
    .select('user_id, email, role, active, created_at')
    .single();

  if (error) return res.status(500).json({ error: error.message });

  return res.json({ ok: true, data });
});

module.exports = router;
