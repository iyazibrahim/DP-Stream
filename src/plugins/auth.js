const fp = require('fastify-plugin');

function resolveCookieSecure() {
  const mode = (process.env.COOKIE_SECURE || 'auto').toLowerCase();
  if (mode === 'true') {
    return true;
  }
  if (mode === 'false') {
    return false;
  }
  const appUrl = (process.env.APP_URL || '').toLowerCase();
  return process.env.NODE_ENV === 'production' && appUrl.startsWith('https://');
}

module.exports = fp(async function authPlugin(fastify) {
  await fastify.register(require('@fastify/jwt'), {
    secret: process.env.JWT_SECRET
  });

  fastify.decorate('createAuthToken', async function createAuthToken(user, sessionId) {
    return fastify.jwt.sign(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        pwdResetRequired: Boolean(user.must_reset_password),
        sid: sessionId
      },
      { expiresIn: process.env.JWT_EXPIRES_IN || '30m' }
    );
  });

  async function hydrateUserFromSession(payload) {
    if (!payload.sid) {
      return null;
    }

    const [rows] = await fastify.db.execute(
      `SELECT s.user_id, u.email, u.role, u.status, u.must_reset_password
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.session_id = ?
         AND s.user_id = ?
         AND s.expires_at > NOW()
       LIMIT 1`,
      [payload.sid, payload.sub]
    );

    if (!rows[0]) {
      return null;
    }

    await fastify.db.execute(
      'UPDATE sessions SET expires_at = DATE_ADD(NOW(), INTERVAL 30 MINUTE) WHERE session_id = ?',
      [payload.sid]
    );

    return rows[0];
  }

  fastify.decorate('requireAuth', async function requireAuth(request, reply) {
    try {
      const token = request.cookies.auth_token;
      if (!token) {
        return reply.redirect('/login');
      }
      const payload = await fastify.jwt.verify(token);
      const userRow = await hydrateUserFromSession(payload);
      if (!userRow || userRow.status !== 'active') {
        reply.clearCookie('auth_token', { path: '/' });
        return reply.redirect('/login');
      }

      request.user = {
        sub: userRow.user_id,
        email: userRow.email,
        role: userRow.role,
        pwdResetRequired: Boolean(userRow.must_reset_password),
        sid: payload.sid
      };

      const currentPath = request.raw.url || '';
      if (request.user.pwdResetRequired && !currentPath.startsWith('/must-reset-password') && !currentPath.startsWith('/auth/reset-password') && !currentPath.startsWith('/auth/logout')) {
        return reply.redirect('/must-reset-password');
      }
    } catch (err) {
      fastify.log.warn({ err }, 'Auth cookie verification failed in requireAuth');
      reply.clearCookie('auth_token', { path: '/' });
      return reply.redirect('/login');
    }
  });

  fastify.decorate('requireApiAuth', async function requireApiAuth(request, reply) {
    try {
      const token = request.cookies.auth_token;
      if (!token) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      const payload = await fastify.jwt.verify(token);
      const userRow = await hydrateUserFromSession(payload);
      if (!userRow || userRow.status !== 'active') {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      request.user = {
        sub: userRow.user_id,
        email: userRow.email,
        role: userRow.role,
        pwdResetRequired: Boolean(userRow.must_reset_password),
        sid: payload.sid
      };

      if (request.user.pwdResetRequired && request.routerPath !== '/auth/reset-password') {
        return reply.code(403).send({ error: 'Password reset required' });
      }
    } catch (err) {
      fastify.log.warn({ err }, 'Auth cookie verification failed in requireApiAuth');
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  fastify.decorate('optionalAuth', async function optionalAuth(request) {
    request.user = null;
    try {
      const token = request.cookies.auth_token;
      if (!token) {
        return;
      }
      const payload = await fastify.jwt.verify(token);
      const userRow = await hydrateUserFromSession(payload);
      if (!userRow || userRow.status !== 'active') {
        return;
      }
      request.user = {
        sub: userRow.user_id,
        email: userRow.email,
        role: userRow.role,
        pwdResetRequired: Boolean(userRow.must_reset_password),
        sid: payload.sid
      };
    } catch (err) {
      fastify.log.warn({ err }, 'Auth cookie verification failed in optionalAuth');
    }
  });

  fastify.decorate('requireAdmin', async function requireAdmin(request, reply) {
    await fastify.requireAuth(request, reply);
    if (reply.sent) {
      return;
    }
    if (request.user.role !== 'admin') {
      return reply.code(403).view('error.ejs', { message: 'Admin access required' });
    }
  });

  fastify.decorate('setAuthCookie', function setAuthCookie(reply, token) {
    reply.setCookie('auth_token', token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: resolveCookieSecure(),
      maxAge: 60 * 30
    });
  });
});
