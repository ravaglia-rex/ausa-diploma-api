require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const jwksRsa = require('jwks-rsa');
const { createClient } = require('@supabase/supabase-js');
const allowedOrigins = [
  'https://ausa.io',
  'https://www.ausa.io',
  'http://localhost:5173', // for local dev
];
const app = express();


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

// Handle preflight explicitly (optional but helpful)
app.options('*', cors());


app.use(express.json());

// Supabase client with service role key
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Auth0 JWT verification setup
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
      console.error('JWT verify error', err);
      return res.status(401).json({ error: 'Invalid token' });
    }

    req.user = decoded; // contains sub, custom claims, etc.
    next();
  });
}

// Helper: check if user has admin role
function isAdmin(user) {
  const roles =
    user['https://ausa.io/claims/roles'] || user.roles || [];
  return Array.isArray(roles) && roles.includes('ausa_admin');
}

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
  // Optionally use cohort from student for filtering
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

  // Basic example: show all_diploma + cohort-specific
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

// Admin-only example: GET /api/diploma/students
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

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Diploma API listening on http://localhost:${port}`);
});
