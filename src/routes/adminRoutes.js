const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { nanoid } = require('nanoid');

const authService = require('../services/authService');
const settingsService = require('../services/settingsService');
const videoService = require('../services/videoService');
const mediaPathsService = require('../services/mediaPathsService');
const learningItemService = require('../services/learningItemService');

const PAGE_SIZE = 25;
const VIDEO_PAGE_SIZE = 10;
const ALLOWED_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi']);

function isStrongPassword(password) {
  if (!password || password.length < 10) {
    return false;
  }
  return /[A-Z]/.test(password) && /[a-z]/.test(password) && /[0-9]/.test(password);
}

function parseTags(value) {
  return String(value || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 12)
    .join(',');
}

function getSafeVideoExtension(fileName, mimeType) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  const mime = String(mimeType || '').toLowerCase();
  const hasAllowedExt = ALLOWED_VIDEO_EXTENSIONS.has(ext);
  const hasAllowedMime = !mime || mime.startsWith('video/') || mime === 'application/octet-stream';
  if (!hasAllowedExt || !hasAllowedMime) {
    return null;
  }
  return ext;
}

function toRelativeMediaPath(absPath) {
  const mediaRoot = path.resolve(process.cwd(), 'media');
  const rel = path.relative(mediaRoot, absPath).replace(/\\/g, '/');
  return `/media/${rel}`;
}

async function saveFilePart(part, absPath) {
  await new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(absPath);
    part.file.pipe(writeStream);
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });
}

function safeUploadId(uploadKey) {
  return crypto.createHash('sha1').update(String(uploadKey || '')).digest('hex');
}

function removeMediaFileIfExists(mediaPath) {
  if (!mediaPath || !String(mediaPath).startsWith('/media/')) {
    return;
  }
  const fileAbsPath = path.resolve(process.cwd(), String(mediaPath).replace('/media/', 'media/'));
  if (fs.existsSync(fileAbsPath)) {
    fs.rmSync(fileAbsPath, { force: true });
  }
}

function getDirectorySizeBytes(targetDir) {
  if (!targetDir || !fs.existsSync(targetDir)) {
    return 0;
  }
  const stat = fs.statSync(targetDir);
  if (stat.isFile()) {
    return stat.size;
  }
  const entries = fs.readdirSync(targetDir, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const child = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      total += getDirectorySizeBytes(child);
    } else if (entry.isFile()) {
      total += fs.statSync(child).size;
    }
  }
  return total;
}

function resumableRootDir() {
  return path.resolve(process.cwd(), 'media/uploads/.resumable');
}

function resumableMetaPath(uploadId) {
  return path.join(resumableRootDir(), uploadId, 'meta.json');
}

function resumableChunkPath(uploadId, index) {
  return path.join(resumableRootDir(), uploadId, `chunk_${index}.part`);
}

function readResumableMeta(uploadId) {
  const metaPath = resumableMetaPath(uploadId);
  if (!fs.existsSync(metaPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
}

function writeResumableMeta(uploadId, meta) {
  const dir = path.dirname(resumableMetaPath(uploadId));
  videoService.ensureDir(dir);
  fs.writeFileSync(resumableMetaPath(uploadId), JSON.stringify(meta, null, 2));
}

async function createVideoAndQueueJob(fastify, params) {
  const [res] = await fastify.db.execute(
    'INSERT INTO videos (title, description, thumbnail_path, tags, status, uploaded_by) VALUES (?, ?, ?, ?, "processing", ?)',
    [params.title, params.description || null, params.thumbnailPath || null, params.tags || null, params.userId]
  );

  const videoId = res.insertId;
  const outputDir = mediaPathsService.getHlsOutputDir(videoId);
  const sourceSize = fs.existsSync(params.uploadPath) ? fs.statSync(params.uploadPath).size : 0;

  await fastify.db.execute(
    'INSERT INTO video_files (video_id, file_type, file_path, profile, size_bytes) VALUES (?, "upload-source", ?, "source", ?)',
    [videoId, params.uploadPath, sourceSize]
  );

  const [jobRes] = await fastify.db.execute(
    'INSERT INTO transcode_jobs (video_id, upload_path, output_path, status) VALUES (?, ?, ?, "pending")',
    [videoId, params.uploadPath, outputDir]
  );

  transcodeJobService.queueTranscodeJob(fastify, jobRes.insertId, params.userId);

  await learningItemService.createPremiumLearningItem(fastify, {
    title: params.title,
    description: params.description,
    thumbnailPath: params.thumbnailPath,
    tags: params.tags,
    videoId,
    userId: params.userId,
    accessLevel: params.accessLevel || 'authenticated'
  });

  await authService.logEvent(fastify, {
    actorUserId: params.userId,
    action: 'admin.video_uploaded',
    targetUserId: null,
    metadata: { videoId, title: params.title }
  });

  return { videoId, jobId: jobRes.insertId };
}

async function adminRoutes(fastify) {
  fastify.get('/', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const activeTab = ['users', 'upload', 'videos', 'courses', 'monitor'].includes(request.query.tab) ? request.query.tab : 'videos';
    const userPage = Math.max(1, Number(request.query.userPage || 1));
    const userQuery = String(request.query.userQuery || '').trim();
    const userOffset = (userPage - 1) * PAGE_SIZE;

    const videoStatusFilter = ['processing', 'published', 'hidden', 'failed'].includes(request.query.status) ? request.query.status : '';
    const videoSort = ['newest', 'oldest', 'title', 'status'].includes(request.query.sort) ? request.query.sort : 'newest';
    const videoTag = String(request.query.tag || '').trim().toLowerCase();
    const videoQuery = String(request.query.videoQuery || '').trim();
    const videoPage = Math.max(1, Number(request.query.videoPage || 1));

    const videoFilters = [];
    const videoParams = [];
    if (videoStatusFilter) {
      videoFilters.push('v.status = ?');
      videoParams.push(videoStatusFilter);
    }
    if (videoTag) {
      videoFilters.push('LOWER(IFNULL(v.tags, "")) LIKE ?');
      videoParams.push(`%${videoTag}%`);
    }
    if (videoQuery) {
      videoFilters.push('(LOWER(v.title) LIKE ? OR LOWER(IFNULL(v.description, "")) LIKE ?)');
      videoParams.push(`%${videoQuery.toLowerCase()}%`, `%${videoQuery.toLowerCase()}%`);
    }

    const sortSql = {
      newest: 'v.created_at DESC',
      oldest: 'v.created_at ASC',
      title: 'v.title ASC',
      status: 'v.status ASC, v.created_at DESC'
    }[videoSort];

    const whereSql = videoFilters.length ? `WHERE ${videoFilters.join(' AND ')}` : '';

    const [videoCountRows] = await fastify.db.execute(
      `SELECT COUNT(*) AS total
       FROM videos v
       ${whereSql}`,
      videoParams
    );
    const totalVideos = Number(videoCountRows[0]?.total || 0);
    const totalVideoPages = Math.max(1, Math.ceil(totalVideos / VIDEO_PAGE_SIZE));
    const safeVideoOffset = Math.max(0, (videoPage - 1) * VIDEO_PAGE_SIZE);

    const [videos] = await fastify.db.execute(
      `SELECT v.*,
              tj.status AS job_status,
              tj.last_error AS job_error,
              tj.attempts AS job_attempts
       FROM videos v
       LEFT JOIN (
         SELECT j1.*
         FROM transcode_jobs j1
         INNER JOIN (
           SELECT video_id, MAX(id) AS max_id FROM transcode_jobs GROUP BY video_id
         ) j2 ON j1.video_id = j2.video_id AND j1.id = j2.max_id
       ) tj ON tj.video_id = v.id
       ${whereSql}
       ORDER BY ${sortSql}
       LIMIT ${VIDEO_PAGE_SIZE} OFFSET ${safeVideoOffset}`,
      videoParams
    );

    const [sourceFileRows] = await fastify.db.execute(
      `SELECT video_id, file_path
       FROM video_files
       WHERE file_type = 'upload-source'`
    );
    const sourcePathByVideoId = new Map(sourceFileRows.map((row) => [row.video_id, row.file_path]));
    const videosWithRepair = videos.map((video) => {
      const sourcePath = sourcePathByVideoId.get(video.id);
      const repair = mediaPathsService.getVideoRepairState(video.id, sourcePath);
      return {
        ...video,
        repair_state: repair.state,
        repair_message: repair.message,
        can_repair: repair.canRepair
      };
    });

    const [allVideos] = await fastify.db.execute('SELECT id, title FROM videos ORDER BY created_at DESC');

    const userWhere = userQuery ? 'WHERE LOWER(u.email) LIKE ?' : '';
    const userParams = userQuery ? [`%${userQuery.toLowerCase()}%`] : [];
    const [userCountRows] = await fastify.db.execute(
      `SELECT COUNT(*) AS total FROM users u ${userWhere}`,
      userParams
    );
    const totalUsers = Number(userCountRows[0]?.total || 0);
    const totalUserPages = Math.max(1, Math.ceil(totalUsers / PAGE_SIZE));

    const safeLimit = Math.max(1, Math.min(PAGE_SIZE, 100));
    const safeOffset = Math.max(0, userOffset);

    const [users] = await fastify.db.execute(
      `SELECT u.id, u.email, u.role, u.status, u.must_reset_password, u.failed_login_attempts, u.locked_until, u.created_at,
              COUNT(vp.id) AS completed_count
       FROM users u
       LEFT JOIN video_progress vp ON vp.user_id = u.id AND vp.completed_at IS NOT NULL
       ${userWhere}
       GROUP BY u.id
       ORDER BY u.created_at DESC
       LIMIT ${safeLimit} OFFSET ${safeOffset}`,
      userParams
    );

    const [pendingUsers] = await fastify.db.execute(
      `SELECT id, email, created_at
       FROM users
       WHERE status = 'pending'
       ORDER BY created_at ASC`
    );

    const [anomalyAlerts] = await fastify.db.execute(
      `SELECT u.id AS user_id, u.email,
              COUNT(DISTINCT JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.ip'))) AS ip_count,
              MAX(a.created_at) AS last_seen
       FROM audit_logs a
       INNER JOIN users u ON u.id = a.actor_user_id
       WHERE a.action = 'auth.login'
         AND a.created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)
       GROUP BY u.id, u.email
       HAVING ip_count >= 3
       ORDER BY ip_count DESC, last_seen DESC
       LIMIT 20`
    );

    const [courses] = await fastify.db.execute('SELECT * FROM courses ORDER BY created_at DESC');
    const [courseItems] = await fastify.db.execute(
      `SELECT ci.id, ci.course_id, ci.learning_item_id, ci.order_index,
              li.title, li.item_type
       FROM course_items ci
       INNER JOIN learning_items li ON li.id = ci.learning_item_id
       ORDER BY ci.course_id ASC, ci.order_index ASC`
    );

    const [allLearningItems] = await fastify.db.execute(
      `SELECT id, title, item_type, status FROM learning_items ORDER BY created_at DESC`
    );

    const [learningItems] = await fastify.db.execute(
      `SELECT li.*,
              tj.status AS job_status,
              tj.last_error AS job_error,
              tj.attempts AS job_attempts
       FROM learning_items li
       LEFT JOIN videos v ON v.id = li.video_id
       LEFT JOIN (
         SELECT j1.*
         FROM transcode_jobs j1
         INNER JOIN (
           SELECT video_id, MAX(id) AS max_id FROM transcode_jobs GROUP BY video_id
         ) j2 ON j1.video_id = j2.video_id AND j1.id = j2.max_id
       ) tj ON tj.video_id = li.video_id
       WHERE li.item_type != 'premium_video' OR li.video_id IS NOT NULL
       ORDER BY li.created_at DESC
       LIMIT 50`
    );

    const [monitorRows] = await fastify.db.execute(
      `SELECT
         (SELECT COUNT(*) FROM users) AS total_users,
         (SELECT COUNT(*) FROM videos) AS total_videos,
         (SELECT COUNT(*) FROM videos WHERE status = 'published') AS published_videos,
         (SELECT COUNT(*) FROM video_progress WHERE completed_at IS NOT NULL) AS total_completions,
         (SELECT COUNT(*) FROM audit_logs WHERE action = 'video.open' AND created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)) AS stream_events_1h,
         (SELECT COUNT(*) FROM playback_tokens WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)) AS token_issued_1h`
    );

    const monitor = monitorRows[0] || {};
    const mem = process.memoryUsage();
    const cpuLoad = os.loadavg()[0] || 0;
    let diskTotalGb = 0;
    let diskFreeGb = 0;
    let diskUsedGb = 0;
    let diskUsedPercent = 0;
    let uploadStorageGb = 0;
    let hlsStorageGb = 0;
    let thumbnailsStorageGb = 0;
    let totalMediaGb = 0;
    try {
      const mediaRoot = path.resolve(process.cwd(), 'media');
      const stat = fs.statfsSync(mediaRoot);
      diskTotalGb = Math.round((stat.blocks * stat.bsize) / (1024 * 1024 * 1024));
      diskFreeGb = Math.round((stat.bfree * stat.bsize) / (1024 * 1024 * 1024));
      diskUsedGb = Math.max(0, diskTotalGb - diskFreeGb);
      diskUsedPercent = diskTotalGb > 0 ? Math.round((diskUsedGb / diskTotalGb) * 100) : 0;

      const uploadRoot = path.resolve(process.cwd(), process.env.UPLOAD_DIR || './media/uploads');
      const hlsRoot = path.resolve(process.cwd(), process.env.HLS_DIR || './media/hls');
      const thumbsRoot = path.resolve(process.cwd(), 'media/thumbnails');

      const uploadBytes = getDirectorySizeBytes(uploadRoot);
      const hlsBytes = getDirectorySizeBytes(hlsRoot);
      const thumbsBytes = getDirectorySizeBytes(thumbsRoot);

      uploadStorageGb = Math.round((uploadBytes / (1024 * 1024 * 1024)) * 100) / 100;
      hlsStorageGb = Math.round((hlsBytes / (1024 * 1024 * 1024)) * 100) / 100;
      thumbnailsStorageGb = Math.round((thumbsBytes / (1024 * 1024 * 1024)) * 100) / 100;
      totalMediaGb = Math.round(((uploadBytes + hlsBytes + thumbsBytes) / (1024 * 1024 * 1024)) * 100) / 100;
    } catch (e) {
      diskTotalGb = 0;
      diskFreeGb = 0;
      diskUsedGb = 0;
      diskUsedPercent = 0;
      uploadStorageGb = 0;
      hlsStorageGb = 0;
      thumbnailsStorageGb = 0;
      totalMediaGb = 0;
    }

    const allowSignup = await settingsService.getSetting(fastify, 'allow_public_signup');

    const [publishedVideosForOrder] = await fastify.db.execute(
      `SELECT id, title, thumbnail_path
       FROM videos
       WHERE status = 'published'
       ORDER BY CASE WHEN display_order > 0 THEN display_order ELSE 2147483647 END ASC,
                published_at DESC, created_at DESC`
    );

    return reply.view('admin/dashboard.ejs', {
      user: request.user,
      videos: videosWithRepair,
      users,
      pendingUsers,
      anomalyAlerts,
      courses,
      courseItems,
      allLearningItems,
      learningItems,
      allVideos,
      allowSignup: allowSignup === 'true',
      activeTab,
      userPage,
      totalUserPages,
      videoPage,
      totalVideoPages,
      userQuery,
      videoFilters: {
        status: videoStatusFilter,
        sort: videoSort,
        tag: videoTag,
        videoQuery
      },
      monitor: {
        ...monitor,
        cpuLoad: cpuLoad.toFixed(2),
        memoryMb: Math.round(mem.rss / (1024 * 1024)),
        diskUsedGb,
        diskTotalGb,
        diskFreeGb,
        diskUsedPercent,
        uploadStorageGb,
        hlsStorageGb,
        thumbnailsStorageGb,
        totalMediaGb,
        diskWarning: diskUsedPercent >= 80
      },
      publishedVideosForOrder
    });
  });

  fastify.get('/videos/order-list', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const [rows] = await fastify.db.execute(
      `SELECT id, title, thumbnail_path
       FROM videos
       WHERE status = 'published'
       ORDER BY CASE WHEN display_order > 0 THEN display_order ELSE 2147483647 END ASC,
                published_at DESC, created_at DESC`
    );
    return { ok: true, videos: rows };
  });

  fastify.post('/videos/reorder', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const ids = Array.isArray((request.body || {}).ids) ? request.body.ids : [];
    if (!ids.length) {
      return reply.code(400).send({ error: 'ids array is required' });
    }
    const conn = await fastify.db.getConnection();
    try {
      await conn.beginTransaction();
      for (let i = 0; i < ids.length; i += 1) {
        const id = Number(ids[i]);
        if (!Number.isFinite(id) || id < 1) continue;
        await conn.execute('UPDATE videos SET display_order = ? WHERE id = ?', [i + 1, id]);
        await conn.execute('UPDATE learning_items SET display_order = ? WHERE video_id = ?', [i + 1, id]);
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    await authService.logEvent(fastify, {
      actorUserId: request.user.sub,
      action: 'admin.video_reorder',
      targetUserId: null,
      metadata: { ids }
    });
    return { ok: true };
  });

  fastify.post('/settings/signup-toggle', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const enabled = String(request.body.enabled) === 'true' ? 'true' : 'false';
    await settingsService.setSetting(fastify, 'allow_public_signup', enabled);
    await authService.logEvent(fastify, {
      actorUserId: request.user.sub,
      action: 'admin.signup_toggle',
      metadata: { enabled }
    });
    return reply.redirect('/admin?tab=users');
  });

  fastify.post('/users/create', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const { email, password, role } = request.body;
    const existing = await authService.findUserByEmail(fastify, email);
    if (existing) {
      return reply.code(400).send({ error: 'Email already exists' });
    }

    const userId = await authService.createUser(fastify, {
      email,
      password,
      role: role === 'admin' ? 'admin' : 'viewer',
      mustResetPassword: true,
      createdBy: request.user.sub
    });

    await authService.logEvent(fastify, {
      actorUserId: request.user.sub,
      action: 'admin.user_created',
      targetUserId: userId,
      metadata: { email, role }
    });

    return reply.redirect('/admin?tab=users');
  });

  fastify.post('/users/:id/approve', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const userId = Number(request.params.id);
    const [rows] = await fastify.db.execute('SELECT id, status FROM users WHERE id = ? LIMIT 1', [userId]);
    if (!rows[0] || rows[0].status !== 'pending') {
      return reply.redirect('/admin?tab=users');
    }
    await fastify.db.execute('UPDATE users SET status = "active", updated_at = NOW() WHERE id = ?', [userId]);
    await authService.logEvent(fastify, {
      actorUserId: request.user.sub,
      action: 'admin.user_approved',
      targetUserId: userId,
      metadata: {}
    });
    return reply.redirect('/admin?tab=users');
  });

  fastify.post('/users/:id/reject', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const userId = Number(request.params.id);
    const [rows] = await fastify.db.execute('SELECT id, status FROM users WHERE id = ? LIMIT 1', [userId]);
    if (!rows[0] || rows[0].status !== 'pending') {
      return reply.redirect('/admin?tab=users');
    }
    await authService.deleteSessionsByUser(fastify, userId);
    await fastify.db.execute('DELETE FROM users WHERE id = ? AND status = "pending"', [userId]);
    await authService.logEvent(fastify, {
      actorUserId: request.user.sub,
      action: 'admin.user_rejected',
      targetUserId: userId,
      metadata: {}
    });
    return reply.redirect('/admin?tab=users');
  });

  fastify.post('/users/:id/disable', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    await fastify.db.execute('UPDATE users SET status = "disabled", updated_at = NOW() WHERE id = ?', [request.params.id]);
    await authService.deleteSessionsByUser(fastify, Number(request.params.id));
    await authService.logEvent(fastify, {
      actorUserId: request.user.sub,
      action: 'admin.user_disabled',
      targetUserId: Number(request.params.id),
      metadata: {}
    });
    return reply.redirect('/admin?tab=users');
  });

  fastify.post('/users/:id/enable', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    await fastify.db.execute('UPDATE users SET status = "active", updated_at = NOW() WHERE id = ?', [request.params.id]);
    await authService.logEvent(fastify, {
      actorUserId: request.user.sub,
      action: 'admin.user_enabled',
      targetUserId: Number(request.params.id),
      metadata: {}
    });
    return reply.redirect('/admin?tab=users');
  });

  fastify.post('/users/:id/force-logout', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    await authService.deleteSessionsByUser(fastify, Number(request.params.id));
    await authService.logEvent(fastify, {
      actorUserId: request.user.sub,
      action: 'admin.user_force_logout',
      targetUserId: Number(request.params.id),
      metadata: {}
    });
    return reply.redirect('/admin?tab=users');
  });

  fastify.post('/users/:id/reset-password', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const userId = Number(request.params.id);
    const password = String(request.body.password || '').trim();
    if (!isStrongPassword(password)) {
      return reply.code(400).send({ error: 'Password must be at least 10 chars with upper/lower/number.' });
    }

    const hash = await bcrypt.hash(password, 12);
    await fastify.db.execute(
      'UPDATE users SET password_hash = ?, must_reset_password = 1, failed_login_attempts = 0, locked_until = NULL, updated_at = NOW() WHERE id = ?',
      [hash, userId]
    );
    await authService.deleteSessionsByUser(fastify, userId);
    await authService.logEvent(fastify, {
      actorUserId: request.user.sub,
      action: 'admin.user_password_reset',
      targetUserId: userId,
      metadata: {}
    });
    return reply.redirect('/admin?tab=users');
  });

  fastify.post('/videos/upload', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const uploadDir = path.resolve(process.cwd(), process.env.UPLOAD_DIR || './media/uploads');
    const hlsRoot = path.resolve(process.cwd(), process.env.HLS_DIR || './media/hls');
    const thumbsDir = path.resolve(process.cwd(), 'media/thumbnails');
    videoService.ensureDir(uploadDir);
    videoService.ensureDir(hlsRoot);
    videoService.ensureDir(thumbsDir);

    const fields = {};
    let videoFilename = '';
    let uploadPath = null;
    let thumbnailPath = null;
    let invalidVideoError = null;
    const videoUid = nanoid(12);

    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if ((part.fieldname === 'videoFile' || part.fieldname === 'file') && part.filename && !uploadPath) {
          const ext = getSafeVideoExtension(part.filename, part.mimetype);
          if (!ext) {
            invalidVideoError = 'Only video files are allowed (.mp4, .mov, .mkv, .webm, .m4v, .avi).';
            part.file.resume();
            continue;
          }
          videoFilename = part.filename;
          uploadPath = path.join(uploadDir, `${videoUid}${ext}`);
          await saveFilePart(part, uploadPath);
        } else if (part.fieldname === 'thumbnailFile' && part.filename) {
          if (part.mimetype && part.mimetype.startsWith('image/')) {
            const ext = path.extname(part.filename || '').toLowerCase() || '.jpg';
            const thumbName = `${videoUid}_${Date.now()}${ext}`;
            const thumbAbsPath = path.join(thumbsDir, thumbName);
            await saveFilePart(part, thumbAbsPath);
            thumbnailPath = toRelativeMediaPath(thumbAbsPath);
          } else {
            part.file.resume();
          }
        } else {
          part.file.resume();
        }
      } else {
        fields[part.fieldname] = part.value;
      }
    }

    if (invalidVideoError) {
      return reply.code(400).send({ error: invalidVideoError });
    }

    if (!uploadPath || !videoFilename) {
      return reply.code(400).send({ error: 'A valid video file is required.' });
    }

    const title = (fields.title || path.parse(videoFilename).name).trim();
    const description = (fields.description || '').trim();
    const tags = parseTags(fields.tags);

    const created = await createVideoAndQueueJob(fastify, {
      title,
      description,
      thumbnailPath,
      tags,
      uploadPath,
      userId: request.user.sub
    });

    const wantsJson =
      request.query.ajax === '1' ||
      (request.headers.accept || '').includes('application/json') ||
      String(request.headers['x-requested-with'] || '').toLowerCase() === 'xmlhttprequest';

    if (wantsJson) {
      return { ok: true, videoId: created.videoId, jobId: created.jobId, statusUrl: `/admin/videos/${created.videoId}/status` };
    }
    return reply.redirect('/admin?tab=videos');
  });

  fastify.post('/uploads/resumable/init', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const body = request.body || {};
    const fileName = String(body.fileName || '').trim();
    const mimeType = String(body.mimeType || '').trim();
    const title = String(body.title || '').trim() || path.parse(fileName || 'video').name;
    const description = String(body.description || '').trim();
    const tags = parseTags(body.tags);
    const fileSize = Math.max(0, Number(body.fileSize || 0));
    const totalChunks = Math.max(1, Number(body.totalChunks || 1));
    const uploadKeyRaw = String(body.uploadKey || `${fileName}-${fileSize}-${totalChunks}`);

    const ext = getSafeVideoExtension(fileName, mimeType);
    if (!ext) {
      return reply.code(400).send({ error: 'Only video files are allowed (.mp4, .mov, .mkv, .webm, .m4v, .avi).' });
    }

    const uploadId = safeUploadId(uploadKeyRaw);
    const meta = {
      uploadId,
      fileName,
      mimeType,
      extension: ext,
      title,
      description,
      tags,
      fileSize,
      totalChunks,
      uploadedBy: request.user.sub,
      createdAt: new Date().toISOString()
    };

    writeResumableMeta(uploadId, meta);

    const dir = path.join(resumableRootDir(), uploadId);
    const uploadedChunks = [];
    if (fs.existsSync(dir)) {
      for (let i = 0; i < totalChunks; i += 1) {
        if (fs.existsSync(resumableChunkPath(uploadId, i))) {
          uploadedChunks.push(i);
        }
      }
    }

    return { ok: true, uploadId, uploadedChunks, totalChunks };
  });

  fastify.get('/uploads/resumable/:uploadId/status', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const uploadId = String(request.params.uploadId || '').trim();
    const meta = readResumableMeta(uploadId);
    if (!meta) {
      return reply.code(404).send({ error: 'Upload session not found' });
    }

    const uploadedChunks = [];
    for (let i = 0; i < Number(meta.totalChunks || 0); i += 1) {
      if (fs.existsSync(resumableChunkPath(uploadId, i))) {
        uploadedChunks.push(i);
      }
    }

    return { ok: true, uploadId, uploadedChunks, totalChunks: meta.totalChunks };
  });

  fastify.post('/uploads/resumable/:uploadId/chunk', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const uploadId = String(request.params.uploadId || '').trim();
    const chunkIndex = Math.max(0, Number(request.query.index || 0));
    const meta = readResumableMeta(uploadId);
    if (!meta) {
      return reply.code(404).send({ error: 'Upload session not found' });
    }

    let chunkSaved = false;
    const chunkAbs = resumableChunkPath(uploadId, chunkIndex);
    for await (const part of request.parts()) {
      if (part.type === 'file' && part.fieldname === 'chunk') {
        if (chunkSaved) {
          part.file.resume();
          continue;
        }
        await saveFilePart(part, chunkAbs);
        chunkSaved = true;
      } else if (part.type === 'file') {
        part.file.resume();
      }
    }

    if (!chunkSaved) {
      return reply.code(400).send({ error: 'Chunk file is required' });
    }

    return { ok: true, uploadId, chunkIndex };
  });

  fastify.post('/uploads/resumable/:uploadId/complete', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const uploadId = String(request.params.uploadId || '').trim();
    const meta = readResumableMeta(uploadId);
    if (!meta) {
      return reply.code(404).send({ error: 'Upload session not found' });
    }

    const totalChunks = Number(meta.totalChunks || 0);
    for (let i = 0; i < totalChunks; i += 1) {
      if (!fs.existsSync(resumableChunkPath(uploadId, i))) {
        return reply.code(400).send({ error: `Missing chunk ${i}` });
      }
    }

    // Parse optional thumbnail sent as multipart FormData
    const thumbsDir = path.resolve(process.cwd(), 'media/thumbnails');
    videoService.ensureDir(thumbsDir);
    let thumbnailPath = null;
    if (request.isMultipart()) {
      for await (const part of request.parts()) {
        if (part.type === 'file' && part.fieldname === 'thumbnailFile' && part.filename
            && part.mimetype && part.mimetype.startsWith('image/')) {
          const ext = path.extname(part.filename || '').toLowerCase() || '.jpg';
          const thumbName = `upload_${uploadId}_${Date.now()}${ext}`;
          const thumbAbsPath = path.join(thumbsDir, thumbName);
          await saveFilePart(part, thumbAbsPath);
          thumbnailPath = toRelativeMediaPath(thumbAbsPath);
        } else if (part.type === 'file') {
          part.file.resume();
        }
      }
    }

    const uploadDir = path.resolve(process.cwd(), process.env.UPLOAD_DIR || './media/uploads');
    videoService.ensureDir(uploadDir);

    const finalExt = ALLOWED_VIDEO_EXTENSIONS.has(String(meta.extension || '').toLowerCase())
      ? String(meta.extension || '').toLowerCase()
      : getSafeVideoExtension(meta.fileName, meta.mimeType);
    if (!finalExt) {
      return reply.code(400).send({ error: 'Upload type is no longer valid.' });
    }

    const uploadPath = path.join(uploadDir, `${nanoid(12)}${finalExt}`);
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(uploadPath);
      let index = 0;

      function appendNext() {
        if (index >= totalChunks) {
          out.end();
          return;
        }
        const chunkPath = resumableChunkPath(uploadId, index);
        const inStream = fs.createReadStream(chunkPath);
        inStream.on('error', reject);
        inStream.on('end', () => {
          index += 1;
          appendNext();
        });
        inStream.pipe(out, { end: false });
      }

      out.on('finish', resolve);
      out.on('error', reject);
      appendNext();
    });

    const created = await createVideoAndQueueJob(fastify, {
      title: meta.title,
      description: meta.description,
      thumbnailPath,
      tags: meta.tags,
      uploadPath,
      userId: request.user.sub
    });

    const dir = path.join(resumableRootDir(), uploadId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    return { ok: true, videoId: created.videoId, jobId: created.jobId, statusUrl: `/admin/videos/${created.videoId}/status` };
  });

  fastify.post('/videos/:id/update', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const videoId = Number(request.params.id);
    const [rows] = await fastify.db.execute('SELECT id, thumbnail_path FROM videos WHERE id = ? LIMIT 1', [videoId]);
    if (!rows[0]) {
      return reply.code(404).send({ error: 'Video not found' });
    }

    const current = rows[0];
    const thumbsDir = path.resolve(process.cwd(), 'media/thumbnails');
    videoService.ensureDir(thumbsDir);

    const fields = {};
    let savedThumbnailPath = null;
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (part.fieldname === 'thumbnailFile' && part.filename && part.mimetype && part.mimetype.startsWith('image/')) {
          const ext = path.extname(part.filename || '').toLowerCase() || '.jpg';
          const thumbName = `video_${videoId}_${Date.now()}${ext}`;
          const thumbAbsPath = path.join(thumbsDir, thumbName);
          await saveFilePart(part, thumbAbsPath);
          savedThumbnailPath = toRelativeMediaPath(thumbAbsPath);
        } else {
          part.file.resume();
        }
      } else {
        fields[part.fieldname] = part.value;
      }
    }

    let nextThumbnail = current.thumbnail_path;
    if (String(fields.removeThumbnail) === 'true') {
      nextThumbnail = null;
    }
    if (savedThumbnailPath) {
      nextThumbnail = savedThumbnailPath;
    }

    await fastify.db.execute(
      'UPDATE videos SET title = ?, description = ?, tags = ?, thumbnail_path = ?, updated_at = NOW() WHERE id = ?',
      [(fields.title || '').trim(), (fields.description || '').trim() || null, parseTags(fields.tags) || null, nextThumbnail, videoId]
    );

    await learningItemService.updateLearningItemMetadata(fastify, videoId, {
      title: (fields.title || '').trim(),
      description: (fields.description || '').trim() || null,
      thumbnailPath: nextThumbnail,
      tags: parseTags(fields.tags) || null
    });

    await authService.logEvent(fastify, {
      actorUserId: request.user.sub,
      action: 'admin.video_updated',
      metadata: { videoId }
    });

    return reply.redirect('/admin?tab=videos');
  });

  fastify.post('/videos/:id/delete', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const videoId = Number(request.params.id);
    const [rows] = await fastify.db.execute('SELECT id, thumbnail_path FROM videos WHERE id = ? LIMIT 1', [videoId]);
    if (!rows[0]) {
      return reply.redirect('/admin?tab=videos');
    }

    const hlsDir = path.resolve(process.cwd(), process.env.HLS_DIR || './media/hls', String(videoId));
    if (fs.existsSync(hlsDir)) {
      fs.rmSync(hlsDir, { recursive: true, force: true });
    }

    removeMediaFileIfExists(rows[0].thumbnail_path);

    const [sourceRows] = await fastify.db.execute(
      'SELECT file_path FROM video_files WHERE video_id = ? AND file_type = "upload-source"',
      [videoId]
    );
    for (const row of sourceRows) {
      if (row.file_path && fs.existsSync(row.file_path)) {
        fs.rmSync(row.file_path, { force: true });
      }
    }

    await fastify.db.execute('DELETE FROM video_progress WHERE video_id = ?', [videoId]);
    await fastify.db.execute('DELETE FROM course_videos WHERE video_id = ?', [videoId]);
    await learningItemService.deleteLearningItemByVideoId(fastify, videoId);
    await fastify.db.execute('DELETE FROM playback_tokens WHERE video_id = ?', [videoId]);
    await fastify.db.execute('DELETE FROM transcode_jobs WHERE video_id = ?', [videoId]);
    await fastify.db.execute('DELETE FROM video_files WHERE video_id = ?', [videoId]);
    await fastify.db.execute('DELETE FROM videos WHERE id = ?', [videoId]);

    await authService.logEvent(fastify, {
      actorUserId: request.user.sub,
      action: 'admin.video_deleted',
      metadata: { videoId }
    });

    return reply.redirect('/admin?tab=videos');
  });

  fastify.post('/videos/:id/publish', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const videoId = Number(request.params.id);
    await fastify.db.execute('UPDATE videos SET status = "published", published_at = NOW() WHERE id = ?', [videoId]);
    await learningItemService.syncVideoStatusToLearningItem(fastify, videoId, 'published', new Date());
    return reply.redirect('/admin?tab=videos');
  });

  fastify.post('/videos/:id/unpublish', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const videoId = Number(request.params.id);
    await fastify.db.execute('UPDATE videos SET status = "hidden" WHERE id = ?', [videoId]);
    await learningItemService.syncVideoStatusToLearningItem(fastify, videoId, 'hidden', null);
    return reply.redirect('/admin?tab=videos');
  });

  fastify.get('/videos/:id/status', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const videoId = Number(request.params.id);
    const [rows] = await fastify.db.execute(
      `SELECT v.id, v.status,
              tj.status AS job_status,
              tj.last_error,
              tj.attempts
       FROM videos v
       LEFT JOIN (
         SELECT j1.*
         FROM transcode_jobs j1
         INNER JOIN (
           SELECT video_id, MAX(id) AS max_id FROM transcode_jobs GROUP BY video_id
         ) j2 ON j1.video_id = j2.video_id AND j1.id = j2.max_id
       ) tj ON tj.video_id = v.id
       WHERE v.id = ?
       LIMIT 1`,
      [videoId]
    );
    if (!rows[0]) {
      return reply.code(404).send({ error: 'Video not found' });
    }
    return rows[0];
  });

  fastify.get('/uploads/active', { preHandler: [fastify.requireAdmin] }, async () => {
    const [rows] = await fastify.db.execute(
      `SELECT v.id AS video_id, v.title, v.status, v.created_at,
              tj.status AS job_status,
              tj.attempts,
              tj.last_error,
              tj.updated_at
       FROM videos v
       LEFT JOIN (
         SELECT j1.*
         FROM transcode_jobs j1
         INNER JOIN (
           SELECT video_id, MAX(id) AS max_id FROM transcode_jobs GROUP BY video_id
         ) j2 ON j1.video_id = j2.video_id AND j1.id = j2.max_id
       ) tj ON tj.video_id = v.id
       WHERE v.status = 'processing'
         OR tj.status IN ('pending','processing')
       ORDER BY v.created_at DESC
       LIMIT 40`
    );
    return { items: rows };
  });

  fastify.post('/uploads/clear-failed', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const [result] = await fastify.db.execute(
      `DELETE tj FROM transcode_jobs tj
       INNER JOIN (
         SELECT video_id, MAX(id) AS max_id
         FROM transcode_jobs
         GROUP BY video_id
       ) latest ON latest.max_id = tj.id
       WHERE tj.status = 'failed'`
    );

    await authService.logEvent(fastify, {
      actorUserId: request.user.sub,
      action: 'admin.failed_jobs_cleared',
      metadata: { cleared: Number(result.affectedRows || 0) }
    });

    return { ok: true, cleared: Number(result.affectedRows || 0) };
  });

  fastify.post('/videos/:id/retry', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const videoId = Number(request.params.id);
    const [sourceRows] = await fastify.db.execute(
      'SELECT file_path FROM video_files WHERE video_id = ? AND file_type = "upload-source" ORDER BY id DESC LIMIT 1',
      [videoId]
    );
    const source = sourceRows[0];
    if (!source || !source.file_path || !fs.existsSync(source.file_path)) {
      return reply.code(400).send({ error: 'Original upload file is missing. Re-upload is required.' });
    }

    const outputDir = mediaPathsService.getHlsOutputDir(videoId);
    await fastify.db.execute('INSERT INTO transcode_jobs (video_id, upload_path, output_path, status) VALUES (?, ?, ?, "pending")', [videoId, source.file_path, outputDir]);
    const [jobRows] = await fastify.db.execute('SELECT MAX(id) AS id FROM transcode_jobs WHERE video_id = ?', [videoId]);
    const jobId = Number(jobRows[0].id);
    transcodeJobService.queueTranscodeJob(fastify, jobId, request.user.sub);

    await authService.logEvent(fastify, {
      actorUserId: request.user.sub,
      action: 'admin.video_retry_queued',
      metadata: { videoId, jobId }
    });

    return reply.redirect('/admin?tab=videos');
  });

  fastify.post('/courses/create', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const fields = {};
    let thumbnailPath = null;
    const thumbsDir = path.resolve(process.cwd(), 'media/thumbnails');
    videoService.ensureDir(thumbsDir);

    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (part.fieldname === 'thumbnailFile' && part.filename && part.mimetype && part.mimetype.startsWith('image/')) {
          const ext = path.extname(part.filename || '').toLowerCase() || '.jpg';
          const thumbName = `course_${Date.now()}_${nanoid(8)}${ext}`;
          const thumbAbsPath = path.join(thumbsDir, thumbName);
          await saveFilePart(part, thumbAbsPath);
          thumbnailPath = toRelativeMediaPath(thumbAbsPath);
        } else {
          part.file.resume();
        }
      } else {
        fields[part.fieldname] = part.value;
      }
    }

    const name = String(fields.name || '').trim();
    const description = String(fields.description || '').trim();
    if (!name) {
      return reply.code(400).send({ error: 'Course name is required' });
    }
    await fastify.db.execute(
      'INSERT INTO courses (name, description, thumbnail_path, created_by) VALUES (?, ?, ?, ?)',
      [name, description || null, thumbnailPath, request.user.sub]
    );

    await authService.logEvent(fastify, {
      actorUserId: request.user.sub,
      action: 'admin.course_created',
      metadata: { name }
    });

    return reply.redirect('/admin?tab=courses');
  });

  fastify.post('/courses/:id/update', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const courseId = Number(request.params.id);
    const [rows] = await fastify.db.execute('SELECT id, name, thumbnail_path FROM courses WHERE id = ? LIMIT 1', [courseId]);
    if (!rows[0]) {
      return reply.redirect('/admin?tab=courses');
    }

    const current = rows[0];
    const thumbsDir = path.resolve(process.cwd(), 'media/thumbnails');
    videoService.ensureDir(thumbsDir);

    const fields = {};
    let thumbnailPart = null;
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (part.fieldname === 'thumbnailFile' && part.filename) {
          thumbnailPart = part;
        } else {
          part.file.resume();
        }
      } else {
        fields[part.fieldname] = part.value;
      }
    }

    const name = String(fields.name || '').trim();
    const description = String(fields.description || '').trim();
    if (!name) {
      return reply.code(400).send({ error: 'Course name is required' });
    }

    let nextThumbnail = current.thumbnail_path;
    if (String(fields.removeThumbnail) === 'true') {
      nextThumbnail = null;
    }

    if (thumbnailPart && thumbnailPart.mimetype && thumbnailPart.mimetype.startsWith('image/')) {
      const ext = path.extname(thumbnailPart.filename || '').toLowerCase() || '.jpg';
      const thumbName = `course_${courseId}_${Date.now()}_${nanoid(8)}${ext}`;
      const thumbAbsPath = path.join(thumbsDir, thumbName);
      await saveFilePart(thumbnailPart, thumbAbsPath);
      nextThumbnail = toRelativeMediaPath(thumbAbsPath);
    }

    if (current.thumbnail_path && current.thumbnail_path !== nextThumbnail) {
      removeMediaFileIfExists(current.thumbnail_path);
    }

    await fastify.db.execute(
      'UPDATE courses SET name = ?, description = ?, thumbnail_path = ?, updated_at = NOW() WHERE id = ?',
      [name, description || null, nextThumbnail, courseId]
    );

    await authService.logEvent(fastify, {
      actorUserId: request.user.sub,
      action: 'admin.course_updated',
      metadata: { courseId }
    });

    return reply.redirect('/admin?tab=courses');
  });

  fastify.post('/courses/:id/delete', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const courseId = Number(request.params.id);
    const [rows] = await fastify.db.execute('SELECT id, name, thumbnail_path FROM courses WHERE id = ? LIMIT 1', [courseId]);
    if (!rows[0]) {
      return reply.redirect('/admin?tab=courses');
    }

    removeMediaFileIfExists(rows[0].thumbnail_path);
    await fastify.db.execute('DELETE FROM course_videos WHERE course_id = ?', [courseId]);
    await fastify.db.execute('DELETE FROM courses WHERE id = ?', [courseId]);

    await authService.logEvent(fastify, {
      actorUserId: request.user.sub,
      action: 'admin.course_deleted',
      metadata: { courseId, name: rows[0].name }
    });

    return reply.redirect('/admin?tab=courses');
  });

  fastify.post('/courses/:id/videos/add', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const courseId = Number(request.params.id);
    const learningItemId = Number(request.body.learningItemId || request.body.videoId);
    const orderIndex = Math.max(1, Number(request.body.orderIndex || 1));

    const [itemRows] = await fastify.db.execute('SELECT id FROM learning_items WHERE id = ? LIMIT 1', [learningItemId]);
    if (!itemRows[0]) {
      return reply.code(400).send({ error: 'Learning item not found' });
    }

    await fastify.db.execute(
      `INSERT INTO course_items (course_id, learning_item_id, order_index)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE order_index = VALUES(order_index)`,
      [courseId, learningItemId, orderIndex]
    );

    const [videoRows] = await fastify.db.execute('SELECT video_id FROM learning_items WHERE id = ? LIMIT 1', [learningItemId]);
    if (videoRows[0] && videoRows[0].video_id) {
      await fastify.db.execute(
        `INSERT INTO course_videos (course_id, video_id, order_index)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE order_index = VALUES(order_index)`,
        [courseId, videoRows[0].video_id, orderIndex]
      );
    }

    return reply.redirect('/admin?tab=courses');
  });

  fastify.post('/courses/:id/videos/:itemId/remove', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const courseId = Number(request.params.id);
    const itemId = Number(request.params.itemId);
    const [rows] = await fastify.db.execute(
      'SELECT learning_item_id FROM course_items WHERE id = ? AND course_id = ? LIMIT 1',
      [itemId, courseId]
    );
    if (rows[0]) {
      const [videoRows] = await fastify.db.execute(
        'SELECT video_id FROM learning_items WHERE id = ? LIMIT 1',
        [rows[0].learning_item_id]
      );
      if (videoRows[0] && videoRows[0].video_id) {
        await fastify.db.execute(
          'DELETE FROM course_videos WHERE course_id = ? AND video_id = ?',
          [courseId, videoRows[0].video_id]
        );
      }
    }
    await fastify.db.execute('DELETE FROM course_items WHERE id = ? AND course_id = ?', [itemId, courseId]);
    return reply.redirect('/admin?tab=courses');
  });

  fastify.post('/content/create', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const docsDir = path.resolve(process.cwd(), 'media/documents');
    const freeDir = path.resolve(process.cwd(), 'media/free-videos');
    const thumbsDir = path.resolve(process.cwd(), 'media/thumbnails');
    videoService.ensureDir(docsDir);
    videoService.ensureDir(freeDir);
    videoService.ensureDir(thumbsDir);

    const fields = {};
    let thumbnailPath = null;
    let documentPath = null;
    let documentMime = null;
    let documentFilename = null;
    let sourcePath = null;

    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (part.fieldname === 'thumbnailFile' && part.filename && part.mimetype && part.mimetype.startsWith('image/')) {
          const ext = path.extname(part.filename || '').toLowerCase() || '.jpg';
          const thumbAbs = path.join(thumbsDir, `content_${Date.now()}_${nanoid(8)}${ext}`);
          await saveFilePart(part, thumbAbs);
          thumbnailPath = toRelativeMediaPath(thumbAbs);
        } else if (part.fieldname === 'documentFile' && part.filename) {
          if (!learningItemService.isDocumentFile(part.filename, part.mimetype)) {
            part.file.resume();
            continue;
          }
          const ext = path.extname(part.filename).toLowerCase();
          const abs = path.join(docsDir, `${nanoid(12)}${ext}`);
          await saveFilePart(part, abs);
          documentPath = toRelativeMediaPath(abs);
          documentMime = part.mimetype || 'application/octet-stream';
          documentFilename = part.filename;
        } else if (part.fieldname === 'videoFile' && part.filename) {
          const ext = getSafeVideoExtension(part.filename, part.mimetype);
          if (!ext) {
            part.file.resume();
            continue;
          }
          const abs = path.join(freeDir, `${nanoid(12)}${ext}`);
          await saveFilePart(part, abs);
          sourcePath = toRelativeMediaPath(abs);
        } else {
          part.file.resume();
        }
      } else {
        fields[part.fieldname] = part.value;
      }
    }

    const itemType = String(fields.itemType || '').trim();
    const title = String(fields.title || '').trim();
    const accessLevel = fields.accessLevel === 'public' ? 'public' : 'authenticated';
    if (!title) {
      return reply.code(400).send({ error: 'Title is required' });
    }

    if (itemType === 'external_video') {
      const parsed = learningItemService.parseExternalUrl(fields.externalUrl);
      if (!parsed) {
        return reply.code(400).send({ error: 'Unsupported or invalid video URL' });
      }
      await fastify.db.execute(
        `INSERT INTO learning_items (
          title, description, thumbnail_path, tags, item_type, access_level, status,
          external_url, external_provider, external_video_id, created_by, published_at
        ) VALUES (?, ?, ?, ?, 'external_video', ?, 'published', ?, ?, ?, ?, NOW())`,
        [
          title,
          (fields.description || '').trim() || null,
          thumbnailPath,
          parseTags(fields.tags) || null,
          accessLevel,
          String(fields.externalUrl || '').trim(),
          parsed.provider,
          parsed.videoId,
          request.user.sub
        ]
      );
      return reply.redirect('/admin?tab=upload');
    }

    if (itemType === 'document') {
      if (!documentPath) {
        return reply.code(400).send({ error: 'Document file is required' });
      }
      await fastify.db.execute(
        `INSERT INTO learning_items (
          title, description, thumbnail_path, tags, item_type, access_level, status,
          document_path, document_mime, document_filename, created_by, published_at
        ) VALUES (?, ?, ?, ?, 'document', ?, 'published', ?, ?, ?, ?, NOW())`,
        [
          title,
          (fields.description || '').trim() || null,
          thumbnailPath,
          parseTags(fields.tags) || null,
          accessLevel,
          documentPath,
          documentMime,
          documentFilename,
          request.user.sub
        ]
      );
      return reply.redirect('/admin?tab=upload');
    }

    if (itemType === 'free_video') {
      if (!sourcePath) {
        return reply.code(400).send({ error: 'Video file is required' });
      }
      await fastify.db.execute(
        `INSERT INTO learning_items (
          title, description, thumbnail_path, tags, item_type, access_level, status,
          source_path, created_by, published_at
        ) VALUES (?, ?, ?, ?, 'free_video', ?, 'published', ?, ?, NOW())`,
        [
          title,
          (fields.description || '').trim() || null,
          thumbnailPath,
          parseTags(fields.tags) || null,
          accessLevel,
          sourcePath,
          request.user.sub
        ]
      );
      return reply.redirect('/admin?tab=upload');
    }

    return reply.code(400).send({ error: 'Invalid content type' });
  });

  fastify.post('/learning-items/:id/publish', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    await fastify.db.execute(
      'UPDATE learning_items SET status = "published", published_at = NOW() WHERE id = ?',
      [request.params.id]
    );
    return reply.redirect('/admin?tab=videos');
  });

  fastify.post('/learning-items/:id/unpublish', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    await fastify.db.execute('UPDATE learning_items SET status = "hidden" WHERE id = ?', [request.params.id]);
    return reply.redirect('/admin?tab=videos');
  });

  fastify.post('/learning-items/:id/delete', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const itemId = Number(request.params.id);
    const item = await learningItemService.getItemById(fastify, itemId);
    if (!item) {
      return reply.redirect('/admin?tab=videos');
    }
    if (item.document_path) {
      removeMediaFileIfExists(item.document_path);
    }
    if (item.source_path) {
      removeMediaFileIfExists(item.source_path);
    }
    removeMediaFileIfExists(item.thumbnail_path);
    await fastify.db.execute('DELETE FROM item_progress WHERE learning_item_id = ?', [itemId]);
    await fastify.db.execute('DELETE FROM course_items WHERE learning_item_id = ?', [itemId]);
    await fastify.db.execute('DELETE FROM learning_items WHERE id = ?', [itemId]);
    return reply.redirect('/admin?tab=videos');
  });
}

module.exports = adminRoutes;
