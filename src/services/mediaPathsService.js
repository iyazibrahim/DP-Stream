const fs = require('fs');
const path = require('path');

function getHlsDir() {
  return path.resolve(process.cwd(), process.env.HLS_DIR || './media/hls');
}

function getUploadDir() {
  return path.resolve(process.cwd(), process.env.UPLOAD_DIR || './media/uploads');
}

function getMasterPlaylistPath(videoId) {
  return path.join(getHlsDir(), String(videoId), 'master.m3u8');
}

function getHlsOutputDir(videoId) {
  return path.join(getHlsDir(), String(videoId));
}

function masterPlaylistExists(videoId) {
  return fs.existsSync(getMasterPlaylistPath(videoId));
}

function sourceFileExists(sourcePath) {
  return Boolean(sourcePath && fs.existsSync(sourcePath));
}

function getVideoRepairState(videoId, sourcePath) {
  const hasSource = sourceFileExists(sourcePath);
  const hasHls = masterPlaylistExists(videoId);

  if (!hasSource) {
    return {
      state: 'source_missing',
      message: 'Upload file lost — re-upload required.',
      canRepair: false
    };
  }
  if (!hasHls) {
    return {
      state: 'hls_missing',
      message: 'Transcode interrupted — use Repair to rebuild playback files.',
      canRepair: true
    };
  }
  return {
    state: 'ok',
    message: '',
    canRepair: false
  };
}

module.exports = {
  getHlsDir,
  getUploadDir,
  getMasterPlaylistPath,
  getHlsOutputDir,
  masterPlaylistExists,
  sourceFileExists,
  getVideoRepairState
};
