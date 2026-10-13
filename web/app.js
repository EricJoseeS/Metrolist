const STORAGE_KEY = 'metrolist.desktop.v1';
const COLOR_THEMES = ['green', 'black', 'red'];
const LYRICS_PROVIDERS = [
  { id: 'BetterLyrics', name: 'Better Lyrics', available: false },
  { id: 'LrcLib', name: 'LRCLIB', available: true },
  { id: 'KuGou', name: 'KuGou', available: true },
  { id: 'Paxsenix', name: 'Paxsenix', available: false },
  { id: 'LyricsPlus', name: 'LyricsPlus', available: true },
  { id: 'Zemer', name: 'Zemer', available: true },
  { id: 'YouTubeSubtitle', name: 'YouTube Subtitles', available: true },
  { id: 'YouTube', name: 'YouTube Music', available: true },
];
const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
const savedLyricsOrder = Array.isArray(saved.lyricsOrder) ? saved.lyricsOrder : [];
const state = {
  view: 'home',
  playlistId: null,
  artistId: null,
  albumId: null,
  query: '',
  results: [],
  artists: [],
  albums: [],
  artistPage: null,
  artistLoadingId: null,
  artistError: '',
  albumPage: null,
  albumLoadingId: null,
  albumError: '',
  library: Array.isArray(saved.library) ? saved.library : [],
  savedArtists: Array.isArray(saved.savedArtists) ? saved.savedArtists : [],
  playlists: Array.isArray(saved.playlists) ? saved.playlists : [],
  queue: Array.isArray(saved.queue) ? saved.queue : [],
  history: Array.isArray(saved.history) ? saved.history : [],
  currentTrack: null,
  theme: saved.theme === 'dark' ? 'black' : COLOR_THEMES.includes(saved.theme) ? saved.theme : 'green',
  lyricsEnabled: Object.fromEntries(LYRICS_PROVIDERS.map(({ id }) => [id, saved.lyricsEnabled?.[id] ?? true])),
  lyricsOrder: [...new Set([...savedLyricsOrder.filter((id) => LYRICS_PROVIDERS.some((provider) => provider.id === id)), ...LYRICS_PROVIDERS.map(({ id }) => id)])],
  lyricsOpen: false,
  lyricsTrackId: null,
  lyricsProvider: '',
  lyricsText: '',
  lyricsLines: [],
  lyricsError: '',
  lyricsLoading: false,
  activeLyricIndex: -1,
};

const mainView = document.getElementById('mainView');
const searchInput = document.getElementById('searchInput');
let toastTimer;

document.body.append(document.getElementById('playerMount'));

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    library: state.library,
    savedArtists: state.savedArtists,
    playlists: state.playlists,
    queue: state.queue,
    history: state.history.slice(0, 50),
    theme: state.theme,
    lyricsEnabled: state.lyricsEnabled,
    lyricsOrder: state.lyricsOrder,
  }));
}

function toast(message) {
  const element = document.getElementById('toast');
  element.textContent = message;
  element.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('is-visible'), 2400);
}

function routeTo(view, entityId = null) {
  const route = entityId ? `${view}/${encodeURIComponent(entityId)}` : view;
  if (location.hash.slice(1) === route) {
    applyRoute(route);
  } else {
    location.hash = route;
  }
}

function applyRoute(route = location.hash.slice(1) || 'home') {
  if (route.startsWith('playlist/')) {
    state.view = 'playlist';
    state.playlistId = decodeURIComponent(route.slice('playlist/'.length));
    state.artistId = null;
    state.albumId = null;
  } else if (route.startsWith('artist/')) {
    state.view = 'artist';
    state.artistId = decodeURIComponent(route.slice('artist/'.length));
    state.playlistId = null;
    state.albumId = null;
  } else if (route.startsWith('album/')) {
    state.view = 'album';
    state.albumId = decodeURIComponent(route.slice('album/'.length));
    state.playlistId = null;
    state.artistId = null;
  } else {
    state.view = ['home', 'search', 'library', 'history', 'settings'].includes(route) ? route : 'home';
    state.playlistId = null;
    state.artistId = null;
    state.albumId = null;
  }
  const activeView = ['artist', 'album'].includes(state.view) ? 'search' : state.view;
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.view === activeView);
  });
  render();
  if (state.view === 'artist') loadArtist(state.artistId);
  if (state.view === 'album') loadAlbum(state.albumId);
}

function trackRow(track, index, context = 'results') {
  const savedTrack = state.library.some((item) => item.id === track.id);
  const artwork = track.artwork
    ? `<img class="track-art" src="${escapeHtml(track.artwork)}" alt="" loading="lazy" />`
    : '<span class="track-art track-art-empty">♪</span>';
  return `<div class="track-row" data-track-id="${escapeHtml(track.id)}">
    <span class="track-index">${String(index + 1).padStart(2, '0')}</span>
    <button class="track-main" data-action="play" data-id="${escapeHtml(track.id)}" aria-label="Play ${escapeHtml(track.title)}">
      ${artwork}<span class="track-copy"><strong>${escapeHtml(track.title)}</strong><small>${escapeHtml(track.artist || 'YouTube Music')}</small></span>
    </button>
    <span class="track-duration">${escapeHtml(track.duration || '—')}</span>
    <div class="track-actions">
      <button class="icon-action" data-action="add-playlist" data-id="${escapeHtml(track.id)}" title="Add to playlist" aria-label="Add ${escapeHtml(track.title)} to playlist">▤</button>
      <button class="icon-action" data-action="queue" data-id="${escapeHtml(track.id)}" title="Add to queue" aria-label="Add ${escapeHtml(track.title)} to queue">＋</button>
      <button class="icon-action ${savedTrack ? 'is-saved' : ''}" data-action="save" data-id="${escapeHtml(track.id)}" title="${savedTrack ? 'Remove from library' : 'Save to library'}" aria-label="${savedTrack ? 'Remove from library' : 'Save to library'}">${savedTrack ? '♥' : '♡'}</button>
      ${context === 'playlist' ? `<button class="icon-action" data-action="remove-playlist-track" data-id="${escapeHtml(track.id)}" title="Remove from playlist" aria-label="Remove from playlist">×</button>` : ''}
    </div>
  </div>`;
}

function trackTable(tracks, context) {
  if (!tracks.length) return '<div class="empty-state"><span class="empty-mark">♪</span><strong>No tracks yet</strong><p>Search for a song, then save it or add it to a playlist.</p><button class="button-primary" data-view="search">Search music</button></div>';
  return `<div class="track-table"><div class="track-head"><span>#</span><span>Title</span><span>Duration</span><span></span></div>${tracks.map((track, index) => trackRow(track, index, context)).join('')}</div>`;
}

function sectionHeading(eyebrow, title, description = '') {
  return `<div class="page-heading"><div><span class="eyebrow">${escapeHtml(eyebrow)}</span><h1>${escapeHtml(title)}</h1>${description ? `<p>${escapeHtml(description)}</p>` : ''}</div></div>`;
}

function entityCards(items, kind) {
  if (!items.length) return '';
  const label = kind === 'artist' ? 'Artists' : 'Albums';
  return `<section class="content-section entity-section"><div class="section-title"><div><span class="eyebrow">BROWSE</span><h2>${label}</h2></div></div><div class="entity-grid">${items.map((item) => `<button class="entity-card" data-action="open-${kind}" data-id="${escapeHtml(item.id)}"><span class="entity-art">${item.artwork ? `<img src="${escapeHtml(item.artwork)}" alt="" loading="lazy" />` : '♪'}</span><strong>${escapeHtml(item.title)}</strong>${item.subtitle ? `<small>${escapeHtml(item.subtitle)}</small>` : ''}</button>`).join('')}</div></section>`;
}

function renderHome() {
  const recent = state.history.slice(0, 5);
  const savedTracks = state.library.slice(0, 5);
  return `<section class="welcome-band"><div><span class="eyebrow">YOUR MUSIC, YOUR WAY</span><h1>Make room for<br />the next favorite.</h1><p>Search the YouTube Music catalog, build a queue, and keep your own library in this browser.</p><button class="button-primary" data-view="search">Find music <span>→</span></button></div><div class="welcome-art" aria-hidden="true"><span class="art-ring ring-one"></span><span class="art-ring ring-two"></span><span class="art-disc"></span><span class="art-note">♪</span></div></section>
    <section class="content-section"><div class="section-title"><div><span class="eyebrow">PICK UP WHERE YOU LEFT OFF</span><h2>Recently played</h2></div><button class="text-action" data-view="history">View history →</button></div>${recent.length ? trackTable(recent, 'history') : '<div class="inline-empty">Your listening history will appear here.</div>'}</section>
    <section class="content-section"><div class="section-title"><div><span class="eyebrow">YOUR COLLECTION</span><h2>Saved songs</h2></div><button class="text-action" data-view="library">Open library →</button></div>${savedTracks.length ? trackTable(savedTracks, 'library') : '<div class="inline-empty">Save songs from search to start your library.</div>'}</section>`;
}

function renderSearch() {
  const query = escapeHtml(state.query);
  const body = state.searching
    ? '<div class="loading-state"><span class="loading-mark"></span><span>Searching YouTube Music…</span></div>'
    : state.searchError
      ? `<div class="empty-state"><strong>Search is unavailable</strong><p>${escapeHtml(state.searchError)}</p><button class="button-secondary" data-action="retry-search">Try again</button></div>`
      : state.query
        ? state.results.length || state.artists.length || state.albums.length
          ? `${entityCards(state.artists, 'artist')}${entityCards(state.albums, 'album')}<section class="content-section"><div class="section-title"><div><span class="eyebrow">CATALOG</span><h2>Songs</h2></div></div>${state.results.length ? trackTable(state.results, 'results') : '<div class="inline-empty">No song results for this search.</div>'}</section>`
          : '<div class="inline-empty">No songs found. Try another search.</div>'
        : '<div class="empty-state"><span class="empty-mark">⌕</span><strong>What do you want to hear?</strong><p>Search songs, artists, albums, and playlists from YouTube Music.</p></div>';
  return `${sectionHeading('DISCOVER', query ? `Results for “${query}”` : 'Search music', 'Search the public YouTube Music catalog.')}
    <form class="large-search" id="largeSearchForm"><span>⌕</span><input id="largeSearchInput" type="search" value="${query}" placeholder="Try an artist, song, or album" aria-label="Search catalog" /><button class="button-primary" type="submit">Search</button></form>${body}`;
}

function renderArtist() {
  if (state.artistLoadingId === state.artistId) return `${sectionHeading('ARTIST', 'Loading profile…')}<div class="loading-state"><span class="loading-mark"></span><span>Loading artist…</span></div>`;
  if (state.artistError) return `${sectionHeading('ARTIST', 'Profile unavailable')}<div class="empty-state"><p>${escapeHtml(state.artistError)}</p><button class="button-secondary" data-view="search">Back to search</button></div>`;
  const page = state.artistPage;
  if (!page || page.artist.id !== state.artistId) return sectionHeading('ARTIST', 'Loading profile…');
  const image = page.artist.artwork ? `<img src="${escapeHtml(page.artist.artwork)}" alt="" />` : '<span>♪</span>';
  const artistSaved = state.savedArtists.some((artist) => artist.id === page.artist.id);
  return `<section class="profile-hero"><div class="profile-art">${image}</div><div class="profile-copy"><span class="eyebrow">ARTIST</span><h1>${escapeHtml(page.artist.title)}</h1><p>${escapeHtml(page.artist.monthlyListeners || 'YouTube Music artist')}</p><button class="button-secondary artist-save" data-action="save-artist" data-id="${escapeHtml(page.artist.id)}">${artistSaved ? '♥ Saved artist' : '♡ Save artist'}</button>${page.artist.description ? `<div class="profile-description">${escapeHtml(page.artist.description)}</div>` : ''}</div></section>
    <section class="content-section"><div class="section-title"><div><span class="eyebrow">TOP TRACKS</span><h2>Songs</h2></div></div>${trackTable(page.songs, 'results')}</section>${entityCards(page.albums, 'album')}`;
}

function renderAlbum() {
  if (state.albumLoadingId === state.albumId) return `${sectionHeading('ALBUM', 'Loading album…')}<div class="loading-state"><span class="loading-mark"></span><span>Loading album…</span></div>`;
  if (state.albumError) return `${sectionHeading('ALBUM', 'Album unavailable')}<div class="empty-state"><p>${escapeHtml(state.albumError)}</p><button class="button-secondary" data-view="search">Back to search</button></div>`;
  const page = state.albumPage;
  if (!page || page.album.id !== state.albumId) return sectionHeading('ALBUM', 'Loading album…');
  const image = page.album.artwork ? `<img src="${escapeHtml(page.album.artwork)}" alt="" />` : '<span>♪</span>';
  const artists = page.album.artists.map((artist) => ({ ...artist, artwork: '' }));
  return `<section class="profile-hero album-hero"><div class="profile-art">${image}</div><div class="profile-copy"><span class="eyebrow">ALBUM ${page.album.year ? `· ${escapeHtml(page.album.year)}` : ''}</span><h1>${escapeHtml(page.album.title)}</h1>${entityCardsInline(artists)}</div></section>
    <section class="content-section"><div class="section-title"><div><span class="eyebrow">TRACKLIST</span><h2>Songs</h2></div></div>${trackTable(page.songs, 'results')}</section>`;
}

function entityCardsInline(artists) {
  return artists.length ? `<div class="artist-credits">${artists.map((artist) => `<button class="text-action" data-action="open-artist" data-id="${escapeHtml(artist.id)}">${escapeHtml(artist.title)}</button>`).join('<span> · </span>')}</div>` : '';
}

async function loadArtist(id) {
  if (!id || state.artistPage?.artist.id === id || state.artistLoadingId === id) return;
  state.artistLoadingId = id;
  state.artistError = '';
  render();
  try {
    const response = await fetch(`/api/artist?id=${encodeURIComponent(id)}`);
    const page = await response.json();
    if (!response.ok) throw new Error(page.error || 'Could not load artist profile.');
    state.artistPage = page;
  } catch (error) {
    state.artistError = error.message || 'Could not load artist profile.';
  } finally {
    state.artistLoadingId = null;
    if (state.view === 'artist' && state.artistId === id) render();
  }
}

async function loadAlbum(id) {
  if (!id || state.albumPage?.album.id === id || state.albumLoadingId === id) return;
  state.albumLoadingId = id;
  state.albumError = '';
  render();
  try {
    const response = await fetch(`/api/album?id=${encodeURIComponent(id)}`);
    const page = await response.json();
    if (!response.ok) throw new Error(page.error || 'Could not load album.');
    state.albumPage = page;
  } catch (error) {
    state.albumError = error.message || 'Could not load album.';
  } finally {
    state.albumLoadingId = null;
    if (state.view === 'album' && state.albumId === id) render();
  }
}

function renderLibrary() {
  return `${sectionHeading('YOUR COLLECTION', 'Library', `${state.library.length} saved songs · ${state.savedArtists.length} saved artists`)}
    <div class="library-toolbar"><button class="button-secondary" id="exportLibrary">Export library</button><button class="button-secondary" id="importLibraryButton">Import library</button><input id="importLibrary" type="file" accept="application/json" hidden /></div><section class="content-section"><div class="section-title"><div><span class="eyebrow">SAVED MUSIC</span><h2>Songs</h2></div></div>${trackTable(state.library, 'library')}</section><section class="content-section"><div class="section-title"><div><span class="eyebrow">SAVED MUSIC</span><h2>Artists</h2></div></div>${state.savedArtists.length ? entityCards(state.savedArtists, 'artist') : '<div class="inline-empty">Save artists from their profile to see them here.</div>'}</section>`;
}

function renderPlaylist() {
  const playlist = state.playlists.find((item) => item.id === state.playlistId);
  if (!playlist) return `${sectionHeading('PLAYLIST', 'Playlist not found')}<button class="button-secondary" data-view="library">Back to library</button>`;
  return `${sectionHeading('YOUR PLAYLIST', playlist.name, `${playlist.tracks.length} ${playlist.tracks.length === 1 ? 'song' : 'songs'}`)}<div class="library-toolbar"><button class="button-secondary" data-action="rename-playlist" data-id="${escapeHtml(playlist.id)}">Rename</button><button class="button-secondary button-danger" data-action="delete-playlist" data-id="${escapeHtml(playlist.id)}">Delete playlist</button></div>${trackTable(playlist.tracks, 'playlist')}`;
}

function renderHistory() {
  return `${sectionHeading('LISTENING', 'History', 'Tracks you have played in this browser.')}${trackTable(state.history, 'history')}`;
}

function renderSettings() {
  const providerRows = state.lyricsOrder.map((id, index) => {
    const provider = LYRICS_PROVIDERS.find((item) => item.id === id);
    const unavailable = !provider.available;
    return `<div class="provider-row"><label class="provider-toggle"><input type="checkbox" data-lyrics-provider="${id}" ${state.lyricsEnabled[id] ? 'checked' : ''} ${unavailable ? 'disabled' : ''}><span><strong>${provider.name}</strong><small>${unavailable ? 'Unavailable in the browser adapter' : 'Fallback source'}</small></span></label><div class="provider-order"><button class="icon-action" data-action="provider-up" data-id="${id}" aria-label="Move ${provider.name} up" title="Move up" ${index === 0 ? 'disabled' : ''}>↑</button><button class="icon-action" data-action="provider-down" data-id="${id}" aria-label="Move ${provider.name} down" title="Move down" ${index === state.lyricsOrder.length - 1 ? 'disabled' : ''}>↓</button></div></div>`;
  }).join('');
  return `${sectionHeading('PREFERENCES', 'Settings', 'This browser edition stores playlists and saved songs on this device.')}
    <section class="settings-list"><div class="setting-row"><span><strong>Color theme</strong><small>Choose Green, Black (dark), or Red.</small></span><div class="theme-options" role="radiogroup" aria-label="Color theme"><label class="theme-option"><input type="radio" name="theme" value="green" ${state.theme === 'green' ? 'checked' : ''}><span class="theme-swatch swatch-green"></span>Green</label><label class="theme-option"><input type="radio" name="theme" value="black" ${state.theme === 'black' ? 'checked' : ''}><span class="theme-swatch swatch-black"></span>Black</label><label class="theme-option"><input type="radio" name="theme" value="red" ${state.theme === 'red' ? 'checked' : ''}><span class="theme-swatch swatch-red"></span>Red</label></div></div><div class="setting-row"><span><strong>Browser data</strong><small>Export your local library or clear this browser’s saved collection.</small></span><button class="button-secondary button-danger" id="clearData">Clear local data</button></div><div class="setting-row"><span><strong>Playback</strong><small>Audio and video are delivered by YouTube’s embedded player.</small></span><a class="text-action" href="https://music.youtube.com/" target="_blank" rel="noreferrer">YouTube Music ↗</a></div></section>
    <section class="content-section lyrics-settings"><div class="section-title"><div><span class="eyebrow">PLAYER</span><h2>Lyrics providers</h2></div></div><p class="provider-description">Enabled providers are tried in order. Lyrics are fetched when requested and are not saved in this browser.</p><div class="provider-list">${providerRows}</div></section>`;
}

function render() {
  document.documentElement.dataset.theme = state.theme;
  const views = { home: renderHome, search: renderSearch, library: renderLibrary, history: renderHistory, settings: renderSettings, playlist: renderPlaylist, artist: renderArtist, album: renderAlbum };
  mainView.innerHTML = views[state.view]();
  renderPlaylists();
  renderQueue();
  if (state.view === 'search') {
    const largeSearch = document.getElementById('largeSearchInput');
    if (largeSearch) largeSearch.value = state.query;
  }
  updatePlayerMeta();
}

function renderPlaylists() {
  const list = document.getElementById('playlistList');
  list.innerHTML = state.playlists.length
    ? state.playlists.map((playlist) => `<button class="playlist-item ${state.playlistId === playlist.id ? 'is-active' : ''}" data-playlist="${escapeHtml(playlist.id)}"><span class="playlist-icon">▤</span><span>${escapeHtml(playlist.name)}</span><small>${playlist.tracks.length}</small></button>`).join('')
    : '<div class="playlist-empty">Create a playlist to organize saved music.</div>';
}

function renderQueue() {
  const list = document.getElementById('queueList');
  document.getElementById('queueCount').textContent = state.queue.length;
  list.innerHTML = state.queue.length
    ? state.queue.map((track, index) => `<div class="queue-row"><button class="queue-play" data-action="play-queue" data-index="${index}" aria-label="Play ${escapeHtml(track.title)}">${String(index + 1).padStart(2, '0')}</button><button class="queue-track" data-action="play" data-id="${escapeHtml(track.id)}"><strong>${escapeHtml(track.title)}</strong><small>${escapeHtml(track.artist || 'YouTube Music')}</small></button><button class="icon-action" data-action="remove-queue" data-index="${index}" title="Remove from queue" aria-label="Remove from queue">×</button></div>`).join('')
    : '<div class="queue-empty">Your queue is clear.<br />Add tracks from search.</div>';
}

function findTrack(id) {
  return [...state.results, ...(state.artistPage?.songs || []), ...(state.albumPage?.songs || []), state.currentTrack, ...state.library, ...state.history, ...state.queue, ...state.playlists.flatMap((item) => item.tracks)].find((track) => track?.id === id);
}

function findArtist(id) {
  return [...state.artists, ...(state.artistPage ? [state.artistPage.artist] : []), ...state.savedArtists].find((artist) => artist.id === id);
}

function playTrack(track) {
  if (!track || !/^[\w-]{6,20}$/.test(track.id)) return;
  state.currentTrack = track;
  playbackWanted = true;
  startKeepAlive();
  state.history = [track, ...state.history.filter((item) => item.id !== track.id)].slice(0, 50);
  persist();
  updateMediaSession(track);
  startVideo(track);
  updatePlayerMeta();
  if (state.lyricsOpen) loadLyrics(true);
  if (state.view === 'home' || state.view === 'history') render();
}

function updatePlayerMeta() {
  const track = state.currentTrack;
  const title = track?.title || 'Nothing playing';
  const artist = track?.artist || (state.currentTrack ? '' : 'Your next track will appear here');
  document.getElementById('nowPlayingTitle').textContent = title;
  document.getElementById('nowPlayingArtist').textContent = artist;
  const barTitle = document.getElementById('barTitle');
  barTitle.textContent = title;
  barTitle.disabled = !track;
  barTitle.setAttribute('aria-label', track ? `Open player for ${title}` : title);
  const barArtist = document.getElementById('barArtist');
  barArtist.textContent = track ? artist : 'Search to find music';
  barArtist.disabled = !track?.artistId;
  barArtist.dataset.action = track?.artistId ? 'open-artist' : '';
  barArtist.dataset.id = track?.artistId || '';
  barArtist.setAttribute('aria-label', track?.artistId ? `Open ${artist} artist profile` : artist);
  const coverImage = document.getElementById('coverImage');
  const coverPlaceholder = document.getElementById('coverPlaceholder');
  coverImage.hidden = !track?.artwork;
  coverPlaceholder.hidden = Boolean(track?.artwork);
  if (track?.artwork) {
    coverImage.src = track.artwork;
    coverImage.alt = `${track.title} cover`;
  } else {
    coverImage.removeAttribute('src');
    coverImage.alt = '';
  }
  const cover = document.getElementById('barCover');
  cover.innerHTML = track?.artwork ? `<img src="${escapeHtml(track.artwork)}" alt="" />` : '♪';
  document.getElementById('saveCurrent').classList.toggle('is-saved', Boolean(track && state.library.some((item) => item.id === track.id)));
}

let youtubePlayer;
let pendingVideo;
let youtubeApiLoading = false;
let playbackClock;
let isMuted = false;
let playbackWanted = false;
let resumeOnReturn = false;
let mediaSessionActionsRegistered = false;

let keepAliveAudio;
function getKeepAliveAudio() {
  if (keepAliveAudio) return keepAliveAudio;
  // ~1s of silent 8kHz mono 8-bit PCM WAV, looped, so the browser treats the tab as an active media session
  const samples = 8000, header = 44, bytes = new Uint8Array(header + samples);
  const dv = new DataView(bytes.buffer);
  const w = (o, t) => [...t].forEach((c, i) => bytes[o + i] = c.charCodeAt(0));
  w(0, 'RIFF'); dv.setUint32(4, 36 + samples, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 8000, true); dv.setUint32(28, 8000, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
  w(36, 'data'); dv.setUint32(40, samples, true); bytes.fill(128, header);
  let bin = ''; bytes.forEach((b) => bin += String.fromCharCode(b));
  keepAliveAudio = new Audio('data:audio/wav;base64,' + btoa(bin));
  keepAliveAudio.loop = true;
  keepAliveAudio.volume = 0.01;
  return keepAliveAudio;
}
function startKeepAlive() { try { getKeepAliveAudio().play().catch(() => {}); } catch {} }
function stopKeepAlive() { try { keepAliveAudio?.pause(); } catch {} }
function resumeIfInterrupted() {
  if (!playbackWanted || !youtubePlayer?.getPlayerState) return;
  if (youtubePlayer.getPlayerState() !== window.YT?.PlayerState.PLAYING) youtubePlayer.playVideo();
}
setInterval(() => { if (document.hidden) resumeIfInterrupted(); }, 1000);

function setMediaSessionState(value) {
  if (!navigator.mediaSession) return;
  try { navigator.mediaSession.playbackState = value; } catch {}
}

function registerMediaSessionActions() {
  const session = navigator.mediaSession;
  if (!session || mediaSessionActionsRegistered) return;
  const actions = {
    play: () => { playbackWanted = true; startKeepAlive(); youtubePlayer?.playVideo(); },
    pause: () => { playbackWanted = false; stopKeepAlive(); youtubePlayer?.pauseVideo(); },
    previoustrack: playPreviousTrack,
    nexttrack: playNextQueued,
    seekto: (details) => { if (Number.isFinite(details.seekTime)) youtubePlayer?.seekTo(details.seekTime, true); },
    seekbackward: (details) => seekBy(-(details.seekOffset || 10)),
    seekforward: (details) => seekBy(details.seekOffset || 10),
  };
  for (const [action, handler] of Object.entries(actions)) {
    try { session.setActionHandler(action, handler); } catch {}
  }
  mediaSessionActionsRegistered = true;
}

function updateMediaSession(track) {
  if (!navigator.mediaSession) return;
  registerMediaSessionActions();
  if ('MediaMetadata' in window) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist || 'YouTube Music',
        album: track.album || 'Metrolist',
        artwork: track.artwork ? [{ src: track.artwork, sizes: '512x512' }] : [],
      });
    } catch {}
  }
  setMediaSessionState('playing');
}

function seekBy(offset) {
  if (!youtubePlayer?.getCurrentTime || !youtubePlayer?.getDuration) return;
  const target = Math.max(0, Math.min(youtubePlayer.getDuration(), youtubePlayer.getCurrentTime() + offset));
  youtubePlayer.seekTo(target, true);
}

function playPreviousTrack() {
  const previous = state.history.find((track) => track.id !== state.currentTrack?.id);
  if (previous) playTrack(previous);
  else toast('No previous track');
}

function startVideo(track) {
  pendingVideo = track;
  if (window.YT?.Player) {
    if (youtubePlayer?.loadVideoById) {
      youtubePlayer.loadVideoById(track.id);
    } else {
      createYoutubePlayer(track);
    }
    return;
  }

  document.getElementById('playerMount').innerHTML = '<div id="youtubePlayer"></div>';
  if (youtubeApiLoading) return;
  youtubeApiLoading = true;
  window.onYouTubeIframeAPIReady = () => {
    youtubeApiLoading = false;
    if (pendingVideo) createYoutubePlayer(pendingVideo);
  };
  const script = document.createElement('script');
  script.src = 'https://www.youtube.com/iframe_api';
  script.onerror = () => {
    youtubeApiLoading = false;
    if (pendingVideo) {
      document.getElementById('playerMount').innerHTML = `<iframe title="Audio source for ${escapeHtml(pendingVideo.title)}" src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(pendingVideo.id)}?autoplay=1&controls=0&rel=0&playsinline=1" allow="autoplay; encrypted-media" referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
    }
  };
  document.head.append(script);
}

function createYoutubePlayer(track) {
  document.getElementById('playerMount').innerHTML = '<div id="youtubePlayer"></div>';
  youtubePlayer = new window.YT.Player('youtubePlayer', {
    width: '200',
    height: '200',
    videoId: track.id,
    host: 'https://www.youtube-nocookie.com',
    playerVars: { autoplay: 1, controls: 0, disablekb: 1, playsinline: 1, rel: 0, modestbranding: 1, origin: location.origin },
    events: {
      onReady: (event) => {
        document.getElementById('playPause').disabled = false;
        document.getElementById('seekSlider').disabled = false;
        event.target.setVolume(Number(document.getElementById('volumeSlider').value));
        event.target.playVideo();
        clearInterval(playbackClock);
        playbackClock = setInterval(updatePlayback, 250);
      },
      onStateChange: (event) => {
        if (event.data === window.YT.PlayerState.PLAYING) setPlayControl(true);
        if (event.data === window.YT.PlayerState.PAUSED) {
          setPlayControl(false);
          if (playbackWanted && document.hidden) setTimeout(resumeIfInterrupted, 150);
        }
        if (event.data === window.YT.PlayerState.ENDED && !playNextQueued()) {
          playbackWanted = false;
          stopKeepAlive();
          setMediaSessionState('none');
        }
      },
    },
  });
}

function setPlayControl(playing) {
  const button = document.getElementById('playPause');
  button.textContent = playing ? 'Ⅱ' : '▶';
  button.title = playing ? 'Pause' : 'Play';
  button.setAttribute('aria-label', button.title);
  setMediaSessionState(playing ? 'playing' : 'paused');
}

function formatPlaybackTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const value = Math.floor(seconds);
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

function updatePlayback() {
  if (!youtubePlayer?.getDuration || !youtubePlayer?.getCurrentTime) return;
  const duration = youtubePlayer.getDuration();
  const current = youtubePlayer.getCurrentTime();
  if (!Number.isFinite(duration) || !Number.isFinite(current)) return;
  document.getElementById('elapsedTime').textContent = formatPlaybackTime(current);
  document.getElementById('durationTime').textContent = formatPlaybackTime(duration);
  if (duration > 0 && document.activeElement !== document.getElementById('seekSlider')) {
    document.getElementById('seekSlider').value = String(Math.round((current / duration) * 1000));
  }
  try {
    navigator.mediaSession?.setPositionState({ duration, position: current, playbackRate: youtubePlayer.getPlaybackRate?.() || 1 });
  } catch {}
  updateActiveLyric();
}

function parseLyrics(text) {
  const result = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const timestamps = [...rawLine.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const lineText = rawLine.replace(/\[[^\]]*\]/g, '').replace(/\{[^}]*\}/g, '').trim();
    if (!lineText || /^<.*>$/.test(lineText)) continue;
    if (!timestamps.length) {
      if (!/^\w+:.+$/.test(lineText)) result.push({ time: null, text: lineText });
      continue;
    }
    for (const [, minutes, seconds, fraction = '0'] of timestamps) {
      const millis = Number(fraction.padEnd(3, '0').slice(0, 3));
      result.push({ time: Number(minutes) * 60 + Number(seconds) + millis / 1000, text: lineText });
    }
  }
  return result.sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity));
}

function renderLyricsPanel() {
  const content = document.getElementById('lyricsContent');
  const source = document.getElementById('lyricsProvider');
  if (state.lyricsLoading) {
    source.textContent = 'Searching enabled providers…';
    content.innerHTML = '<div class="lyrics-message">Looking for lyrics…</div>';
  } else if (state.lyricsError) {
    source.textContent = 'Lyrics unavailable';
    content.innerHTML = `<div class="lyrics-message">${escapeHtml(state.lyricsError)}</div>`;
  } else if (state.lyricsLines.length) {
    source.textContent = state.lyricsProvider;
    content.innerHTML = state.lyricsLines.map((line, index) => `<button class="lyric-line ${index === state.activeLyricIndex ? 'is-active' : ''}" data-lyric-index="${index}" ${line.time === null ? 'disabled' : ''}>${escapeHtml(line.text)}</button>`).join('');
  } else {
    source.textContent = 'Lyrics';
    content.innerHTML = '<div class="lyrics-message">Choose a track and request lyrics.</div>';
  }
}

async function loadLyrics(force = false) {
  const track = state.currentTrack;
  if (!track) {
    state.lyricsError = 'Play a track before requesting lyrics.';
    state.lyricsLines = [];
    renderLyricsPanel();
    return;
  }
  if (!force && state.lyricsTrackId === track.id && (state.lyricsLines.length || state.lyricsError)) return;
  const providers = state.lyricsOrder.filter((id) => state.lyricsEnabled[id] && LYRICS_PROVIDERS.find((provider) => provider.id === id)?.available);
  if (!providers.length) {
    state.lyricsError = 'Enable at least one available lyrics provider in Settings.';
    state.lyricsLines = [];
    renderLyricsPanel();
    return;
  }

  state.lyricsTrackId = track.id;
  state.lyricsLoading = true;
  state.lyricsError = '';
  state.lyricsLines = [];
  state.activeLyricIndex = -1;
  renderLyricsPanel();
  try {
    const response = await fetch('/api/lyrics', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album || '',
        duration: Number(track.duration) || 0,
        providers,
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'No lyrics found from the enabled providers.');
    if (state.currentTrack?.id !== track.id) return;
    state.lyricsProvider = payload.provider;
    state.lyricsText = payload.lyrics;
    state.lyricsLines = parseLyrics(payload.lyrics);
    if (!state.lyricsLines.length) throw new Error('The selected provider returned no readable lines.');
  } catch (error) {
    if (state.currentTrack?.id === track.id) state.lyricsError = error.message || 'Lyrics could not be loaded.';
  } finally {
    if (state.currentTrack?.id === track.id) {
      state.lyricsLoading = false;
      renderLyricsPanel();
      updateActiveLyric();
    }
  }
}

function updateActiveLyric() {
  if (!state.lyricsOpen || !state.lyricsLines.length || !youtubePlayer?.getCurrentTime) return;
  const time = youtubePlayer.getCurrentTime();
  if (!Number.isFinite(time)) return;
  let active = -1;
  for (let index = 0; index < state.lyricsLines.length; index++) {
    if (state.lyricsLines[index].time !== null && state.lyricsLines[index].time <= time) active = index;
  }
  if (active === state.activeLyricIndex) return;
  state.activeLyricIndex = active;
  document.querySelectorAll('.lyric-line').forEach((line, index) => line.classList.toggle('is-active', index === active));
  document.querySelector('.lyric-line.is-active')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function toggleLyrics(open = !state.lyricsOpen) {
  state.lyricsOpen = open;
  document.getElementById('nowPlayingCover').hidden = open;
  document.querySelector('.now-playing-meta').hidden = open;
  document.getElementById('playerControls').hidden = open;
  document.getElementById('lyricsPanel').hidden = !open;
  const button = document.getElementById('toggleLyrics');
  button.setAttribute('aria-expanded', String(open));
  button.classList.toggle('is-active', open);
  if (open) loadLyrics();
}

function playNextQueued() {
  const next = state.queue.shift();
  if (!next) return false;
  persist();
  renderQueue();
  playTrack(next);
  return true;
}

async function search(query) {
  const cleanQuery = query.trim();
  if (!cleanQuery) return;
  state.query = cleanQuery;
  state.searching = true;
  state.searchError = '';
  routeTo('search');
  render();
  searchInput.value = cleanQuery;
  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(cleanQuery)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Search failed (${response.status})`);
    state.results = payload.tracks || [];
    state.artists = payload.artists || [];
    state.albums = payload.albums || [];
    state.searchError = '';
  } catch (error) {
    state.results = [];
    state.artists = [];
    state.albums = [];
    state.searchError = error.message || 'Could not reach YouTube Music.';
  } finally {
    state.searching = false;
    if (state.view === 'search') render();
  }
}

function toggleSaved(track) {
  const existing = state.library.some((item) => item.id === track.id);
  state.library = existing ? state.library.filter((item) => item.id !== track.id) : [track, ...state.library];
  persist();
  render();
  toast(existing ? 'Removed from library' : 'Saved to library');
}

function toggleSavedArtist(artist) {
  const exists = state.savedArtists.some((item) => item.id === artist.id);
  state.savedArtists = exists
    ? state.savedArtists.filter((item) => item.id !== artist.id)
    : [{ id: artist.id, title: artist.title, artwork: artist.artwork || '' }, ...state.savedArtists];
  persist();
  render();
  toast(exists ? 'Artist removed from library' : 'Artist saved to library');
}

function addToQueue(track) {
  if (state.queue.some((item) => item.id === track.id)) return toast('Already in queue');
  state.queue.push(track);
  persist();
  renderQueue();
  toast('Added to queue');
}

function createPlaylist() {
  const name = prompt('Playlist name');
  if (!name?.trim()) return;
  const playlist = { id: crypto.randomUUID(), name: name.trim().slice(0, 80), tracks: [] };
  state.playlists.push(playlist);
  persist();
  renderPlaylists();
  routeTo('playlist', playlist.id);
}

function handleAction(button) {
  const { action, id } = button.dataset;
  const track = id ? findTrack(id) : null;
  if (action === 'open-player' && window.matchMedia('(max-width: 880px)').matches) setMobilePlayerOpen(true);
  if (action === 'open-artist') routeTo('artist', id);
  if (action === 'open-album') routeTo('album', id);
  if (action === 'save-artist') {
    const artist = findArtist(id);
    if (artist) toggleSavedArtist(artist);
  }
  if (action === 'provider-up' || action === 'provider-down') {
    const index = state.lyricsOrder.indexOf(id);
    const destination = index + (action === 'provider-up' ? -1 : 1);
    if (index >= 0 && destination >= 0 && destination < state.lyricsOrder.length) {
      [state.lyricsOrder[index], state.lyricsOrder[destination]] = [state.lyricsOrder[destination], state.lyricsOrder[index]];
      persist(); render();
    }
  }
  if (action === 'play' && track) playTrack(track);
  if (action === 'save' && track) toggleSaved(track);
  if (action === 'queue' && track) addToQueue(track);
  if (action === 'add-playlist' && track) {
    if (!state.playlists.length) return toast('Create a playlist first');
    const choices = state.playlists.map((playlist, index) => `${index + 1}. ${playlist.name}`).join('\n');
    const selection = prompt(`Add to which playlist? Enter its number or name:\n${choices}`);
    if (!selection) return;
    const playlist = state.playlists[Number(selection) - 1] || state.playlists.find((item) => item.name.toLowerCase() === selection.trim().toLowerCase());
    if (!playlist) return toast('Playlist not found');
    if (playlist.tracks.some((item) => item.id === track.id)) return toast('Already in playlist');
    playlist.tracks.unshift(track);
    persist();
    if (state.view === 'playlist' && state.playlistId === playlist.id) render();
    toast(`Added to ${playlist.name}`);
  }
  if (action === 'remove-queue') {
    state.queue.splice(Number(button.dataset.index), 1);
    persist(); renderQueue();
  }
  if (action === 'play-queue') {
    const index = Number(button.dataset.index);
    const [next] = state.queue.splice(index, 1);
    if (next) playTrack(next);
    persist(); renderQueue();
  }
  if (action === 'remove-playlist-track') {
    const playlist = state.playlists.find((item) => item.id === state.playlistId);
    if (playlist) playlist.tracks = playlist.tracks.filter((item) => item.id !== id);
    persist(); render();
  }
  if (action === 'retry-search') search(state.query);
  if (action === 'rename-playlist') {
    const playlist = state.playlists.find((item) => item.id === id);
    const name = prompt('Rename playlist', playlist?.name || '');
    if (playlist && name?.trim()) { playlist.name = name.trim().slice(0, 80); persist(); render(); }
  }
  if (action === 'delete-playlist' && confirm('Delete this playlist? Saved songs in your library will not be removed.')) {
    state.playlists = state.playlists.filter((item) => item.id !== id);
    persist(); routeTo('library');
  }
}

document.addEventListener('click', (event) => {
  const viewButton = event.target.closest('[data-view]');
  if (viewButton) routeTo(viewButton.dataset.view);
  const playlistButton = event.target.closest('[data-playlist]');
  if (playlistButton) routeTo('playlist', playlistButton.dataset.playlist);
  const actionButton = event.target.closest('[data-action]');
  if (actionButton) handleAction(actionButton);
});

document.getElementById('searchForm').addEventListener('submit', (event) => {
  event.preventDefault();
  search(searchInput.value);
});

mainView.addEventListener('submit', (event) => {
  if (event.target.id === 'largeSearchForm') {
    event.preventDefault();
    search(document.getElementById('largeSearchInput').value);
  }
});

document.getElementById('createPlaylist').addEventListener('click', createPlaylist);
document.getElementById('clearQueue').addEventListener('click', () => {
  state.queue = [];
  persist(); renderQueue(); toast('Queue cleared');
});
document.getElementById('nextTrack').addEventListener('click', () => {
  if (!playNextQueued()) toast('Your queue is empty');
});
document.getElementById('previousTrack').addEventListener('click', () => {
  playPreviousTrack();
});
document.getElementById('playPause').addEventListener('click', () => {
  if (!youtubePlayer) return;
  if (youtubePlayer.getPlayerState() === window.YT.PlayerState.PLAYING) {
    playbackWanted = false;
    stopKeepAlive();
    youtubePlayer.pauseVideo();
  } else {
    playbackWanted = true;
    startKeepAlive();
    youtubePlayer.playVideo();
  }
});
document.getElementById('seekSlider').addEventListener('change', (event) => {
  const duration = youtubePlayer?.getDuration?.() || 0;
  if (duration > 0) youtubePlayer.seekTo((Number(event.target.value) / 1000) * duration, true);
});
document.getElementById('volumeSlider').addEventListener('input', (event) => {
  const volume = Number(event.target.value);
  if (youtubePlayer?.setVolume) youtubePlayer.setVolume(volume);
  isMuted = volume === 0;
  const muteButton = document.getElementById('toggleMute');
  muteButton.textContent = isMuted ? '×' : '◖';
  muteButton.title = isMuted ? 'Unmute' : 'Mute';
  muteButton.setAttribute('aria-label', muteButton.title);
});
document.getElementById('toggleMute').addEventListener('click', () => {
  if (!youtubePlayer) return;
  isMuted = !isMuted;
  if (isMuted) youtubePlayer.mute();
  else {
    youtubePlayer.unMute();
    youtubePlayer.setVolume(Number(document.getElementById('volumeSlider').value) || 70);
  }
  const button = document.getElementById('toggleMute');
  button.textContent = isMuted ? '×' : '◖';
  button.title = isMuted ? 'Unmute' : 'Mute';
  button.setAttribute('aria-label', button.title);
});
document.getElementById('addCurrentQueue').addEventListener('click', () => {
  if (state.currentTrack) addToQueue(state.currentTrack);
  else toast('Choose a track first');
});
function setMobilePlayerOpen(open) {
  const rail = document.querySelector('.detail-rail');
  const shell = document.querySelector('.app-shell');
  if (open) {
    document.body.append(rail);
    document.body.classList.add('mobile-player-open');
    shell.inert = true;
    rail.setAttribute('role', 'dialog');
    rail.setAttribute('aria-modal', 'true');
    document.getElementById('closeMobilePlayer').focus();
  } else {
    shell.insertBefore(rail, document.querySelector('.player-bar'));
    document.body.classList.remove('mobile-player-open');
    shell.inert = false;
    rail.removeAttribute('role');
    rail.removeAttribute('aria-modal');
    if (window.innerWidth <= 880) document.getElementById('openMobilePlayer').focus();
  }
}
document.getElementById('openMobilePlayer').addEventListener('click', () => setMobilePlayerOpen(true));
document.getElementById('closeMobilePlayer').addEventListener('click', () => setMobilePlayerOpen(false));
document.getElementById('openVideo').addEventListener('click', () => {
  if (state.currentTrack) window.open(`https://music.youtube.com/watch?v=${encodeURIComponent(state.currentTrack.id)}`, '_blank', 'noopener');
});
document.getElementById('saveCurrent').addEventListener('click', () => {
  if (state.currentTrack) toggleSaved(state.currentTrack);
});
document.getElementById('toggleLyrics').addEventListener('click', () => toggleLyrics());
document.getElementById('reloadLyrics').addEventListener('click', () => loadLyrics(true));
document.getElementById('goBack').addEventListener('click', () => history.back());
document.getElementById('goForward').addEventListener('click', () => history.forward());

mainView.addEventListener('change', (event) => {
  if (event.target.name === 'theme' && COLOR_THEMES.includes(event.target.value)) {
    state.theme = event.target.value;
    persist(); render();
  }
  if (event.target.matches('[data-lyrics-provider]')) {
    state.lyricsEnabled[event.target.dataset.lyricsProvider] = event.target.checked;
    persist();
  }
  if (event.target.id === 'importLibrary') importLibrary(event.target.files[0]);
});

mainView.addEventListener('click', (event) => {
  const lyricLine = event.target.closest('[data-lyric-index]');
  if (lyricLine && youtubePlayer?.seekTo) youtubePlayer.seekTo(state.lyricsLines[Number(lyricLine.dataset.lyricIndex)]?.time || 0, true);
  if (event.target.id === 'exportLibrary') exportLibrary();
  if (event.target.id === 'importLibraryButton') document.getElementById('importLibrary').click();
  if (event.target.id === 'clearData' && confirm('Clear saved songs, artists, playlists, queue, and history from this browser?')) {
    state.library = []; state.savedArtists = []; state.playlists = []; state.queue = []; state.history = [];
    persist(); render(); toast('Browser library cleared');
  }
});

function exportLibrary() {
  const backup = { version: 1, library: state.library, savedArtists: state.savedArtists, playlists: state.playlists };
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
  link.download = 'metrolist-library.json';
  link.click();
  URL.revokeObjectURL(link.href);
}

async function importLibrary(file) {
  if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    if (!Array.isArray(backup.library) || !Array.isArray(backup.playlists)) throw new Error('Invalid Metrolist library file');
    state.library = backup.library.filter((track) => track && typeof track.id === 'string' && typeof track.title === 'string');
    state.savedArtists = Array.isArray(backup.savedArtists)
      ? backup.savedArtists.filter((artist) => artist && typeof artist.id === 'string' && typeof artist.title === 'string')
      : [];
    state.playlists = backup.playlists.filter((playlist) => playlist && typeof playlist.name === 'string' && Array.isArray(playlist.tracks));
    persist(); render(); toast('Library imported');
  } catch (error) {
    toast(error.message || 'Could not import that file');
  }
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.body.classList.contains('mobile-player-open')) {
    setMobilePlayerOpen(false);
    return;
  }
  if ((event.key === '/' || (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey))) && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    event.preventDefault(); searchInput.focus();
  }
});

window.addEventListener('hashchange', () => applyRoute());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    resumeOnReturn = playbackWanted;
    setTimeout(resumeIfInterrupted, 300);
    return;
  }
  if (!resumeOnReturn) return;
  resumeOnReturn = false;
  if (playbackWanted && youtubePlayer?.getPlayerState && youtubePlayer.getPlayerState() !== window.YT?.PlayerState.PLAYING) {
    youtubePlayer.playVideo();
  }
});
searchInput.addEventListener('focus', () => {
  if (state.view !== 'search') routeTo('search');
});

render();
applyRoute();
