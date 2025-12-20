// routes/adminInbox.js
const express = require('express');
const { z } = require('zod');
const { supabaseAdmin } = require('../lib/supabase');
const { resend, RESEND_FROM_EMAIL } = require('../lib/resend');
const { requireStaff } = require('../middleware/requireStaff');
const {
  ALLOWED_SOURCES,
  getInboxRow,
  getOrCreateLead,
  addLeadEvent,
  updateLeadStatusAndAssign,
} = require('../utils/leadUtils');

const router = express.Router();

// ---- List inbox ----
router.get('/inbox', requireStaff(['admin', 'super_admin']), async (req, res) => {
  try {
    const scope = (req.query.scope || 'open').toString(); // open | all
    const view = scope === 'all' ? 'v_inbox_all' : 'v_inbox_open';

    const q = (req.query.q || '').toString().trim();
    const kind = (req.query.kind || '').toString().trim();
    const source_table = (req.query.source_table || '').toString().trim();
    const assigned_to = (req.query.assigned_to || '').toString().trim();

    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const pageSize = Math.min(100, Math.max(10, parseInt(req.query.pageSize || '25', 10)));
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    let query = supabaseAdmin
      .from(view)
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false });

    if (kind) query = query.eq('kind', kind);
    if (source_table) query = query.eq('source_table', source_table);
    if (assigned_to) query = query.eq('assigned_to', assigned_to);

    if (q) {
      const esc = q.replace(/%/g, '\\%').replace(/_/g, '\\_');
      query = query.or(
        [
          `full_name.ilike.%${esc}%`,
          `email.ilike.%${esc}%`,
          `organization_name.ilike.%${esc}%`,
          `city.ilike.%${esc}%`,
          `interest_summary.ilike.%${esc}%`,
        ].join(',')
      );
    }

    const { data, error, count } = await query.range(from, to);
    if (error) return res.status(500).json({ error: error.message });

    return res.json({ data, count, page, pageSize });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to list inbox' });
  }
});

// ---- Detail: source row + lead + events ----
router.get('/inbox/:source_table/:source_id', requireStaff(['admin', 'super_admin']), async (req, res) => {
  try {
    const { source_table, source_id } = req.params;
    if (!ALLOWED_SOURCES.has(source_table)) return res.status(400).json({ error: 'Unsupported source_table' });

    const inboxRow = await getInboxRow(source_table, source_id);

    const { data: sourceRow, error: srcErr } = await supabaseAdmin
      .from(source_table)
      .select('*')
      .eq('id', source_id)
      .single();

    if (srcErr) return res.status(404).json({ error: srcErr.message });

    const lead = await getOrCreateLead({
      source_table,
      source_id,
      assigned_to: inboxRow?.assigned_to || sourceRow?.assigned_to || null,
      source_page: inboxRow?.source_page || sourceRow?.source_page || null,
    });

    const { data: events, error: evErr } = await supabaseAdmin
      .from('lead_events')
      .select('*')
      .eq('lead_id', lead.id)
      .order('created_at', { ascending: false });

    if (evErr) return res.status(500).json({ error: evErr.message });

    return res.json({ inbox: inboxRow, source: sourceRow, lead, events });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load inbox item' });
  }
});

// ---- Patch: update status/assigned_to on source + mirror into leads ----
const patchSchema = z.object({
  // source table status is TEXT; v_inbox_open considers 'new' and 'submitted' open
  source_status: z.string().min(1).optional(),
  assigned_to: z.string().uuid().nullable().optional(),
  // optional: set lead status (must be one of enum values)
  lead_status: z.enum(['new', 'in_review', 'contacted', 'qualified', 'converted', 'archived']).optional(),
});

router.patch('/inbox/:source_table/:source_id', requireStaff(['admin', 'super_admin']), async (req, res) => {
  try {
    const { source_table, source_id } = req.params;
    if (!ALLOWED_SOURCES.has(source_table)) return res.status(400).json({ error: 'Unsupported source_table' });

    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const inboxRow = await getInboxRow(source_table, source_id);
    const lead = await getOrCreateLead({
      source_table,
      source_id,
      assigned_to: inboxRow?.assigned_to || null,
      source_page: inboxRow?.source_page || null,
    });

    // Update source table if possible
    const updates = {};
    if (typeof parsed.data.source_status !== 'undefined') updates.status = parsed.data.source_status;
    if (typeof parsed.data.assigned_to !== 'undefined') updates.assigned_to = parsed.data.assigned_to;

    if (Object.keys(updates).length > 0) {
      // Not every source table has assigned_to; Supabase will throw if column doesn’t exist.
      // We handle that error cleanly.
      const { error: upErr } = await supabaseAdmin
        .from(source_table)
        .update(updates)
        .eq('id', source_id);

      if (upErr) return res.status(400).json({ error: upErr.message });
    }

    // Mirror into leads table (lead_status + assigned_to)
    const updatedLead = await updateLeadStatusAndAssign({
      lead,
      to_status: parsed.data.lead_status,
      assigned_to: typeof parsed.data.assigned_to !== 'undefined' ? parsed.data.assigned_to : lead.assigned_to,
      actor_staff_id: req.staff.user_id,
    });

    return res.json({ ok: true, lead: updatedLead });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to update inbox item' });
  }
});

// ---- Add note ----
const noteSchema = z.object({
  body: z.string().min(1),
  title: z.string().optional(),
});

router.post('/inbox/:source_table/:source_id/note', requireStaff(['admin', 'super_admin']), async (req, res) => {
  try {
    const { source_table, source_id } = req.params;
    if (!ALLOWED_SOURCES.has(source_table)) return res.status(400).json({ error: 'Unsupported source_table' });

    const parsed = noteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const lead = await getOrCreateLead({ source_table, source_id });

    await addLeadEvent({
      lead_id: lead.id,
      event_kind: 'note',
      title: parsed.data.title || 'Note',
      body: parsed.data.body,
      created_by: req.staff.user_id,
    });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to add note' });
  }
});

// ---- Reply via Resend + log event ----
const replySchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  text: z.string().min(1).optional(),
  html: z.string().min(1).optional(),
  // optional status update on send (source table status)
  set_source_status: z.string().optional(), // e.g. 'contacted'
  // optional lead status update on send
  set_lead_status: z.enum(['new', 'in_review', 'contacted', 'qualified', 'converted', 'archived']).optional(),
});

router.post('/inbox/:source_table/:source_id/reply', requireStaff(['admin', 'super_admin']), async (req, res) => {
  try {
    const { source_table, source_id } = req.params;
    if (!ALLOWED_SOURCES.has(source_table)) return res.status(400).json({ error: 'Unsupported source_table' });

    const parsed = replySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const lead = await getOrCreateLead({ source_table, source_id });

    const sendRes = await resend.emails.send({
      from: RESEND_FROM_EMAIL,
      to: parsed.data.to,
      subject: parsed.data.subject,
      text: parsed.data.text,
      html: parsed.data.html,
    });

    // Log email in lead_events
    await addLeadEvent({
      lead_id: lead.id,
      event_kind: 'email',
      title: parsed.data.subject,
      body: [
        `To: ${parsed.data.to}`,
        `Subject: ${parsed.data.subject}`,
        sendRes?.data?.id ? `Resend ID: ${sendRes.data.id}` : null,
        '',
        parsed.data.text || '(html email sent)',
      ].filter(Boolean).join('\n'),
      created_by: req.staff.user_id,
    });

    // Optional: update source status so it falls out of v_inbox_open
    if (parsed.data.set_source_status) {
      const { error: upErr } = await supabaseAdmin
        .from(source_table)
        .update({ status: parsed.data.set_source_status })
        .eq('id', source_id);

      if (upErr) return res.status(400).json({ error: upErr.message });
    }

    // Optional: update lead status enum
    if (parsed.data.set_lead_status) {
      await updateLeadStatusAndAssign({
        lead,
        to_status: parsed.data.set_lead_status,
        assigned_to: lead.assigned_to,
        actor_staff_id: req.staff.user_id,
      });
    }

    return res.json({ ok: true, resend: sendRes.data || null });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to send reply' });
  }
});

module.exports = router;
