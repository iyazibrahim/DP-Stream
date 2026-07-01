const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getProfiles() {
  const profiles = [
    { name: '480p', width: 854, height: 480, bitrate: '1000k' },
    { name: '720p', width: 1280, height: 720, bitrate: '2000k' }
  ];
  if ((process.env.ENABLE_1080P || 'false').toLowerCase() === 'true') {
    profiles.push({ name: '1080p', width: 1920, height: 1080, bitrate: '3500k' });
  }
  return profiles;
}

function isVaapiEnabled() {
  return (process.env.FFMPEG_HWACCEL || 'none').toLowerCase() === 'vaapi';
}

function getSoftwareVideoArgs(p, inputFilePath, outDir, playlistPath) {
  return [
    '-y',
    '-i', inputFilePath,
    '-vf', `scale=w=${p.width}:h=${p.height}:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2`,
    '-c:a', 'aac',
    '-ar', '48000',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'main',
    '-crf', '20',
    '-sc_threshold', '0',
    '-g', '48',
    '-keyint_min', '48',
    '-hls_time', '6',
    '-hls_playlist_type', 'vod',
    '-b:v', p.bitrate,
    '-maxrate', p.bitrate,
    '-hls_segment_filename', path.join(outDir, 'seg_%03d.ts'),
    playlistPath
  ];
}

function getVaapiVideoArgs(p, inputFilePath, outDir, playlistPath) {
  const vaapiDevice = process.env.FFMPEG_VAAPI_DEVICE || '/dev/dri/renderD128';
  const qp = String(process.env.FFMPEG_VAAPI_QP || '23');
  return [
    '-y',
    '-vaapi_device', vaapiDevice,
    '-i', inputFilePath,
    '-vf', `format=nv12,hwupload,scale_vaapi=w=${p.width}:h=${p.height}`,
    '-c:a', 'aac',
    '-ar', '48000',
    '-c:v', 'h264_vaapi',
    '-profile:v', 'main',
    '-rc_mode', 'CQP',
    '-qp', qp,
    '-g', '48',
    '-keyint_min', '48',
    '-hls_time', '6',
    '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(outDir, 'seg_%03d.ts'),
    playlistPath
  ];
}

function writeMasterPlaylist(outputRoot, variantPlaylists) {
  const masterPath = path.join(outputRoot, 'master.m3u8');
  const lines = ['#EXTM3U'];
  for (const item of variantPlaylists) {
    const bandwidth = Number(item.bandwidth.replace('k', '000'));
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${item.profile === '480p' ? '854x480' : item.profile === '720p' ? '1280x720' : '1920x1080'}`);
    lines.push(`${item.profile}/index.m3u8`);
  }
  fs.writeFileSync(masterPath, `${lines.join('\n')}\n`);
  return masterPath;
}

async function transcodeToHls(videoId, inputFilePath, outputRoot, options = {}) {
  ensureDir(outputRoot);
  const profiles = getProfiles();
  const useVaapi = isVaapiEnabled();
  const variantPlaylists = [];

  for (const p of profiles) {
    const outDir = path.join(outputRoot, p.name);
    ensureDir(outDir);
    const playlistPath = path.join(outDir, 'index.m3u8');

    const args = useVaapi
      ? getVaapiVideoArgs(p, inputFilePath, outDir, playlistPath)
      : getSoftwareVideoArgs(p, inputFilePath, outDir, playlistPath);

    await runProcess(process.env.FFMPEG_BIN || 'ffmpeg', args);
    variantPlaylists.push({ profile: p.name, playlistPath, bandwidth: p.bitrate });

    const currentMasterPath = writeMasterPlaylist(outputRoot, variantPlaylists);
    if (typeof options.onProfileReady === 'function') {
      await options.onProfileReady({
        videoId,
        profile: p.name,
        variantCount: variantPlaylists.length,
        masterPath: currentMasterPath
      });
    }
  }

  const masterPath = path.join(outputRoot, 'master.m3u8');

  return { masterPath, variantCount: variantPlaylists.length };
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timeoutMs = Number(process.env.FFMPEG_TIMEOUT_MS || 14400000); // 4 hours

    const stderrLines = [];
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => {
      process.stderr.write(d);
      // Keep last 30 lines for error reporting
      const lines = d.toString().split('\n').filter(Boolean);
      stderrLines.push(...lines);
      if (stderrLines.length > 30) { stderrLines.splice(0, stderrLines.length - 30); }
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`FFmpeg timed out after ${Math.round(timeoutMs / 60000)} minutes`));
    }, timeoutMs);

    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const detail = stderrLines.slice(-5).join(' | ').trim();
        reject(new Error(`FFmpeg exited with code ${code}${detail ? ': ' + detail : ''}`));
        return;
      }
      resolve();
    });
  });
}

module.exports = {
  transcodeToHls,
  ensureDir
};
