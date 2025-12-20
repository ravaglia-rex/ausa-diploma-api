// middleware/requireWebsiteStaff.js
// Purpose: gate /api/admin/* by checking public.staff using Auth0 identity (req.user.sub + email)
// Uses service-role supabase client (passed in)

function getTokenEmail(decoded) {
  return (
    decoded?.email ||
    decoded?.['https://ausa.io/email'] ||
    decoded?.['https://ausa.io/claims/email'] ||
    decoded?.['https://ausa.io/claims/email_address'] ||
    null
  );
}

function normalizeEmail(v) {
  if (!v || typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return s ? s : null;
}

module.exports = function createRequireWebsiteStaff({ supabase, sendError }) {
  return function requireWebsiteStaff(allowedRoles = ['admin', 'super_admin']) {
    return async (req, res, next) => {
      try {
        const sub = req.user?.sub || null;
        if (!sub) return sendError(res, 401, 'MISSING_SUB', 'Missing sub in token');

        const tokenEmail = normalizeEmail(getTokenEmail(req.user));

        // 1) Try lookup by auth0_sub
        let { data: staff, error } = await supabase
          .from('staff')
          .select('user_id, auth0_sub, email, role, active, created_at')
          .eq('auth0_sub', sub)
          .maybeSingle();

        if (error) {
          return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to read staff', { detail: error.message });
        }

        // 2) If not found, try auto-link by email (invite workflow)
        //    If a row exists with this email and no auth0_sub yet, link it.
        if (!staff && tokenEmail) {
          const { data: byEmail, error: emailErr } = await supabase
            .from('staff')
            .select('user_id, auth0_sub, email, role, active, created_at')
            .eq('email', tokenEmail)
            .maybeSingle();

          if (emailErr) {
            return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to read staff by email', { detail: emailErr.message });
          }

          if (byEmail && !byEmail.auth0_sub) {
            const { data: linked, error: linkErr } = await supabase
              .from('staff')
              .update({ auth0_sub: sub })
              .eq('user_id', byEmail.user_id)
              .select('user_id, auth0_sub, email, role, active, created_at')
              .single();

            if (linkErr) {
              return sendError(res, 500, 'SUPABASE_ERROR', 'Failed to link staff auth0_sub', { detail: linkErr.message });
            }

            staff = linked;
          } else {
            staff = byEmail || null;
          }
        }

        if (!staff || !staff.active) {
          return sendError(res, 403, 'FORBIDDEN', 'Admin access not enabled for this user');
        }

        {/*}
        if (allowedRoles && allowedRoles.length) {
          const role = staff.role || '';
          if (!allowedRoles.includes(role)) {
            return sendError(res, 403, 'FORBIDDEN', 'Insufficient role');
          }
        }
          */}

        req.staff = staff;
        next();
      } catch (e) {
        return sendError(res, 500, 'SERVER_ERROR', 'Staff gate failed', { detail: e?.message });
      }
    };
  };
};
