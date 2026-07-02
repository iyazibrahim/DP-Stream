const authService = require('./authService');
const videoService = require('./videoService');

const activeJobs = new Set();
const pendingRunQueue = [];

function getMaxConcurrentTranscodes() {
  return Math.max(1, Math.min(4, Number(process.env.MAX_CONCURRENT_TRANSCODES || 1)));
}

function isJobActive(jobId) {
  return activeJobs.has(jobId);
}

function drainPendingQueue() {
  while (pendingRunQueue.length > 0 && activeJobs.size < getMaxConcurrentTranscodes()) {
    const next = pendingRunQueue.shift();
    if (!next || activeJobs.has(next.jobId)) {
      continue;
    }
    startTranscodeJob(next.fastify, next.jobId, next.actorUserId);
  }
}

function startTranscodeJob(fastify, jobId, actorUserId) {
  runTranscodeJob(fastify, jobId, actorUserId)
    .catch((err) => fastify.log.error(err))
    .finally(() => {
      drainPendingQueue();
    });
}

function queueTranscodeJob(fastify, jobId, actorUserId) {
  if (activeJobs.has(jobId)) {
    return;
  }
  if (activeJobs.size < getMaxConcurrentTranscodes()) {
    startTranscodeJob(fastify, jobId, actorUserId);
    return;
  }
  pendingRunQueue.push({ fastify, jobId, actorUserId });
}

async function runTranscodeJob(fastify, jobId, actorUserId) {
  if (activeJobs.has(jobId)) {
    return;
  }

  activeJobs.add(jobId);
  let publishedEarly = false;
  try {
    const [rows] = await fastify.db.execute('SELECT * FROM transcode_jobs WHERE id = ? LIMIT 1', [jobId]);
    const job = rows[0];
    if (!job || job.status === 'done') {
      return;
    }

    await fastify.db.execute(
      'UPDATE transcode_jobs SET status = "processing", attempts = attempts + 1, started_at = NOW(), last_error = NULL WHERE id = ?',
      [jobId]
    );

    await fastify.db.execute('UPDATE videos SET status = "processing", updated_at = NOW() WHERE id = ?', [job.video_id]);

    const result = await videoService.transcodeToHls(job.video_id, job.upload_path, job.output_path, {
      onProfileReady: async ({ masterPath }) => {
        if (publishedEarly) {
          return;
        }

        await fastify.db.execute('DELETE FROM video_files WHERE video_id = ? AND file_type = "hls-master"', [job.video_id]);
        await fastify.db.execute(
          'INSERT INTO video_files (video_id, file_type, file_path, profile, size_bytes) VALUES (?, "hls-master", ?, "master", ?)',
          [job.video_id, masterPath, 0]
        );
        await fastify.db.execute('UPDATE videos SET status = "published", published_at = NOW(), updated_at = NOW() WHERE id = ?', [job.video_id]);
        publishedEarly = true;
      }
    });

    await fastify.db.execute('DELETE FROM video_files WHERE video_id = ? AND file_type = "hls-master"', [job.video_id]);
    await fastify.db.execute(
      'INSERT INTO video_files (video_id, file_type, file_path, profile, size_bytes) VALUES (?, "hls-master", ?, "master", ?)',
      [job.video_id, result.masterPath, 0]
    );
    await fastify.db.execute('UPDATE videos SET status = "published", published_at = COALESCE(published_at, NOW()), updated_at = NOW() WHERE id = ?', [job.video_id]);
    await fastify.db.execute('UPDATE transcode_jobs SET status = "done", completed_at = NOW(), updated_at = NOW() WHERE id = ?', [jobId]);

    await authService.logEvent(fastify, {
      actorUserId,
      action: 'admin.video_transcode_done',
      metadata: { videoId: job.video_id, jobId }
    });
  } catch (err) {
    if (!publishedEarly) {
      await fastify.db.execute('UPDATE videos SET status = "failed", updated_at = NOW() WHERE id = (SELECT video_id FROM transcode_jobs WHERE id = ?)', [jobId]);
    }
    await fastify.db.execute(
      'UPDATE transcode_jobs SET status = "failed", last_error = ?, updated_at = NOW() WHERE id = ?',
      [String(err.message || err), jobId]
    );
  } finally {
    activeJobs.delete(jobId);
  }
}

module.exports = {
  activeJobs,
  isJobActive,
  queueTranscodeJob,
  runTranscodeJob
};
