require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const jwksRsa = require('jwks-rsa');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('etag', false); // 👈 disable 304/ETag for API responses

// ---------- CORS ----------
const allowedOrigins = [
  'https://ausa.io',
  'https://www.ausa.io',
  'http://localhost:5173', // for local dev
];

app.use(
  cors({
    origin(origin, callback) {
      // Allow requests with no origin (e.g. curl, Postman) and whitelisted origins
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  })
);

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
    query = query.in('audience', ['all_diploma', `cohort_${student.cohort}`]);
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
//  LEGACY ADMIN STUDENTS LIST (OPTIONAL)
//  (You can keep or remove this if unused)
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
    const { cohort, drive_binder_url, drive_folder_url, full_name, email } =
      req.body || {};

    const update = {};
    if (cohort !== undefined) update.cohort = cohort;
    if (drive_binder_url !== undefined) update.drive_binder_url = drive_binder_url;
    if (drive_folder_url !== undefined) update.drive_folder_url = drive_folder_url;
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

    const { title, body, drive_link_url, audience, starts_at, ends_at } =
      req.body || {};

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


// --------------------------------------------------
//  START SERVER
// --------------------------------------------------
const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Diploma API listening on port ${port}`);
});
