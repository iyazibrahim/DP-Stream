const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const authService = require('../services/authService');

const playbackBindingCache = new Map();
const playbackBindingCacheTtlMs = Math.max(1000, Number(process.env.PLAYBACK_BINDING_CACHE_TTL_MS || 20000));
const playbackBindingSweepIntervalMs = Math.max(10000, Number(process.env.PLAYBACK_BINDING_CACHE_SWEEP_MS || 60000));
const playbackBindingSweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of playbackBindingCache.entries()) {
    if (!entry || now >= entry.expiresAt) {
      playbackBindingCache.delete(key);
    }
  }
}, playbackBindingSweepIntervalMs);
if (typeof playbackBindingSweepTimer.unref === 'function') {
  playbackBindingSweepTimer.unref();
}

function signToken(payload) {
  const secret = process.env.JWT_SECRET;
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function getPlaybackTokenGraceSeconds() {
  return Math.max(0, Number(process.env.PLAYBACK_TOKEN_GRACE_SECONDS || 30));
}

function verifyToken(token, graceSeconds) {
  const secret = process.env.JWT_SECRET;
  const [body, sig] = token.split('.');
  if (!body || !sig) {
    return null;
  }
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (expected !== sig) {
    return null;
  }
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  const graceMs = Math.max(0, Number(graceSeconds || 0)) * 1000;
  if (Date.now() > payload.exp + graceMs) {
    return null;
  }
  return payload;
}

async function verifyPlaybackBinding(fastify, request, token, payload, graceSeconds) {
  const grace = Math.max(0, Number(graceSeconds || 0));
  const [rows] = await fastify.db.execute(
    `SELECT id
     FROM playback_tokens
     WHERE token_hash = SHA2(?, 256)
       AND user_id = ?
       AND video_id = ?
       AND UNIX_TIMESTAMP(expires_at) > UNIX_TIMESTAMP(NOW()) - ?
       AND ip_address = ?
       AND user_agent = ?
     LIMIT 1`,
    [token, payload.userId, payload.videoId, grace, request.ip, request.headers['user-agent'] || 'unknown']
  );
  return Boolean(rows[0]);
}

function playbackBindingCacheKey(request, payload, token) {
  return [
    String(token || ''),
    String(payload.userId || ''),
    String(payload.videoId || ''),
    String(request.ip || ''),
    String(request.headers['user-agent'] || 'unknown')
  ].join('|');
}

async function verifyPlaybackBindingCached(fastify, request, token, payload, graceSeconds) {
  const key = playbackBindingCacheKey(request, payload, token);
  const now = Date.now();
  const cached = playbackBindingCache.get(key);
  if (cached && now < cached.expiresAt) {
    return true;
  }

  const ok = await verifyPlaybackBinding(fastify, request, token, payload, graceSeconds);
  if (!ok) {
    playbackBindingCache.delete(key);
    return false;
  }

  const tokenExpiresAt = Number(payload.exp || 0);
  const ttlBound = tokenExpiresAt > now ? Math.min(playbackBindingCacheTtlMs, tokenExpiresAt - now) : playbackBindingCacheTtlMs;
  playbackBindingCache.set(key, { expiresAt: now + Math.max(1000, ttlBound) });
  return true;
}

async function videoRoutes(fastify) {
  fastify.get('/', { preHandler: [fastify.optionalAuth] }, async (request, reply) => {
    const qs = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
    return reply.redirect('/learn' + qs);
  });

  fastify.get('/:id', { preHandler: [fastify.requireAuth] }, async (request, reply) => {
    const [rows] = await fastify.db.execute(
      `SELECT v.id, v.title, v.description, v.thumbnail_path, v.status,
              vp.completed_at,
              COALESCE(vp.last_position_seconds, 0) AS last_position_seconds,
              COALESCE(vp.duration_seconds, 0) AS duration_seconds,
              (
                SELECT c.id
                FROM course_videos cv
                INNER JOIN courses c ON c.id = cv.course_id
                WHERE cv.video_id = v.id
                ORDER BY cv.order_index ASC, cv.id ASC
                LIMIT 1
              ) AS course_id,
              (
                SELECT c.name
                FROM course_videos cv
                INNER JOIN courses c ON c.id = cv.course_id
                WHERE cv.video_id = v.id
                ORDER BY cv.order_index ASC, cv.id ASC
                LIMIT 1
              ) AS course_name,
              (
                SELECT c.description
                FROM course_videos cv
                INNER JOIN courses c ON c.id = cv.course_id
                WHERE cv.video_id = v.id
                ORDER BY cv.order_index ASC, cv.id ASC
                LIMIT 1
              ) AS course_description,
              EXISTS (
                SELECT 1 FROM transcode_jobs tj
                WHERE tj.video_id = v.id AND tj.status IN ('pending','processing')
              ) AS transcoding_active
       FROM videos v
       LEFT JOIN video_progress vp ON vp.video_id = v.id AND vp.user_id = ?
       WHERE v.id = ?
       LIMIT 1`,
      [request.user.sub, request.params.id]
    );
    const video = rows[0];
    if (!video || video.status !== 'published') {
      return reply.code(404).view('error.ejs', { message: 'Video not found.' });
    }

    await authService.logEvent(fastify, {
      actorUserId: request.user.sub,
      action: 'video.open',
      metadata: { videoId: video.id, ip: request.ip }
    });

    let playlistItems = [];
    if (video.course_id) {
      const [items] = await fastify.db.execute(
        `SELECT v.id, v.title, v.thumbnail_path,
                vp.completed_at,
                cv.order_index
         FROM course_videos cv
         INNER JOIN videos v ON v.id = cv.video_id
         LEFT JOIN video_progress vp ON vp.video_id = v.id AND vp.user_id = ?
         WHERE cv.course_id = ?
           AND v.status = "published"
         ORDER BY cv.order_index ASC, v.created_at ASC`,
        [request.user.sub, video.course_id]
      );
      playlistItems = items;
    }

    return reply.view('videos/watch.ejs', {
      user: request.user,
      video,
      playlistItems,
      playbackTokenTtlSeconds: Math.max(60, Number(process.env.PLAYBACK_TOKEN_TTL_SECONDS || 1200)),
      progressSaveIntervalSeconds: Math.max(5, Number(process.env.PROGRESS_SAVE_INTERVAL_SECONDS || 15)),
      initialProgressSeconds: Math.max(0, Number(video.last_position_seconds || 0))
    });
  });

  fastify.get('/:id/progress', { preHandler: [fastify.requireApiAuth] }, async (request, reply) => {
    const [videoRows] = await fastify.db.execute(
      'SELECT id FROM videos WHERE id = ? AND status = "published" LIMIT 1',
      [request.params.id]
    );
    if (!videoRows[0]) {
      return reply.code(404).send({ error: 'Video not found' });
    }

    const [rows] = await fastify.db.execute(
      `SELECT last_position_seconds, duration_seconds, completed_at
       FROM video_progress
       WHERE user_id = ? AND video_id = ?
       LIMIT 1`,
      [request.user.sub, request.params.id]
    );

    const progress = rows[0] || {};
    return {
      positionSeconds: Number(progress.last_position_seconds || 0),
      durationSeconds: Number(progress.duration_seconds || 0),
      completedAt: progress.completed_at || null
    };
  });

  fastify.post('/:id/progress', { preHandler: [fastify.requireApiAuth] }, async (request, reply) => {
    const [videoRows] = await fastify.db.execute(
      'SELECT id FROM videos WHERE id = ? AND status = "published" LIMIT 1',
      [request.params.id]
    );
    if (!videoRows[0]) {
      return reply.code(404).send({ error: 'Video not found' });
    }

    const positionSeconds = Math.max(0, Math.floor(Number((request.body && request.body.positionSeconds) || 0)));
    const durationSecondsRaw = Number((request.body && request.body.durationSeconds) || 0);
    const durationSeconds = Number.isFinite(durationSecondsRaw) && durationSecondsRaw > 0
      ? Math.floor(durationSecondsRaw)
      : 0;
    const completeRatio = Math.min(0.99, Math.max(0.5, Number(process.env.PROGRESS_COMPLETE_RATIO || 0.95)));
    const completedByRatio = durationSeconds > 0 && positionSeconds / durationSeconds >= completeRatio;
    const completed = Boolean(request.body && request.body.completed) || completedByRatio;

    await fastify.db.execute(
      `INSERT INTO video_progress (user_id, video_id, last_position_seconds, duration_seconds, completed_at, last_watched_at)
       VALUES (?, ?, ?, ?, CASE WHEN ? THEN NOW() ELSE NULL END, NOW())
       ON DUPLICATE KEY UPDATE
         last_position_seconds = GREATEST(last_position_seconds, VALUES(last_position_seconds)),
         duration_seconds = GREATEST(IFNULL(duration_seconds, 0), VALUES(duration_seconds)),
         completed_at = CASE WHEN completed_at IS NOT NULL OR ? THEN NOW() ELSE NULL END,
         last_watched_at = NOW(),
         updated_at = NOW()`,
      [request.user.sub, request.params.id, positionSeconds, durationSeconds, completed ? 1 : 0, completed ? 1 : 0]
    );

    const [rows] = await fastify.db.execute(
      `SELECT last_position_seconds, duration_seconds, completed_at
       FROM video_progress
       WHERE user_id = ? AND video_id = ?
       LIMIT 1`,
      [request.user.sub, request.params.id]
    );

    const progress = rows[0] || {};
    return {
      ok: true,
      positionSeconds: Number(progress.last_position_seconds || positionSeconds),
      durationSeconds: Number(progress.duration_seconds || durationSeconds),
      completedAt: progress.completed_at || null
    };
  });

  fastify.post('/:id/complete', { preHandler: [fastify.requireApiAuth] }, async (request, reply) => {
    const [rows] = await fastify.db.execute('SELECT id FROM videos WHERE id = ? LIMIT 1', [request.params.id]);
    if (!rows[0]) {
      return reply.code(404).send({ error: 'Video not found' });
    }

    const durationSecondsRaw = Number((request.body && request.body.durationSeconds) || 0);
    const durationSeconds = Number.isFinite(durationSecondsRaw) && durationSecondsRaw > 0
      ? Math.floor(durationSecondsRaw)
      : 0;

    await fastify.db.execute(
      `INSERT INTO video_progress (user_id, video_id, last_position_seconds, duration_seconds, completed_at, last_watched_at)
       VALUES (?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         completed_at = NOW(),
         last_position_seconds = GREATEST(last_position_seconds, VALUES(last_position_seconds)),
         duration_seconds = GREATEST(IFNULL(duration_seconds, 0), VALUES(duration_seconds)),
         last_watched_at = NOW(),
         updated_at = NOW()`,
      [request.user.sub, request.params.id, durationSeconds, durationSeconds]
    );

    await authService.logEvent(fastify, {
      actorUserId: request.user.sub,
      action: 'video.completed',
      metadata: { videoId: Number(request.params.id) }
    });

    return { ok: true };
  });

  fastify.post('/:id/token', { preHandler: [fastify.requireApiAuth] }, async (request, reply) => {
    const [rows] = await fastify.db.execute('SELECT id FROM videos WHERE id = ? AND status = "published" LIMIT 1', [request.params.id]);
    if (!rows[0]) {
      return reply.code(404).send({ error: 'Video not found' });
    }

    const ttlSeconds = Math.max(60, Number(process.env.PLAYBACK_TOKEN_TTL_SECONDS || 1200));
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const token = signToken({
      videoId: Number(request.params.id),
      userId: request.user.sub,
      ua: request.headers['user-agent'] || '',
      exp: expiresAt
    });

    await fastify.db.execute(
      'INSERT INTO playback_tokens (token_hash, user_id, video_id, expires_at, ip_address, user_agent) VALUES (SHA2(?, 256), ?, ?, FROM_UNIXTIME(?), ?, ?)',
      [token, request.user.sub, request.params.id, Math.floor(expiresAt / 1000), request.ip, request.headers['user-agent'] || 'unknown']
    );

    return { token, expiresAt };
  });

  fastify.get('/stream/:videoId/master.m3u8', async (request, reply) => {
    const token = request.query.token;
    const tokenGraceSeconds = getPlaybackTokenGraceSeconds();
    const payload = verifyToken(token || '', tokenGraceSeconds);
    if (!payload || payload.videoId !== Number(request.params.videoId)) {
      return reply.code(403).send('Forbidden');
    }
    if ((request.headers['user-agent'] || '') !== (payload.ua || '')) {
      return reply.code(403).send('Forbidden');
    }
    const bindingOk = await verifyPlaybackBindingCached(fastify, request, token, payload, tokenGraceSeconds);
    if (!bindingOk) {
      return reply.code(403).send('Forbidden');
    }

    const masterPath = path.resolve(process.cwd(), process.env.HLS_DIR || './media/hls', String(request.params.videoId), 'master.m3u8');
    if (!fs.existsSync(masterPath)) {
      return reply.code(404).send('Not found');
    }

    let content = fs.readFileSync(masterPath, 'utf8');
    content = content
      .split('\n')
      .map((line) => {
        if (line.endsWith('/index.m3u8')) {
          return `${line}?token=${encodeURIComponent(token)}`;
        }
        return line;
      })
      .join('\n');

    reply.header('Content-Type', 'application/vnd.apple.mpegurl');
    return reply.send(content);
  });

  fastify.get('/stream/:videoId/:profile/index.m3u8', async (request, reply) => {
    const token = request.query.token;
    const tokenGraceSeconds = getPlaybackTokenGraceSeconds();
    const payload = verifyToken(token || '', tokenGraceSeconds);
    if (!payload || payload.videoId !== Number(request.params.videoId)) {
      return reply.code(403).send('Forbidden');
    }
    if ((request.headers['user-agent'] || '') !== (payload.ua || '')) {
      return reply.code(403).send('Forbidden');
    }
    const bindingOk = await verifyPlaybackBindingCached(fastify, request, token, payload, tokenGraceSeconds);
    if (!bindingOk) {
      return reply.code(403).send('Forbidden');
    }

    const playlistPath = path.resolve(process.cwd(), process.env.HLS_DIR || './media/hls', String(request.params.videoId), request.params.profile, 'index.m3u8');
    if (!fs.existsSync(playlistPath)) {
      return reply.code(404).send('Not found');
    }

    let content = fs.readFileSync(playlistPath, 'utf8');
    content = content
      .split('\n')
      .map((line) => {
        if (line.endsWith('.ts')) {
          return `${line}?token=${encodeURIComponent(token)}`;
        }
        return line;
      })
      .join('\n');

    reply.header('Content-Type', 'application/vnd.apple.mpegurl');
    return reply.send(content);
  });

  fastify.get('/stream/:videoId/:profile/:segment', async (request, reply) => {
    const token = request.query.token;
    const tokenGraceSeconds = getPlaybackTokenGraceSeconds();
    const payload = verifyToken(token || '', tokenGraceSeconds);
    if (!payload || payload.videoId !== Number(request.params.videoId)) {
      return reply.code(403).send('Forbidden');
    }
    if ((request.headers['user-agent'] || '') !== (payload.ua || '')) {
      return reply.code(403).send('Forbidden');
    }
    const bindingOk = await verifyPlaybackBindingCached(fastify, request, token, payload, tokenGraceSeconds);
    if (!bindingOk) {
      return reply.code(403).send('Forbidden');
    }

    const tsPath = path.resolve(process.cwd(), process.env.HLS_DIR || './media/hls', String(request.params.videoId), request.params.profile, request.params.segment);
    if (!fs.existsSync(tsPath)) {
      return reply.code(404).send('Not found');
    }

    reply.header('Cache-Control', process.env.HLS_SEGMENT_CACHE_CONTROL || 'public, max-age=86400, s-maxage=86400');
    reply.header('Content-Type', 'video/mp2t');
    return reply.send(fs.createReadStream(tsPath));
  });
}

module.exports = videoRoutes;
