const ALLOWED_EXTERNAL_HOSTS = {
  youtube: ['youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com'],
  vimeo: ['vimeo.com', 'www.vimeo.com', 'player.vimeo.com']
};

const DOCUMENT_MIMES = new Set([
  'application/pdf',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
]);

const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.ppt', '.pptx']);

function parseExternalUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (ALLOWED_EXTERNAL_HOSTS.youtube.some((h) => host === h || host.endsWith('.' + h))) {
    let videoId = '';
    if (host === 'youtu.be') {
      videoId = url.pathname.replace(/^\//, '').split('/')[0];
    } else {
      videoId = url.searchParams.get('v') || '';
      if (!videoId && url.pathname.startsWith('/embed/')) {
        videoId = url.pathname.split('/')[2] || '';
      }
      if (!videoId && url.pathname.startsWith('/shorts/')) {
        videoId = url.pathname.split('/')[2] || '';
      }
    }
    if (!videoId) {
      return null;
    }
    return { provider: 'youtube', videoId, embedUrl: `https://www.youtube.com/embed/${videoId}` };
  }

  if (ALLOWED_EXTERNAL_HOSTS.vimeo.some((h) => host === h)) {
    const parts = url.pathname.split('/').filter(Boolean);
    const videoId = parts[parts.length - 1];
    if (!videoId || !/^\d+$/.test(videoId)) {
      return null;
    }
    return { provider: 'vimeo', videoId, embedUrl: `https://player.vimeo.com/video/${videoId}` };
  }

  return null;
}

function canViewItem(item, user) {
  if (!item || item.status !== 'published') {
    return false;
  }
  if (item.access_level === 'public') {
    return true;
  }
  return Boolean(user && user.sub);
}

function itemTypeLabel(itemType) {
  const labels = {
    premium_video: 'Premium video',
    free_video: 'Free video',
    external_video: 'External video',
    document: 'Document'
  };
  return labels[itemType] || itemType;
}

function isDocumentFile(fileName, mimeType) {
  const ext = String(fileName || '').toLowerCase().slice(String(fileName || '').lastIndexOf('.'));
  const mime = String(mimeType || '').toLowerCase();
  return DOCUMENT_EXTENSIONS.has(ext) || DOCUMENT_MIMES.has(mime);
}

async function getItemById(fastify, itemId) {
  const [rows] = await fastify.db.execute(
    'SELECT * FROM learning_items WHERE id = ? LIMIT 1',
    [itemId]
  );
  return rows[0] || null;
}

async function getItemByVideoId(fastify, videoId) {
  const [rows] = await fastify.db.execute(
    'SELECT * FROM learning_items WHERE video_id = ? LIMIT 1',
    [videoId]
  );
  return rows[0] || null;
}

async function createPremiumLearningItem(fastify, params) {
  const [res] = await fastify.db.execute(
    `INSERT INTO learning_items (
      title, description, thumbnail_path, tags, item_type, access_level, status,
      video_id, created_by
    ) VALUES (?, ?, ?, ?, 'premium_video', ?, 'processing', ?, ?)`,
    [
      params.title,
      params.description || null,
      params.thumbnailPath || null,
      params.tags || null,
      params.accessLevel || 'authenticated',
      params.videoId,
      params.userId
    ]
  );
  return res.insertId;
}

async function syncVideoStatusToLearningItem(fastify, videoId, status, publishedAt) {
  await fastify.db.execute(
    `UPDATE learning_items
     SET status = ?, published_at = ?, updated_at = NOW()
     WHERE video_id = ?`,
    [status, publishedAt || null, videoId]
  );
}

async function updateLearningItemMetadata(fastify, videoId, fields) {
  await fastify.db.execute(
    `UPDATE learning_items
     SET title = COALESCE(?, title),
         description = COALESCE(?, description),
         thumbnail_path = COALESCE(?, thumbnail_path),
         tags = COALESCE(?, tags),
         updated_at = NOW()
     WHERE video_id = ?`,
    [fields.title, fields.description, fields.thumbnailPath, fields.tags, videoId]
  );
}

async function deleteLearningItemByVideoId(fastify, videoId) {
  const item = await getItemByVideoId(fastify, videoId);
  if (!item) {
    return;
  }
  await fastify.db.execute('DELETE FROM item_progress WHERE learning_item_id = ?', [item.id]);
  await fastify.db.execute('DELETE FROM course_items WHERE learning_item_id = ?', [item.id]);
  await fastify.db.execute('DELETE FROM learning_items WHERE id = ?', [item.id]);
}

module.exports = {
  ALLOWED_EXTERNAL_HOSTS,
  DOCUMENT_MIMES,
  DOCUMENT_EXTENSIONS,
  parseExternalUrl,
  canViewItem,
  itemTypeLabel,
  isDocumentFile,
  getItemById,
  getItemByVideoId,
  createPremiumLearningItem,
  syncVideoStatusToLearningItem,
  updateLearningItemMetadata,
  deleteLearningItemByVideoId
};
