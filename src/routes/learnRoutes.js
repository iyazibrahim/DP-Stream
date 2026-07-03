const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const learningItemService = require('../services/learningItemService');
const authService = require('../services/authService');

function signDocumentToken(payload) {
  const secret = process.env.JWT_SECRET;
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyDocumentToken(token) {
  const secret = process.env.JWT_SECRET;
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) {
    return null;
  }
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (expected !== sig) {
    return null;
  }
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (Date.now() > payload.exp) {
    return null;
  }
  return payload;
}

async function learnRoutes(fastify) {
  fastify.get('/', { preHandler: [fastify.optionalAuth] }, async (request, reply) => {
    const searchQuery = String(request.query.q || '').trim();
    const query = searchQuery.toLowerCase();
    const courseId = Math.max(0, Number(request.query.courseId || 0));
    const filterType = String(request.query.type || 'all');
    const likeQuery = `%${query}%`;
    const userId = request.user ? request.user.sub : 0;

    const accessClause = request.user
      ? ''
      : 'AND li.access_level = "public"';

    const [items] = await fastify.db.execute(
      `SELECT li.*,
              ip.completed_at,
              EXISTS (
                SELECT 1 FROM transcode_jobs tj
                INNER JOIN videos v ON v.id = tj.video_id
                WHERE v.id = li.video_id AND tj.status IN ('pending','processing')
              ) AS transcoding_active,
              (
                SELECT c.id FROM course_items ci
                INNER JOIN courses c ON c.id = ci.course_id
                WHERE ci.learning_item_id = li.id
                ORDER BY ci.order_index ASC LIMIT 1
              ) AS course_id,
              (
                SELECT c.name FROM course_items ci
                INNER JOIN courses c ON c.id = ci.course_id
                WHERE ci.learning_item_id = li.id
                ORDER BY ci.order_index ASC LIMIT 1
              ) AS course_name,
              (
                SELECT ci.order_index FROM course_items ci
                WHERE ci.learning_item_id = li.id
                ORDER BY ci.order_index ASC LIMIT 1
              ) AS course_order
       FROM learning_items li
       LEFT JOIN item_progress ip ON ip.learning_item_id = li.id AND ip.user_id = ?
       WHERE li.status = 'published'
         ${accessClause}
         AND (? = '' OR LOWER(li.title) LIKE ? OR LOWER(IFNULL(li.description,'')) LIKE ?)
         AND (? = 0 OR EXISTS (
           SELECT 1 FROM course_items ci2 WHERE ci2.learning_item_id = li.id AND ci2.course_id = ?
         ))
         AND (? = 'all'
           OR (? = 'videos' AND li.item_type IN ('premium_video','free_video','external_video'))
           OR (? = 'documents' AND li.item_type = 'document')
           OR (? = 'courses' AND 1 = 0))
       ORDER BY CASE WHEN li.display_order > 0 THEN li.display_order ELSE 2147483647 END ASC,
                li.published_at DESC, li.created_at DESC`,
      [userId, query, likeQuery, likeQuery, courseId, courseId, filterType, filterType, filterType, filterType]
    );

    const [courses] = await fastify.db.execute(
      `SELECT c.id, c.name, c.description, c.thumbnail_path,
              COUNT(DISTINCT CASE WHEN li.status = 'published' THEN li.id END) AS published_count,
              SUM(CASE WHEN li.item_type = 'document' AND li.status = 'published' THEN 1 ELSE 0 END) AS document_count,
              SUM(CASE WHEN li.item_type IN ('premium_video','free_video','external_video') AND li.status = 'published' THEN 1 ELSE 0 END) AS video_count
       FROM courses c
       LEFT JOIN course_items ci ON ci.course_id = c.id
       LEFT JOIN learning_items li ON li.id = ci.learning_item_id
       WHERE (? = '' OR LOWER(c.name) LIKE ? OR LOWER(IFNULL(c.description,'')) LIKE ?)
       GROUP BY c.id
       ORDER BY c.created_at DESC`,
      [query, likeQuery, likeQuery]
    );

    let selectedCourse = null;
    if (courseId > 0) {
      const [courseRows] = await fastify.db.execute(
        `SELECT c.id, c.name, c.description, c.thumbnail_path,
                COUNT(DISTINCT CASE WHEN li.status = 'published' THEN li.id END) AS published_count,
                SUM(CASE WHEN li.item_type = 'document' AND li.status = 'published' THEN 1 ELSE 0 END) AS document_count,
                SUM(CASE WHEN li.item_type IN ('premium_video','free_video','external_video') AND li.status = 'published' THEN 1 ELSE 0 END) AS video_count
         FROM courses c
         LEFT JOIN course_items ci ON ci.course_id = c.id
         LEFT JOIN learning_items li ON li.id = ci.learning_item_id
         WHERE c.id = ?
         GROUP BY c.id LIMIT 1`,
        [courseId]
      );
      selectedCourse = courseRows[0] || null;
    }

    return reply.view('learn/list.ejs', {
      user: request.user,
      items,
      courses,
      selectedCourse,
      passwordChanged: String(request.query.passwordChanged || '') === '1',
      searchQuery,
      selectedCourseId: courseId,
      filterType
    });
  });

  fastify.get('/:id', { preHandler: [fastify.optionalAuth] }, async (request, reply) => {
    const itemId = Number(request.params.id);
    const item = await learningItemService.getItemById(fastify, itemId);
    if (!item || item.status !== 'published') {
      return reply.code(404).view('error.ejs', { message: 'Content not found', user: request.user });
    }
    if (!learningItemService.canViewItem(item, request.user)) {
      return reply.view('learn/gated.ejs', { user: request.user, item });
    }

    if (item.item_type === 'premium_video' && item.video_id) {
      return reply.redirect(`/videos/${item.video_id}`);
    }

    let progress = null;
    if (request.user) {
      const [rows] = await fastify.db.execute(
        'SELECT * FROM item_progress WHERE user_id = ? AND learning_item_id = ? LIMIT 1',
        [request.user.sub, itemId]
      );
      progress = rows[0] || null;
    }

    const [courseRows] = await fastify.db.execute(
      `SELECT c.id, c.name, c.description
       FROM course_items ci
       INNER JOIN courses c ON c.id = ci.course_id
       WHERE ci.learning_item_id = ?
       ORDER BY ci.order_index ASC LIMIT 1`,
      [itemId]
    );
    const course = courseRows[0] || null;

    let playlistItems = [];
    if (course) {
      const accessClause = request.user ? '' : 'AND li.access_level = "public"';
      const [playlist] = await fastify.db.execute(
        `SELECT li.id, li.title, li.item_type, ci.order_index, ip.completed_at
         FROM course_items ci
         INNER JOIN learning_items li ON li.id = ci.learning_item_id
         LEFT JOIN item_progress ip ON ip.learning_item_id = li.id AND ip.user_id = ?
         WHERE ci.course_id = ? AND li.status = 'published' ${accessClause}
         ORDER BY ci.order_index ASC, ci.id ASC`,
        [request.user ? request.user.sub : 0, course.id]
      );
      playlistItems = playlist;
    }

    const external = item.item_type === 'external_video'
      ? learningItemService.parseExternalUrl(item.external_url)
      : null;

    await authService.logEvent(fastify, {
      actorUserId: request.user ? request.user.sub : null,
      action: 'learn.open',
      metadata: { itemId, itemType: item.item_type }
    });

    return reply.view('learn/watch.ejs', {
      user: request.user,
      item,
      progress,
      course,
      playlistItems,
      external,
      documentTokenTtlSeconds: Number(process.env.DOCUMENT_TOKEN_TTL_SECONDS || 300)
    });
  });

  fastify.get('/:id/document', { preHandler: [fastify.optionalAuth] }, async (request, reply) => {
    const itemId = Number(request.params.id);
    const item = await learningItemService.getItemById(fastify, itemId);
    if (!item || item.item_type !== 'document' || item.status !== 'published') {
      return reply.code(404).send({ error: 'Document not found' });
    }
    if (!learningItemService.canViewItem(item, request.user)) {
      return reply.code(403).send({ error: 'Sign in required' });
    }

    const token = String(request.query.token || '');
    const payload = verifyDocumentToken(token);
    if (!payload || Number(payload.itemId) !== itemId) {
      return reply.code(403).send({ error: 'Invalid or expired token' });
    }

    const absPath = path.resolve(process.cwd(), String(item.document_path || '').replace(/^\/media\//, 'media/'));
    if (!item.document_path || !fs.existsSync(absPath)) {
      return reply.code(404).send({ error: 'File missing' });
    }

    reply.header('Content-Type', item.document_mime || 'application/octet-stream');
    reply.header('Content-Disposition', `inline; filename="${item.document_filename || 'document'}"`);
    return reply.send(fs.createReadStream(absPath));
  });

  fastify.post('/:id/document-token', { preHandler: [fastify.optionalAuth] }, async (request, reply) => {
    const itemId = Number(request.params.id);
    const item = await learningItemService.getItemById(fastify, itemId);
    if (!item || item.item_type !== 'document' || !learningItemService.canViewItem(item, request.user)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const ttl = Number(process.env.DOCUMENT_TOKEN_TTL_SECONDS || 300);
    const token = signDocumentToken({ itemId, exp: Date.now() + ttl * 1000 });
    return { token, expiresIn: ttl };
  });

  fastify.get('/:id/stream', { preHandler: [fastify.optionalAuth] }, async (request, reply) => {
    const itemId = Number(request.params.id);
    const item = await learningItemService.getItemById(fastify, itemId);
    if (!item || item.item_type !== 'free_video' || !learningItemService.canViewItem(item, request.user)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const token = String(request.query.token || '');
    const payload = verifyDocumentToken(token);
    if (!payload || Number(payload.itemId) !== itemId) {
      return reply.code(403).send({ error: 'Invalid token' });
    }
    const absPath = path.resolve(process.cwd(), String(item.source_path || '').replace(/^\/media\//, 'media/'));
    if (!item.source_path || !fs.existsSync(absPath)) {
      return reply.code(404).send({ error: 'File missing' });
    }
    reply.header('Content-Type', 'video/mp4');
    return reply.send(fs.createReadStream(absPath));
  });

  fastify.post('/:id/progress', { preHandler: [fastify.requireApiAuth] }, async (request, reply) => {
    const itemId = Number(request.params.id);
    const position = Math.max(0, Number(request.body.positionSeconds || 0));
    const duration = Math.max(0, Number(request.body.durationSeconds || 0));
    await fastify.db.execute(
      `INSERT INTO item_progress (user_id, learning_item_id, last_position_seconds, duration_seconds, last_watched_at)
       VALUES (?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         last_position_seconds = VALUES(last_position_seconds),
         duration_seconds = GREATEST(duration_seconds, VALUES(duration_seconds)),
         last_watched_at = NOW(),
         updated_at = NOW()`,
      [request.user.sub, itemId, position, duration]
    );
    return { ok: true };
  });

  fastify.post('/:id/complete', { preHandler: [fastify.requireApiAuth] }, async (request, reply) => {
    const itemId = Number(request.params.id);
    await fastify.db.execute(
      `INSERT INTO item_progress (user_id, learning_item_id, completed_at, last_watched_at)
       VALUES (?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE completed_at = COALESCE(completed_at, NOW()), last_watched_at = NOW(), updated_at = NOW()`,
      [request.user.sub, itemId]
    );
    return { ok: true };
  });
}

module.exports = learnRoutes;
