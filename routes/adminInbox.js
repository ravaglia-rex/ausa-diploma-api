// routes/adminInbox.js
const express = require('express');
const { z } = require('zod');
const { supabaseAdmin } = require('../lib/supabase');
const { resend, RESEND_FROM_EMAIL } = require('../lib/resend');
const {
  ALLOWED_SOURCES,
  getInboxRow,
  getOrCreateLead,
  addLeadEvent,
  updateLeadStatusAndAssign,
} = require('../utils/leadUtils');

const router = express.Router();

// ------------------------------
// Helpers
// ------------------------------
function getRequestId(req, res) {
  return (
    (req && (req.requestId || req.id)) ||
    res.getHeader('x-request-id') ||
    res.getHeader('X-Request-Id') ||
    undefined
  );
}

function jsonError(res, status, code, message, requestId, detail) {
  return res.status(status).json({
    error: {
      code,
      message,
      requestId,
      ...(detail ? { detail } : {}),
    },
  });
}

// Cache inbox_status for a short time to avoid DB hits on every patch/reply
let _statusCache = { at: 0, ttlMs: 30_000, list: null, set: null };

async function loadInboxStatuses() {
  const now = Date.now();
  if (_statusCache.list && _statusCache.set && now - _statusCache.at < _statusCache.ttlMs) {
    return { list: _statusCache.list, set: _statusCache.set };
  }

  const { data, error } = await supabaseAdmin
    .from('inbox_status')
    .select('code,label,sort_order,is_terminal')
    .order('sort_order', { ascending: true })
    .order('code', { ascending: true });

  if (error) throw error;

  const list = (data || []).map((r) => ({
    value: r.code,
    label: r.label,
    sortOrder: r.sort_order,
    isTerminal: r.is_terminal,
  }));

  const set = new Set(list.map((x) => x.value));

  _statusCache = { ..._statusCache, at: now, list, set };
  return { list, set };
}

async function assertValidStatusOrThrow(statusValue) {
  const { set } = await loadInboxStatuses();
  return set.has(statusValue);
}

// ------------------------------
// NEW: GET /api/admin/inbox/statuses
// (Assumes this router is mounted at /api/admin)
// ------------------------------
router.get('/inbox/statuses',  async (req, res) => {
  const requestId = getRequestId(req, res);
  try {
    const { list } = await loadInboxStatuses();
    return res.json({ data: list });
  } catch (e) {
    return jsonError(
      res,
      500,
      'DB_ERROR',
      'Failed to load inbox statuses',
      requestId,
      e?.message || String(e)
    );
  }
});

// ---- List inbox ----
router.get('/inbox', async (req, res) => {
  const requestId = getRequestId(req, res);
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
    if (error) return jsonError(res, 500, 'DB_ERROR', error.message, requestId);

    return res.json({ data, count, page, pageSize });
  } catch (e) {
    return jsonError(res, 500, 'SERVER_ERROR', 'Failed to list inbox', requestId, e?.message || String(e));
  }
});

// ---- Detail: source row + lead + events ----
router.get('/inbox/:source_table/:source_id', async (req, res) => {
  const requestId = getRequestId(req, res);
  try {
    const { source_table, source_id } = req.params;
    if (!ALLOWED_SOURCES.has(source_table)) {
      return jsonError(res, 400, 'BAD_REQUEST', 'Unsupported source_table', requestId, source_table);
    }

    const inboxRow = await getInboxRow(source_table, source_id);

    const { data: sourceRow, error: srcErr } = await supabaseAdmin
      .from(source_table)
      .select('*')
      .eq('id', source_id)
      .single();

    if (srcErr) return jsonError(res, 404, 'NOT_FOUND', srcErr.message, requestId);

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

    if (evErr) return jsonError(res, 500, 'DB_ERROR', evErr.message, requestId);

    return res.json({ inbox: inboxRow, source: sourceRow, lead, events });
  } catch (e) {
    return jsonError(res, 500, 'SERVER_ERROR', 'Failed to load inbox item', requestId, e?.message || String(e));
  }
});

// ---- Patch: update status/assigned_to on source + mirror into leads ----
// NOTE: status values now validated against public.inbox_status (unified)
const patchSchema = z.object({
  source_status: z.string().min(1).optional(),
  assigned_to: z.string().uuid().nullable().optional(),
  lead_status: z.string().min(1).optional(),
});

router.patch('/inbox/:source_table/:source_id', async (req, res) => {
  const requestId = getRequestId(req, res);
  try {
    const { source_table, source_id } = req.params;
    if (!ALLOWED_SOURCES.has(source_table)) {
      return jsonError(res, 400, 'BAD_REQUEST', 'Unsupported source_table', requestId, source_table);
    }

    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      return jsonError(res, 400, 'BAD_REQUEST', 'Invalid payload', requestId, parsed.error.flatten());
    }

    // Validate statuses against inbox_status
    if (typeof parsed.data.source_status !== 'undefined') {
      const ok = await assertValidStatusOrThrow(parsed.data.source_status);
      if (!ok) {
        return jsonError(
          res,
          400,
          'INVALID_STATUS',
          `Invalid source_status '${parsed.data.source_status}'`,
          requestId
        );
      }
    }
    if (typeof parsed.data.lead_status !== 'undefined') {
      const ok = await assertValidStatusOrThrow(parsed.data.lead_status);
      if (!ok) {
        return jsonError(
          res,
          400,
          'INVALID_STATUS',
          `Invalid lead_status '${parsed.data.lead_status}'`,
          requestId
        );
      }
    }

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
      const { error: upErr } = await supabaseAdmin.from(source_table).update(updates).eq('id', source_id);
      if (upErr) {
        return jsonError(res, 400, 'BAD_REQUEST', 'Failed to update source row', requestId, upErr.message);
      }
    }

    // Mirror into leads table (lead_status + assigned_to)
    // NOTE: updateLeadStatusAndAssign should accept unified status strings (TEXT) now.
    const updatedLead = await updateLeadStatusAndAssign({
      lead,
      to_status: parsed.data.lead_status,
      assigned_to:
        typeof parsed.data.assigned_to !== 'undefined' ? parsed.data.assigned_to : lead.assigned_to,
      actor_staff_id: req.staff.user_id,
    });

    return res.json({ ok: true, lead: updatedLead });
  } catch (e) {
    return jsonError(res, 500, 'SERVER_ERROR', 'Failed to update inbox item', requestId, e?.message || String(e));
  }
});

// ---- Add note ----
const noteSchema = z.object({
  body: z.string().min(1),
  title: z.string().optional(),
});

router.post('/inbox/:source_table/:source_id/note', async (req, res) => {
  const requestId = getRequestId(req, res);
  try {
    const { source_table, source_id } = req.params;
    if (!ALLOWED_SOURCES.has(source_table)) {
      return jsonError(res, 400, 'BAD_REQUEST', 'Unsupported source_table', requestId, source_table);
    }

    const parsed = noteSchema.safeParse(req.body);
    if (!parsed.success) {
      return jsonError(res, 400, 'BAD_REQUEST', 'Invalid payload', requestId, parsed.error.flatten());
    }

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
    return jsonError(res, 500, 'SERVER_ERROR', 'Failed to add note', requestId, e?.message || String(e));
  }
});

// ---- Reply via Resend + log event ----
// NOTE: status values now validated against public.inbox_status (unified)
const replySchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  text: z.string().min(1).optional(),
  html: z.string().min(1).optional(),
  set_source_status: z.string().min(1).optional(),
  set_lead_status: z.string().min(1).optional(),
});

router.post('/inbox/:source_table/:source_id/reply',  async (req, res) => {
  const requestId = getRequestId(req, res);
  try {
    const { source_table, source_id } = req.params;
    if (!ALLOWED_SOURCES.has(source_table)) {
      return jsonError(res, 400, 'BAD_REQUEST', 'Unsupported source_table', requestId, source_table);
    }

    const parsed = replySchema.safeParse(req.body);
    if (!parsed.success) {
      return jsonError(res, 400, 'BAD_REQUEST', 'Invalid payload', requestId, parsed.error.flatten());
    }

    // Validate statuses against inbox_status
    if (parsed.data.set_source_status) {
      const ok = await assertValidStatusOrThrow(parsed.data.set_source_status);
      if (!ok) {
        return jsonError(
          res,
          400,
          'INVALID_STATUS',
          `Invalid set_source_status '${parsed.data.set_source_status}'`,
          requestId
        );
      }
    }
    if (parsed.data.set_lead_status) {
      const ok = await assertValidStatusOrThrow(parsed.data.set_lead_status);
      if (!ok) {
        return jsonError(
          res,
          400,
          'INVALID_STATUS',
          `Invalid set_lead_status '${parsed.data.set_lead_status}'`,
          requestId
        );
      }
    }

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
      ]
        .filter(Boolean)
        .join('\n'),
      created_by: req.staff.user_id,
    });

    // Optional: update source status
    if (parsed.data.set_source_status) {
      const { error: upErr } = await supabaseAdmin
        .from(source_table)
        .update({ status: parsed.data.set_source_status })
        .eq('id', source_id);

      if (upErr) {
        return jsonError(res, 400, 'BAD_REQUEST', 'Failed to update source status', requestId, upErr.message);
      }
    }

    // Optional: update lead status
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
    return jsonError(res, 500, 'SERVER_ERROR', 'Failed to send reply', requestId, e?.message || String(e));
  }
});

module.exports = router;
