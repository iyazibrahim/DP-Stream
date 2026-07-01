import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import exec from 'k6/execution';

const BASE_URL = (__ENV.BASE_URL || 'https://learn.iyabrhm.site/').replace(/\/$/, '');
const DEFAULT_VIDEO_ID = String(__ENV.VIDEO_ID || '').trim();
const PROFILE = __ENV.PROFILE || '';
const VUS = Number(__ENV.VUS || 30);
const DURATION = __ENV.DURATION || '10m';
const SEGMENTS_PER_PASS = Number(__ENV.SEGMENTS_PER_PASS || 6);
const SEGMENT_SLEEP_SECONDS = Number(__ENV.SEGMENT_SLEEP_SECONDS || 4);
const REFRESH_TOKEN_EARLY_MS = Number(__ENV.REFRESH_TOKEN_EARLY_MS || 90000);
const LOGIN_MAX_ATTEMPTS = Number(__ENV.LOGIN_MAX_ATTEMPTS || 5);
const LOGIN_RETRY_SECONDS = Number(__ENV.LOGIN_RETRY_SECONDS || 15);
const LOGIN_SPREAD_SECONDS = Number(__ENV.LOGIN_SPREAD_SECONDS || 6);
const USER_AGENT = __ENV.USER_AGENT || 'k6-video-stream/1.0';
const USERS = parseUsers(__ENV.USERS || 'admin@digitalpenang.my:StrongPass123!');

const vuState = {
  session: null,
  profilePath: null,
  segmentPaths: [],
  segmentIndex: 0,
  token: null,
  tokenExpiresAt: 0,
  csrfToken: null,
  currentVideoId: '',
  credentialsKey: '',
  startupDelayApplied: false
};

export const options = {
  scenarios: {
    streamers: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION
    }
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<3000'],
    checks: ['rate>0.95']
  }
};

export function setup() {
  if (!USERS.length) {
    fail('No USERS were configured. Provide USERS="email:password,email2:password2"');
  }

  if (USERS.length === 1 && VUS > 1) {
    console.warn(
      `Only one login was provided for ${VUS} VUs. Set MAX_ACTIVE_SESSIONS >= ${VUS} or provide multiple accounts in USERS.`
    );
  }

  if (!DEFAULT_VIDEO_ID) {
    console.warn('VIDEO_ID not provided; script will auto-discover the first available published video from /videos.');
  }

  return { startedAt: Date.now() };
}

export default function () {
  const credentials = USERS[(__VU - 1) % USERS.length];
  ensureLoggedIn(credentials);
  ensurePlaybackBootstrap();
  maybeRefreshToken();
  streamSegments();
}

function ensureLoggedIn(credentials) {
  const credentialsKey = `${credentials.email}:${credentials.password}`;
  if (vuState.session && vuState.credentialsKey === credentialsKey) {
    return;
  }

  if (!vuState.startupDelayApplied) {
    vuState.startupDelayApplied = true;
    const startupDelaySeconds = ((__VU - 1) % Math.max(1, VUS)) * LOGIN_SPREAD_SECONDS;
    if (startupDelaySeconds > 0) {
      sleep(startupDelaySeconds);
    }
  }

  const jar = http.cookieJar();
  jar.clear(BASE_URL);

  const loginPage = http.get(`${BASE_URL}/login`, {
    redirects: 0,
    headers: baseHeaders()
  });

  const csrfCookie = extractCookie(loginPage, 'csrf_token');
  check(loginPage, {
    'login page ok': (res) => res.status === 200,
    'csrf cookie present': () => Boolean(csrfCookie)
  });

  if (!csrfCookie) {
    fail('Missing csrf_token cookie on GET /login');
  }

  let loginRes = null;
  for (let attempt = 1; attempt <= LOGIN_MAX_ATTEMPTS; attempt += 1) {
    loginRes = http.post(
      `${BASE_URL}/auth/login`,
      {
        email: credentials.email,
        password: credentials.password
      },
      {
        redirects: 0,
        headers: {
          ...baseHeaders(),
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRF-Token': csrfCookie
        },
        tags: { endpoint: 'login' }
      }
    );

    if (loginRes.status !== 429) {
      break;
    }

    if (attempt < LOGIN_MAX_ATTEMPTS) {
      sleep(LOGIN_RETRY_SECONDS);
    }
  }

  const authCookie = extractCookie(loginRes, 'auth_token');
  check(loginRes, {
    'login redirect': (res) => res.status === 302,
    'auth cookie present': () => Boolean(authCookie)
  });

  if (!authCookie) {
    fail(`Login failed for ${credentials.email}. Status: ${loginRes.status}. Body: ${String(loginRes.body || '').slice(0, 300)}`);
  }

  vuState.session = {
    email: credentials.email,
    authCookie
  };
  vuState.credentialsKey = credentialsKey;
  vuState.csrfToken = getCsrfToken();
  vuState.profilePath = null;
  vuState.segmentPaths = [];
  vuState.segmentIndex = 0;
  vuState.token = null;
  vuState.tokenExpiresAt = 0;
  vuState.currentVideoId = DEFAULT_VIDEO_ID;
}

function ensurePlaybackBootstrap() {
  if (vuState.profilePath && vuState.segmentPaths.length) {
    return;
  }

  if (!vuState.currentVideoId) {
    discoverPlayableVideoId();
  }

  vuState.csrfToken = getCsrfToken();

  let watchRes = http.get(`${BASE_URL}/videos/${vuState.currentVideoId}`, {
    redirects: 0,
    headers: authHeaders(),
    tags: { endpoint: 'watch' }
  });

  if (watchRes.status === 404) {
    discoverPlayableVideoId(true);
    watchRes = http.get(`${BASE_URL}/videos/${vuState.currentVideoId}`, {
      redirects: 0,
      headers: authHeaders(),
      tags: { endpoint: 'watch' }
    });
  }

  vuState.csrfToken = getCsrfToken();

  check(watchRes, {
    'watch page ok': (res) => res.status === 200
  });
  if (watchRes.status !== 200) {
    fail(`Watch page failed. Status: ${watchRes.status}. Body: ${String(watchRes.body || '').slice(0, 300)}`);
  }

  const tokenData = issuePlaybackToken();
  const masterRes = http.get(`${BASE_URL}/videos/stream/${vuState.currentVideoId}/master.m3u8?token=${encodeURIComponent(tokenData.token)}`, {
    headers: mediaHeaders(),
    tags: { endpoint: 'master-playlist' }
  });

  check(masterRes, {
    'master playlist ok': (res) => res.status === 200,
    'master playlist looks like m3u8': (res) => String(res.body || '').includes('#EXTM3U')
  });

  const variantPath = resolveVariantPath(masterRes.body);
  const mediaPlaylistRes = http.get(`${BASE_URL}${variantPath}`, {
    headers: mediaHeaders(),
    tags: { endpoint: 'media-playlist' }
  });

  check(mediaPlaylistRes, {
    'media playlist ok': (res) => res.status === 200,
    'media playlist has segments': (res) => String(res.body || '').includes('.ts')
  });

  const segments = parseSegmentPaths(mediaPlaylistRes.body, variantPath);
  if (!segments.length) {
    fail(`No segments found in playlist ${variantPath}`);
  }

  vuState.profilePath = variantPath;
  vuState.segmentPaths = segments;
}

function issuePlaybackToken() {
  vuState.csrfToken = getCsrfToken();

  const tokenRes = http.post(
    `${BASE_URL}/videos/${vuState.currentVideoId}/token`,
    {},
    {
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRF-Token': vuState.csrfToken
      },
      tags: { endpoint: 'playback-token' }
    }
  );

  check(tokenRes, {
    'playback token ok': (res) => res.status === 200
  });

  const data = tokenRes.status === 200 ? tokenRes.json() : null;
  if (!data || !data.token) {
    fail(`Missing playback token. Status: ${tokenRes.status}. Body: ${String(tokenRes.body || '').slice(0, 300)}`);
  }

  vuState.token = data.token;
  vuState.tokenExpiresAt = Number(data.expiresAt || 0);
  return data;
}

function maybeRefreshToken() {
  if (!vuState.token || !vuState.tokenExpiresAt) {
    issuePlaybackToken();
    return;
  }

  if (Date.now() + REFRESH_TOKEN_EARLY_MS >= vuState.tokenExpiresAt) {
    issuePlaybackToken();
    vuState.profilePath = null;
    vuState.segmentPaths = [];
    ensurePlaybackBootstrap();
  }
}

function streamSegments() {
  const requests = [];

  for (let i = 0; i < SEGMENTS_PER_PASS; i += 1) {
    const segmentPath = vuState.segmentPaths[vuState.segmentIndex % vuState.segmentPaths.length];
    vuState.segmentIndex += 1;
    requests.push([
      'GET',
      `${BASE_URL}${segmentPath}`,
      null,
      {
        headers: mediaHeaders(),
        responseType: 'binary',
        tags: { endpoint: 'segment' }
      }
    ]);
  }

  const responses = http.batch(requests);
  for (const response of responses) {
    check(response, {
      'segment request ok': (res) => res.status === 200,
      'segment body present': (res) => (res.body ? res.body.byteLength || res.body.length || 0 : 0) > 0
    });
  }

  sleep(SEGMENT_SLEEP_SECONDS);
}

function resolveVariantPath(masterBody) {
  const lines = String(masterBody || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const variants = lines.filter((line) => !line.startsWith('#') && /\.m3u8(?:\?|$)/i.test(line));
  if (!variants.length) {
    fail(`Master playlist did not contain any media playlists. Body: ${String(masterBody || '').slice(0, 500)}`);
  }

  if (PROFILE) {
    const requested = variants.find((line) => line.includes(`/${PROFILE}/`) || line.startsWith(`${PROFILE}/`));
    if (requested) {
      return normalizePath(requested);
    }
  }

  return normalizePath(variants[0]);
}

function parseSegmentPaths(playlistBody, playlistPath) {
  return String(playlistBody || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('.ts'))
    .map((line) => normalizePath(line, playlistPath));
}

function normalizePath(pathValue, playlistPath) {
  if (pathValue.startsWith('http://') || pathValue.startsWith('https://')) {
    return pathValue.replace(BASE_URL, '');
  }
  if (pathValue.startsWith('/')) {
    return pathValue;
  }

  const cleanPlaylistPath = String(playlistPath || '').split('?')[0];
  const slashIndex = cleanPlaylistPath.lastIndexOf('/');
  const baseDir = slashIndex >= 0 ? cleanPlaylistPath.slice(0, slashIndex + 1) : `/videos/stream/${vuState.currentVideoId}/`;
  return `${baseDir}${pathValue}`;
}

function extractCookie(response, name) {
  const cookies = response.cookies && response.cookies[name];
  return cookies && cookies.length ? cookies[0].value : '';
}

function getCsrfToken() {
  const jar = http.cookieJar();
  const videoPath = vuState.currentVideoId ? `/videos/${vuState.currentVideoId}` : '/videos';
  const cookies = jar.cookiesForURL(`${BASE_URL}${videoPath}`);
  const csrfToken = cookies && cookies.csrf_token && cookies.csrf_token.length ? cookies.csrf_token[0] : '';
  return csrfToken || vuState.csrfToken || '';
}

function discoverPlayableVideoId(forceRefresh) {
  if (vuState.currentVideoId && !forceRefresh) {
    return vuState.currentVideoId;
  }

  const videosRes = http.get(`${BASE_URL}/videos`, {
    redirects: 0,
    headers: authHeaders(),
    tags: { endpoint: 'videos-list' }
  });

  if (videosRes.status !== 200) {
    fail(`Unable to load /videos for discovery. Status: ${videosRes.status}. Body: ${String(videosRes.body || '').slice(0, 300)}`);
  }

  const discoveredVideoId = extractFirstVideoId(videosRes.body);
  if (!discoveredVideoId) {
    fail('Could not auto-discover a playable video ID from /videos. Set VIDEO_ID explicitly to a published video on the NUC.');
  }

  vuState.currentVideoId = discoveredVideoId;
  vuState.profilePath = null;
  vuState.segmentPaths = [];
  return discoveredVideoId;
}

function extractFirstVideoId(html) {
  const match = String(html || '').match(/href="\/videos\/(\d+)"/);
  return match ? match[1] : '';
}

function parseUsers(rawUsers) {
  return rawUsers
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separatorIndex = entry.indexOf(':');
      if (separatorIndex === -1) {
        fail(`Invalid USERS entry: ${entry}. Expected email:password`);
      }
      return {
        email: entry.slice(0, separatorIndex),
        password: entry.slice(separatorIndex + 1)
      };
    });
}

function baseHeaders() {
  return {
    'User-Agent': USER_AGENT
  };
}

function mediaHeaders() {
  return {
    ...baseHeaders(),
    Accept: '*/*'
  };
}

function authHeaders() {
  const cookieParts = [];
  if (vuState.session && vuState.session.authCookie) {
    cookieParts.push(`auth_token=${vuState.session.authCookie}`);
  }
  if (vuState.csrfToken) {
    cookieParts.push(`csrf_token=${vuState.csrfToken}`);
  }

  const headers = {
    ...baseHeaders()
  };

  if (cookieParts.length) {
    headers.Cookie = cookieParts.join('; ');
  }

  return headers;
}