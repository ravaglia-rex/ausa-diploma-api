// middleware/requireStaff.js
const { supabaseAdmin, supabaseAuth } = require('../lib/supabase');

function requireStaff(allowedRoles = ['admin', 'super_admin']) {
  return async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
      if (!token) return res.status(401).json({ error: 'Missing Authorization: Bearer <token>' });

      const { data: userData, error: userErr } = await supabaseAuth.auth.getUser(token);
      if (userErr || !userData?.user) return res.status(401).json({ error: 'Invalid token' });

      const user = userData.user;

      const { data: staff, error: staffErr } = await supabaseAdmin
        .from('staff')
        .select('user_id, role, active, email')
        .eq('user_id', user.id)
        .maybeSingle();

      if (staffErr) return res.status(500).json({ error: staffErr.message });
      if (!staff || !staff.active) return res.status(403).json({ error: 'Not an active admin' });
      if (!allowedRoles.includes(staff.role)) return res.status(403).json({ error: 'Insufficient role' });

      req.user = user;   // Supabase auth user
      req.staff = staff; // staff row
      next();
    } catch (e) {
      return res.status(500).json({ error: 'Staff auth failed' });
    }
  };
}

function requireSuperAdmin(req, res, next) {
  return requireStaff(['super_admin'])(req, res, next);
}

module.exports = { requireStaff, requireSuperAdmin };
