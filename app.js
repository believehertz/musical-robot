/* ══════════════════════════════════════════════════════════════
   SongVault — Real API-powered Application Logic
   APIs used:
     • Spotify oEmbed  → https://open.spotify.com/oembed?url=…
     • iTunes Search    → https://itunes.apple.com/search?…
     • iTunes previewUrl → actual 30-sec MP3 blob download
   ══════════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  // ── DOM REFERENCES ──
  const $ = (sel) => document.querySelector(sel);
  const API_AUTH_TOKEN = window.__SONGVAULT_API_TOKEN__ || 'songvault-local-dev';

  function authHeaders(extra = {}) {
    return {
      ...extra,
      Authorization: `Bearer ${API_AUTH_TOKEN}`,
    };
  }

  const tabUrl        = $('#tab-url');
  const tabSearch     = $('#tab-search');
  const tabIdentify   = $('#tab-identify');
  const tabBar        = $('#mode-tabs');
  const inputUrl      = $('#input-url');
  const inputSearch   = $('#input-search');
  const inputIdentify = $('#input-identify');
  const urlField      = $('#url-input');
  const searchField   = $('#search-input');
  const btnFindUrl    = $('#btn-find-url');
  const btnFindSearch = $('#btn-find-search');
  const resultsSection = $('#results-section');
  const resultsList   = $('#results-list');
  const skeletonList  = $('#skeleton-list');
  const resultsTitle  = $('#results-title');
  // #btn-download-selected was removed from HTML in favour of the floating bar.
  // Keep a null-safe stub so legacy references don't throw.
  const btnDlSelected = null;
  const selectedCount  = null;
  const queueSection  = $('#queue-section');
  const queueList     = $('#queue-list');
  const completedSection = $('#completed-section');
  const completedList = $('#completed-list');

  let currentMode = 'url';

  // Track only active/in-flight downloads so the same song can be downloaded again.
  const activeDownloadKeys = new Set();

  // Audio player for in-app preview
  let currentAudio = null;
  let currentPlayBtn = null;

  function getSongKey(song) {
    return `${(song.title || '').toLowerCase().trim()}|${(song.artist || '').toLowerCase().trim()}`;
  }

  function isSongLocked(song) {
    return activeDownloadKeys.has(getSongKey(song));
  }

  // ═══════════════════════════════════════════
  //  TAB SWITCHING
  // ═══════════════════════════════════════════

  function setMode(mode) {
    currentMode = mode;
    tabBar.setAttribute('data-active', mode);
    tabUrl.classList.toggle('active', mode === 'url');
    tabSearch.classList.toggle('active', mode === 'search');
    tabIdentify.classList.toggle('active', mode === 'identify');
    tabUrl.setAttribute('aria-pressed', mode === 'url');
    tabSearch.setAttribute('aria-pressed', mode === 'search');
    tabIdentify.setAttribute('aria-pressed', mode === 'identify');
    inputUrl.classList.toggle('active', mode === 'url');
    inputSearch.classList.toggle('active', mode === 'search');
    inputIdentify.classList.toggle('active', mode === 'identify');
    hideResults();
  }

  tabUrl.addEventListener('click', () => setMode('url'));
  tabSearch.addEventListener('click', () => setMode('search'));
  tabIdentify.addEventListener('click', () => setMode('identify'));

  // ═══════════════════════════════════════════
  //  SPOTIFY oEMBED API
  // ═══════════════════════════════════════════

  /**
   * Calls Spotify oEmbed to extract song title & artist from a Spotify URL.
   * The response JSON contains:
   *   title        → "Song Name"  (for tracks) or "Playlist Name" (for playlists)
   *   thumbnail_url → album/playlist art
   *   html         → iframe embed (we parse the <title> attr which sometimes has more info)
   *
   * Spotify oEmbed does NOT return a separate "artist" field for tracks,
   * but it does have an undocumented "provider_name" and sometimes the title
   * includes "by Artist". We'll extract what we can.
   *
   * Returns { title, artist, thumbnail } or throws.
   */
  async function spotifyOembed(spotifyUrl) {
    const endpoint = `https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`;
    const res = await fetch(endpoint);
    if (!res.ok) throw new Error(`Spotify oEmbed error: ${res.status}`);
    const data = await res.json();

    const rawTitle = data.title || '';
    const thumbnail = data.thumbnail_url || '';

    // The iframe HTML's title attribute sometimes has "Spotify Embed: Title"
    // For albums/playlists, data.title is the collection name.
    // For tracks, data.title is the song name.

    // Attempt to extract artist from the HTML embed.
    // The iframe title is typically "Spotify Embed: Track Name" — no artist.
    // However, the `description` field or `author_name` may exist in newer responses.
    let artist = '';
    if (data.author_name) {
      artist = data.author_name;
    }

    // If no author_name, try to parse from the HTML title attr:
    // <iframe ... title="Spotify Embed: Song by Artist"> (sometimes)
    if (!artist && data.html) {
      const iframeTitleMatch = data.html.match(/title="[^"]*?:\s*(.+?)"/i);
      if (iframeTitleMatch) {
        const iframeTitle = iframeTitleMatch[1].trim();
        // If it differs from rawTitle, it may contain extra info
        if (iframeTitle !== rawTitle && iframeTitle.length > rawTitle.length) {
          artist = iframeTitle.replace(rawTitle, '').replace(/^[\s\-–—,]+/, '').trim();
        }
      }
    }

    return { title: rawTitle, artist, thumbnail };
  }

  // ═══════════════════════════════════════════
  //  SEARCH API  (iTunes + MusicBrainz)
  // ═══════════════════════════════════════════

  /**
   * Search songs via the server proxy (iTunes + MusicBrainz in parallel).
   * Both sources are normalised server-side to the same field names, so
   * this function handles both identically.
   */
  async function searchItunes(query, limit = 200) {
    const endpoint = `/api/search?query=${encodeURIComponent(query)}&limit=${limit}`;
    try {
      const res = await fetch(endpoint, { headers: authHeaders() });
      if (!res.ok) throw new Error(`Search error: ${res.status}`);
      const data = await res.json();
      const tracks = normalizeItunesResults(data.results || []);
      // Log source breakdown to console for debugging
      if (data._meta) console.log(`Search: ${data._meta.itunes} iTunes + ${data._meta.musicbrainz} MusicBrainz results`);
      return tracks;
    } catch (err) {
      console.error('Search fetch failed:', err);
      return [];
    }
  }

  /**
   * Normalise the merged iTunes+MusicBrainz results into our internal format.
   * The server already unifies both into the same field names.
   */
  function normalizeItunesResults(results) {
    return results.map((r, idx) => {
      const ms = r.trackTimeMillis || 0;
      const totalSec = Math.round(ms / 1000);
      const min = Math.floor(totalSec / 60);
      const sec = totalSec % 60;
      const durationStr = ms ? `${min}:${String(sec).padStart(2, '0')}` : '';

      // Release year — iTunes gives ISO date; MusicBrainz gives "YYYY", "YYYY-MM", or "YYYY-MM-DD"
      const releaseYear = r.releaseDate ? r.releaseDate.substring(0, 4) : '';

      const collectionName = r.collectionName
        || (r.trackName ? `${r.trackName} - Single` : 'Unknown Album');

      // Artwork: iTunes gives a full URL; MusicBrainz gives a Cover Art Archive URL.
      // For MusicBrainz, the URL may 404 if no art is indexed — that's fine, the
      // placeholder kicks in on the frontend.
      const rawArt = r.artworkUrl100 || r.artworkUrl60 || '';
      const artworkUrl = rawArt
        ? rawArt.replace('100x100bb', '600x600bb').replace('100x100', '600x600')
        : '';

      return {
        id: r.trackId ? String(r.trackId) : `result-${idx}-${Date.now()}`,
        title:        r.trackName        || 'Unknown Title',
        artist:       r.artistName       || 'Unknown Artist',
        albumArtist:  r.artistName       || 'Unknown Artist',
        duration:     durationStr,
        artworkUrl,
        collectionName,
        releaseYear,
        genre:        r.primaryGenreName || '',
        trackNumber:  r.trackNumber      || '',
        trackCount:   r.trackCount       || '',
        discNumber:   r.discNumber       || '',
        source:       'Full Audio',
        _searchSource: r._source || 'itunes', // 'itunes' | 'musicbrainz'
      };
    });
  }

  /**
   * We don't use this fetch-stream approach anymore.
   * Replaced by EventSource in startRealDownload.
   */
  async function downloadMp3() { return null; }

  // ═══════════════════════════════════════════
  //  URL PASTE HANDLER
  // ═══════════════════════════════════════════

  btnFindUrl.addEventListener('click', async () => {
    const url = urlField.value.trim();
    if (!url) { urlField.focus(); return; }

    // Validate Spotify URL
    const isSpotify = /open\.spotify\.com\/(track|playlist|album|intl-[a-z]+\/track)/i.test(url);
    if (!isSpotify) {
      showError('⚠ Please paste a valid Spotify track or playlist URL.', 'warning');
      return;
    }

    // Detect URL type
    const urlType = /open\.spotify\.com\/(?:intl-[a-z]+\/)?(playlist|album|track)/i.exec(url)?.[1]?.toLowerCase();
    const isCollection = urlType === 'playlist' || urlType === 'album';

    btnFindUrl.classList.add('loading', 'scanning');
    showSkeletons();

    try {
      if (isCollection) {
        // ── PLAYLIST / ALBUM ──────────────────────────────────────
        // Fetch all tracks from the Spotify Web API via our proxy
        resultsTitle.textContent = `Loading ${urlType}…`;

        const apiRes = await fetch(`/api/spotify-tracks?url=${encodeURIComponent(url)}`);
        if (!apiRes.ok) throw new Error(`Server error: ${apiRes.status}`);
        const data = await apiRes.json();

        if (!data.tracks || data.tracks.length === 0) {
          btnFindUrl.classList.remove('loading', 'scanning');
          hideSkeletons();
          showError(`No tracks found in this ${urlType}. It may be private or empty.`, 'muted');
          return;
        }

        // Convert Spotify track objects → our internal song format
        // iTunes lookup is skipped for playlists/albums since we already have
        // all the metadata we need from Spotify. We let the downloader engine
        // handle the actual audio file search.
        const songs = data.tracks.map((t, idx) => ({
          id: `spotify-${idx}-${Date.now()}`,
          title: t.title,
          artist: t.artist,
          albumArtist: t.artist,
          duration: '',
          artworkUrl: t.artworkUrl || '',
          collectionName: t.album || 'Unknown Album',
          releaseYear: t.year || '',
          genre: '',
          trackNumber: t.trackNumber || '',
          trackCount: t.trackCount || '',
          source: 'Full Audio',
        }));

        btnFindUrl.classList.remove('loading', 'scanning');
        hideSkeletons();
        renderResults(songs, `${urlType === 'playlist' ? 'Playlist' : 'Album'}: ${songs.length} tracks`);

      } else {
        // ── SINGLE TRACK ──────────────────────────────────────────
        // Use the Spotify API via proxy to get clean title + artist
        const apiRes = await fetch(`/api/spotify-tracks?url=${encodeURIComponent(url)}`);
        let songTitle = '';
        let songArtist = '';
        let spotifyMeta = null;

        if (apiRes.ok) {
          const data = await apiRes.json();
          if (data.tracks && data.tracks.length > 0) {
            spotifyMeta = data.tracks[0];
            songTitle  = spotifyMeta.title;
            songArtist = spotifyMeta.artist;
          }
        }

        // Fallback to oEmbed if API proxy failed
        if (!songTitle) {
          const oembedData = await spotifyOembed(url);
          songTitle  = oembedData.title;
          songArtist = oembedData.artist;
        }

        const searchQuery = songArtist ? `${songTitle} ${songArtist}` : songTitle;
        resultsTitle.textContent = songArtist
          ? `Results for "${songTitle}" by ${songArtist}`
          : `Results for "${songTitle}"`;

        const results = await searchItunes(searchQuery);

        btnFindUrl.classList.remove('loading', 'scanning');
        hideSkeletons();

        if (results.length === 0) {
          showError(`No downloadable results found for "${songTitle}". Try searching manually.`, 'muted');
        } else {
          renderResults(results, resultsTitle.textContent);
        }
      }
    } catch (err) {
      console.error('URL paste error:', err);
      btnFindUrl.classList.remove('loading', 'scanning');
      hideSkeletons();
      showError('❌ Could not resolve track info. Check the URL and try again.', 'danger');
    }
  });

  urlField.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnFindUrl.click();
  });

  // ═══════════════════════════════════════════
  //  SEARCH HANDLER
  // ═══════════════════════════════════════════

  btnFindSearch.addEventListener('click', async () => {
    const q = searchField.value.trim();
    if (!q) { searchField.focus(); return; }

    btnFindSearch.classList.add('loading', 'scanning');
    showSkeletons();

    try {
      const results = await searchItunes(q);
      btnFindSearch.classList.remove('loading', 'scanning');
      hideSkeletons();

      if (results.length === 0) {
        showError(`No results found for "${q}". Try different keywords.`, 'muted');
      } else {
        renderResults(results, `Results for "${q}"`);
      }
    } catch (err) {
      console.error('Search error:', err);
      btnFindSearch.classList.remove('loading', 'scanning');
      hideSkeletons();
      showError('❌ Search failed. Please check your connection and try again.', 'danger');
    }
  });

  searchField.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnFindSearch.click();
  });

  // ═══════════════════════════════════════════
  //  UI HELPERS
  // ═══════════════════════════════════════════

  function showSkeletons() {
    resultsSection.classList.remove('hidden');
    skeletonList.classList.remove('hidden');
    resultsList.classList.add('hidden');
    if (btnDlSelected) btnDlSelected.classList.add('hidden');
    $('#pagination-controls').classList.add('hidden');
    resultsTitle.textContent = 'Scanning…';
  }

  function hideSkeletons() {
    skeletonList.classList.add('hidden');
    resultsList.classList.remove('hidden');
  }

  function hideResults() {
    resultsSection.classList.add('hidden');
    resultsList.innerHTML = '';
    if (btnDlSelected) btnDlSelected.classList.add('hidden');
    $('#pagination-controls').classList.add('hidden');
  }

  function showError(message, colorKey) {
    const colors = {
      warning: 'var(--warning)',
      danger: 'var(--danger)',
      muted: 'var(--text-muted)',
    };
    resultsSection.classList.remove('hidden');
    skeletonList.classList.add('hidden');
    resultsList.classList.remove('hidden');
    $('#pagination-controls').classList.add('hidden');
    // Use textContent to avoid any accidental HTML injection
    resultsList.innerHTML = '';
    const p = document.createElement('p');
    p.style.color = colors[colorKey] || colors.muted;
    p.style.padding = '20px';
    p.style.textAlign = 'center';
    p.textContent = message;
    resultsList.appendChild(p);
  }

  // Health check — updates header badge and status dot
  async function checkHealth() {
    try {
      const res = await fetch('/api/health', { headers: authHeaders() });
      if (!res.ok) throw new Error('no');
      const data = await res.json();
      const badge = document.querySelector('.header-badge');
      badge.querySelector('.status-dot').style.background = 'var(--success)';
      badge.querySelector('span:nth-child(2)').textContent = 'Engine Online';
    } catch (e) {
      const badge = document.querySelector('.header-badge');
      badge.querySelector('.status-dot').style.background = 'var(--danger)';
      badge.querySelector('span:nth-child(2)').textContent = 'Engine Offline';
    }
  }

  // Load completed downloads from server and render them
  async function loadCompletedFromServer() {
    try {
      const res = await fetch('/api/completed', { headers: authHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      (data.completed || []).forEach(item => {
        // Render as non-playable completed item (no blob URL)
        const div = document.createElement('div');
        div.className = 'completed-item';
        const sourceBadge = item.source === 'YouTube' ? `<span class="badge badge-yt">YouTube</span>` : `<span class="badge badge-web">${escapeHtml(item.source || '')}</span>`;
        div.innerHTML = `
          <img class="card-thumb completed-thumb" src="" alt="${escapeHtml(item.title)}" style="width:44px;height:44px;border-radius:8px;flex-shrink:0;" />
          <div class="completed-info">
            <div class="completed-title-text">${escapeHtml(item.title)}</div>
            <div class="completed-sub">${escapeHtml(item.artist)} · ${escapeHtml(item.filename || '')} · ${sourceBadge}</div>
          </div>
          <button class="btn-secondary btn-redownload" data-id="${item.id}" style="padding:8px 10px;">⬇ Re-download</button>
        `;
        completedList.appendChild(div);
      });
    } catch (e) { /* ignore */ }
  }

  // Clear completed handler
  $('#btn-clear-completed').addEventListener('click', async () => {
    try {
      await fetch('/api/clear-completed', { method: 'POST', headers: authHeaders() });
      completedList.innerHTML = '';
    } catch (e) { console.error(e); }
  });

  // Re-download persisted item
  completedList.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-redownload');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    // Find item in current results or use a minimal object
    // Server persisted minimal metadata; we request re-download by building a song stub
    fetch('/api/completed', { headers: authHeaders() }).then(r => r.json()).then(data => {
      const item = (data.completed || []).find(x => String(x.id) === String(id));
      if (!item) return;
      const song = {
        id: `re-${item.id}`,
        title: item.title,
        artist: item.artist || 'Unknown Artist',
        collectionName: item.filename || '',
        artworkUrl: '',
        duration: '',
        source: item.source || 'Web',
      };
      startRealDownload(song);
    }).catch(() => {});
  });

  // ═══════════════════════════════════════════
  //  RENDER RESULTS
  // ═══════════════════════════════════════════

  // We store the current result set so download buttons can reference them
  let currentResults = [];
  const globalSelectedSongs = new Map();
  let currentPage = 1;
  const itemsPerPage = 10;

  function renderResults(songs, title) {
    currentResults = songs;
    currentPage = 1;
    globalSelectedSongs.clear();
    updateSelectedCount();
    // Show total results count above the list
    resultsTitle.textContent = `${title} (${songs.length} songs found)`;
    resultsSection.classList.remove('hidden');
    $('#select-all-container').classList.remove('hidden');
    renderPage();
  }

  function renderPage() {
    resultsList.innerHTML = '';
    const totalPages = Math.ceil(currentResults.length / itemsPerPage);
    const startIdx = (currentPage - 1) * itemsPerPage;
    const endIdx = Math.min(startIdx + itemsPerPage, currentResults.length);
    
    const pageSongs = currentResults.slice(startIdx, endIdx);

    pageSongs.forEach((song, i) => {
      const card = document.createElement('div');
      card.className = 'song-card';
      card.style.animationDelay = `${i * 0.06}s`;
      const absoluteIdx = startIdx + i;
      card.innerHTML = buildCardHTML(song, absoluteIdx);
      resultsList.appendChild(card);
    });

    updateSelectedCount();
    renderPaginationControls(totalPages);
    
    // Scroll back to top of results automatically when changing pages
    if (currentPage > 1 || totalPages > 1) {
        resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function renderPaginationControls(totalPages) {
    const paginationControls = $('#pagination-controls');
    const paginationNumbers = $('#pagination-numbers');
    const btnPrev = $('#btn-prev-page');
    const btnNext = $('#btn-next-page');

    if (totalPages <= 1) {
      paginationControls.classList.add('hidden');
      return;
    }

    paginationControls.classList.remove('hidden');
    paginationNumbers.innerHTML = '';

    btnPrev.disabled = currentPage === 1;
    btnNext.disabled = currentPage === totalPages;

    let pages = [];
    if (totalPages <= 5) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      if (currentPage <= 3) {
        pages = [1, 2, 3, 4, '...', totalPages - 1, totalPages];
      } else if (currentPage >= totalPages - 2) {
        pages = [1, 2, '...', totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
      } else {
        pages = [1, 2, '...', currentPage - 1, currentPage, currentPage + 1, '...', totalPages - 1, totalPages];
      }
    }

    pages.forEach(p => {
      if (p === '...') {
        const span = document.createElement('span');
        span.className = 'page-ellipsis';
        span.textContent = '...';
        paginationNumbers.appendChild(span);
      } else {
        const div = document.createElement('div');
        div.className = `page-num ${p === currentPage ? 'active' : ''}`;
        div.textContent = p;
        div.addEventListener('click', () => {
          if (p !== currentPage) {
            currentPage = p;
            renderPage();
          }
        });
        paginationNumbers.appendChild(div);
      }
    });
  }

  // Bind pagination static buttons
  $('#btn-prev-page').addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--;
      renderPage();
    }
  });

  $('#btn-next-page').addEventListener('click', () => {
    const totalPages = Math.ceil(currentResults.length / itemsPerPage);
    if (currentPage < totalPages) {
      currentPage++;
      renderPage();
    }
  });

  function buildCardHTML(song, index) {
    const thumbSrc = song.artworkUrl || placeholderThumb(index);
    const songLocked = isSongLocked(song);
    const disabledAttr = songLocked ? 'disabled' : '';

    const sourceBadge = songLocked
      ? '<span class="badge badge-official">Queued</span>'
      : song._searchSource === 'musicbrainz'
        ? '<span class="badge badge-mb">MusicBrainz</span>'
        : '<span class="badge badge-official">HQ Audio</span>';
    const badgeHTML = sourceBadge;

    // Always show album — never blank
    const albumDisplay = escapeHtml(song.collectionName || 'Unknown Album');
    const yearDisplay  = song.releaseYear ? ` · ${song.releaseYear}` : '';
    const genreDisplay = song.genre ? ` · ${escapeHtml(song.genre)}` : '';

    const isGloballySelected = globalSelectedSongs.has(song.id);
    const checkedAttr = isGloballySelected ? 'checked' : '';

    return `
      <input type="checkbox" class="card-checkbox" data-index="${index}" ${disabledAttr} ${checkedAttr} id="check-${index}" />
      <img class="card-thumb" src="${thumbSrc}" alt="${escapeHtml(song.title)} artwork" loading="lazy" />
      <div class="card-info">
        <div class="card-title">${escapeHtml(song.title)}</div>
        <div class="card-meta">
          <span class="card-artist">${escapeHtml(song.artist)}</span>
          <span>·</span>
          <span>${song.duration}</span>
          ${badgeHTML}
        </div>
        <div class="card-meta" style="margin-top:2px;opacity:0.75;font-size:0.78rem;">
          <span class="card-album">${albumDisplay}${yearDisplay}${genreDisplay}</span>
        </div>
      </div>
      <button class="btn-dl" title="${songLocked ? 'Download already queued' : 'Download Full Track'}" ${disabledAttr} data-index="${index}">
        <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 12L3 7h3V2h4v5h3L8 12zM2 14h12v1H2v-1z"/></svg>
      </button>
    `;
  }

  function placeholderThumb(index) {
    const colors = ['#7C3AED', '#5B21B6', '#22D3EE', '#0E7490', '#6D28D9', '#1E1B4B'];
    const notes = ['♫', '♪', '♬', '♩', '♫', '♭'];
    const c = colors[index % colors.length];
    const n = notes[index % notes.length];
    return 'data:image/svg+xml,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" rx="6" fill="${c}"/><text x="24" y="30" text-anchor="middle" font-size="20" fill="white">${n}</text></svg>`
    );
  }

  // ═══════════════════════════════════════════
  //  CHECKBOX & SELECTION
  // ═══════════════════════════════════════════

  resultsList.addEventListener('change', (e) => {
    if (e.target.classList.contains('card-checkbox')) {
      const index = parseInt(e.target.getAttribute('data-index'), 10);
      const song = currentResults[index];
      if (e.target.checked) {
        globalSelectedSongs.set(song.id, song);
      } else {
        globalSelectedSongs.delete(song.id);
      }
      updateSelectedCount();
    }
  });

  function updateSelectedCount() {
    const count = globalSelectedSongs.size;
    
    // Update floating bar
    const floatingBar = $('#floating-selection-bar');
    const floatingCount = $('#floating-selected-count');
    if (count > 0) {
      floatingBar.classList.remove('hidden');
      floatingCount.textContent = `${count} song${count > 1 ? 's' : ''} selected`;
    } else {
      floatingBar.classList.add('hidden');
    }

    // Update select-all indeterminate state for the current page
    updateSelectAllState();
  }

  function updateSelectAllState() {
    const selectAllCheckbox = $('#check-select-all');
    if (!selectAllCheckbox) return;

    const startIdx = (currentPage - 1) * itemsPerPage;
    const endIdx = Math.min(startIdx + itemsPerPage, currentResults.length);
    const pageSongs = currentResults.slice(startIdx, endIdx);
    
    // Allow repeated downloads; only block simultaneous in-flight jobs.
    const selectableSongs = pageSongs.filter(s => !isSongLocked(s));

    if (selectableSongs.length === 0) {
      selectAllCheckbox.checked = false;
      selectAllCheckbox.indeterminate = false;
      selectAllCheckbox.disabled = true;
      return;
    }
    selectAllCheckbox.disabled = false;

    let checkedCount = 0;
    selectableSongs.forEach(s => {
      if (globalSelectedSongs.has(s.id)) checkedCount++;
    });

    if (checkedCount === 0) {
      selectAllCheckbox.checked = false;
      selectAllCheckbox.indeterminate = false;
    } else if (checkedCount === selectableSongs.length) {
      selectAllCheckbox.checked = true;
      selectAllCheckbox.indeterminate = false;
    } else {
      selectAllCheckbox.checked = false;
      selectAllCheckbox.indeterminate = true;
    }
  }

  // Select all on page listener
  $('#check-select-all').addEventListener('change', (e) => {
    const startIdx = (currentPage - 1) * itemsPerPage;
    const endIdx = Math.min(startIdx + itemsPerPage, currentResults.length);
    const pageSongs = currentResults.slice(startIdx, endIdx);

    const isChecked = e.target.checked;
    pageSongs.forEach(song => {
      // Allow repeated downloads. Only prevent duplicate in-flight jobs.
      if (isSongLocked(song)) return;

      if (isChecked) {
        globalSelectedSongs.set(song.id, song);
      } else {
        globalSelectedSongs.delete(song.id);
      }
    });

    // Visually update checkboxes on the page
    resultsList.querySelectorAll('.card-checkbox').forEach(cb => {
      if (!cb.disabled) {
        cb.checked = isChecked;
      }
    });

    updateSelectedCount();
  });

  // Floating Bar Actions
  $('#btn-floating-clear').addEventListener('click', () => {
    globalSelectedSongs.clear();
    // Uncheck visually
    resultsList.querySelectorAll('.card-checkbox').forEach(cb => {
      if (!cb.disabled) cb.checked = false;
    });
    updateSelectedCount();
  });

  $('#btn-floating-download').addEventListener('click', () => {
    const songsToDownload = Array.from(globalSelectedSongs.values());
    globalSelectedSongs.clear();
    updateSelectedCount();

    // Visually uncheck & disable to prevent double clicks
    resultsList.querySelectorAll('.card-checkbox:checked').forEach(cb => {
      cb.checked = false;
      cb.disabled = true;
      const btn = cb.closest('.song-card').querySelector('.btn-dl');
      if (btn) btn.disabled = true;
    });

    songsToDownload.forEach(song => startRealDownload(song));
  });

  // ═══════════════════════════════════════════
  //  INDIVIDUAL DOWNLOAD
  // ═══════════════════════════════════════════

  resultsList.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-dl');
    if (!btn || btn.disabled) return;
    const index = parseInt(btn.getAttribute('data-index'), 10);
    const song = currentResults[index];
    if (!song) return;

    // Only prevent concurrent duplicate jobs, not repeated downloads.
    if (isSongLocked(song)) return;

    btn.disabled = true;
    startRealDownload(song);
  });

  // ═══════════════════════════════════════════
  //  BATCH DOWNLOAD
  // ═══════════════════════════════════════════

  // Batch download is now handled by #btn-floating-download (floating bar).
  // btnDlSelected is null (element removed from HTML), so this block is a no-op guard.
  if (btnDlSelected) btnDlSelected.addEventListener('click', () => {
    const checked = resultsList.querySelectorAll('.card-checkbox:checked');
    checked.forEach(cb => {
      const index = parseInt(cb.getAttribute('data-index'), 10);
      const song = currentResults[index];
      if (song && !isSongLocked(song)) {
        startRealDownload(song);
      }
      cb.checked = false;
      cb.disabled = true;
      const card = cb.closest('.song-card');
      const dlBtn = card.querySelector('.btn-dl');
      if (dlBtn) dlBtn.disabled = true;
    });
    updateSelectedCount();
  });

  // ═══════════════════════════════════════════
  //  DOWNLOAD QUEUE ENGINE
  //  Max 3 concurrent downloads. Songs beyond
  //  that wait in pendingQueue and auto-start
  //  as slots free up.
  // ═══════════════════════════════════════════

  const MAX_CONCURRENT = 3;
  let activeDownloads = 0;
  let downloadId = 0;
  const pendingQueue = []; // { song, item, id, filename, songKey }

  // Public entry point — called from all download buttons & batch actions.
  function startRealDownload(song) {
    const songKey = getSongKey(song);
    if (activeDownloadKeys.has(songKey)) return;
    activeDownloadKeys.add(songKey); // prevent concurrent duplicates but allow repeated re-downloads later

    const id = ++downloadId;
    const sanitizedTitle  = song.title.replace(/[^\w\s\-]/g, '').trim();
    const sanitizedArtist = song.artist.replace(/[^\w\s\-]/g, '').trim();
    const filename = `${sanitizedArtist} - ${sanitizedTitle}.mp3`;

    // Build queue card immediately so all 20+ appear at once
    queueSection.classList.remove('hidden');
    const thumbSrc = song.artworkUrl || placeholderThumb(0);
    const item = document.createElement('div');
    item.className = 'queue-item';
    item.id = `queue-${id}`;
    item.innerHTML = `
      <img class="card-thumb" src="${thumbSrc}" alt="" style="width:40px;height:40px;flex-shrink:0;" />
      <div class="queue-info">
        <div class="queue-title">${escapeHtml(song.title)}</div>
        <div class="queue-artist">${escapeHtml(song.artist)} · ${escapeHtml(song.collectionName || 'Unknown Album')}</div>
        <div class="progress-wrap"><div class="progress-bar" id="bar-${id}"></div></div>
      </div>
      <div class="queue-percent" id="pct-${id}">Queued</div>
    `;
    queueList.appendChild(item);

    const entry = { song, item, id, filename, songKey };

    if (activeDownloads < MAX_CONCURRENT) {
      _beginDownload(entry);
    } else {
      pendingQueue.push(entry);
      _refreshQueuePositions();
    }
  }

  function _refreshQueuePositions() {
    pendingQueue.forEach((entry, idx) => {
      const pct = $(`#pct-${entry.id}`);
      if (pct) {
        pct.textContent = `Queued #${idx + 1}`;
        pct.style.color = 'var(--text-muted)';
        pct.style.fontSize = '12px';
      }
    });
  }

  function _processNextInQueue() {
    if (pendingQueue.length === 0) return;
    const next = pendingQueue.shift();
    _refreshQueuePositions();
    _beginDownload(next);
  }

  // Opens SSE connection and drives the actual download
  function _beginDownload({ song, item, id, filename, songKey }) {
    activeDownloads++;

    const bar = $(`#bar-${id}`);
    const pct = $(`#pct-${id}`);

    bar.style.background = 'var(--primary)';
    bar.style.animation = 'shimmer 1.5s infinite';
    pct.textContent = '0%';
    pct.style.color = '';
    pct.style.fontSize = '13px';

    const eventId = Date.now().toString() + id;

    // Pass ALL metadata to server so ID3 tags are fully populated
    const endpoint = `/api/download-progress?id=${eventId}`
      + `&token=${encodeURIComponent(API_AUTH_TOKEN)}`
      + `&title=${encodeURIComponent(song.title)}`
      + `&artist=${encodeURIComponent(song.artist)}`
      + `&album=${encodeURIComponent(song.collectionName || '')}`
      + `&year=${encodeURIComponent(song.releaseYear || '')}`
      + `&genre=${encodeURIComponent(song.genre || '')}`
      + `&trackNumber=${encodeURIComponent(song.trackNumber || '')}`
      + `&trackCount=${encodeURIComponent(song.trackCount || '')}`
      + `&cover=${encodeURIComponent(song.artworkUrl || '')}`;

    const sse = new EventSource(endpoint);

    const releaseSlot = () => {
      activeDownloads--;
      _processNextInQueue();
    };

    sse.onmessage = (e) => {
      const data = JSON.parse(e.data);

      if (data.status === 'READY') {
        sse.close();
        bar.style.animation = 'none';
        bar.style.width = '100%';
        bar.style.background = '#34D399';
        pct.textContent = '100%';

        const downloadUrl = `/api/serve-file?id=${eventId}`
          + `&title=${encodeURIComponent(song.title)}`
          + `&artist=${encodeURIComponent(song.artist)}`;

        const fetchFileWithRetry = async (attempt = 1) => {
          const response = await fetch(downloadUrl, { headers: authHeaders() });
          if (response.ok) return response.blob();
          if (attempt < 3) {
            await new Promise(resolve => setTimeout(resolve, attempt * 1000));
            return fetchFileWithRetry(attempt + 1);
          }
          throw new Error(`File fetch failed: ${response.status}`);
        };

        fetchFileWithRetry()
          .then(blob => {
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => {
              item.remove();
              if (queueList.children.length === 0) queueSection.classList.add('hidden');
              addCompleted(song, filename, data.source, blobUrl);
            }, 800);
          })
          .catch(err => {
            console.error('File fetch failed:', err);
            activeDownloadKeys.delete(songKey);
          })
          .finally(() => {
            activeDownloadKeys.delete(songKey);
            releaseSlot();
          });

      } else if (data.status === 'ERROR') {
        sse.close();
        activeDownloadKeys.delete(songKey);
        bar.style.animation = 'none';
        bar.style.background = 'var(--danger)';
        bar.style.width = '100%';
        pct.textContent = 'Failed';
        pct.style.color = 'var(--danger)';
        pct.style.fontSize = '11px';
        console.error('Download failed:', data.message);
        setTimeout(() => {
          item.remove();
          if (queueList.children.length === 0) queueSection.classList.add('hidden');
        }, 5000);
        releaseSlot();

      } else if (data.message) {
        pct.textContent = data.message;
        pct.style.fontSize = '11px';
        pct.style.whiteSpace = 'nowrap';
      }
    };

    sse.onerror = () => {
      sse.close();
      activeDownloadKeys.delete(songKey);
      bar.style.animation = 'none';
      bar.style.background = 'var(--danger)';
      bar.style.width = '100%';
      pct.textContent = 'Connection lost';
      pct.style.color = 'var(--danger)';
      setTimeout(() => {
        item.remove();
        if (queueList.children.length === 0) queueSection.classList.add('hidden');
      }, 3000);
      releaseSlot();
    };
  }


  function addCompleted(song, filename, sourceUsed, blobUrl) {
    completedSection.classList.remove('hidden');
    const thumbSrc = song.artworkUrl || placeholderThumb(0);
    const item = document.createElement('div');
    item.className = 'completed-item';

    const sourceBadge = sourceUsed === 'YouTube'
      ? `<span class="badge badge-yt">YouTube</span>`
      : `<span class="badge badge-web">${escapeHtml(sourceUsed)}</span>`;

    const albumLine = song.collectionName
      ? `<div style="font-size:0.75rem;opacity:0.65;margin-top:2px;">${escapeHtml(song.collectionName)}${song.releaseYear ? ' · ' + song.releaseYear : ''}</div>`
      : '';

    item.innerHTML = `
      <img class="card-thumb completed-thumb" src="${thumbSrc}" alt="${escapeHtml(song.title)}" style="width:44px;height:44px;border-radius:8px;flex-shrink:0;" />
      <div class="completed-info">
        <div class="completed-title-text">${escapeHtml(song.title)}</div>
        <div class="completed-sub">${escapeHtml(song.artist)} · ${song.duration} · ${sourceBadge}</div>
        ${albumLine}
      </div>
      <button class="btn-play" title="Play preview" data-blob="${blobUrl || ''}">
        <svg viewBox="0 0 16 16" fill="currentColor" width="16" height="16"><path d="M4 2l10 6-10 6V2z"/></svg>
      </button>
    `;
    completedList.appendChild(item);
  }

  // ═══════════════════════════════════════════
  //  IN-APP AUDIO PLAYBACK
  // ═══════════════════════════════════════════

  completedList.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-play');
    if (!btn) return;

    const blobUrl = btn.getAttribute('data-blob');
    if (!blobUrl) return;

    // If clicking the same button that's playing, pause it
    if (currentAudio && currentPlayBtn === btn && !currentAudio.paused) {
      currentAudio.pause();
      btn.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor" width="16" height="16"><path d="M4 2l10 6-10 6V2z"/></svg>';
      return;
    }

    // Stop any currently playing audio
    if (currentAudio) {
      currentAudio.pause();
      if (currentPlayBtn) {
        currentPlayBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor" width="16" height="16"><path d="M4 2l10 6-10 6V2z"/></svg>';
      }
    }

    // Play new audio
    currentAudio = new Audio(blobUrl);
    currentPlayBtn = btn;
    btn.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor" width="16" height="16"><path d="M3 2h4v12H3V2zm6 0h4v12H9V2z"/></svg>';

    currentAudio.play();
    currentAudio.onended = () => {
      btn.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor" width="16" height="16"><path d="M4 2l10 6-10 6V2z"/></svg>';
      currentAudio = null;
      currentPlayBtn = null;
    };
  });

  // ═══════════════════════════════════════════
  //  HELPERS
  // ═══════════════════════════════════════════

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // ═══════════════════════════════════════════
  //  IDENTIFY SONG (SHAZAM-LIKE)
  // ═══════════════════════════════════════════

  const btnMic          = $('#btn-mic');
  const micContainer    = $('#btn-mic').parentElement;
  const identifyHint    = $('#identify-hint');
  const identifyTimer   = $('#identify-timer');
  const timerBar        = $('#timer-bar');
  const timerLabel      = $('#timer-label');
  const equalizer       = $('#equalizer');
  const identifyResult  = $('#identify-result');
  const identifyArt     = $('#identify-art');
  const identifySongTitle  = $('#identify-song-title');
  const identifySongArtist = $('#identify-song-artist');
  const identifySongAlbum  = $('#identify-song-album');
  const btnIdentifyDownload = $('#btn-identify-download');
  const btnIdentifySearch   = $('#btn-identify-search');
  const identifyError   = $('#identify-error');
  const identifyErrorMsg = $('#identify-error-msg');
  const btnRetryIdentify = $('#btn-retry-identify');

  let mediaRecorder = null;
  let recordingChunks = [];
  let recordingTimer = null;
  let identifiedSong = null; // Store identified song for download

  function resetIdentifyUI() {
    btnMic.classList.remove('recording');
    micContainer.classList.remove('listening');
    identifyHint.textContent = 'Tap the mic and hold your phone near the song';
    identifyTimer.classList.add('hidden');
    equalizer.classList.add('hidden');
    identifyResult.classList.add('hidden');
    identifyError.classList.add('hidden');
    timerBar.style.width = '100%';
    timerLabel.textContent = '10s';
    identifiedSong = null;
  }

  btnMic.addEventListener('click', async () => {
    // If already recording, stop
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      return;
    }

    resetIdentifyUI();

    // Request microphone
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      startRecording(stream);
    } catch (err) {
      showIdentifyError('Microphone access denied. Please allow microphone permission in your browser.');
    }
  });

  function startRecording(stream) {
    recordingChunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordingChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      clearInterval(recordingTimer);
      stream.getTracks().forEach(t => t.stop());
      btnMic.classList.remove('recording');
      micContainer.classList.remove('listening');
      equalizer.classList.add('hidden');
      identifyTimer.classList.add('hidden');
      identifyHint.textContent = 'Identifying song…';

      const audioBlob = new Blob(recordingChunks, { type: 'audio/webm' });
      await sendForRecognition(audioBlob);
    };

    mediaRecorder.start();
    btnMic.classList.add('recording');
    micContainer.classList.add('listening');
    identifyHint.textContent = 'Listening…';
    identifyTimer.classList.remove('hidden');
    equalizer.classList.remove('hidden');

    // Countdown timer: 10 seconds
    let secondsLeft = 10;
    timerLabel.textContent = `${secondsLeft}s`;
    timerBar.style.width = '100%';

    recordingTimer = setInterval(() => {
      secondsLeft--;
      timerLabel.textContent = `${secondsLeft}s`;
      timerBar.style.width = `${(secondsLeft / 10) * 100}%`;
      if (secondsLeft <= 0) {
        clearInterval(recordingTimer);
        if (mediaRecorder && mediaRecorder.state === 'recording') {
          mediaRecorder.stop();
        }
      }
    }, 1000);
  }

  async function sendForRecognition(audioBlob) {
    try {
      const formData = new FormData();
      formData.append('audio', audioBlob, 'recording.webm');

      const res = await fetch('/api/recognize', {
        method: 'POST',
        headers: authHeaders(),
        body: formData,
      });

      const data = await res.json();

      if (data.result) {
        const r = data.result;
        identifiedSong = {
          title: r.title,
          artist: r.artist,
          album: r.album || '',
          artworkUrl: r.spotify?.album?.images?.[0]?.url || '',
          duration: '',
          id: `identified-${Date.now()}`,
          collectionName: r.album || '',
          source: 'Identified',
        };

        // Try to get better artwork from iTunes
        try {
          const itunesRes = await fetch(`/api/search?query=${encodeURIComponent(r.title + ' ' + r.artist)}&limit=1`);
          const itunesData = await itunesRes.json();
          if (itunesData.results && itunesData.results.length > 0) {
            const art = itunesData.results[0].artworkUrl100 || '';
            if (art) identifiedSong.artworkUrl = art.replace('100x100', '600x600');
          }
        } catch (e) { /* use spotify art */ }

        showIdentifyResult(identifiedSong);
      } else {
        showIdentifyError("Couldn't identify this song. Try again or search manually.");
      }
    } catch (err) {
      console.error('Recognition error:', err);
      showIdentifyError('Recognition failed. Check your connection and try again.');
    }
  }

  function showIdentifyResult(song) {
    identifyHint.textContent = 'Song identified! ✨';
    identifyArt.src = song.artworkUrl || placeholderThumb(0);
    identifySongTitle.textContent = song.title;
    identifySongArtist.textContent = song.artist;
    identifySongAlbum.textContent = song.album || '';
    identifyResult.classList.remove('hidden');
  }

  function showIdentifyError(msg) {
    identifyHint.textContent = '';
    identifyErrorMsg.textContent = msg;
    identifyError.classList.remove('hidden');
  }

  btnRetryIdentify.addEventListener('click', resetIdentifyUI);

  btnIdentifyDownload.addEventListener('click', () => {
    if (!identifiedSong) return;
    startRealDownload(identifiedSong);
    btnIdentifyDownload.disabled = true;
  });

  btnIdentifySearch.addEventListener('click', () => {
    if (!identifiedSong) return;
    setMode('search');
    $('#search-input').value = identifiedSong.artist;
    $('#btn-find-search').click();
  });

  // ═══════════════════════════════════════════
  //  INIT
  // ═══════════════════════════════════════════
  setMode('url');
  // Start health checks and load persisted completed list
  checkHealth();
  setInterval(checkHealth, 10000);
  loadCompletedFromServer();
})();
