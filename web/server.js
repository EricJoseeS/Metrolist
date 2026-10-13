import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const userAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
let clientConfig;

async function getClientConfig() {
  if (!clientConfig) {
    clientConfig = fetch('https://music.youtube.com/', { headers: { 'user-agent': userAgent } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`YouTube Music returned ${response.status}`);
        const html = await response.text();
        const apiKey = html.match(/INNERTUBE_API_KEY":"([^"]+)/)?.[1];
        const clientVersion = html.match(/INNERTUBE_CLIENT_VERSION":"([^"]+)/)?.[1];
        if (!apiKey || !clientVersion) throw new Error('Could not read YouTube Music client configuration');
        return { apiKey, clientVersion };
      })
      .catch((error) => {
        clientConfig = undefined;
        throw error;
      });
  }
  return clientConfig;
}

function textOf(runs = []) {
  return runs.map((run) => run.text || '').join('');
}

function trackFromRenderer(renderer) {
  const columns = renderer.flexColumns || [];
  const title = textOf(columns[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs).trim();
  const id = renderer.playlistItemData?.videoId
    || renderer.navigationEndpoint?.watchEndpoint?.videoId
    || renderer.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
  if (!id || !title) return null;

  const metadata = columns.slice(1).flatMap((column) => column.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []);
  const artistRun = metadata.find((run) => run.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType === 'MUSIC_PAGE_TYPE_ARTIST');
  const albumRun = metadata.find((run) => run.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType === 'MUSIC_PAGE_TYPE_ALBUM');
  const artist = artistRun?.text || textOf(metadata).split(/[•·]/).map((part) => part.trim()).find((part) => part && !/^song$|^video$|^album$/i.test(part) && !/^\d+:\d+$/.test(part)) || 'YouTube Music';
  const duration = metadata.map((run) => run.text || '').join(' ').match(/(?:^|[^\d])(\d{1,2}:\d{2}(?::\d{2})?)(?!\d)/)?.[1] || '';
  const thumbnails = renderer.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
  return {
    id,
    title,
    artist,
    artistId: artistRun?.navigationEndpoint?.browseEndpoint?.browseId || '',
    album: albumRun?.text || '',
    albumId: albumRun?.navigationEndpoint?.browseEndpoint?.browseId || '',
    duration,
    artwork: thumbnails.at(-1)?.url || '',
  };
}

function tracksFromSections(sections) {
  const tracks = new Map();
  for (const section of sections) {
    const items = section.musicShelfRenderer?.contents
      || section.itemSectionRenderer?.contents
      || section.musicCarouselShelfRenderer?.contents
      || [];
    for (const item of items) {
      const track = item.musicResponsiveListItemRenderer && trackFromRenderer(item.musicResponsiveListItemRenderer);
      if (track) tracks.set(track.id, track);
    }
  }
  return [...tracks.values()];
}

function findTracks(response) {
  const sections = response.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
  return tracksFromSections(sections);
}

function thumbnailUrl(renderer) {
  const thumbnails = renderer?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails
    || renderer?.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails
    || renderer?.foregroundThumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails
    || renderer?.thumbnail?.croppedSquareThumbnailRenderer?.thumbnail?.thumbnails
    || [];
  return thumbnails.at(-1)?.url || '';
}

function albumCardFromRenderer(renderer) {
  const endpoint = renderer.navigationEndpoint?.browseEndpoint;
  const title = textOf(renderer.title?.runs).trim();
  if (!endpoint?.browseId || !title) return null;
  return { id: endpoint.browseId, title, artwork: thumbnailUrl(renderer), subtitle: textOf(renderer.subtitle?.runs) };
}

function findBrowseEntities(response, pageType) {
  const entities = new Map();
  function visit(value, ancestors = [], insideMenu = false) {
    if (!value || typeof value !== 'object') return;
    const endpoint = value.navigationEndpoint?.browseEndpoint;
    const type = endpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
    if (!insideMenu && endpoint?.browseId && type === pageType) {
      const title = (typeof value.text === 'string' ? value.text : textOf(value.text?.runs) || textOf(value.title?.runs)).trim();
      const current = entities.get(endpoint.browseId);
      const placeholder = /^(go to|view)\s+(album|artist)$/i;
      if (title && (!current || (placeholder.test(current.title) && !placeholder.test(title)))) {
        const artwork = [...ancestors].reverse().map(thumbnailUrl).find(Boolean) || thumbnailUrl(value);
        entities.set(endpoint.browseId, { id: endpoint.browseId, title, artwork });
      }
    }
    const menuContext = insideMenu || Boolean(value.menuRenderer || value.menuNavigationItemRenderer || value.menuServiceItemRenderer);
    for (const child of Object.values(value)) visit(child, [...ancestors, value], menuContext);
  }
  visit(response);
  return [...entities.values()];
}

async function browseInnerTube(browseId) {
  const { apiKey, clientVersion } = await getClientConfig();
  const response = await fetch(`https://music.youtube.com/youtubei/v1/browse?key=${apiKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': userAgent },
    body: JSON.stringify({ context: { client: { clientName: 'WEB_REMIX', clientVersion, hl: 'en', gl: 'US' } }, browseId }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`YouTube Music browse failed (${response.status})`);
  return response.json();
}

function artistPageFromResponse(id, response) {
  const header = response.header?.musicImmersiveHeaderRenderer
    || response.header?.musicVisualHeaderRenderer
    || response.header?.musicHeaderRenderer
    || {};
  const sections = response.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
  const songSection = sections.find((section) => section.musicShelfRenderer);
  const albums = sections
    .filter((section) => {
      const title = textOf(section.musicCarouselShelfRenderer?.header?.musicCarouselShelfBasicHeaderRenderer?.title?.runs).toLowerCase();
      return title === 'albums' || title === 'singles & eps';
    })
    .flatMap((section) => section.musicCarouselShelfRenderer.contents || [])
    .map((item) => item.musicTwoRowItemRenderer && albumCardFromRenderer(item.musicTwoRowItemRenderer))
    .filter(Boolean)
    .slice(0, 24);
  const description = textOf(header.description?.runs)
    || textOf(sections.find((section) => section.musicDescriptionShelfRenderer)?.musicDescriptionShelfRenderer?.description?.runs);
  return {
    artist: {
      id,
      title: textOf(header.title?.runs) || 'Artist',
      artwork: thumbnailUrl(header),
      description,
      monthlyListeners: textOf(header.monthlyListenerCount?.runs),
    },
    songs: songSection ? tracksFromSections([songSection]) : [],
    albums,
  };
}

function albumPageFromResponse(id, response) {
  const columns = response.contents?.twoColumnBrowseResultsRenderer;
  const header = columns?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents
    ?.find((section) => section.musicResponsiveHeaderRenderer)?.musicResponsiveHeaderRenderer || {};
  const sections = columns?.secondaryContents?.sectionListRenderer?.contents || [];
  const subtitleRuns = header.subtitle?.runs || [];
  const artists = subtitleRuns
    .filter((run) => run.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType === 'MUSIC_PAGE_TYPE_ARTIST')
    .map((run) => ({ id: run.navigationEndpoint.browseEndpoint.browseId, title: run.text }));
  return {
    album: {
      id,
      title: textOf(header.title?.runs) || 'Album',
      artwork: thumbnailUrl(header),
      artists,
      year: subtitleRuns.map((run) => run.text).find((text) => /^\d{4}$/.test(text || '')) || '',
    },
    songs: tracksFromSections(sections),
  };
}

const lyricsProviderOrder = ['BetterLyrics', 'LrcLib', 'KuGou', 'Paxsenix', 'LyricsPlus', 'Zemer', 'YouTubeSubtitle', 'YouTube'];
const lyricsUserAgent = 'Metrolist Desktop/1.0 (https://github.com/MetrolistGroup/Metrolist)';

async function fetchLyricsJson(url, timeout = 5000) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': lyricsUserAgent },
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`Provider returned ${response.status}`);
  return response.json();
}

function lyricLrcTime(milliseconds) {
  const time = Math.max(0, Math.round(milliseconds));
  const minutes = Math.floor(time / 60000);
  const seconds = Math.floor((time % 60000) / 1000);
  const centiseconds = Math.floor((time % 1000) / 10);
  return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}]`;
}

function cleanLyricsTitle(title) {
  return title
    .replace(/\s*[([][^\])]*(official|video|audio|lyrics|visualizer|remaster|remix|live|acoustic|version|edit|radio)[^\])]*[)\]]/gi, '')
    .replace(/\s*[-|]\s*(official|video|audio|lyrics).*$/i, '')
    .trim();
}

function selectLrcLibLyrics(tracks, title, artist, duration) {
  const normalizedTitle = cleanLyricsTitle(title).toLowerCase();
  const normalizedArtist = artist.toLowerCase();
  const candidates = tracks
    .filter((track) => track.syncedLyrics || track.plainLyrics)
    .map((track) => {
      const resultTitle = String(track.trackName || '').toLowerCase();
      const resultArtist = String(track.artistName || '').toLowerCase();
      const durationDifference = duration > 0 ? Math.abs(Number(track.duration) - duration) : 0;
      const score = (resultTitle === normalizedTitle ? 4 : resultTitle.includes(normalizedTitle) || normalizedTitle.includes(resultTitle) ? 2 : 0)
        + (resultArtist === normalizedArtist ? 3 : resultArtist.includes(normalizedArtist) || normalizedArtist.includes(resultArtist) ? 1 : 0)
        + (track.syncedLyrics ? 0.5 : 0);
      return { track, score, durationDifference };
    })
    .filter((item) => item.score >= 2 && (!duration || item.durationDifference <= 5))
    .sort((a, b) => b.score - a.score || a.durationDifference - b.durationDifference);
  return candidates[0]?.track?.syncedLyrics || candidates[0]?.track?.plainLyrics || null;
}

async function getLrcLibLyrics({ title, artist, duration }, timeout) {
  const cleanTitle = cleanLyricsTitle(title);
  const searches = [
    { track_name: cleanTitle, artist_name: artist },
    { track_name: cleanTitle },
    { q: `${artist} ${cleanTitle}` },
    { q: cleanTitle },
  ];
  for (const search of searches) {
    const url = new URL('https://lrclib.net/api/search');
    for (const [key, value] of Object.entries(search)) url.searchParams.set(key, value);
    const tracks = await fetchLyricsJson(url, timeout);
    const lyrics = selectLrcLibLyrics(Array.isArray(tracks) ? tracks : [], cleanTitle, artist, duration);
    if (lyrics) return lyrics;
  }
  return null;
}

async function getKuGouLyrics({ title, artist, album, duration }, timeout) {
  const keyword = [title, ' - ', artist, album ? ` ${album}` : ''].join('');
  const songUrl = new URL('https://mobileservice.kugou.com/api/v3/search/song');
  Object.entries({ version: '9108', plat: '0', pagesize: '8', showtype: '0', keyword }).forEach(([key, value]) => songUrl.searchParams.set(key, value));
  const songs = await fetchLyricsJson(songUrl, timeout);
  const entries = songs.data?.info || [];
  const candidates = entries
    .filter((song) => !duration || Math.abs(Number(song.duration) - duration) <= 8)
    .slice(0, 4);

  async function downloadCandidate(candidate) {
    const downloadUrl = new URL('https://lyrics.kugou.com/download');
    Object.entries({ fmt: 'lrc', charset: 'utf8', client: 'pc', ver: '1', id: candidate.id, accesskey: candidate.accesskey }).forEach(([key, value]) => downloadUrl.searchParams.set(key, value));
    const download = await fetchLyricsJson(downloadUrl, timeout);
    const lyrics = Buffer.from(download.content || '', 'base64').toString('utf8');
    return lyrics.split(/\r?\n/).filter((line) => /^\[\d{2}:\d{2}\.\d{2,3}\]/.test(line)).join('\n') || null;
  }

  for (const song of candidates) {
    const searchUrl = new URL('https://lyrics.kugou.com/search');
    Object.entries({ ver: '1', man: 'yes', client: 'pc', hash: song.hash }).forEach(([key, value]) => searchUrl.searchParams.set(key, value));
    const search = await fetchLyricsJson(searchUrl, timeout);
    const candidate = search.candidates?.[0];
    if (!candidate) continue;
    const filtered = await downloadCandidate(candidate);
    if (filtered) return filtered;
  }

  const searchUrl = new URL('https://lyrics.kugou.com/search');
  Object.entries({ ver: '1', man: 'yes', client: 'pc', keyword }).forEach(([key, value]) => searchUrl.searchParams.set(key, value));
  if (duration > 0) searchUrl.searchParams.set('duration', String(duration * 1000));
  const search = await fetchLyricsJson(searchUrl, timeout);
  for (const candidate of (search.candidates || []).slice(0, 4)) {
    const filtered = await downloadCandidate(candidate);
    if (filtered) return filtered;
  }
  return null;
}

async function getLyricsPlusLyrics({ title, artist, album, duration }, timeout) {
  const url = new URL('https://lyricsplus.binimum.org/v2/lyrics/get');
  url.searchParams.set('title', title);
  url.searchParams.set('artist', artist);
  if (duration > 0) url.searchParams.set('duration', String(duration));
  if (album) url.searchParams.set('album', album);
  const response = await fetchLyricsJson(url, timeout);
  const lines = response.lyrics || [];
  const lrc = lines.map((line) => {
    const text = String(line.text || line.syllabus?.map((word) => word.text || '').join('') || '').trim();
    if (!text) return '';
    const timestamp = Number(line.time);
    return Number.isFinite(timestamp) ? `${lyricLrcTime(timestamp)}${text}` : text;
  }).filter(Boolean).join('\n');
  return lrc || null;
}

async function getZemerLyrics({ id }, timeout) {
  const url = new URL('https://search.zemer.io/lyrics/resolve');
  url.searchParams.set('videoId', id);
  const resolved = await fetchLyricsJson(url, timeout);
  const sources = (resolved.sources || []).slice().sort((a, b) => Number(b.synced) - Number(a.synced));
  for (const source of sources) {
    if (source.syncedLrc?.trim()) return source.syncedLrc;
    if (source.plain?.trim()) return source.plain;
    if (source.type === 'lrclib' && source.trackId) {
      try {
        const track = await fetchLyricsJson(`https://lrclib.net/api/get/${encodeURIComponent(source.trackId)}`, timeout);
        if (track.syncedLyrics || track.plainLyrics) return track.syncedLyrics || track.plainLyrics;
      } catch {}
    }
    if (source.type === 'jkaraoke' && source.feedUrl && source.songId) {
      try {
        const page = await fetchLyricsJson(source.feedUrl, timeout);
        const song = page.data?.find((item) => item.id === source.songId);
        const lines = song?.lyrics?.filter((line) => Number.isFinite(line.start) && line.text?.trim()) || [];
        if (lines.length >= 4) return lines.map((line) => `${lyricLrcTime(line.start * 1000)}${line.text.trim()}`).join('\n');
      } catch {}
    }
  }
  return null;
}

function decodeXml(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const value = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity.toLowerCase()] || match;
  });
}

async function getYouTubeSubtitleLyrics({ id }, timeout) {
  const listUrl = new URL('https://www.youtube.com/api/timedtext');
  listUrl.searchParams.set('type', 'list');
  listUrl.searchParams.set('v', id);
  const response = await fetch(listUrl, { headers: { 'user-agent': lyricsUserAgent }, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) return null;
  const tracks = await response.text();
  const options = [...tracks.matchAll(/<track\b([^>]*)\/?\s*>/g)].map((match) => {
    const attributes = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((item) => [item[1], decodeXml(item[2])]));
    return attributes;
  });
  const selected = options.find((track) => track.lang_code === 'en') || options[0];
  if (!selected?.lang_code) return null;
  const captionsUrl = new URL('https://www.youtube.com/api/timedtext');
  captionsUrl.searchParams.set('v', id);
  captionsUrl.searchParams.set('lang', selected.lang_code);
  if (selected.name) captionsUrl.searchParams.set('name', selected.name);
  captionsUrl.searchParams.set('fmt', 'srv3');
  const captionsResponse = await fetch(captionsUrl, { headers: { 'user-agent': lyricsUserAgent }, signal: AbortSignal.timeout(timeout) });
  if (!captionsResponse.ok) return null;
  const xml = await captionsResponse.text();
  const lines = [...xml.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)].map((match) => {
    const start = Number(match[1].match(/\bstart="([\d.]+)"/)?.[1]);
    const text = decodeXml(match[2].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
    return Number.isFinite(start) && text ? `${lyricLrcTime(start * 1000)}${text}` : '';
  }).filter(Boolean);
  return lines.length ? lines.join('\n') : null;
}

function findLyricsEndpoint(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.lyricsEndpoint?.browseEndpoint) return value.lyricsEndpoint.browseEndpoint;
  for (const child of Object.values(value)) {
    const endpoint = findLyricsEndpoint(child);
    if (endpoint) return endpoint;
  }
  return null;
}

function findDescription(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.musicDescriptionShelfRenderer?.description?.runs) {
    return value.musicDescriptionShelfRenderer.description.runs.map((run) => run.text || '').join('');
  }
  for (const child of Object.values(value)) {
    const lyrics = findDescription(child);
    if (lyrics) return lyrics;
  }
  return null;
}

async function getYouTubeLyrics({ id }, timeout) {
  const { apiKey, clientVersion } = await getClientConfig();
  const context = { client: { clientName: 'WEB_REMIX', clientVersion, hl: 'en', gl: 'US' } };
  const next = await fetch(`https://music.youtube.com/youtubei/v1/next?key=${apiKey}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': userAgent },
    body: JSON.stringify({ context, videoId: id }), signal: AbortSignal.timeout(timeout),
  });
  if (!next.ok) return null;
  const endpoint = findLyricsEndpoint(await next.json());
  if (!endpoint?.browseId) return null;
  const browse = await fetch(`https://music.youtube.com/youtubei/v1/browse?key=${apiKey}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': userAgent },
    body: JSON.stringify({ context, browseId: endpoint.browseId, params: endpoint.params }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!browse.ok) return null;
  return findDescription(await browse.json());
}

const lyricsFetchers = {
  BetterLyrics: async () => null,
  LrcLib: getLrcLibLyrics,
  KuGou: getKuGouLyrics,
  Paxsenix: async () => null,
  LyricsPlus: getLyricsPlusLyrics,
  Zemer: getZemerLyrics,
  YouTubeSubtitle: getYouTubeSubtitleLyrics,
  YouTube: getYouTubeLyrics,
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (request.method === 'GET' && (url.pathname === '/api/artist' || url.pathname === '/api/album')) {
    const id = (url.searchParams.get('id') || '').trim();
    if (!/^[\w-]{5,120}$/.test(id)) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'A valid artist or album ID is required.' }));
      return;
    }
    try {
      const data = await browseInnerTube(id);
      const page = url.pathname === '/api/artist'
        ? artistPageFromResponse(id, data)
        : albumPageFromResponse(id, data);
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=180' });
      response.end(JSON.stringify(page));
    } catch (error) {
      response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: error.message || 'Could not load this music page.' }));
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/search') {
    const query = (url.searchParams.get('q') || '').trim().slice(0, 120);
    if (!query) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Enter a search query.' }));
      return;
    }

    try {
      const { apiKey, clientVersion } = await getClientConfig();
      const upstream = await fetch(`https://music.youtube.com/youtubei/v1/search?key=${apiKey}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': userAgent },
        body: JSON.stringify({
          context: { client: { clientName: 'WEB_REMIX', clientVersion, hl: 'en', gl: 'US' } },
          query,
        }),
      });
      if (!upstream.ok) throw new Error(`YouTube Music search failed (${upstream.status})`);
      const payload = await upstream.json();
      const tracks = findTracks(payload);
      const artists = findBrowseEntities(payload, 'MUSIC_PAGE_TYPE_ARTIST').slice(0, 8);
      const albums = findBrowseEntities(payload, 'MUSIC_PAGE_TYPE_ALBUM').slice(0, 8);
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ tracks, artists, albums }));
    } catch (error) {
      response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: error.message || 'Search is temporarily unavailable.' }));
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/lyrics') {
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 16000) {
        response.writeHead(413, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'Lyrics request is too large.' }));
        return;
      }
    }

    try {
      const input = JSON.parse(body);
      const id = String(input.id || '');
      const track = {
        id,
        title: String(input.title || '').trim().slice(0, 200),
        artist: String(input.artist || '').trim().slice(0, 200),
        album: String(input.album || '').trim().slice(0, 200),
        duration: Math.max(0, Math.min(7200, Number(input.duration) || 0)),
      };
      if (!/^[\w-]{6,20}$/.test(id) || !track.title || !track.artist) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'A track ID, title, and artist are required.' }));
        return;
      }
      const requestedOrder = Array.isArray(input.providers) ? input.providers : lyricsProviderOrder;
      const order = [...new Set(requestedOrder.filter((name) => lyricsProviderOrder.includes(name)))];
      for (const name of order) {
        const fetchLyrics = lyricsFetchers[name];
        if (!fetchLyrics) continue;
        try {
          const lyrics = await fetchLyrics(track, 4500);
          if (lyrics?.trim()) {
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            response.end(JSON.stringify({ provider: name, lyrics }));
            return;
          }
        } catch {}
      }
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'No lyrics found from the enabled providers.' }));
    } catch {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'Invalid lyrics request.' }));
    }
    return;
  }

  const pathname = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const file = resolve(root, `.${pathname}`);
  if (!file.startsWith(`${root}${sep}`)) {
    response.writeHead(403);
    response.end();
    return;
  }

  try {
    const content = await readFile(file);
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
    response.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
});

server.listen(port, host, () => {
  console.log(`Metrolist desktop web listening at http://localhost:${port}`);
});
