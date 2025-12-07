require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const jwksRsa = require('jwks-rsa');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('etag', false); // disable 304/ETag for API responses

// ---------- CORS ----------
// Very permissive CORS while we debug front-end calls.
// (We can tighten this later to specific origins.)
const corsOptions = {
  origin: true,       // reflect request origin
  credentials: true,  // allow cookies / auth headers
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Authorization',
    'Content-Type',
    'Accept',
    'X-Requested-With',
  ],
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));
// 🔧 Handle preflight OPTIONS for ALL paths using a RegExp,
// so we don't go through path-to-regexp's string parser.
app.options(/.*/, cors(corsOptions));

app.use(express.json());


// ---------- Supabase client (service role) ----------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
    return res.status(401).json({ error: 'Missing token' });
  }

  const options = {
    audience: process.env.AUTH0_AUDIENCE,
    issuer: `https://${process.env.AUTH0_DOMAIN}/`,
    algorithms: ['RS256'],
  };

  jwt.verify(token, getKey, options, (err, decoded) => {
    if (err) {
      console.error('JWT verify error:', err.name, err.message);
      return res.status(401).json({ error: 'Invalid token' });
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

  if (error) {
    console.error('Error fetching diploma student', error);
    return res.status(404).json({ error: 'Diploma student not found' });
  }

  res.json(student);
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
    return res.status(404).json({ error: 'Diploma student not found' });
  }

  const { data: items, error: itemsError } = await supabase
    .from('diploma_student_items')
    .select('*')
    .eq('student_id', student.id)
    .eq('visible_to_student', true)
    .order('created_at', { ascending: false });

  if (itemsError) {
    console.error('Error fetching student items', itemsError);
    return res.status(500).json({ error: 'Failed to fetch items' });
  }

  res.json(items);
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
    query = query.in('audience', [
      'all_diploma',
      `cohort_${student.cohort}`,
    ]);
  } else {
    query = query.eq('audience', 'all_diploma');
  }

  const { data, error } = await query.order('created_at', {
    ascending: false,
  });

  if (error) {
    console.error('Error fetching announcements', error);
    return res.status(500).json({ error: 'Failed to fetch announcements' });
  }

  res.json(data);
});


// --------------------------------------------------
//  ADMIN – UPDATE / DELETE INDIVIDUAL ITEMS (Phase 1.3)
// --------------------------------------------------

// PATCH /api/diploma/admin/items/:itemId
app.patch(
  '/api/diploma/admin/items/:itemId',
  authenticateJwt,
  async (req, res) => {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: 'Admin role required' });
    }

    const itemId = req.params.itemId; // UUID string

    if (!itemId) {
      return res.status(400).json({ error: 'Item id is required' });
    }

    const {
      title,
      body,
      drive_link_url,
      due_date,
      visible_to_student,
      item_type,
    } = req.body || {};

    const update = {};

    if (title !== undefined) update.title = title;
    if (body !== undefined) update.body = body;
    if (drive_link_url !== undefined)
      update.drive_link_url = drive_link_url || null;
    if (due_date !== undefined) update.due_date = due_date || null;
    if (visible_to_student !== undefined)
      update.visible_to_student = !!visible_to_student;

    if (item_type !== undefined) {
      const allowedTypes = ['task', 'note', 'resource'];
      if (!allowedTypes.includes(item_type)) {
        return res.status(400).json({
          error: 'item_type must be one of: task | note | resource',
        });
      }
      update.item_type = item_type;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    try {
      const { data, error } = await supabase
        .from('diploma_student_items')
        .update(update)
        .eq('id', itemId)
        .select('*')
        .single();

      if (error) {
        console.error('Error updating admin student item', error);
        return res
          .status(500)
          .json({ error: 'Failed to update student item' });
      }

      return res.json(data);
    } catch (err) {
      console.error('Unexpected error updating student item', err);
      return res.status(500).json({
        error: 'Unexpected server error updating student item',
      });
    }
  }
);

// DELETE /api/diploma/admin/items/:itemId
app.delete(
  '/api/diploma/admin/items/:itemId',
  authenticateJwt,
  async (req, res) => {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: 'Admin role required' });
    }

    const itemId = req.params.itemId; // UUID string

    if (!itemId) {
      return res.status(400).json({ error: 'Item id is required' });
    }

    try {
      const { error } = await supabase
        .from('diploma_student_items')
        .delete()
        .eq('id', itemId);

      if (error) {
        console.error('Error deleting admin student item', error);
        return res
          .status(500)
          .json({ error: 'Failed to delete student item' });
      }

      return res.status(204).send();
    } catch (err) {
      console.error('Unexpected error deleting student item', err);
      return res.status(500).json({
        error: 'Unexpected server error deleting student item',
      });
    }
  }
);


// --------------------------------------------------
//  LEGACY ADMIN STUDENTS LIST (OPTIONAL)
// --------------------------------------------------

// GET /api/diploma/students  (admin-only)
app.get('/api/diploma/students', authenticateJwt, async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: 'Admin role required' });
  }

  const { data, error } = await supabase
    .from('diploma_students')
    .select('*')
    .order('full_name');

  if (error) {
    console.error('Error fetching students', error);
    return res.status(500).json({ error: 'Failed to fetch students' });
  }

  res.json(data);
});

// --------------------------------------------------
//  ADMIN ROUTES (for /diploma/admin UI)
// --------------------------------------------------

// GET /api/diploma/admin/students
app.get('/api/diploma/admin/students', authenticateJwt, async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: 'Admin role required' });
  }

  const { query = '', cohort = '' } = req.query;

  let sb = supabase
    .from('diploma_students')
    .select('id, full_name, email, cohort, auth0_sub, created_at')
    .order('full_name', { ascending: true });

  if (query) {
    const q = `%${query}%`;
    sb = sb.or(`full_name.ilike.${q},email.ilike.${q}`);
  }

  if (cohort) {
    sb = sb.eq('cohort', cohort);
  }

  const { data, error } = await sb;

  if (error) {
    console.error('Error fetching admin students', error);
    return res.status(500).json({ error: 'Failed to fetch students' });
  }

  res.json(data || []);
});

// PATCH /api/diploma/admin/students/:id
app.patch(
  '/api/diploma/admin/students/:id',
  authenticateJwt,
  async (req, res) => {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: 'Admin role required' });
    }

    const id = req.params.id;
    const {
      cohort,
      drive_binder_url,
      drive_folder_url,
      full_name,
      email,
    } = req.body || {};

    const update = {};
    if (cohort !== undefined) update.cohort = cohort;
    if (drive_binder_url !== undefined)
      update.drive_binder_url = drive_binder_url;
    if (drive_folder_url !== undefined)
      update.drive_folder_url = drive_folder_url;
    if (full_name !== undefined) update.full_name = full_name;
    if (email !== undefined) update.email = email;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    try {
      const { data, error } = await supabase
        .from('diploma_students')
        .update(update)
        .eq('id', id)
        .select('*')
        .single();

      if (error) {
        console.error('Error updating admin student', error);
        return res.status(500).json({ error: 'Failed to update student' });
      }

      return res.json(data);
    } catch (err) {
      console.error('Unexpected error updating student', err);
      return res
        .status(500)
        .json({ error: 'Unexpected server error updating student' });
    }
  }
);

// GET /api/diploma/admin/students/:id
app.get(
  '/api/diploma/admin/students/:id',
  authenticateJwt,
  async (req, res) => {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: 'Admin role required' });
    }

    const id = req.params.id;

    const { data, error } = await supabase
      .from('diploma_students')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      console.error('Error fetching admin student detail', error);
      return res.status(404).json({ error: 'Student not found' });
    }

    res.json(data);
  }
);

// --------------------------------------------------
//  ADMIN – PER-STUDENT ITEMS (Phase 1.1–1.2)
// --------------------------------------------------

// GET /api/diploma/admin/students/:studentId/items
app.get(
  '/api/diploma/admin/students/:studentId/items',
  authenticateJwt,
  async (req, res) => {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: 'Admin role required' });
    }

    const studentId = req.params.studentId; // UUID string

    if (!studentId) {
      return res.status(400).json({ error: 'Student id is required' });
    }

    const { data, error } = await supabase
      .from('diploma_student_items')
      .select('*')
      .eq('student_id', studentId)
      .order('due_date', { ascending: true, nullsLast: true })
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching admin student items', error);
      return res
        .status(500)
        .json({ error: 'Failed to fetch student items' });
    }

    res.json(data || []);
  }
);

// POST /api/diploma/admin/students/:studentId/items
app.post(
  '/api/diploma/admin/students/:studentId/items',
  authenticateJwt,
  async (req, res) => {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: 'Admin role required' });
    }

    const studentId = req.params.studentId; // UUID string

    if (!studentId) {
      return res.status(400).json({ error: 'Student id is required' });
    }

    const {
      item_type,
      title,
      body,
      drive_link_url,
      due_date,
      visible_to_student,
    } = req.body || {};

    const allowedTypes = ['task', 'note', 'resource'];

    if (!allowedTypes.includes(item_type)) {
      return res.status(400).json({
        error: 'item_type must be one of: task | note | resource',
      });
    }

    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'Title is required' });
    }

    const insertPayload = {
      student_id: studentId,
      item_type,
      title: title.trim(),
      body: body && typeof body === 'string' ? body.trim() : null,
      drive_link_url:
        drive_link_url && typeof drive_link_url === 'string'
          ? drive_link_url.trim()
          : null,
      due_date: due_date || null, // expect 'YYYY-MM-DD' or null
      visible_to_student: !!visible_to_student,
      created_by_admin: true,
    };

    const { data, error } = await supabase
      .from('diploma_student_items')
      .insert(insertPayload)
      .select('*')
      .single();

    if (error) {
      console.error('Error creating admin student item', error);
      return res
        .status(500)
        .json({ error: 'Failed to create student item' });
    }

    res.status(201).json(data);
  }
);

// --------------------------------------------------
//  ADMIN – ANNOUNCEMENTS
// --------------------------------------------------

// GET /api/diploma/admin/announcements
app.get(
  '/api/diploma/admin/announcements',
  authenticateJwt,
  async (req, res) => {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: 'Admin role required' });
    }

    const { data, error } = await supabase
      .from('diploma_announcements')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching admin announcements', error);
      return res.status(500).json({ error: 'Failed to fetch announcements' });
    }

    res.json(data || []);
  }
);

// POST /api/diploma/admin/announcements
app.post(
  '/api/diploma/admin/announcements',
  authenticateJwt,
  async (req, res) => {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: 'Admin role required' });
    }

    const {
      title,
      body,
      drive_link_url,
      audience,
      starts_at,
      ends_at,
    } = req.body || {};

    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }

    const nowIso = new Date().toISOString();

    const insert = {
      title,
      body: body || '',
      drive_link_url: drive_link_url || null,
      audience: audience || 'all_diploma',
      starts_at: starts_at || nowIso,
      ends_at: ends_at || null,
    };

    try {
      const { data, error } = await supabase
        .from('diploma_announcements')
        .insert(insert)
        .select('*')
        .single();

      if (error) {
        console.error('Error creating admin announcement', error);
        return res.status(500).json({ error: 'Failed to create announcement' });
      }

      return res.status(201).json(data);
    } catch (err) {
      console.error('Unexpected error creating announcement', err);
      return res
        .status(500)
        .json({ error: 'Unexpected server error creating announcement' });
    }
  }
);

// DEBUG: test Supabase connectivity
app.get('/api/debug/test-supabase', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('diploma_students')
      .select('id')
      .limit(1);

    if (error) {
      console.error('Supabase test error', error);
      return res.status(500).json({ error });
    }

    res.json({ ok: true, sample: data });
  } catch (err) {
    console.error('Supabase test exception', err);
    res.status(500).json({ error: err.message });
  }
});


// Simple health check
app.get('/', (req, res) => {
  res.json({ ok: true, message: 'Diploma API root is alive' });
});

// Existing debug route is fine too:
app.get('/api/debug/test-supabase', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('diploma_students')
      .select('id')
      .limit(1);

    if (error) {
      console.error('Supabase test error', error);
      return res.status(500).json({ error });
    }

    res.json({ ok: true, sample: data });
  } catch (err) {
    console.error('Supabase test exception', err);
    res.status(500).json({ error: err.message });
  }
});



// --------------------------------------------------
//  START SERVER
// --------------------------------------------------
const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Diploma API listening on port ${port}`);
});
