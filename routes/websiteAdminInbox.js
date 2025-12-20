// routes/websiteAdminInbox.js
const express = require('express');
const { randomUUID } = require('crypto');

const ALLOWED_SOURCES = new Set([
  'applications',
  'course_preregistrations',
  'inquiries',
  'school_leads',
  'university_leads',
  'workshop_reservations',
]);

function leadKindForSource(sourceTable) {
  switch (sourceTable) {
    case 'applications': return 'application';
    case 'course_preregistrations': return 'course_prereg';
    case 'inquiries': return 'general_inquiry';
    case 'school_leads': return 'school_lead';
    case 'university_leads': return 'university_partner'; // enum uses university_partner
    case 'workshop_reservations': return 'workshop_reservation';
    default: return 'general_inquiry';
  }
}

function normalizeUuidOrNull(v) {
  if (!v) return null;
  try {
    const s = String(v).trim();
    // cheap uuid check
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)) return s;
    return null;
  } catch {
    return null;
  }
}

async function getInboxRow({ supabase, source_table, source_id }) {
  const { data, error } = await supabase
    .from('v_inbox_all')
    .select('*')
    .eq('source_table', source_table)
    .eq('source_id', source_id)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data || null;
}

async function getOrCreateLead({ supabase, source_table, source_id, assigned_to, source_page }) {
  // Upsert against unique index (source_table, source_row_id)
  const payload = {
    kind: leadKindForSource(source_table),
    source_table,
    source_row_id: source_id,
    source_page: source_page || null,
    assigned_to: assigned_to || null,
    // status default 'new', priority default 'normal'
  };

  const { data, error } = await supabase
    .from('leads')
    .upsert(payload, { onConflict: 'source_table,source_row_id' })
    .select('*')
    .single();

  if (error) throw new Error(error.message);

  // Ensure there is at least one event
  // (don’t spam events if lead already existed)
  // We'll check for any existing event quickly.
  const { data: anyEvent } = await supabase
    .from('lead_events')
    .select('id')
    .eq('lead_id', data.id)
    .limit(1);

  if (!anyEvent || anyEvent.length === 0) {
    await supabase.from('lead_events').insert({
      id: randomUUID(),
      lead_id: data.id,
      event_kind: 'other',
      title: 'Lead created',
      body: `Created lead for ${source_table}:${source_id}`,
      created_by: null,
    });
  }

  return data;
}

module.exports = function createWebsiteAdminInboxRouter({ supabase, sendError }) {
  const router = express.Router();

  // GET /api/admin/inbox?scope=open|all&page=&pageSize=&q=&kind=&source_table=&assigned_to=
  router.get('/inbox', async (req, res) => {
    try {
      const scope = String(req.query.scope || 'open');
      const view = scope === 'all' ? 'v_inbox_all' : 'v_inbox_open';

      const q = String(req.query.q || '').trim();
      const kind = String(req.query.kind || '').trim();
      const source_table = String(req.query.source_table || '').trim();
      const assigned_to = String(req.query.assigned_to || '').trim();

      const page = Math.max(1, Number(req.query.page || 1));
      const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize || 25)));
      const from = (page - 1) * pageSize;
      const to = from + pageSize - 1;

      let sb = supabase
        .from(view)
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false });

      if (kind) sb = sb.eq('kind', kind);
      if (source_table) sb = sb.eq('source_table', source_table);
      if (assigned_to) sb = sb.eq('assigned_to', assigned_to);

      if (q) {
        const like = `%${q}%`;
        sb = sb.or(
          [
            `full_name.ilike.${like}`,
            `email.ilike.${like}`,
            `organization_name.ilike.${like}`,
            `city.ilike.${like}`,
            `interest_summary.ilike.${like}`,
          ].join(',')
        );
      }

      const { data, error, count } = await sb.range(from, to);

      if (error) {
        return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to fetch inbox', { detail: error.message });
      }

      return res.json({ rows: data || [], total: count || 0, page, pageSize });
    } catch (e) {
      return sendError(res, 500, 'SERVER_ERROR', 'Inbox list failed', { detail: e?.message });
    }
  });

  // GET /api/admin/inbox/:source_table/:source_id
  router.get('/inbox/:source_table/:source_id', async (req, res) => {
    try {
      const { source_table, source_id } = req.params;

      if (!ALLOWED_SOURCES.has(source_table)) {
        return sendError(res, 400, 'BAD_REQUEST', 'Unsupported source_table');
      }

      const inboxRow = await getInboxRow({ supabase, source_table, source_id });

      const { data: sourceRow, error: srcErr } = await supabase
        .from(source_table)
        .select('*')
        .eq('id', source_id)
        .single();

      if (srcErr || !sourceRow) {
        return sendError(res, 404, 'NOT_FOUND', 'Source row not found', { detail: srcErr?.message });
      }

      const lead = await getOrCreateLead({
        supabase,
        source_table,
        source_id,
        assigned_to: inboxRow?.assigned_to || sourceRow?.assigned_to || null,
        source_page: inboxRow?.source_page || sourceRow?.source_page || null,
      });

      const { data: events, error: evErr } = await supabase
        .from('lead_events')
        .select('*')
        .eq('lead_id', lead.id)
        .order('created_at', { ascending: false });

      if (evErr) {
        return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to fetch lead events', { detail: evErr.message });
      }

      return res.json({ inbox: inboxRow, source: sourceRow, lead, events: events || [] });
    } catch (e) {
      return sendError(res, 500, 'SERVER_ERROR', 'Inbox detail failed', { detail: e?.message });
    }
  });

  // PATCH /api/admin/inbox/:source_table/:source_id
  // body: { source_status?, assigned_to?, lead_status? }
  router.patch('/inbox/:source_table/:source_id', async (req, res) => {
    try {
      const { source_table, source_id } = req.params;
      if (!ALLOWED_SOURCES.has(source_table)) {
        return sendError(res, 400, 'BAD_REQUEST', 'Unsupported source_table');
      }

      const source_status = req.body?.source_status !== undefined ? String(req.body.source_status) : undefined;
      const assigned_to = req.body?.assigned_to !== undefined ? normalizeUuidOrNull(req.body.assigned_to) : undefined;
      const lead_status = req.body?.lead_status !== undefined ? String(req.body.lead_status) : undefined;

      const inboxRow = await getInboxRow({ supabase, source_table, source_id });
      const lead = await getOrCreateLead({ supabase, source_table, source_id });

      // Update source row columns (only if provided)
      const sourceUpdate = {};
      if (source_status !== undefined) sourceUpdate.status = source_status;
      if (assigned_to !== undefined) sourceUpdate.assigned_to = assigned_to;

      if (Object.keys(sourceUpdate).length > 0) {
        const { error: upErr } = await supabase
          .from(source_table)
          .update(sourceUpdate)
          .eq('id', source_id);

        if (upErr) {
          return sendError(res, 400, 'BAD_REQUEST', 'Failed to update source row', { detail: upErr.message });
        }
      }

      // Mirror into leads (status/assigned_to)
      const leadUpdate = {};
      if (assigned_to !== undefined) leadUpdate.assigned_to = assigned_to;
      if (lead_status !== undefined) leadUpdate.status = lead_status;

      if (Object.keys(leadUpdate).length > 0) {
        const { data: updatedLead, error: leadErr } = await supabase
          .from('leads')
          .update(leadUpdate)
          .eq('id', lead.id)
          .select('*')
          .single();

        if (leadErr) {
          return sendError(res, 400, 'BAD_REQUEST', 'Failed to update lead', { detail: leadErr.message });
        }

        // Event log
        await supabase.from('lead_events').insert({
          id: randomUUID(),
          lead_id: lead.id,
          event_kind: 'status_change',
          title: 'Updated',
          body: `Updated lead/source from API`,
          from_status: lead.status,
          to_status: updatedLead.status,
          created_by: req.staff?.user_id || null,
        });

        return res.json({ ok: true, lead: updatedLead, inbox: inboxRow });
      }

      return res.json({ ok: true, lead, inbox: inboxRow });
    } catch (e) {
      return sendError(res, 500, 'SERVER_ERROR', 'Update failed', { detail: e?.message });
    }
  });

  // POST /api/admin/inbox/:source_table/:source_id/note
  router.post('/inbox/:source_table/:source_id/note', async (req, res) => {
    try {
      const { source_table, source_id } = req.params;
      if (!ALLOWED_SOURCES.has(source_table)) {
        return sendError(res, 400, 'BAD_REQUEST', 'Unsupported source_table');
      }

      const body = String(req.body?.body || '').trim();
      const title = String(req.body?.title || 'Note').trim();

      if (!body) return sendError(res, 400, 'BAD_REQUEST', 'Note body is required');

      const lead = await getOrCreateLead({ supabase, source_table, source_id });

      const { error } = await supabase.from('lead_events').insert({
        id: randomUUID(),
        lead_id: lead.id,
        event_kind: 'note',
        title,
        body,
        created_by: req.staff?.user_id || null,
      });

      if (error) {
        return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to insert note', { detail: error.message });
      }

      return res.json({ ok: true });
    } catch (e) {
      return sendError(res, 500, 'SERVER_ERROR', 'Note failed', { detail: e?.message });
    }
  });

  // POST /api/admin/inbox/:source_table/:source_id/reply
  // body: { to, subject, text?, html?, set_source_status?, set_lead_status? }
  router.post('/inbox/:source_table/:source_id/reply', async (req, res) => {
    try {
      const { source_table, source_id } = req.params;
      if (!ALLOWED_SOURCES.has(source_table)) {
        return sendError(res, 400, 'BAD_REQUEST', 'Unsupported source_table');
      }

      const to = String(req.body?.to || '').trim();
      const subject = String(req.body?.subject || '').trim();
      const text = req.body?.text ? String(req.body.text) : null;
      const html = req.body?.html ? String(req.body.html) : null;
      const set_source_status = req.body?.set_source_status ? String(req.body.set_source_status) : null;
      const set_lead_status = req.body?.set_lead_status ? String(req.body.set_lead_status) : null;

      if (!to || !to.includes('@')) return sendError(res, 400, 'BAD_REQUEST', '`to` must be an email');
      if (!subject) return sendError(res, 400, 'BAD_REQUEST', 'subject is required');
      if (!text && !html) return sendError(res, 400, 'BAD_REQUEST', 'Provide text or html');

      // Send via Resend (using the same env vars you already use)
      const { Resend } = require('resend');
      if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM) {
        return sendError(res, 400, 'BAD_REQUEST', 'Resend not configured (missing RESEND_API_KEY or RESEND_FROM)');
      }
      const resend = new Resend(process.env.RESEND_API_KEY);

      const sendResult = await resend.emails.send({
        from: process.env.RESEND_FROM,
        to,
        subject,
        text: text || undefined,
        html: html || undefined,
      });

      const lead = await getOrCreateLead({ supabase, source_table, source_id });

      // Log email
      await supabase.from('lead_events').insert({
        id: randomUUID(),
        lead_id: lead.id,
        event_kind: 'email',
        title: subject,
        body:
          `To: ${to}\n` +
          `Subject: ${subject}\n` +
          (sendResult?.data?.id ? `Resend ID: ${sendResult.data.id}\n` : '') +
          `\n` +
          (text || '(html email sent)'),
        created_by: req.staff?.user_id || null,
      });

      // Optional updates
      if (set_source_status) {
        const { error: srcErr } = await supabase
          .from(source_table)
          .update({ status: set_source_status })
          .eq('id', source_id);

        if (srcErr) {
          return sendError(res, 400, 'BAD_REQUEST', 'Failed to update source status', { detail: srcErr.message });
        }
      }

      if (set_lead_status) {
        const { error: leadErr } = await supabase
          .from('leads')
          .update({ status: set_lead_status })
          .eq('id', lead.id);

        if (leadErr) {
          return sendError(res, 400, 'BAD_REQUEST', 'Failed to update lead status', { detail: leadErr.message });
        }
      }

      return res.json({ ok: true, sendResult });
    } catch (e) {
      return sendError(res, 500, 'SERVER_ERROR', 'Reply failed', { detail: e?.message });
    }
  });

  return router;
};
