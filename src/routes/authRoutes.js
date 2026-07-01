const settingsService = require('../services/settingsService');
const authService = require('../services/authService');

async function getSignupEnabled(fastify) {
  const allowSignup = await settingsService.getSetting(fastify, 'allow_public_signup');
  return allowSignup === 'true';
}

function validatePassword(password) {
  if (!password || password.length < 10) {
    return 'Password must be at least 10 characters';
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must include upper, lower, and number';
  }
  return null;
}

async function loadProfileData(fastify, userId) {
  const [rows] = await fastify.db.execute(
    `SELECT u.id, u.email, u.role, u.created_at,
            COUNT(v.id) AS completed_count
     FROM users u
     LEFT JOIN video_progress vp ON vp.user_id = u.id AND vp.completed_at IS NOT NULL
     LEFT JOIN videos v ON v.id = vp.video_id
     WHERE u.id = ?
     GROUP BY u.id
     LIMIT 1`,
    [userId]
  );

  const [completedVideos] = await fastify.db.execute(
    `SELECT v.id, v.title, v.thumbnail_path, vp.completed_at
     FROM video_progress vp
     INNER JOIN videos v ON v.id = vp.video_id
     WHERE vp.user_id = ?
       AND vp.completed_at IS NOT NULL
     ORDER BY vp.completed_at DESC`,
    [userId]
  );

  return {
    profile: rows[0] || null,
    completedVideos
  };
}

async function authRoutes(fastify) {
  fastify.post('/signup', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } }
  }, async (request, reply) => {
    const allowSignup = await settingsService.getSetting(fastify, 'allow_public_signup');
    if (allowSignup !== 'true') {
      return reply.code(403).view('auth/signup.ejs', { error: 'Registration is currently closed.', signupEnabled: false, success: null });
    }

    const { email, password } = request.body;
    const passwordError = validatePassword(password);
    if (passwordError) {
      return reply.code(400).view('auth/signup.ejs', { error: passwordError, signupEnabled: true, success: null });
    }

    const existing = await authService.findUserByEmail(fastify, email);
    if (existing) {
      return reply.code(400).view('auth/signup.ejs', { error: 'Email already in use.', signupEnabled: true, success: null });
    }

    const userId = await authService.createUser(fastify, {
      email,
      password,
      role: 'viewer',
      status: 'pending',
      mustResetPassword: false
    });

    await authService.logEvent(fastify, {
      actorUserId: userId,
      action: 'auth.signup',
      targetUserId: userId,
      metadata: { email, status: 'pending' }
    });

    return reply.view('auth/signup.ejs', {
      error: null,
      signupEnabled: true,
      success: 'Registration received. An administrator must approve your account before you can sign in.'
    });
  });

  fastify.post('/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } }
  }, async (request, reply) => {
    const { email, password } = request.body;
    const user = await authService.findUserByEmail(fastify, email);

    if (!user) {
      return reply.code(401).view('auth/login.ejs', { error: 'Invalid credentials.', signupEnabled: await getSignupEnabled(fastify) });
    }

    if (user.status === 'pending') {
      return reply.code(403).view('auth/login.ejs', {
        error: 'Your account is awaiting administrator approval.',
        signupEnabled: await getSignupEnabled(fastify)
      });
    }

    if (user.status !== 'active') {
      return reply.code(401).view('auth/login.ejs', { error: 'Invalid credentials.', signupEnabled: await getSignupEnabled(fastify) });
    }

    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      return reply.code(429).view('auth/login.ejs', { error: 'Account temporarily locked. Try again later.', signupEnabled: await getSignupEnabled(fastify) });
    }

    const ok = await authService.verifyPassword(password, user.password_hash);
    if (!ok) {
      await authService.registerFailedLogin(fastify, user.id);
      return reply.code(401).view('auth/login.ejs', { error: 'Invalid credentials.', signupEnabled: await getSignupEnabled(fastify) });
    }

    await authService.clearFailedLogin(fastify, user.id);

    const sessionId = await authService.createSession(fastify, user.id, request);
    await authService.trimSessions(fastify, user.id);

    const token = await fastify.createAuthToken(user, sessionId);
    fastify.setAuthCookie(reply, token);

    await authService.logEvent(fastify, {
      actorUserId: user.id,
      action: 'auth.login',
      targetUserId: user.id,
      metadata: { ip: request.ip, ua: request.headers['user-agent'] || 'unknown' }
    });

    if (user.must_reset_password) {
      return reply.redirect('/must-reset-password');
    }

    return reply.redirect('/videos');
  });

  fastify.post('/reset-password', { preHandler: [fastify.requireAuth] }, async (request, reply) => {
    const { newPassword } = request.body;
    const passwordError = validatePassword(newPassword);
    if (passwordError) {
      return reply.code(400).view('auth/reset-password.ejs', { user: request.user, error: passwordError, success: null });
    }

    const bcrypt = require('bcrypt');
    const hash = await bcrypt.hash(newPassword, 12);
    await fastify.db.execute(
      'UPDATE users SET password_hash = ?, must_reset_password = 0, updated_at = NOW() WHERE id = ?',
      [hash, request.user.sub]
    );

    await authService.logEvent(fastify, {
      actorUserId: request.user.sub,
      action: 'auth.password_reset',
      targetUserId: request.user.sub,
      metadata: {}
    });

    return reply.redirect('/videos?passwordChanged=1');
  });

  fastify.post('/logout', { preHandler: [fastify.requireApiAuth] }, async (request, reply) => {
    if (request.user.sid) {
      await authService.deleteSessionById(fastify, request.user.sid);
    }
    reply.clearCookie('auth_token', { path: '/' });
    return reply.redirect('/login');
  });

  fastify.post('/profile/password', { preHandler: [fastify.requireAuth] }, async (request, reply) => {
    const currentPassword = String(request.body.currentPassword || '');
    const newPassword = String(request.body.newPassword || '');
    const confirmPassword = String(request.body.confirmPassword || '');

    const user = await authService.findUserByEmail(fastify, request.user.email);
    if (!user) {
      return reply.code(404).send({ error: 'User not found' });
    }

    const currentOk = await authService.verifyPassword(currentPassword, user.password_hash);
    if (!currentOk) {
      const profileData = await loadProfileData(fastify, request.user.sub);
      return reply.code(400).view('auth/profile.ejs', {
        user: request.user,
        ...profileData,
        error: 'Current password is incorrect.',
        success: null
      });
    }

    if (newPassword !== confirmPassword) {
      const profileData = await loadProfileData(fastify, request.user.sub);
      return reply.code(400).view('auth/profile.ejs', {
        user: request.user,
        ...profileData,
        error: 'New password confirmation does not match.',
        success: null
      });
    }

    const passwordError = validatePassword(newPassword);
    if (passwordError) {
      const profileData = await loadProfileData(fastify, request.user.sub);
      return reply.code(400).view('auth/profile.ejs', {
        user: request.user,
        ...profileData,
        error: passwordError,
        success: null
      });
    }

    const bcrypt = require('bcrypt');
    const hash = await bcrypt.hash(newPassword, 12);
    await fastify.db.execute(
      'UPDATE users SET password_hash = ?, must_reset_password = 0, updated_at = NOW() WHERE id = ?',
      [hash, request.user.sub]
    );

    await authService.logEvent(fastify, {
      actorUserId: request.user.sub,
      action: 'auth.profile_password_changed',
      targetUserId: request.user.sub,
      metadata: {}
    });

    return reply.redirect('/videos?passwordChanged=1');
  });
}

module.exports = authRoutes;
