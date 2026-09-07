const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const cheerio = require('cheerio');
const NodeID3 = require('node-id3');
const { exec } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { promisify } = require('util');
const multer = require('multer');
const FormData = require('form-data');
const { SCRAPER_PIPELINE, runScraperPipeline } = require('./scrapers.js');
const youtubeDlExec = require('youtube-dl-exec');
const ytdlpPath = path.join(__dirname, '.venv', 'Scripts', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const youtubedl = fs.existsSync(ytdlpPath) ? youtubeDlExec.create(ytdlpPath) : youtubeDlExec;
console.log(`Using yt-dlp executable: ${fs.existsSync(ytdlpPath) ? ytdlpPath : youtubeDlExec.constants.YOUTUBE_DL_PATH}`);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }); // memory storage for audio
const sessionStore = {}; // Store temporary paths for final delivery

// Use an application-specific storage folder instead of raw system tmp
const APP_STORAGE = process.env.VERCEL
    ? path.join(os.tmpdir(), 'songvault-storage')
    : path.join(__dirname, 'storage');
if (!fs.existsSync(APP_STORAGE)) fs.mkdirSync(APP_STORAGE, { recursive: true });

// Persist completed downloads metadata to disk
const COMPLETED_DB = path.join(APP_STORAGE, 'completed.json');
function loadCompletedDB() {
    try {
        if (fs.existsSync(COMPLETED_DB)) return JSON.parse(fs.readFileSync(COMPLETED_DB, 'utf8')) || [];
    } catch (e) { console.error('Could not read completed DB:', e.message); }
    return [];
}
function saveCompletedDB(arr) {
    try { fs.writeFileSync(COMPLETED_DB, JSON.stringify(arr, null, 2)); } catch (e) { console.error('Could not save completed DB:', e.message); }
}
let completedDB = loadCompletedDB();

// Cleanup old files in APP_STORAGE older than 24 hours (best-effort)
try {
    const files = fs.readdirSync(APP_STORAGE);
    const now = Date.now();
    files.forEach(f => {
        try {
            const p = path.join(APP_STORAGE, f);
            const stat = fs.statSync(p);
            if (stat.isFile() && now - stat.mtimeMs > 24 * 60 * 60 * 1000) {
                fs.unlinkSync(p);
            }
        } catch (e) {}
    });
} catch (e) { console.error('Storage cleanup failed:', e.message); }

const app = express();
const API_TOKEN = process.env.SONGVAULT_API_KEY || 'songvault-local-dev';
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false,
    hidePoweredBy: true,
    frameguard: { action: 'deny' },
}));
app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please slow down.' },
});
app.use('/api/', apiLimiter);
app.use(express.json({ limit: '2mb' }));
app.use('/api', (req, res, next) => {
    if (req.path === '/health') return next();
    if (['index.html', 'index.css', 'app.js'].includes(req.query.asset)) return next();
    const authHeader = req.headers.authorization || '';
    const expected = `Bearer ${API_TOKEN}`;
    const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
    if (authHeader !== expected && queryToken !== API_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
});
app.use(express.static(path.join(__dirname))); // Serve static files
app.get('/', (req, res) => {
    const asset = req.query.asset;
    const allowedAssets = {
        'index.html': ['text/html; charset=UTF-8', 'index.html'],
        'index.css': ['text/css; charset=UTF-8', 'index.css'],
        'app.js': ['application/javascript; charset=UTF-8', 'app.js'],
    };
    if (asset && allowedAssets[asset]) {
        const [contentType, filename] = allowedAssets[asset];
        res.type(contentType).sendFile(path.join(__dirname, filename));
        return;
    }
    let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    if (process.env.VERCEL) {
        const css = fs.readFileSync(path.join(__dirname, 'index.css'), 'utf8');
        const javascript = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
        html = html
            .replace('<link rel="stylesheet" href="/index.css" />', `<style>${css}</style>`)
            .replace('<script src="/app.js"></script>', `<script>${javascript}</script>`);
    }
    res.type('html').send(html);
});

function isSafeRemoteUrl(rawUrl) {
    if (!rawUrl) return false;
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        return false;
    }

    if (!['http:', 'https:'].includes(url.protocol)) return false;

    const host = url.hostname.toLowerCase();
    const blockedHosts = ['localhost', '127.0.0.1', '::1', '0.0.0.0', '10.0.0.0', '169.254.169.254', 'internal', 'local'];
    if (blockedHosts.some(value => host === value || host.endsWith('.local') || host.endsWith('.internal'))) {
        return false;
    }

    if (host === 'localhost' || host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('172.')) {
        return false;
    }

    return true;
}

// Helper to download an image to buffer
async function downloadImage(url) {
    if (!isSafeRemoteUrl(url)) {
        console.warn('Blocked unsafe cover art URL:', url);
        return null;
    }

    try {
        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
        return Buffer.from(res.data, 'binary');
    } catch (err) {
        console.error('Failed to download cover art:', err.message);
        return null;
    }
}

// 2. SSE Download Progress endpoint
app.get('/api/download-progress', async (req, res) => {
    const { title, artist, album, year, genre, trackNumber, trackCount, cover, id } = req.query;
    if (!title || !id) return res.status(400).json({ error: 'Title and ID are required' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendMsg = (msg) => res.write(`data: ${JSON.stringify({ message: msg })}\n\n`);

    console.log(`\n--- Starting priority download process for: ${artist} - ${title} ---`);

    let downloadUrl = null;
    let sourceUsed = '';

    // Step 1: Run all scrapers IN PARALLEL — resolves at the speed of the fastest winner
    sendMsg('Scanning music sources...');
    const scraperResult = await runScraperPipeline(
        artist || '',
        title,
        (scraperName) => console.log(`   Trying ${scraperName}...`)
    );

    if (scraperResult.url) {
        downloadUrl = scraperResult.url;
        sourceUsed  = scraperResult.source;
        sendMsg(`Found on ${sourceUsed}!`);
    } else {
        sendMsg('Falling back to YouTube...');
        console.log('   All scrapers failed. Falling back to YouTube...');
        downloadUrl = `ytsearch1:${artist} ${title} official audio`;
        sourceUsed  = 'YouTube';
    }

    sendMsg('Processing audio...');
    // Store generated files in APP_STORAGE to avoid writing into system temp directly
    const finalMp3Path = path.join(APP_STORAGE, `${id}.mp3`);
    const partMp3Path = path.join(APP_STORAGE, `${id}-${Date.now()}.part`);

    // Only validate safety for real HTTP(S) URLs. Skip validation for
    // ytsearch/yt-dlp pseudo-specifiers (e.g. 'ytsearch1:...').
    const isDirectMp3Guess = !!(downloadUrl && downloadUrl.match(/^https?:\/\//i));
    if (isDirectMp3Guess && !isSafeRemoteUrl(downloadUrl)) {
        throw new Error('Unsafe media source URL');
    }

    try {
        // Determine whether this is a direct MP3 link (fast) or needs yt-dlp
        const isDirectMp3 = !!downloadUrl.match(/^https?:\/\/[^\s]+\.mp3(\?.*)?$/i);

        // Helper: simple retry/backoff
        const backoff = ms => new Promise(r => setTimeout(r, ms));

        if (isDirectMp3) {
            console.log(`2. Direct MP3 download from ${sourceUsed}: ${downloadUrl}`);
            sendMsg(`Downloading from ${sourceUsed}...`);

            // Try up to 4 attempts for flaky connections
            const maxAttempts = 4;
            let lastErr = null;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    // Stream download to avoid buffering large files into memory
                    const resp = await axios.get(downloadUrl, {
                        responseType: 'stream',
                        timeout: 60000,
                        headers: {
                            'User-Agent': 'SongVault/1.0 (compatible)',
                            'Referer': new URL(downloadUrl).origin + '/',
                        },
                    });

                    await new Promise((resolve, reject) => {
                        const writer = fs.createWriteStream(partMp3Path);
                        resp.data.pipe(writer);
                        let errored = false;
                        writer.on('error', err => { errored = true; reject(err); });
                        writer.on('finish', () => { if (!errored) resolve(); });
                    });

                    // Atomic move to final path (overwrite if exists)
                    try { fs.renameSync(partMp3Path, finalMp3Path); } catch (e) {
                        // fallback copy+unlink
                        fs.copyFileSync(partMp3Path, finalMp3Path);
                        fs.unlinkSync(partMp3Path);
                    }

                    console.log('Direct download complete.');
                    lastErr = null;
                    break;
                } catch (err) {
                    lastErr = err;
                    console.error(`Direct download attempt ${attempt} failed:`, err.message || err);
                    // remove partial file if exists
                    try { if (fs.existsSync(partMp3Path)) fs.unlinkSync(partMp3Path); } catch (e) {}
                    if (attempt < maxAttempts) await backoff(1000 * attempt);
                }
            }
            if (lastErr) throw lastErr;

        } else {
            // Use spawn with args to avoid shell interpolation vulnerabilities
            const outTemplate = partMp3Path.replace('.part', '') + '.%(ext)s';
            const args = [
                downloadUrl,
                '--extract-audio',
                '--audio-format', 'mp3',
                '--audio-quality', '0',
                '--no-playlist',
                '-o', outTemplate,
                '--ffmpeg-location', ffmpegPath,
            ];
            if (sourceUsed === 'YouTube') {
                args.splice(0, 0, '--match-filter', 'duration < 600');
            }

            console.log(`2. Running yt-dlp with args: ${args.join(' ')}`);

            // Try youtubedl a few times in case of transient failures
            const maxYtAttempts = 3;
            let ytLastErr = null;
            for (let attempt = 1; attempt <= maxYtAttempts; attempt++) {
                try {
                    // Use the bundled youtube-dl-exec so a system yt-dlp binary is not required
                    const ytdlOpts = {
                        output: outTemplate,
                        extractAudio: true,
                        audioFormat: 'mp3',
                        audioQuality: '0',
                        noPlaylist: true,
                        ffmpegLocation: ffmpegPath,
                        noWarnings: true,
                        preferFreeFormats: true,
                        noCallHome: true,
                    };
                    if (sourceUsed === 'YouTube') ytdlOpts.matchFilter = 'duration < 600';

                    const ytdlpArgs = [
                        downloadUrl,
                        '--extract-audio',
                        '--audio-format', 'mp3',
                        '--audio-quality', '0',
                        '--no-playlist',
                        '-o', outTemplate,
                        '--ffmpeg-location', ffmpegPath,
                        '--no-warnings',
                        '--no-call-home',
                    ];
                    if (sourceUsed === 'YouTube') ytdlpArgs.unshift('--match-filter', 'duration < 600');

                    const executable = fs.existsSync(ytdlpPath)
                        ? ytdlpPath
                        : youtubeDlExec.constants.YOUTUBE_DL_PATH;
                    await new Promise((resolve, reject) => {
                        const child = require('child_process').spawn(executable, ytdlpArgs, {
                            windowsHide: true,
                            shell: false,
                            stdio: ['ignore', 'pipe', 'pipe'],
                        });
                        let stderr = '';
                        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
                        child.on('error', reject);
                        child.on('close', code => {
                            if (code === 0) return resolve();
                            reject(new Error(`yt-dlp exited with code ${code}: ${stderr.slice(-4000)}`));
                        });
                    });

                    // Find the produced file
                    const producedPrefix = partMp3Path.replace('.part', '');
                    const producedCandidates = fs.readdirSync(APP_STORAGE).filter(f => f.startsWith(path.basename(producedPrefix)) && f.toLowerCase().endsWith('.mp3'));
                    if (producedCandidates.length === 0) throw new Error('youtubedl did not produce an mp3 file');
                    const producedPath = path.join(APP_STORAGE, producedCandidates[0]);
                    try { fs.renameSync(producedPath, finalMp3Path); } catch (e) {
                        fs.copyFileSync(producedPath, finalMp3Path);
                        fs.unlinkSync(producedPath);
                    }

                    ytLastErr = null;
                    break;
                } catch (err) {
                    ytLastErr = err;
                    console.error(`youtubedl attempt ${attempt} failed:`, err && err.stack ? err.stack : (err.message || err));
                    // write debug file for post-mortem
                    try {
                        const dbgPath = path.join(APP_STORAGE, `ytdl-error-${id}.log`);
                        fs.appendFileSync(dbgPath, `${new Date().toISOString()} attempt ${attempt} error:\n${err && err.stack ? err.stack : err}\n\n`);
                    } catch (e) { console.error('Could not write debug log:', e.message); }
                    // cleanup any partial outputs matching our prefix
                    try {
                        const prefix = partMp3Path.replace('.part','');
                        fs.readdirSync(APP_STORAGE).forEach(f => {
                            if (f.startsWith(path.basename(prefix)) && (f.endsWith('.mp3') || f.endsWith('.tmp') || f.endsWith('.part'))) {
                                try { fs.unlinkSync(path.join(APP_STORAGE, f)); } catch (e) {}
                            }
                        });
                    } catch (e) {}
                    if (attempt < maxYtAttempts) await backoff(1500 * attempt);
                }
            }
            if (ytLastErr) throw ytLastErr;
        }

        if (!fs.existsSync(finalMp3Path)) {
            throw new Error("Downloaded file not found at " + finalMp3Path);
        }

        sendMsg('Embedding metadata...');
        let imageBuffer = null;
        if (cover) {
            const hqCover = cover.replace('100x100bb', '600x600bb').replace('100x100', '600x600');
            imageBuffer = await downloadImage(hqCover);
        }

        const tags = {
            title:  title,
            artist: artist  || 'Unknown Artist',
            album:  album   || 'Unknown Album',
            year:   year    || '',
            genre:  genre   || '',
        };

        // Track number — node-id3 expects "N" or "N/Total"
        if (trackNumber) {
            tags.trackNumber = trackCount ? `${trackNumber}/${trackCount}` : `${trackNumber}`;
        }

        if (imageBuffer) {
            tags.image = {
                mime: 'image/jpeg',
                type: { id: 3, name: 'front cover' },
                description: 'Cover Art',
                imageBuffer: imageBuffer
            };
        }

        NodeID3.write(tags, finalMp3Path);

        // Store file info for actual delivery
        sessionStore[id] = { path: finalMp3Path, source: sourceUsed };

        // Record completed metadata for persistence (cleanup will remove file after serve)
        try {
            const filename = `${artist || 'Unknown Artist'} - ${title}.mp3`;
            const now = Date.now();
            completedDB.push({ id, title, artist, filename, source: sourceUsed, timestamp: now });
            saveCompletedDB(completedDB);
        } catch (e) { console.error('Could not persist completed metadata:', e.message); }

        // Notify client that file is ready
        res.write(`data: ${JSON.stringify({ status: 'READY', source: sourceUsed })}\n\n`);
        res.end();
    } catch (err) {
        console.error('Download process failed:', err && err.stack ? err.stack : err.message);
        res.write(`data: ${JSON.stringify({ status: 'ERROR', message: err.message })}\n\n`);
        res.end();
        if (fs.existsSync(finalMp3Path)) {
            try { fs.unlinkSync(finalMp3Path); } catch (e) {}
        }
    }
});

// 3. Serve the finalized MP3 file
app.get('/api/serve-file', (req, res) => {
    const { id, title, artist } = req.query;
    const session = sessionStore[id];
    
    if (!session || !fs.existsSync(session.path)) {
        return res.status(404).send('File not found or expired.');
    }

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(artist)} - ${encodeURIComponent(title)}.mp3"`);
    res.setHeader('Content-Type', 'audio/mpeg');
    
    const fileStream = fs.createReadStream(session.path);
    fileStream.pipe(res);

    fileStream.on('end', () => {
        try {
            fs.unlinkSync(session.path);
            delete sessionStore[id];
        } catch (e) {
            console.error("Cleanup error:", e);
        }
    });
});

// ─── Search: iTunes + MusicBrainz in parallel ────────────────────────────────
// Runs both APIs simultaneously and returns a merged, deduplicated result set.
// Either source can fail independently without breaking the whole search.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
    const { query, limit = 200 } = req.query;
    if (!query) return res.status(400).json({ error: 'query param required' });

    // ── iTunes ────────────────────────────────────────────────
    async function fetchItunes() {
        const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=${Math.min(limit, 200)}&version=2`;
        let lastErr;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const r = await axios.get(url, { timeout: 25000 });
                return (r.data.results || []).map(t => ({
                    _source: 'itunes',
                    trackId:          String(t.trackId || ''),
                    trackName:        t.trackName        || '',
                    artistName:       t.artistName       || '',
                    collectionName:   t.collectionName   || '',
                    trackTimeMillis:  t.trackTimeMillis  || 0,
                    artworkUrl100:    t.artworkUrl100     || '',
                    artworkUrl60:     t.artworkUrl60      || '',
                    releaseDate:      t.releaseDate       || '',
                    primaryGenreName: t.primaryGenreName  || '',
                    trackNumber:      t.trackNumber       || '',
                    trackCount:       t.trackCount        || '',
                    discNumber:       t.discNumber        || '',
                }));
            } catch (err) {
                lastErr = err;
                if (attempt < 3) await new Promise(r => setTimeout(r, 1500 * attempt));
            }
        }
        throw lastErr;
    }

    // ── MusicBrainz ───────────────────────────────────────────
    // MusicBrainz returns recordings; we enrich each with
    // release + cover art from the Cover Art Archive.
    async function fetchMusicBrainz() {
        const mbUrl = `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(query)}&limit=100&fmt=json`;
        const r = await axios.get(mbUrl, {
            timeout: 30000,
            headers: { 'User-Agent': 'SongVault/1.0 (songvault@localhost)' },
        });

        const recordings = r.data.recordings || [];
        return recordings.map(rec => {
            // Pick the first release that has a date
            const release = (rec.releases || []).find(rel => rel.date) || rec.releases?.[0] || {};
            const releaseGroupId = release['release-group']?.id || '';
            const releaseId      = release.id || '';

            // Cover art: Cover Art Archive URL (no extra request needed — predictable URL)
            const artworkUrl = releaseId
                ? `https://coverartarchive.org/release/${releaseId}/front-250`
                : '';

            // Duration: MusicBrainz gives milliseconds as `length`
            const ms = rec.length || 0;

            // Track number from the first medium
            const medium  = release?.media?.[0];
            const track   = medium?.track?.[0];
            const trackNo = track?.number || '';
            const trackCount = medium?.['track-count'] || '';

            return {
                _source: 'musicbrainz',
                trackId:          `mb-${rec.id}`,
                trackName:        rec.title           || '',
                artistName:       rec['artist-credit']?.[0]?.artist?.name || '',
                collectionName:   release.title        || '',
                trackTimeMillis:  ms,
                artworkUrl100:    artworkUrl,
                artworkUrl60:     artworkUrl,
                releaseDate:      release.date          || '',
                primaryGenreName: rec.genres?.[0]?.name || rec.tags?.[0]?.name || '',
                trackNumber:      trackNo,
                trackCount:       trackCount,
                discNumber:       medium?.position      || '',
                releaseGroupId,
                releaseId,
            };
        });
    }

    // ── Run in parallel ───────────────────────────────────────
    const [itunesResult, mbResult] = await Promise.allSettled([fetchItunes(), fetchMusicBrainz()]);

    const itunesTracks = itunesResult.status === 'fulfilled' ? itunesResult.value : [];
    const mbTracks     = mbResult.status     === 'fulfilled' ? mbResult.value     : [];

    if (itunesResult.status === 'rejected') console.error('iTunes failed:', itunesResult.reason?.message);
    if (mbResult.status     === 'rejected') console.error('MusicBrainz failed:', mbResult.reason?.message);

    // ── Deduplicate ───────────────────────────────────────────
    // Normalise a string for fuzzy comparison
    function norm(s) {
        return (s || '').toLowerCase()
            .replace(/[^\w\s]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // Build a Set of "title|artist" keys from iTunes results (prefer iTunes — better artwork)
    const seen = new Set(
        itunesTracks.map(t => `${norm(t.trackName)}|${norm(t.artistName)}`)
    );

    // Only add MusicBrainz tracks that aren't already covered by iTunes
    const uniqueMbTracks = mbTracks.filter(t => {
        const key = `${norm(t.trackName)}|${norm(t.artistName)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    // iTunes results first (better metadata/artwork), then unique MB results
    const merged = [...itunesTracks, ...uniqueMbTracks];

    res.json({ results: merged, _meta: { itunes: itunesTracks.length, musicbrainz: uniqueMbTracks.length } });
});

// Proxy for AudD API recognition
app.post('/api/recognize', upload.single('audio'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No audio file provided' });
    }

    try {
        const formData = new FormData();
        formData.append('file', req.file.buffer, {
            filename: 'recording.webm',
            contentType: req.file.mimetype,
        });
        formData.append('api_token', 'test'); // Dummy token for testing
        formData.append('return', 'spotify');

        const response = await axios.post('https://api.audd.io/', formData, {
            headers: formData.getHeaders(),
        });

        res.json(response.data);
    } catch (err) {
        console.error('AudD API failed:', err.response?.data || err.message);
        res.status(500).json({ error: 'Recognition failed' });
    }
});

// ─── Spotify playlist / album track resolver ───────────────────────────────
// Uses Spotify's public token endpoint (no user OAuth needed) to fetch
// track listings from any public playlist or album URL.
//
// Strategy:
//   1. GET https://open.spotify.com/get_access_token  → short-lived public token
//   2. Parse the Spotify ID + type from the URL
//   3. Hit the Web API:
//        /v1/playlists/{id}/tracks   (playlist)
//        /v1/albums/{id}/tracks      (album)
//   4. Return a flat list of { title, artist, album, year, artworkUrl }
//      so the frontend can queue them all for iTunes lookup + download.
// ─────────────────────────────────────────────────────────────────────────────

let _spotifyToken = null;
let _spotifyTokenExpiry = 0;

async function getSpotifyToken() {
    if (_spotifyToken && Date.now() < _spotifyTokenExpiry) return _spotifyToken;
    const res = await axios.get('https://open.spotify.com/get_access_token?reason=transport&productType=web_player', {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json',
            'Accept-Language': 'en',
            'Referer': 'https://open.spotify.com/',
        },
    });
    _spotifyToken = res.data.accessToken;
    _spotifyTokenExpiry = Date.now() + (res.data.accessTokenExpirationTimestampMs - Date.now()) - 30000;
    return _spotifyToken;
}

app.get('/api/spotify-tracks', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url param required' });

    // Parse type + ID from the Spotify URL
    const match = url.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?(track|playlist|album)\/([A-Za-z0-9]+)/);
    if (!match) return res.status(400).json({ error: 'Unrecognised Spotify URL' });

    const [, type, id] = match;

    try {
        const token = await getSpotifyToken();
        const headers = { Authorization: `Bearer ${token}` };
        const tracks = [];

        if (type === 'track') {
            // Single track — just return its info
            const r = await axios.get(`https://api.spotify.com/v1/tracks/${id}`, { headers });
            const t = r.data;
            tracks.push({
                title: t.name,
                artist: t.artists.map(a => a.name).join(', '),
                album: t.album.name,
                year: t.album.release_date?.substring(0, 4) || '',
                artworkUrl: t.album.images?.[0]?.url || '',
                trackNumber: t.track_number,
                trackCount: t.album.total_tracks,
            });

        } else if (type === 'playlist') {
            // Paginate through playlist tracks (up to 200)
            let apiUrl = `https://api.spotify.com/v1/playlists/${id}/tracks?limit=100&fields=next,items(track(name,artists,album(name,images,release_date,total_tracks),track_number,disc_number))`;
            while (apiUrl && tracks.length < 200) {
                const r = await axios.get(apiUrl, { headers });
                for (const item of r.data.items) {
                    const t = item?.track;
                    if (!t || !t.name) continue; // skip null/local tracks
                    tracks.push({
                        title: t.name,
                        artist: t.artists.map(a => a.name).join(', '),
                        album: t.album.name,
                        year: t.album.release_date?.substring(0, 4) || '',
                        artworkUrl: t.album.images?.[0]?.url || '',
                        trackNumber: t.track_number,
                        trackCount: t.album.total_tracks,
                    });
                }
                apiUrl = r.data.next || null;
            }

        } else if (type === 'album') {
            // Albums — also paginate
            // First get album meta (artwork, year)
            const albumMeta = await axios.get(`https://api.spotify.com/v1/albums/${id}`, { headers });
            const albumName = albumMeta.data.name;
            const albumArt  = albumMeta.data.images?.[0]?.url || '';
            const albumYear = albumMeta.data.release_date?.substring(0, 4) || '';
            const totalTracks = albumMeta.data.total_tracks;

            let apiUrl = `https://api.spotify.com/v1/albums/${id}/tracks?limit=50`;
            while (apiUrl && tracks.length < 200) {
                const r = await axios.get(apiUrl, { headers });
                for (const t of r.data.items) {
                    tracks.push({
                        title: t.name,
                        artist: t.artists.map(a => a.name).join(', '),
                        album: albumName,
                        year: albumYear,
                        artworkUrl: albumArt,
                        trackNumber: t.track_number,
                        trackCount: totalTracks,
                    });
                }
                apiUrl = r.data.next || null;
            }
        }

        res.json({ type, id, tracks });

    } catch (err) {
        console.error('Spotify API error:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to fetch Spotify tracks', detail: err.message });
    }
});

// Simple health check
app.get('/api/health', (req, res) => {
    const storageInfo = { storagePath: APP_STORAGE };
    res.json({ status: 'ok', storage: storageInfo, uptime: process.uptime() });
});

// Return persisted completed downloads metadata
app.get('/api/completed', (req, res) => {
    res.json({ completed: completedDB });
});

// Clear persisted completed metadata (useful for UI clear). This does NOT remove files still on disk.
app.post('/api/clear-completed', (req, res) => {
    completedDB = [];
    try { if (fs.existsSync(COMPLETED_DB)) fs.unlinkSync(COMPLETED_DB); } catch (e) { console.error('Could not delete completed DB file:', e.message); }
    res.json({ ok: true });
});

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`\n======================================`);
        console.log(`🎵 SongVault Backend Server is RUNNING!`);
        console.log(`🚀 http://localhost:${PORT}`);
        console.log(`======================================\n`);
    });
}

module.exports = app;
