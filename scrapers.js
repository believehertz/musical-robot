const youtubedl = require('youtube-dl-exec');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const ytdlpPath = path.join(__dirname, '.venv', 'Scripts', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const ytdlp = fs.existsSync(ytdlpPath) ? youtubedl.create(ytdlpPath) : youtubedl;

// ─────────────────────────────────────────────────────────────
//  SongVault Scraper Pipeline — Parallel Edition
//
//  Two classes of scraper:
//
//  A) HTTP scrapers (fast, direct):
//     Citimuzik, Zamusic, HipHopZa, Naijaloaded, Fakaza
//     → Search the site, scrape the post page, extract a direct
//       .mp3 URL from the HTML. Returns the URL straight to
//       yt-dlp (which downloads it) or the server downloads it
//       directly via axios.
//
//  B) yt-dlp platform extractors (slower, broad):
//     Audiomack, Boomplay, Mdundo, SoundCloud, YouTube Music
//     → Spawn a yt-dlp --dump-json process to find a streamable URL.
//
//  All scrapers run IN PARALLEL with a per-scraper timeout.
//  The first successful result wins (Promise.any).
// ─────────────────────────────────────────────────────────────

const SCRAPER_TIMEOUT_MS = 14000; // 14 s hard cap per scraper

/** Reusable browser-like headers to avoid 403s */
const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Referer': 'https://www.google.com/',
};

/** Wrap a promise with a timeout. */
function withTimeout(promise, ms, label) {
    const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    );
    return Promise.race([promise, timeout]);
}

/**
 * Generic WordPress music blog scraper.
 *
 * Flow:
 *  1. GET /?s={query}  → parse search results page for post links
 *  2. GET first post   → extract first href ending in .mp3
 *
 * @param {string} baseUrl   e.g. 'https://www.citimuzik.com'
 * @param {string} label     e.g. 'Citimuzik'
 * @param {string} query     e.g. 'diamond platnumz gere'
 * @param {object} opts      optional overrides
 *   opts.searchPath         defaults to '/?s='
 *   opts.postSelector       CSS selector for post links on search page
 *   opts.mp3Selector        CSS selector for the download <a> on the post page
 */
async function wordpressScraper(baseUrl, label, query, opts = {}) {
    const searchPath  = opts.searchPath  || '/?s=';
    const postSel     = opts.postSelector || 'h2.entry-title a, h2 a, .post-title a, article h2 a, .entry-title a';
    // MP3 link selectors tried in order
    const mp3Selectors = [
        'a[href$=".mp3"]',
        'a[href*=".mp3"]',
        'a[href*="wp-content/uploads"][href*="mp3"]',
        'a[href*="timheven.com"]',
        'a[href*="live.zamusics.site"]',
        'a[href*="zamusics.site"]',
    ];

    try {
        // ── Step 1: search ────────────────────────────────────
        const searchUrl = `${baseUrl}${searchPath}${encodeURIComponent(query)}`;
        console.log(`   [${label}] Searching: ${searchUrl}`);
        const searchRes = await axios.get(searchUrl, {
            headers: BROWSER_HEADERS,
            timeout: 10000,
        });

        const $s = cheerio.load(searchRes.data);
        // Collect all post links; pick the one whose text best matches
        const postLinks = [];
        $s(postSel).each((_, el) => {
            const href = $s(el).attr('href');
            const text = $s(el).text().toLowerCase();
            if (href && href.startsWith('http')) postLinks.push({ href, text });
        });

        if (!postLinks.length) {
            console.log(`   [${label}] No post links found`);
            return null;
        }

        // Rank: prefer links whose text contains both artist and title words
        const queryWords = query.toLowerCase().split(' ').filter(w => w.length > 2);
        postLinks.sort((a, b) => {
            const scoreA = queryWords.filter(w => a.text.includes(w)).length;
            const scoreB = queryWords.filter(w => b.text.includes(w)).length;
            return scoreB - scoreA;
        });

        const postUrl = postLinks[0].href;
        console.log(`   [${label}] Fetching post: ${postUrl}`);

        // ── Step 2: extract MP3 from the post ─────────────────
        const postRes = await axios.get(postUrl, {
            headers: { ...BROWSER_HEADERS, Referer: baseUrl + '/' },
            timeout: 10000,
        });

        const $p = cheerio.load(postRes.data);
        let mp3Url = null;

        for (const sel of mp3Selectors) {
            $p(sel).each((_, el) => {
                if (mp3Url) return; // already found
                const href = $p(el).attr('href');
                if (href && (href.includes('.mp3') || href.includes('timheven') || href.includes('zamusics'))) {
                    // Strip query strings from mp3 URLs
                    mp3Url = href.split('?')[0];
                }
            });
            if (mp3Url) break;
        }

        if (!mp3Url) {
            // Last resort: scan raw HTML for any .mp3 URL
            const rawMatch = postRes.data.match(/https?:\/\/[^\s"'<>]+\.mp3/i);
            if (rawMatch) mp3Url = rawMatch[0].split('?')[0];
        }

        if (mp3Url) {
            console.log(`   [${label}] Found MP3: ${mp3Url}`);
            return mp3Url;
        }

        console.log(`   [${label}] Post found but no MP3 link extracted`);
        return null;

    } catch (err) {
        console.log(`   [${label}] Error: ${err.message}`);
        return null;
    }
}

// ─────────────────────────────────────────────────────────────
//  HTTP SCRAPERS
// ─────────────────────────────────────────────────────────────

// ── 1. Citimuzik ──────────────────────────────────────────────
// Huge East African (Bongo, Afrobeats) catalog.
// MP3s hosted on timheven.com CDN.
async function scrapeCitimuzik(artist, title) {
    return wordpressScraper(
        'https://www.citimuzik.com',
        'Citimuzik',
        `${artist} ${title}`,
        {
            postSelector: 'h1.post-title a, h2 a, .post a h2, article h2 a, h3 a',
            // Citimuzik posts list their mp3 href inline — mp3Selectors covers it
        }
    );
}

// ── 2. Zamusic ────────────────────────────────────────────────
// South African — Amapiano, Afro House, Gqom.
// MP3s hosted on live.zamusics.site CDN.
async function scrapeZamusic(artist, title) {
    return wordpressScraper(
        'https://zamusic.org',
        'Zamusic',
        `${artist} ${title}`,
        {
            searchPath: '/?s=',
        }
    );
}

// ── 3. HipHopZa ───────────────────────────────────────────────
// South African — Hip Hop, Amapiano, Maskandi.
async function scrapeHiphopza(artist, title) {
    return wordpressScraper(
        'https://hiphopza.com',
        'HipHopZa',
        `${artist} ${title}`,
    );
}

// ── 4. Naijaloaded ────────────────────────────────────────────
// Nigerian — Afrobeats, Naija pop.
// MP3s in wp-content/uploads.
async function scrapeNaijaloaded(artist, title) {
    return wordpressScraper(
        'https://www.naijaloaded.com.ng',
        'Naijaloaded',
        `${artist} ${title}`,
        {
            searchPath: '/?s=',
        }
    );
}

// ── 5. Fakaza ─────────────────────────────────────────────────
// South African — Amapiano, Hip Hop, Gqom. Huge catalog.
// The download button now routes through an ad gateway (ey43.com).
// Strategy: extract the direct up.fakaza.com or CDN mp3 URL if present,
// otherwise fall back to returning the song page URL for yt-dlp.
async function scrapeFakaza(artist, title) {
    try {
        const query = `${artist} ${title}`;
        const searchUrl = `https://fakaza.com/?s=${encodeURIComponent(query)}`;
        console.log(`   [Fakaza] Searching: ${searchUrl}`);

        const searchRes = await axios.get(searchUrl, {
            headers: BROWSER_HEADERS,
            timeout: 10000,
        });

        const $s = cheerio.load(searchRes.data);
        const postLinks = [];
        $s('h2 a, .entry-title a, article h2 a').each((_, el) => {
            const href = $s(el).attr('href');
            const text = $s(el).text().toLowerCase();
            if (href && href.includes('fakaza.com')) postLinks.push({ href, text });
        });

        if (!postLinks.length) return null;

        // Rank by query word overlap
        const qWords = query.toLowerCase().split(' ').filter(w => w.length > 2);
        postLinks.sort((a, b) => {
            const sA = qWords.filter(w => a.text.includes(w)).length;
            const sB = qWords.filter(w => b.text.includes(w)).length;
            return sB - sA;
        });

        const postUrl = postLinks[0].href;
        console.log(`   [Fakaza] Fetching post: ${postUrl}`);
        const postRes = await axios.get(postUrl, {
            headers: { ...BROWSER_HEADERS, Referer: 'https://fakaza.com/' },
            timeout: 10000,
        });

        // Try direct MP3 URL first (older posts still have up.fakaza.com links)
        const rawMp3 = postRes.data.match(/https?:\/\/[^\s"'<>]*(?:up\.fakaza\.com|wp-content\/uploads)[^\s"'<>]*\.mp3/i);
        if (rawMp3) {
            console.log(`   [Fakaza] Direct MP3: ${rawMp3[0]}`);
            return rawMp3[0].split('?')[0];
        }

        // Newer posts gate downloads behind ad redirects that yt-dlp cannot follow.
        // Return null so the pipeline falls through to YouTube instead.
        console.log(`   [Fakaza] No direct MP3 found — skipping (ad-gated download).`);
        return null;

    } catch (err) {
        console.log(`   [Fakaza] Error: ${err.message}`);
        return null;
    }
}

// ─────────────────────────────────────────────────────────────
//  yt-dlp PLATFORM SCRAPERS
// ─────────────────────────────────────────────────────────────

async function ytdlpSearch(query, label) {
    try {
        const output = await ytdlp(query, {
            dumpJson: true,
            noWarnings: true,
            noCallHome: true,
            skipDownload: true,
        });
        if (!output) return null;
        const item = Array.isArray(output) ? output[0] : output;
        if (!item) return null;
        const url = item.webpage_url || item.url;
        if (url) { console.log(`   [${label}] Found: ${url}`); return url; }
        return null;
    } catch (e) { return null; }
}

async function scrapeAudiomack(artist, title) {
    return ytdlpSearch(`amsearch1:${artist} ${title}`, 'Audiomack');
}

async function scrapeSoundCloud(artist, title) {
    return ytdlpSearch(`scsearch1:${artist} ${title}`, 'SoundCloud');
}

async function scrapeYouTubeMusic(artist, title) {
    return ytdlpSearch(`ytsearch1:${artist} ${title} official audio`, 'YouTube Music');
}

async function scrapeBoomplay(artist, title) {
    try {
        const searchUrl = `https://www.boomplay.com/search/default/${encodeURIComponent(artist + ' ' + title)}`;
        const output = await ytdlp(searchUrl, {
            dumpJson: true, noWarnings: true, noCallHome: true,
            skipDownload: true, playlistItems: '1',
        });
        if (!output) return null;
        const item = Array.isArray(output) ? output[0] : output;
        const url = item?.webpage_url || item?.url;
        if (url) { console.log(`   [Boomplay] Found: ${url}`); return url; }
        return null;
    } catch (e) { return null; }
}

async function scrapeMdundo(artist, title) {
    try {
        const searchUrl = `https://mdundo.com/search?q=${encodeURIComponent(artist + ' ' + title)}`;
        const output = await ytdlp(searchUrl, {
            dumpJson: true, noWarnings: true, noCallHome: true,
            skipDownload: true, playlistItems: '1',
        });
        if (!output) return null;
        const item = Array.isArray(output) ? output[0] : output;
        const url = item?.webpage_url || item?.url;
        if (url) { console.log(`   [Mdundo] Found: ${url}`); return url; }
        return null;
    } catch (e) { return null; }
}

// ─────────────────────────────────────────────────────────────
//  PIPELINE — ordered by speed + catalog relevance
//
//  HTTP scrapers (Citimuzik, Zamusic, HipHopZa, Naijaloaded,
//  Fakaza) return direct MP3 URLs — fastest path.
//
//  yt-dlp scrapers (Audiomack, Boomplay, Mdundo, SoundCloud,
//  YouTube Music) are broader but spawn a subprocess.
// ─────────────────────────────────────────────────────────────
const SCRAPER_PIPELINE = [
    // HTTP (direct MP3) — fastest
    { name: 'Citimuzik',    fn: scrapeCitimuzik   },
    { name: 'Zamusic',      fn: scrapeZamusic     },
    { name: 'Fakaza',       fn: scrapeFakaza      },
    { name: 'HipHopZa',     fn: scrapeHiphopza    },
    { name: 'Naijaloaded',  fn: scrapeNaijaloaded },
    // yt-dlp platform extractors — broad catalog
    { name: 'Audiomack',    fn: scrapeAudiomack   },
    { name: 'Boomplay',     fn: scrapeBoomplay    },
    { name: 'Mdundo',       fn: scrapeMdundo      },
    { name: 'SoundCloud',   fn: scrapeSoundCloud  },
    { name: 'YouTube Music',fn: scrapeYouTubeMusic},
];

/**
 * Run ALL scrapers in parallel and return the first success.
 * Falls back to { url: null, source: null } if all fail.
 */
async function runScraperPipeline(artist, title, onProgress) {
    console.log(`\n[Pipeline] Running ${SCRAPER_PIPELINE.length} scrapers in parallel...`);

    const tasks = SCRAPER_PIPELINE.map(scraper => {
        onProgress && onProgress(scraper.name);
        return withTimeout(
            scraper.fn(artist, title),
            SCRAPER_TIMEOUT_MS,
            scraper.name
        ).then(url => {
            if (!url) throw new Error(`${scraper.name} returned null`);
            return { url, source: scraper.name };
        });
    });

    try {
        const winner = await Promise.any(tasks);
        console.log(`[Pipeline] Winner: ${winner.source} → ${winner.url}`);
        return winner;
    } catch {
        console.log('[Pipeline] All scrapers failed. Falling back to YouTube.');
        return { url: null, source: null };
    }
}

module.exports = { SCRAPER_PIPELINE, runScraperPipeline };
