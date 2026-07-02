const mediaPathsService = require('./mediaPathsService');
const transcodeJobService = require('./transcodeJobService');

async function markJobFailedMissingSource(fastify, job, log) {
  const message = 'Source file missing after redeploy';
  await fastify.db.execute(
    'UPDATE transcode_jobs SET status = "failed", last_error = ?, updated_at = NOW() WHERE id = ?',
    [message, job.id]
  );

  const [videoRows] = await fastify.db.execute('SELECT status FROM videos WHERE id = ? LIMIT 1', [job.video_id]);
  const videoStatus = videoRows[0]?.status;
  if (videoStatus !== 'published') {
    await fastify.db.execute('UPDATE videos SET status = "failed", updated_at = NOW() WHERE id = ?', [job.video_id]);
  }

  log.warn({ videoId: job.video_id, jobId: job.id }, 'Skipped transcode recovery — source file missing');
}

async function resumeInterruptedJobs(fastify, log) {
  const [rows] = await fastify.db.execute(
    `SELECT id, video_id, upload_path, output_path, status
     FROM transcode_jobs
     WHERE status IN ('pending', 'processing')
     ORDER BY id ASC`
  );

  let resumed = 0;
  let skipped = 0;

  for (const job of rows) {
    if (!mediaPathsService.sourceFileExists(job.upload_path)) {
      await markJobFailedMissingSource(fastify, job, log);
      skipped += 1;
      continue;
    }

    if (job.status === 'processing') {
      await fastify.db.execute(
        'UPDATE transcode_jobs SET status = "pending", updated_at = NOW() WHERE id = ?',
        [job.id]
      );
    }

    transcodeJobService.queueTranscodeJob(fastify, job.id, null);
    resumed += 1;
    log.info({ videoId: job.video_id, jobId: job.id }, 'Resumed interrupted transcode job');
  }

  return { resumed, skipped };
}

async function repairPublishedVideosMissingHls(fastify, log) {
  const [rows] = await fastify.db.execute(
    `SELECT v.id AS video_id, v.uploaded_by, vf.file_path AS source_path
     FROM videos v
     INNER JOIN (
       SELECT vf1.video_id, vf1.file_path
       FROM video_files vf1
       INNER JOIN (
         SELECT video_id, MAX(id) AS max_id
         FROM video_files
         WHERE file_type = 'upload-source'
         GROUP BY video_id
       ) latest ON latest.max_id = vf1.id
     ) vf ON vf.video_id = v.id
     LEFT JOIN (
       SELECT j1.video_id, j1.status
       FROM transcode_jobs j1
       INNER JOIN (
         SELECT video_id, MAX(id) AS max_id FROM transcode_jobs GROUP BY video_id
       ) j2 ON j1.video_id = j2.video_id AND j1.id = j2.max_id
     ) tj ON tj.video_id = v.id
     WHERE v.status IN ('published', 'hidden')
       AND (tj.status IS NULL OR tj.status NOT IN ('pending', 'processing'))
     ORDER BY v.id ASC`
  );

  let repaired = 0;
  let skipped = 0;

  for (const row of rows) {
    if (mediaPathsService.masterPlaylistExists(row.video_id)) {
      continue;
    }

    if (!mediaPathsService.sourceFileExists(row.source_path)) {
      log.warn({ videoId: row.video_id }, 'Published video missing HLS and source — re-upload required');
      skipped += 1;
      continue;
    }

    const outputDir = mediaPathsService.getHlsOutputDir(row.video_id);
    const [jobRes] = await fastify.db.execute(
      'INSERT INTO transcode_jobs (video_id, upload_path, output_path, status) VALUES (?, ?, ?, "pending")',
      [row.video_id, row.source_path, outputDir]
    );

    transcodeJobService.queueTranscodeJob(fastify, jobRes.insertId, row.uploaded_by || null);
    repaired += 1;
    log.info({ videoId: row.video_id, jobId: jobRes.insertId }, 'Queued repair transcode for published video missing HLS');
  }

  return { repaired, skipped };
}

async function recoverOnStartup(fastify) {
  const log = fastify.log;
  log.info('Starting transcode recovery after deploy...');

  const interrupted = await resumeInterruptedJobs(fastify, log);
  const repaired = await repairPublishedVideosMissingHls(fastify, log);

  log.info(
  {
    interruptedResumed: interrupted.resumed,
    interruptedSkipped: interrupted.skipped,
    hlsRepairQueued: repaired.repaired,
    hlsRepairSkipped: repaired.skipped
  },
  'Transcode recovery finished'
  );
}

module.exports = {
  recoverOnStartup,
  resumeInterruptedJobs,
  repairPublishedVideosMissingHls
};
