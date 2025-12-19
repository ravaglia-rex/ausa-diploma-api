require('dotenv').config();

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const jwksRsa = require('jwks-rsa');
const { createClient } = require('@supabase/supabase-js');
const { randomUUID } = require('crypto');

const { sendWelcomeToDiplomaPortal } = require('./email/sendWelcomeEmail');

const app = express();
app.set('etag', false); // disable 304/ETag for API responses

// ---------- CORS ----------
const corsOptions = {
  origin: ['https://ausa.io', 'https://www.ausa.io', 'http://localhost:5173'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Authorization',
    'Content-Type',
    'Accept',
    'X-Requested-With',
    'X-Request-Id',
  ],
  exposedHeaders: ['X-Request-Id'],
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));
app.use(express.json());

// ---------- Request ID middleware ----------
app.use((req, res, next) => {
  const incoming = req.get('X-Request-Id');
  const requestId = incoming || randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
});

// ---------- Supabase client (service role) ----------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------- Helpers ----------
function sendError(res, status, code, message, extra = {}) {
  const requestId = res.getHeader('X-Request-Id');
  return res.status(status).json({
    error: {
      code,
      message,
      requestId,
      ...extra,
    },
  });
}

const ALLOWED_DIPLOMA_TIERS = new Set(['Targeted', 'Platinum', 'Diamond', 'Ivy']);

function cleanStringOrNull(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
}

function cleanLowerEmailOrNull(v) {
  const s = cleanStringOrNull(v);
  return s ? s.toLowerCase() : null;
}

function cleanBoolNullable(v) {
  // nullable boolean: undefined/null => null, otherwise coerce
  if (v === undefined || v === null) return null;
  return !!v;
}

async function recordInviteStatus({ studentId, sendResult }) {
  const patch = {
    invited_at: new Date().toISOString(),
    last_invite_message_id: sendResult?.id ? String(sendResult.id) : null,
  };

  const { error } = await supabase
    .from('diploma_students')
    .update(patch)
    .eq('id', studentId);

  if (error) {
    throw new Error(error.message || 'Failed to record invite status');
  }
}

// ---------- Auth0 JWT verification ----------
const jwksClient = jwksRsa({
  jwksUri: `https://${process.env.AUTH0_DOMAIN}/.well-known/jwks.json`,
  cache: true,
  rateLimit: true,
  jwksRequestsPerMinute: 10,
});

function getKey(header, callback) {
  jwksClient.getSigningKey(header.kid, function (err, key) {
    if (err) return callback(err);
    if (!key) return callback(new Error('Signing key not found'));
    const signingKey =
      typeof key.getPublicKey === 'function'
        ? key.getPublicKey()
        : key.publicKey || key.rsaPublicKey;
    callback(null, signingKey);
  });
}

function authenticateJwt(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.split(' ')[1];

  if (!token) {
    return sendError(res, 401, 'MISSING_TOKEN', 'Missing token');
  }

  const options = {
    audience: process.env.AUTH0_AUDIENCE,
    issuer: `https://${process.env.AUTH0_DOMAIN}/`,
    algorithms: ['RS256'],
  };

  jwt.verify(token, getKey, options, (err, decoded) => {
    if (err) {
      console.error('JWT verify error:', {
        requestId: req.requestId,
        name: err.name,
        message: err.message,
      });
      return sendError(res, 401, 'INVALID_TOKEN', 'Invalid token');
    }

    req.user = decoded;
    next();
  });
}

// ---------- Helper: admin role check ----------
function isAdmin(user) {
  const roles = user?.['https://ausa.io/claims/roles'] || user?.roles || [];
  return Array.isArray(roles) && roles.includes('ausa_admin');
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req.user)) {
    return sendError(res, 403, 'FORBIDDEN', 'Admin role required');
  }
  next();
}

// --------------------------------------------------
//  STUDENT-FACING ROUTES
// --------------------------------------------------

// GET /api/diploma/me
app.get('/api/diploma/me', authenticateJwt, async (req, res) => {
  const auth0Sub = req.user.sub;

  const { data: student, error } = await supabase
    .from('diploma_students')
    .select('*')
    .eq('auth0_sub', auth0Sub)
    .single();

  if (error || !student) {
    console.error('Error fetching diploma student', {
      requestId: req.requestId,
      error: error?.message,
    });
    return sendError(res, 404, 'NOT_FOUND', 'Diploma student not found');
  }

  return res.json(student);
});

// GET /api/diploma/me/items
app.get('/api/diploma/me/items', authenticateJwt, async (req, res) => {
  const auth0Sub = req.user.sub;

  const { data: student, error: studentError } = await supabase
    .from('diploma_students')
    .select('id')
    .eq('auth0_sub', auth0Sub)
    .single();

  if (studentError || !student) {
    return sendError(res, 404, 'NOT_FOUND', 'Diploma student not found');
  }

  const { data: items, error: itemsError } = await supabase
    .from('diploma_student_items')
    .select('*')
    .eq('student_id', student.id)
    .eq('visible_to_student', true)
    .order('created_at', { ascending: false });

  if (itemsError) {
    console.error('Error fetching student items', {
      requestId: req.requestId,
      error: itemsError.message,
    });
    return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to fetch items');
  }

  return res.json(items || []);
});

// POST /api/diploma/me/link-auth0
app.post('/api/diploma/me/link-auth0', authenticateJwt, async (req, res) => {
  try {
    const tokenPayload = req.user || {};
    const sub = tokenPayload.sub;

    if (!sub) return sendError(res, 401, 'MISSING_SUB', 'Missing sub in token');

    const tokenEmail =
      tokenPayload.email ||
      tokenPayload['https://ausa.io/email'] ||
      tokenPayload['https://ausa.io/claims/email'] ||
      null;

    const bodyEmail = req.body?.email ? String(req.body.email).trim().toLowerCase() : null;
    const email = (tokenEmail || bodyEmail || '').trim().toLowerCase();

    if (!email) {
      return sendError(
        res,
        400,
        'MISSING_EMAIL',
        'Email required to link account (provide email claim in token or send { email } in request body).'
      );
    }

    // If already linked, return success
    const { data: already, error: alreadyErr } = await supabase
      .from('diploma_students')
      .select('id, email, auth0_sub')
      .eq('auth0_sub', sub)
      .maybeSingle();

    if (alreadyErr) {
      console.error('Error checking existing sub link', { requestId: req.requestId, error: alreadyErr.message });
      return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to check existing link');
    }

    if (already?.id) {
      return res.json({ ok: true, linked: true, already: true, student: already });
    }

    // Find student by email
    const { data: student, error: findErr } = await supabase
      .from('diploma_students')
      .select('id, email, auth0_sub')
      .ilike('email', email)
      .maybeSingle();

    if (findErr) {
      console.error('Error finding student for link-auth0', { requestId: req.requestId, error: findErr.message });
      return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to find student');
    }

    if (!student) {
      return sendError(res, 404, 'NOT_FOUND', 'No student record matches this email');
    }

    if (student.auth0_sub) {
      if (student.auth0_sub === sub) return res.json({ ok: true, linked: true, already: true, student });
      return sendError(res, 409, 'ALREADY_LINKED', 'Student record is already linked to a different Auth0 user.');
    }

    const { data: updated, error: updErr } = await supabase
      .from('diploma_students')
      .update({ auth0_sub: sub })
      .eq('id', student.id)
      .select('id, email, auth0_sub')
      .single();

    if (updErr) {
      console.error('Error updating student auth0_sub', { requestId: req.requestId, error: updErr.message });
      return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to link Auth0 sub');
    }

    return res.json({ ok: true, linked: true, student: updated });
  } catch (e) {
    console.error('link-auth0 exception', { requestId: req.requestId, message: e?.message });
    return sendError(res, 500, 'SERVER_ERROR', 'Link failed');
  }
});

// GET /api/diploma/announcements
app.get('/api/diploma/announcements', authenticateJwt, async (req, res) => {
  const auth0Sub = req.user.sub;

  const { data: student } = await supabase
    .from('diploma_students')
    .select('cohort')
    .eq('auth0_sub', auth0Sub)
    .maybeSingle();

  const now = new Date().toISOString();

  let query = supabase
    .from('diploma_announcements')
    .select('*')
    .lte('starts_at', now)
    .or(`ends_at.is.null,ends_at.gt.${now}`);

  if (student?.cohort) {
    query = query.in('audience', ['all_diploma', `cohort_${student.cohort}`]);
  } else {
    query = query.eq('audience', 'all_diploma');
  }

  const { data, error } = await query.order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching announcements', { requestId: req.requestId, error: error.message });
    return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to fetch announcements');
  }

  return res.json(data || []);
});

// --------------------------------------------------
//  ADMIN – UPDATE / DELETE INDIVIDUAL ITEMS
// --------------------------------------------------

app.patch('/api/diploma/admin/items/:itemId', authenticateJwt, requireAdmin, async (req, res) => {
  const itemId = req.params.itemId;

  if (!itemId) return sendError(res, 400, 'BAD_REQUEST', 'Item id is required');

  const { title, body, drive_link_url, due_date, visible_to_student, item_type, status } = req.body || {};
  const update = {};

  if (title !== undefined) update.title = title;
  if (body !== undefined) update.body = body;
  if (drive_link_url !== undefined) update.drive_link_url = drive_link_url || null;
  if (due_date !== undefined) update.due_date = due_date || null;
  if (visible_to_student !== undefined) update.visible_to_student = !!visible_to_student;

  if (item_type !== undefined) {
    const allowedTypes = ['task', 'note', 'resource'];
    if (!allowedTypes.includes(item_type)) {
      return sendError(res, 400, 'BAD_REQUEST', 'item_type must be one of: task | note | resource');
    }
    update.item_type = item_type;
  }

  if (status !== undefined) {
    const allowedStatuses = ['open', 'done'];
    if (!allowedStatuses.includes(status)) {
      return sendError(res, 400, 'BAD_REQUEST', 'status must be one of: open | done');
    }
    update.status = status;
  }

  if (Object.keys(update).length === 0) {
    return sendError(res, 400, 'BAD_REQUEST', 'No fields to update');
  }

  const { data, error } = await supabase
    .from('diploma_student_items')
    .update(update)
    .eq('id', itemId)
    .select('*')
    .single();

  if (error) {
    console.error('Error updating admin student item', { requestId: req.requestId, error: error.message });
    return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to update student item');
  }

  return res.json(data);
});

app.delete('/api/diploma/admin/items/:itemId', authenticateJwt, requireAdmin, async (req, res) => {
  const itemId = req.params.itemId;
  if (!itemId) return sendError(res, 400, 'BAD_REQUEST', 'Item id is required');

  const { error } = await supabase
    .from('diploma_student_items')
    .delete()
    .eq('id', itemId);

  if (error) {
    console.error('Error deleting admin student item', { requestId: req.requestId, error: error.message });
    return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to delete student item');
  }

  return res.status(204).send();
});

// --------------------------------------------------
//  ADMIN – STUDENTS LIST
// --------------------------------------------------

app.get('/api/diploma/admin/students', authenticateJwt, requireAdmin, async (req, res) => {
  try {
    const q = String(req.query.q || req.query.query || '').trim();
    const cohort = String(req.query.cohort || '').trim();

    const wantsMeta =
      req.query.page !== undefined ||
      req.query.pageSize !== undefined ||
      req.query.sort !== undefined ||
      req.query.dir !== undefined ||
      req.query.has_binder !== undefined ||
      req.query.missing_binder !== undefined ||
      req.query.missing_auth0_sub !== undefined ||
      req.query.has_overdue !== undefined;

    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize || 25)));

    const requestedSort = String(req.query.sort || '');
    const dir = req.query.dir === 'desc' ? 'desc' : 'asc';

    const hasBinder = req.query.has_binder === '1' || req.query.has_binder === 'true';
    const missingBinder = req.query.missing_binder === '1' || req.query.missing_binder === 'true';
    const missingAuth0 = req.query.missing_auth0_sub === '1' || req.query.missing_auth0_sub === 'true';
    const hasOverdue = req.query.has_overdue === '1' || req.query.has_overdue === 'true';

    const derivedSortAllow = new Set(['items_count', 'overdue_count', 'last_activity_at']);
    const needsDerivedProcessing = hasOverdue || derivedSortAllow.has(requestedSort);

    const dbSortAllow = new Set(['full_name', 'email', 'cohort', 'created_at', 'updated_at']);
    const dbSort = dbSortAllow.has(requestedSort) ? requestedSort : 'full_name';

    let sb = supabase
      .from('diploma_students')
      .select(
        [
          'id',
          'full_name',
          'email',
          'cohort',
          'auth0_sub',
          'drive_binder_url',
          'drive_folder_url',
          'created_at',
          'updated_at',
          // ✅ NEW fields (safe for list even if UI doesn't use them yet)
          'diploma_tier',
          'has_signed_agreement',
          'invited_at',
          'last_invite_message_id',
        ].join(','),
        { count: 'exact' }
      );

    if (q) {
      const like = `%${q}%`;
      sb = sb.or(`full_name.ilike.${like},email.ilike.${like}`);
    }

    if (cohort) sb = sb.eq('cohort', cohort);

    if (hasBinder) sb = sb.not('drive_binder_url', 'is', null).neq('drive_binder_url', '');
    if (missingBinder) sb = sb.or('drive_binder_url.is.null,drive_binder_url.eq.');
    if (missingAuth0) sb = sb.or('auth0_sub.is.null,auth0_sub.eq.');

    if (!wantsMeta) {
      const { data, error } = await sb.order('full_name', { ascending: true });
      if (error) {
        console.error('Error fetching admin students (legacy)', { requestId: req.requestId, error: error.message });
        return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to fetch students');
      }
      return res.json(data || []);
    }

    if (needsDerivedProcessing) {
      const { data: rowsAll, error } = await sb.order(dbSort, { ascending: dir === 'asc' });

      if (error) {
        console.error('Error fetching admin students (derived)', { requestId: req.requestId, error: error.message });
        return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to fetch students');
      }

      const safeRows = Array.isArray(rowsAll) ? rowsAll : [];

      let merged = safeRows;
      try {
        const ids = safeRows.map((r) => r.id).filter(Boolean);

        if (ids.length > 0) {
          const { data: rollups, error: rollupError } = await supabase.rpc('admin_student_rollup', {
            student_ids: ids,
          });

          if (rollupError) {
            console.error('Rollup RPC error', { requestId: req.requestId, error: rollupError.message });
          } else {
            const map = new Map((rollups || []).map((r) => [r.student_id, r]));
            merged = safeRows.map((s) => ({
              ...s,
              ...(map.get(s.id) || { items_count: 0, overdue_count: 0, last_activity_at: null }),
            }));
          }
        }
      } catch (e) {
        console.error('Rollup merge exception', { requestId: req.requestId, message: e?.message });
      }

      if (hasOverdue) merged = merged.filter((s) => Number(s.overdue_count || 0) > 0);

      const sortKey =
        requestedSort && (dbSortAllow.has(requestedSort) || derivedSortAllow.has(requestedSort))
          ? requestedSort
          : 'full_name';

      const asc = dir === 'asc';

      merged = merged.slice().sort((a, b) => {
        const av = a?.[sortKey];
        const bv = b?.[sortKey];

        if (['created_at', 'updated_at', 'last_activity_at'].includes(sortKey)) {
          const ad = av ? new Date(av).getTime() : 0;
          const bd = bv ? new Date(bv).getTime() : 0;
          return asc ? ad - bd : bd - ad;
        }

        if (['items_count', 'overdue_count'].includes(sortKey)) {
          const an = Number(av || 0);
          const bn = Number(bv || 0);
          return asc ? an - bn : bn - an;
        }

        const as = String(av || '').toLowerCase();
        const bs = String(bv || '').toLowerCase();
        if (as < bs) return asc ? -1 : 1;
        if (as > bs) return asc ? 1 : -1;
        return 0;
      });

      const totalFiltered = merged.length;
      const start = (page - 1) * pageSize;
      const end = start + pageSize;
      const pageRows = merged.slice(start, end);

      return res.json({ rows: pageRows, total: totalFiltered, page, pageSize });
    }

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const { data: rows, error, count } = await sb
      .order(dbSort, { ascending: dir === 'asc' })
      .range(from, to);

    if (error) {
      console.error('Error fetching admin students (paged)', { requestId: req.requestId, error: error.message });
      return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to fetch students');
    }

    return res.json({ rows: rows || [], total: count || 0, page, pageSize });
  } catch (e) {
    console.error('admin/students error', { requestId: req.requestId, message: e?.message });
    return sendError(res, 500, 'SERVER_ERROR', 'Server error');
  }
});

// --------------------------------------------------
//  ADMIN – CREATE STUDENT (WITH INVITE)
// --------------------------------------------------

app.post('/api/diploma/admin/students', authenticateJwt, requireAdmin, async (req, res) => {
  try {
    const {
      full_name,
      email,
      cohort,
      drive_binder_url,
      drive_folder_url,
      auth0_sub,
      send_invite,

      // ✅ NEW fields (nullable)
      diploma_tier,
      parent_name,
      parent_mobile,
      parent_email,
      has_signed_agreement,
      signed_agreement_url,
      running_notes_url,
    } = req.body || {};

    if (!email || typeof email !== 'string' || !email.trim()) {
      return sendError(res, 400, 'BAD_REQUEST', 'Email is required');
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanName = typeof full_name === 'string' ? full_name.trim() : '';
    const cleanCohort = typeof cohort === 'string' ? cohort.trim() : null;

    if (cleanCohort && !/^\d{4}$/.test(cleanCohort)) {
      return sendError(res, 400, 'BAD_REQUEST', 'Cohort must be a 4-digit year (e.g., 2026)');
    }

    const cleanTier = cleanStringOrNull(diploma_tier);
    if (cleanTier && !ALLOWED_DIPLOMA_TIERS.has(cleanTier)) {
      return sendError(res, 400, 'BAD_REQUEST', 'Diploma Tier must be one of: Targeted | Platinum | Diamond | Ivy');
    }

    const { data: existing, error: existingErr } = await supabase
      .from('diploma_students')
      .select('id,email')
      .ilike('email', cleanEmail)
      .maybeSingle();

    if (existingErr) {
      console.error('Error checking existing student', { requestId: req.requestId, error: existingErr.message });
      return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to check existing student');
    }

    if (existing?.id) {
      return sendError(res, 409, 'ALREADY_EXISTS', 'A student with this email already exists');
    }

    const insertPayload = {
      email: cleanEmail,
      full_name: cleanName || null,
      cohort: cleanCohort,
      drive_binder_url: cleanStringOrNull(drive_binder_url),
      drive_folder_url: cleanStringOrNull(drive_folder_url),
      auth0_sub: cleanStringOrNull(auth0_sub),

      // ✅ NEW fields
      diploma_tier: cleanTier,
      parent_name: cleanStringOrNull(parent_name),
      parent_mobile: cleanStringOrNull(parent_mobile),
      parent_email: cleanLowerEmailOrNull(parent_email),
      has_signed_agreement: cleanBoolNullable(has_signed_agreement),
      signed_agreement_url: cleanStringOrNull(signed_agreement_url),
      running_notes_url: cleanStringOrNull(running_notes_url),
    };

    const { data, error } = await supabase
      .from('diploma_students')
      .insert(insertPayload)
      .select('*')
      .single();

    if (error) {
      console.error('Error creating student', { requestId: req.requestId, error: error.message });
      return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to create student');
    }

    const shouldSendInvite = send_invite === undefined ? true : !!send_invite;

    let invite = { requested: shouldSendInvite, ok: false, skipped: true };

    if (shouldSendInvite) {
      try {
        if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM) {
          invite = {
            requested: true,
            ok: false,
            skipped: true,
            reason: 'Resend not configured (missing RESEND_API_KEY or RESEND_FROM)',
          };
        } else {
          const firstName = (data?.full_name || '').trim().split(/\s+/)[0] || '';
          const sendResult = await sendWelcomeToDiplomaPortal({ toEmail: data.email, firstName });

          invite = { requested: true, ok: true, skipped: false, sendResult };

          // ✅ Persist invite status (best-effort; never blocks creation success)
          try {
            await recordInviteStatus({ studentId: data.id, sendResult });
          } catch (persistErr) {
            console.error('Failed to persist invite status', {
              requestId: req.requestId,
              studentId: data?.id,
              message: persistErr?.message,
            });
          }
        }
      } catch (e) {
        console.error('Invite send failed (non-fatal)', {
          requestId: req.requestId,
          studentId: data?.id,
          email: data?.email,
          message: e?.message,
        });
        invite = { requested: true, ok: false, skipped: false, error: e?.message || 'Invite send failed' };
      }
    }

    return res.status(201).json({ ...data, invite });
  } catch (e) {
    console.error('Create student error', { requestId: req.requestId, message: e?.message });
    return sendError(res, 500, 'SERVER_ERROR', 'Server error');
  }
});

// --------------------------------------------------
//  ADMIN – UPDATE/GET STUDENT
// --------------------------------------------------

app.patch('/api/diploma/admin/students/:id', authenticateJwt, requireAdmin, async (req, res) => {
  const id = req.params.id;

  const {
    cohort,
    drive_binder_url,
    drive_folder_url,
    full_name,
    email,
    auth0_sub,

    // ✅ NEW fields
    diploma_tier,
    parent_name,
    parent_mobile,
    parent_email,
    has_signed_agreement,
    signed_agreement_url,
    running_notes_url,
  } = req.body || {};

  const update = {};

  if (cohort !== undefined) update.cohort = cohort;
  if (drive_binder_url !== undefined) update.drive_binder_url = cleanStringOrNull(drive_binder_url);
  if (drive_folder_url !== undefined) update.drive_folder_url = cleanStringOrNull(drive_folder_url);
  if (full_name !== undefined) update.full_name = full_name;
  if (email !== undefined) update.email = typeof email === 'string' ? email.trim().toLowerCase() : email;

  if (auth0_sub !== undefined) update.auth0_sub = cleanStringOrNull(auth0_sub);

  if (diploma_tier !== undefined) {
    const t = cleanStringOrNull(diploma_tier);
    if (t && !ALLOWED_DIPLOMA_TIERS.has(t)) {
      return sendError(res, 400, 'BAD_REQUEST', 'Diploma Tier must be one of: Targeted | Platinum | Diamond | Ivy');
    }
    update.diploma_tier = t;
  }

  if (parent_name !== undefined) update.parent_name = cleanStringOrNull(parent_name);
  if (parent_mobile !== undefined) update.parent_mobile = cleanStringOrNull(parent_mobile);
  if (parent_email !== undefined) update.parent_email = cleanLowerEmailOrNull(parent_email);

  if (has_signed_agreement !== undefined) {
    update.has_signed_agreement = cleanBoolNullable(has_signed_agreement);
  }

  if (signed_agreement_url !== undefined) update.signed_agreement_url = cleanStringOrNull(signed_agreement_url);
  if (running_notes_url !== undefined) update.running_notes_url = cleanStringOrNull(running_notes_url);

  if (Object.keys(update).length === 0) {
    return sendError(res, 400, 'BAD_REQUEST', 'No fields to update');
  }

  const { data, error } = await supabase
    .from('diploma_students')
    .update(update)
    .eq('id', id)
    .select('*')
    .single();

  if (error) {
    console.error('Error updating admin student', { requestId: req.requestId, error: error.message });
    return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to update student');
  }

  return res.json(data);
});

app.get('/api/diploma/admin/students/:id', authenticateJwt, requireAdmin, async (req, res) => {
  const id = req.params.id;

  const { data, error } = await supabase
    .from('diploma_students')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !data) {
    console.error('Error fetching admin student detail', { requestId: req.requestId, error: error?.message });
    return sendError(res, 404, 'NOT_FOUND', 'Student not found');
  }

  return res.json(data);
});

app.post('/api/diploma/admin/students/:id/send-invite', authenticateJwt, requireAdmin, async (req, res) => {
  try {
    const studentId = req.params.id;

    const { data: student, error } = await supabase
      .from('diploma_students')
      .select('id, full_name, email')
      .eq('id', studentId)
      .single();

    if (error || !student) return sendError(res, 404, 'NOT_FOUND', 'Student not found');
    if (!student.email) return sendError(res, 400, 'BAD_REQUEST', 'Student has no email');

    if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM) {
      return sendError(res, 400, 'BAD_REQUEST', 'Resend not configured (missing RESEND_API_KEY or RESEND_FROM)');
    }

    const firstName = (student.full_name || '').trim().split(/\s+/)[0] || '';
    const sendResult = await sendWelcomeToDiplomaPortal({ toEmail: student.email, firstName });

    try {
      await recordInviteStatus({ studentId: student.id, sendResult });
    } catch (e) {
      console.error('Failed to persist invite status', {
        requestId: req.requestId,
        studentId: student.id,
        message: e?.message,
      });
    }

    return res.json({
      ok: true,
      sendResult,
      invited_at: new Date().toISOString(),
      last_invite_message_id: sendResult?.id ? String(sendResult.id) : null,
    });
  } catch (e) {
    console.error('send-invite error', { requestId: req.requestId, message: e?.message });
    return sendError(res, 500, 'SERVER_ERROR', e?.message || 'Invite send failed');
  }
});

// --------------------------------------------------
//  ADMIN – PER-STUDENT ITEMS
// --------------------------------------------------

app.get('/api/diploma/admin/students/:studentId/items', authenticateJwt, requireAdmin, async (req, res) => {
  const studentId = req.params.studentId;
  if (!studentId) return sendError(res, 400, 'BAD_REQUEST', 'Student id is required');

  const { data, error } = await supabase
    .from('diploma_student_items')
    .select('*')
    .eq('student_id', studentId)
    .order('due_date', { ascending: true, nullsLast: true })
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching admin student items', { requestId: req.requestId, error: error.message });
    return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to fetch student items');
  }

  return res.json(data || []);
});

app.post('/api/diploma/admin/students/:studentId/items', authenticateJwt, requireAdmin, async (req, res) => {
  const studentId = req.params.studentId;
  if (!studentId) return sendError(res, 400, 'BAD_REQUEST', 'Student id is required');

  const { item_type, title, body, drive_link_url, due_date, visible_to_student } = req.body || {};
  const allowedTypes = ['task', 'note', 'resource'];

  if (!allowedTypes.includes(item_type)) {
    return sendError(res, 400, 'BAD_REQUEST', 'item_type must be one of: task | note | resource');
  }

  if (!title || typeof title !== 'string' || !title.trim()) {
    return sendError(res, 400, 'BAD_REQUEST', 'Title is required');
  }

  const insertPayload = {
    student_id: studentId,
    item_type,
    title: title.trim(),
    body: body && typeof body === 'string' ? body.trim() : null,
    drive_link_url: drive_link_url && typeof drive_link_url === 'string' ? drive_link_url.trim() : null,
    due_date: due_date || null,
    visible_to_student: !!visible_to_student,
    created_by_admin: true,
  };

  const { data, error } = await supabase
    .from('diploma_student_items')
    .insert(insertPayload)
    .select('*')
    .single();

  if (error) {
    console.error('Error creating admin student item', { requestId: req.requestId, error: error.message });
    return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to create student item');
  }

  return res.status(201).json(data);
});

// --------------------------------------------------
//  ADMIN – ANNOUNCEMENTS
// --------------------------------------------------

app.get('/api/diploma/admin/announcements', authenticateJwt, requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('diploma_announcements')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching admin announcements', { requestId: req.requestId, error: error.message });
    return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to fetch announcements');
  }

  return res.json(data || []);
});

app.post('/api/diploma/admin/announcements', authenticateJwt, requireAdmin, async (req, res) => {
  const { title, body, drive_link_url, audience, starts_at, ends_at } = req.body || {};

  if (!title) {
    return sendError(res, 400, 'BAD_REQUEST', 'Title is required');
  }

  const nowIso = new Date().toISOString();

  const insert = {
    title: title.trim(),
    body: body?.trim() || '',
    drive_link_url: drive_link_url?.trim() || null,
    audience: audience || 'all_diploma',
    starts_at: starts_at || nowIso,
    ends_at: ends_at || null,
  };

  const { data, error } = await supabase
    .from('diploma_announcements')
    .insert(insert)
    .select('*')
    .single();

  if (error) {
    console.error('Error creating admin announcement', { requestId: req.requestId, error: error.message });
    return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to create announcement');
  }

  return res.status(201).json(data);
});

// --------------------------------------------------
//  OBSERVABILITY
// --------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    requestId: req.requestId,
    uptime: process.uptime(),
    version: process.env.RENDER_GIT_COMMIT || process.env.npm_package_version || 'unknown',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/debug/test-supabase', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('diploma_students')
      .select('id')
      .limit(1);

    if (error) {
      console.error('Supabase test error', { requestId: req.requestId, error: error.message });
      return sendError(res, 500, 'SUPABASE_ERROR', 'Supabase test failed');
    }

    return res.json({ ok: true, requestId: req.requestId, sample: data });
  } catch (err) {
    console.error('Supabase test exception', { requestId: req.requestId, message: err?.message });
    return sendError(res, 500, 'SERVER_ERROR', 'Supabase test exception');
  }
});

app.get('/', (req, res) => {
  res.json({ ok: true, requestId: req.requestId, message: 'Diploma API root is alive' });
});

// --------------------------------------------------
//  START SERVER
// --------------------------------------------------
const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Diploma API listening on port ${port}`);
});
