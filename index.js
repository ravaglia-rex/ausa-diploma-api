require('dotenv').config();

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const jwksRsa = require('jwks-rsa');
const { createClient } = require('@supabase/supabase-js');
const { randomUUID } = require('crypto');

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
    'X-Request-Id', // 👈 Step 1.1: allow request id header from browser
  ],
  exposedHeaders: ['X-Request-Id'], // 👈 required so the browser can READ it
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));
app.use(express.json());

// ---------- Step 1.1: Request ID middleware ----------
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

// ---------- Response helper (Step 1.3: standardized errors) ----------
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

// ---------- Auth0 JWT verification ----------
const jwksClient = jwksRsa({
  jwksUri: `https://${process.env.AUTH0_DOMAIN}/.well-known/jwks.json`,
});

function getKey(header, callback) {
  jwksClient.getSigningKey(header.kid, function (err, key) {
    const signingKey = key.getPublicKey();
    callback(err, signingKey);
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

    req.user = decoded; // contains sub, custom claims, etc.
    next();
  });
}

// ---------- Helper: admin role check ----------
function isAdmin(user) {
  const roles =
    user?.['https://ausa.io/claims/roles'] || user?.roles || [];
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
    .or('ends_at.is.null,ends_at.gt.' + now);

  if (student?.cohort) {
    query = query.in('audience', ['all_diploma', `cohort_${student.cohort}`]);
  } else {
    query = query.eq('audience', 'all_diploma');
  }

  const { data, error } = await query.order('created_at', {
    ascending: false,
  });

  if (error) {
    console.error('Error fetching announcements', {
      requestId: req.requestId,
      error: error.message,
    });
    return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to fetch announcements');
  }

  return res.json(data || []);
});

// --------------------------------------------------
//  ADMIN – UPDATE / DELETE INDIVIDUAL ITEMS
// --------------------------------------------------

// PATCH /api/diploma/admin/items/:itemId
app.patch('/api/diploma/admin/items/:itemId', authenticateJwt, requireAdmin, async (req, res) => {
  const itemId = req.params.itemId;

  if (!itemId) {
    return sendError(res, 400, 'BAD_REQUEST', 'Item id is required');
  }

  const { title, body, drive_link_url, due_date, visible_to_student, item_type } = req.body || {};
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

// DELETE /api/diploma/admin/items/:itemId
app.delete('/api/diploma/admin/items/:itemId', authenticateJwt, requireAdmin, async (req, res) => {
  const itemId = req.params.itemId;

  if (!itemId) {
    return sendError(res, 400, 'BAD_REQUEST', 'Item id is required');
  }

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
//  ADMIN ROUTES (for /diploma/admin UI)
// --------------------------------------------------

// Step 1.2: GET /api/diploma/admin/students (paginated + sortable + filterable)
// Back-compat: if caller does NOT provide paging/sort/filter params, we return an array (old behavior).
app.get('/api/diploma/admin/students', authenticateJwt, requireAdmin, async (req, res) => {
  try {
    const q = String(req.query.q || req.query.query || '').trim(); // accept both q and legacy query
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
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const sortAllow = new Set(['full_name', 'email', 'cohort', 'created_at', 'updated_at']);
    const requestedSort = String(req.query.sort || '');
    const sort = sortAllow.has(requestedSort) ? requestedSort : 'full_name';

    const dir = req.query.dir === 'desc' ? 'desc' : 'asc';

    const hasBinder = req.query.has_binder === '1' || req.query.has_binder === 'true';
    const missingBinder = req.query.missing_binder === '1' || req.query.missing_binder === 'true';
    const missingAuth0 = req.query.missing_auth0_sub === '1' || req.query.missing_auth0_sub === 'true';

    // NOTE: include updated_at if your table has it; harmless if present.
    let sb = supabase
      .from('diploma_students')
      .select(
        'id, full_name, email, cohort, auth0_sub, drive_binder_url, drive_folder_url, created_at, updated_at',
        { count: 'exact' }
      );

    if (q) {
      const like = `%${q}%`;
      sb = sb.or(`full_name.ilike.${like},email.ilike.${like}`);
    }

    if (cohort) {
      sb = sb.eq('cohort', cohort);
    }

    if (hasBinder) {
      sb = sb.not('drive_binder_url', 'is', null).neq('drive_binder_url', '');
    }

    if (missingBinder) {
      // missing = null OR empty string
      sb = sb.or('drive_binder_url.is.null,drive_binder_url.eq.');
    }

    if (missingAuth0) {
      sb = sb.or('auth0_sub.is.null,auth0_sub.eq.');
    }

    sb = sb.order(sort, { ascending: dir === 'asc' });

    // If "wantsMeta" is true, apply range pagination and return rows+total.
    if (wantsMeta) {
      const { data, error, count } = await sb.range(from, to);

      if (error) {
        console.error('Error fetching admin students (paged)', { requestId: req.requestId, error: error.message });
        return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to fetch students');
      }

      return res.json({
        rows: data || [],
        total: count || 0,
        page,
        pageSize,
      });
    }

    // Back-compat: old behavior returns array
    const { data, error } = await sb.order('full_name', { ascending: true });
    if (error) {
      console.error('Error fetching admin students (legacy)', { requestId: req.requestId, error: error.message });
      return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to fetch students');
    }

    return res.json(data || []);
  } catch (e) {
    console.error('admin/students error', { requestId: req.requestId, message: e?.message });
    return sendError(res, 500, 'SERVER_ERROR', 'Server error');
  }
});

// PATCH /api/diploma/admin/students/:id
app.patch('/api/diploma/admin/students/:id', authenticateJwt, requireAdmin, async (req, res) => {
  const id = req.params.id;
  const { cohort, drive_binder_url, drive_folder_url, full_name, email } = req.body || {};

  const update = {};
  if (cohort !== undefined) update.cohort = cohort;
  if (drive_binder_url !== undefined) update.drive_binder_url = drive_binder_url;
  if (drive_folder_url !== undefined) update.drive_folder_url = drive_folder_url;
  if (full_name !== undefined) update.full_name = full_name;
  if (email !== undefined) update.email = email;

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

// GET /api/diploma/admin/students/:id
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

// --------------------------------------------------
//  ADMIN – PER-STUDENT ITEMS
// --------------------------------------------------

// GET /api/diploma/admin/students/:studentId/items
app.get('/api/diploma/admin/students/:studentId/items', authenticateJwt, requireAdmin, async (req, res) => {
  const studentId = req.params.studentId;

  if (!studentId) {
    return sendError(res, 400, 'BAD_REQUEST', 'Student id is required');
  }

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

// POST /api/diploma/admin/students/:studentId/items
app.post('/api/diploma/admin/students/:studentId/items', authenticateJwt, requireAdmin, async (req, res) => {
  const studentId = req.params.studentId;

  if (!studentId) {
    return sendError(res, 400, 'BAD_REQUEST', 'Student id is required');
  }

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

// GET /api/diploma/admin/announcements
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

// POST /api/diploma/admin/announcements-app.post('/api/diploma/admin/announcements', cors(corsOptions), authenticateJwt, requireAdmin, async (req, res) => {
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

// Simple liveness check — does not touch Supabase
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    requestId: req.requestId,
    uptime: process.uptime(),
    version: process.env.RENDER_GIT_COMMIT || process.env.npm_package_version || 'unknown',
    timestamp: new Date().toISOString(),
  });
});

// Debug endpoint – do not expose in public docs
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

// Root (simple)
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
