const settingsService = require('../services/settingsService');

async function pageRoutes(fastify) {
  fastify.get('/', { preHandler: [fastify.optionalAuth] }, async (request, reply) => {
    return reply.redirect('/learn');
  });

  fastify.get('/login', async (request, reply) => {
    const allowSignup = await settingsService.getSetting(fastify, 'allow_public_signup');
    return reply.view('auth/login.ejs', {
      error: null,
      signupEnabled: allowSignup === 'true'
    });
  });

  fastify.get('/signup', async (request, reply) => {
    const allowSignup = await settingsService.getSetting(fastify, 'allow_public_signup');
    return reply.view('auth/signup.ejs', {
      error: null,
      success: null,
      signupEnabled: allowSignup === 'true'
    });
  });

  fastify.get('/must-reset-password', { preHandler: [fastify.requireAuth] }, async (request, reply) => {
    return reply.view('auth/reset-password.ejs', { user: request.user, error: null, success: null });
  });

  fastify.get('/profile', { preHandler: [fastify.requireAuth] }, async (request, reply) => {
    const [rows] = await fastify.db.execute(
      `SELECT u.id, u.email, u.role, u.created_at,
              COUNT(v.id) AS completed_count
       FROM users u
       LEFT JOIN video_progress vp ON vp.user_id = u.id AND vp.completed_at IS NOT NULL
       LEFT JOIN videos v ON v.id = vp.video_id
       WHERE u.id = ?
       GROUP BY u.id
       LIMIT 1`,
      [request.user.sub]
    );

    const [completedVideos] = await fastify.db.execute(
      `SELECT v.id, v.title, v.thumbnail_path, vp.completed_at
       FROM video_progress vp
       INNER JOIN videos v ON v.id = vp.video_id
       WHERE vp.user_id = ?
         AND vp.completed_at IS NOT NULL
       ORDER BY vp.completed_at DESC`,
      [request.user.sub]
    );

    return reply.view('auth/profile.ejs', {
      user: request.user,
      profile: rows[0] || null,
      completedVideos,
      error: null,
      success: null
    });
  });
}

module.exports = pageRoutes;
