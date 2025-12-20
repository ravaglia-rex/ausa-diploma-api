// utils/leadUtils.js
const { supabaseAdmin } = require('../lib/supabase');

const ALLOWED_SOURCES = new Set([
  'applications',
  'course_preregistrations',
  'inquiries',
  'school_leads',
  'university_leads',
  'workshop_reservations',
]);

// Your enum values (confirmed from your DB):
const LEAD_STATUSES = new Set(['new', 'in_review', 'contacted', 'qualified', 'converted', 'archived']);

function leadKindForSource(sourceTable) {
  switch (sourceTable) {
    case 'applications': return 'application';
    case 'course_preregistrations': return 'course_prereg';
    case 'inquiries': return 'general_inquiry';
    case 'school_leads': return 'school_lead';
    case 'university_leads': return 'university_partner'; // IMPORTANT: enum uses university_partner, view uses university_lead
    case 'workshop_reservations': return 'workshop_reservation';
    default: return 'general_inquiry';
  }
}

function safeLeadStatus(candidate) {
  if (!candidate) return null;
  return LEAD_STATUSES.has(candidate) ? candidate : null;
}

async function getInboxRow(source_table, source_id) {
  const { data, error } = await supabaseAdmin
    .from('v_inbox_all')
    .select('*')
    .eq('source_table', source_table)
    .eq('source_id', source_id)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getOrCreateLead({ source_table, source_id, assigned_to = null, source_page = null }) {
  const { data: existing, error: existErr } = await supabaseAdmin
    .from('leads')
    .select('*')
    .eq('source_table', source_table)
    .eq('source_row_id', source_id)
    .maybeSingle();

  if (existErr) throw existErr;
  if (existing?.id) return existing;

  const insertPayload = {
    kind: leadKindForSource(source_table),
    source_table,
    source_row_id: source_id,
    source_page: source_page || null,
    assigned_to: assigned_to || null,
    // leads.status defaults to 'new'
    // leads.priority defaults to 'normal'
  };

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('leads')
    .insert(insertPayload)
    .select('*')
    .single();

  if (insErr) throw insErr;

  // initial event
  await supabaseAdmin.from('lead_events').insert({
    lead_id: inserted.id,
    event_kind: 'other',
    title: 'Lead created',
    body: `Created lead for ${source_table}:${source_id}`,
    created_by: null,
  });

  return inserted;
}

async function addLeadEvent({ lead_id, event_kind, title, body, from_status, to_status, created_by }) {
  const payload = {
    lead_id,
    event_kind,
    title: title || null,
    body: body || null,
    from_status: from_status || null,
    to_status: to_status || null,
    created_by: created_by || null,
  };

  const { error } = await supabaseAdmin.from('lead_events').insert(payload);
  if (error) throw error;
}

async function updateLeadStatusAndAssign({ lead, to_status, assigned_to, actor_staff_id }) {
  const updates = {};
  const safeStatus = safeLeadStatus(to_status);
  if (safeStatus && safeStatus !== lead.status) updates.status = safeStatus;
  if (typeof assigned_to !== 'undefined' && assigned_to !== lead.assigned_to) updates.assigned_to = assigned_to || null;

  if (Object.keys(updates).length === 0) return lead;

  const { data: updated, error } = await supabaseAdmin
    .from('leads')
    .update(updates)
    .eq('id', lead.id)
    .select('*')
    .single();

  if (error) throw error;

  if (updates.status) {
    await addLeadEvent({
      lead_id: lead.id,
      event_kind: 'status_change',
      title: 'Status changed',
      body: `Lead status changed: ${lead.status} → ${updates.status}`,
      from_status: lead.status,
      to_status: updates.status,
      created_by: actor_staff_id,
    });
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'assigned_to')) {
    await addLeadEvent({
      lead_id: lead.id,
      event_kind: 'other',
      title: 'Assignment changed',
      body: `Lead assigned_to updated.`,
      created_by: actor_staff_id,
    });
  }

  return updated;
}

module.exports = {
  ALLOWED_SOURCES,
  getInboxRow,
  getOrCreateLead,
  addLeadEvent,
  updateLeadStatusAndAssign,
};
