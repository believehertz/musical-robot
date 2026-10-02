// ytdlp-config.js
// Centralised yt-dlp argument builder for SongVault.
// Handles: .env loading, cookie detection (+ per-download cookie copies),
// JS runtime detection, player-client rotation and PO-token provider wiring.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

// ─── Tiny .env loader (no dotenv dependency) ─────────────────────────────
// Real environment variables always win over values in .env.
function loadDotEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv(path.join(__dirname, '.env'));

// ─── Cookies ─────────────────────────────────────────────────────────────
const fromRoot = p => (path.isAbsolute(p) ? p : path.resolve(__dirname, p));
const COOKIES_PATH = fromRoot(process.env.YTDLP_COOKIES_FILE || 'cookies.txt');

function cookiesAvailable() {
  try { return fs.statSync(COOKIES_PATH).size > 200; }
  catch { return false; }
}

/**
 * yt-dlp writes the cookie jar back to disk when it exits. If several
 * downloads share one file they can clobber each other, so every download
 * attempt works on its own throw-away copy.
 * @returns {{path: string, cleanup: () => void} | null}
 */
function prepareCookies(tag = 'x') {
  if (!cookiesAvailable()) return null;
  const safeTag = String(tag).replace(/[^\w.-]/g, '_');
  const copy = path.join(os.tmpdir(), `songvault-cookies-${process.pid}-${safeTag}-${Date.now()}.txt`);
  try { fs.copyFileSync(COOKIES_PATH, copy); }
  catch { return { path: COOKIES_PATH, cleanup() {} }; } // fall back to the original
  return { path: copy, cleanup() { try { fs.unlinkSync(copy); } catch {} } };
}

// ─── JS runtime (needed for YouTube's signature / n-challenge solving) ──
const _cmdCache = {};
function commandExists(cmd) {
  if (cmd in _cmdCache) return _cmdCache[cmd];
  try {
    execSync(process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`,
             { stdio: 'ignore' });
    return (_cmdCache[cmd] = true);
  } catch { return (_cmdCache[cmd] = false); }
}

function jsRuntime() {
  return process.env.YTDLP_JS_RUNTIME || (commandExists('deno') ? 'deno' : null);
}

// ─── Player-client rotation ──────────────────────────────────────────────
// Attempt 1 uses yt-dlp's own defaults (upstream keeps those working).
// Later attempts force specific clients. Override with YTDLP_PLAYER_CLIENTS,
// e.g.  YTDLP_PLAYER_CLIENTS=default|tv,web_safari|mweb
// ("default" or an empty entry = let yt-dlp choose).
const CLIENT_PROFILES = (process.env.YTDLP_PLAYER_CLIENTS
  ? process.env.YTDLP_PLAYER_CLIENTS.split('|').map(s => s.trim())
  : ['default', 'tv,web_safari', 'mweb,tv']
).map(s => (s === '' || s === 'default' ? null : s));

// ─── PO-token provider (bgutil-ytdlp-pot-provider) ──────────────────────
// The plugin must be pip-installed into the same environment as yt-dlp and
// its server must be running. On the default http://127.0.0.1:4416 the plugin
// finds it by itself, so you only need this when the URL differs.
function potBaseUrl() {
  return process.env.YTDLP_POT_BASE_URL || process.env.YTDLP_POT_PROVIDER_URL || '';
}

function isYouTubeUrl(u) {
  return /^(https?:\/\/((www|m|music)\.)?(youtube\.com|youtu\.be)\/|ytsearch\d*:)/i.test(u || '');
}

/**
 * Build shared yt-dlp args (argv style).
 * @param {object}  [opts]
 * @param {string}  [opts.ffmpegLocation]
 * @param {boolean} [opts.forYouTube=true]  Adds YouTube-only args + cookies.
 * @param {number}  [opts.attempt=1]        1-based; rotates the client profile.
 * @param {string}  [opts.cookiesPath]      Cookie file to use (e.g. from prepareCookies).
 * @returns {string[]}
 */
function buildYtdlpArgs({ ffmpegLocation, forYouTube = true, attempt = 1, cookiesPath } = {}) {
  const args = [
    '--no-warnings',
    '--no-playlist',
    '--retries', '5',
    '--fragment-retries', '5',
    '--socket-timeout', '20',
    '--force-ipv4',
  ];

  if (forYouTube) {
    args.push('--sleep-requests', '0.5');

    // ONE --extractor-args per extractor namespace; options inside it are
    // separated with ';' (repeating the flag for the same namespace does not work).
    const profile = CLIENT_PROFILES[(Math.max(attempt, 1) - 1) % CLIENT_PROFILES.length];
    if (profile) args.push('--extractor-args', `youtube:player_client=${profile}`);

    const pot = potBaseUrl();
    if (pot) args.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${pot}`);

    const runtime = jsRuntime();
    if (runtime) args.push('--js-runtimes', runtime);

    const cookies = cookiesPath || (cookiesAvailable() ? COOKIES_PATH : null);
    if (cookies) args.push('--cookies', cookies);
  }

  if (ffmpegLocation) args.push('--ffmpeg-location', ffmpegLocation);
  return args;
}

/**
 * Convert an argv-style list into the object form youtube-dl-exec wants.
 *   ['--no-warnings', '--cookies', '/x'] → { noWarnings: true, cookies: '/x' }
 * A flag that appears more than once becomes an array (youtube-dl-exec repeats
 * the flag), so multiple --extractor-args are no longer overwritten.
 */
function argsToOptions(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith('--')) continue;
    const key = flag.replace(/^--/, '').replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    let value = true;
    if (next !== undefined && !next.startsWith('--')) { value = next; i++; }

    if (key in out) out[key] = [].concat(out[key], value);
    else out[key] = value;
  }
  return out;
}

module.exports = {
  buildYtdlpArgs,
  argsToOptions,
  prepareCookies,
  cookiesAvailable,
  commandExists,
  jsRuntime,
  potBaseUrl,
  isYouTubeUrl,
  COOKIES_PATH,
  CLIENT_PROFILES,
};
