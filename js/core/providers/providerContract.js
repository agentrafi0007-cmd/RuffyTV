/**
 * Provider contract — the JS API every content provider must implement.
 *
 * Shaped by CloudStream's MainAPI (search / getMainPage / load / loadLinks)
 * but expressed in plain JavaScript for the QuickJS sandbox. A provider is a
 * JS module whose `module.exports` (or globals) implement any subset of:
 *
 *   search(query: string)            -> SearchResult[]
 *   getHomePage()                    -> HomeRow[]
 *   load(url: string)                -> LoadResponse
 *   loadLinks(episode: Episode)      -> StreamLink[]
 *
 * All four are async-friendly (may return a Promise). Missing entry points
 * resolve to empty results; they never throw the host.
 *
 * Execution: providers run inside the existing QuickJS Web-Worker sandbox
 * (js/core/player/pluginWorker.js). Network access is ONLY via the bridged
 * `fetch`, which routes through the plugin HTTP service
 * (services/plugin-http.cjs) where the SSRF blocklist and per-author cookie
 * jars are enforced. Providers never see raw sockets, the service port, or
 * other providers' cookies.
 */

export const PROVIDER_API_VERSION = 1;

/** Entry points the host can invoke. `getStreams` is the legacy NUVIO_JS contract. */
export const PROVIDER_ENTRY_POINTS = Object.freeze(["search", "getHomePage", "load", "loadLinks"]);

export const PROVIDER_CONTENT_TYPES = Object.freeze([
  "movie",
  "series",
  "anime",
  "live",
  "audio",
  "other"
]);

export const MAX_PROVIDER_RESULTS = 50;
export const MAX_PROVIDER_EPISODES = 5000;
export const MAX_PROVIDER_LINKS = 100;

function text(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function validUrl(value) {
  const raw = text(value);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return parsed.toString();
  } catch (_) {
    return "";
  }
}

function normalizeContentType(value) {
  const normalized = text(value).toLowerCase();
  return PROVIDER_CONTENT_TYPES.includes(normalized) ? normalized : "other";
}

/**
 * SearchResult — one row from search() or getHomePage().
 * { title: string (required), url: string (required, http/https),
 *   poster?: string, type?: content type, year?: number }
 */
export function validateSearchResult(entry) {
  if (!entry || typeof entry !== "object") return null;
  const title = text(entry.title);
  const url = validUrl(entry.url);
  if (!title || !url) return null;
  const result = { title, url, type: normalizeContentType(entry.type) };
  const poster = validUrl(entry.poster);
  if (poster) result.poster = poster;
  const year = Number(entry.year);
  if (Number.isInteger(year) && year >= 1800 && year <= 2100) result.year = year;
  return result;
}

/**
 * HomeRow — one rail on the home page.
 * { title: string (required), results: SearchResult[] }
 */
export function validateHomeRow(entry) {
  if (!entry || typeof entry !== "object") return null;
  const title = text(entry.title);
  if (!title) return null;
  const results = (Array.isArray(entry.results) ? entry.results : [])
    .map(validateSearchResult)
    .filter(Boolean)
    .slice(0, MAX_PROVIDER_RESULTS);
  return { title, results };
}

/**
 * Episode — one playable item.
 * { title: string (required), url: string (required),
 *   season?: number, episode?: number, poster?: string }
 */
export function validateEpisode(entry) {
  if (!entry || typeof entry !== "object") return null;
  const title = text(entry.title);
  const url = validUrl(entry.url);
  if (!title || !url) return null;
  const episode = { title, url };
  const season = Number(entry.season);
  if (Number.isInteger(season) && season >= 0) episode.season = season;
  const episodeNum = Number(entry.episode);
  if (Number.isInteger(episodeNum) && episodeNum >= 0) episode.episode = episodeNum;
  const poster = validUrl(entry.poster);
  if (poster) episode.poster = poster;
  return episode;
}

/**
 * LoadResponse — full detail page.
 * { title: string (required), url: string (required), type,
 *   poster?, plot?, year?, episodes: Episode[] }
 */
export function validateLoadResponse(entry) {
  if (!entry || typeof entry !== "object") return null;
  const title = text(entry.title);
  const url = validUrl(entry.url);
  if (!title || !url) return null;
  const response = { title, url, type: normalizeContentType(entry.type) };
  const poster = validUrl(entry.poster);
  if (poster) response.poster = poster;
  const plot = text(entry.plot);
  if (plot) response.plot = plot.slice(0, 4000);
  const year = Number(entry.year);
  if (Number.isInteger(year) && year >= 1800 && year <= 2100) response.year = year;
  response.episodes = (Array.isArray(entry.episodes) ? entry.episodes : [])
    .map(validateEpisode)
    .filter(Boolean)
    .slice(0, MAX_PROVIDER_EPISODES);
  return response;
}

/**
 * StreamLink — one playable stream.
 * { url: string (required, http/https), server?: string, quality?: string,
 *   headers?: object, subtitles?: [{url, lang?, label?}] }
 */
export function validateStreamLink(entry) {
  if (!entry || typeof entry !== "object") return null;
  const url = validUrl(entry.url);
  if (!url) return null;
  const link = { url };
  const server = text(entry.server);
  if (server) link.server = server.slice(0, 128);
  const quality = text(entry.quality);
  if (quality) link.quality = quality.slice(0, 32);
  if (entry.headers && typeof entry.headers === "object") {
    const headers = {};
    for (const [key, value] of Object.entries(entry.headers).slice(0, 32)) {
      const name = text(key);
      if (!name || /^(cookie|set-cookie|host|content-length)$/i.test(name)) continue;
      headers[name] = text(value).slice(0, 2048);
    }
    if (Object.keys(headers).length) link.headers = headers;
  }
  if (Array.isArray(entry.subtitles)) {
    const subtitles = entry.subtitles
      .map((sub) => {
        if (!sub || typeof sub !== "object") return null;
        const subUrl = validUrl(sub.url);
        if (!subUrl) return null;
        const track = { url: subUrl };
        const lang = text(sub.lang).slice(0, 16);
        if (lang) track.lang = lang;
        const label = text(sub.label).slice(0, 64);
        if (label) track.label = label;
        return track;
      })
      .filter(Boolean)
      .slice(0, 16);
    if (subtitles.length) link.subtitles = subtitles;
  }
  return link;
}

/**
 * Provider metadata as declared in a repo.json `providers` entry.
 * { name (required), author, version, url (required, .js), description, type }
 */
export function validateProviderMetadata(entry) {
  if (!entry || typeof entry !== "object") return null;
  const name = text(entry.name);
  const url = validUrl(entry.url);
  if (!name || !url) return null;
  if (!/\.(?:mjs|cjs|js)(?:$|[?#])/i.test(url)) return null;
  return {
    name: name.slice(0, 128),
    author: text(entry.author, "unknown").slice(0, 128),
    version: text(entry.version, "0.0.0").slice(0, 32),
    url,
    description: text(entry.description).slice(0, 512),
    type: normalizeContentType(entry.type)
  };
}

/** Validate a raw provider result by entry point. Returns the sanitized value. */
export function validateProviderResult(entryPoint, value) {
  switch (entryPoint) {
    case "search":
      return (Array.isArray(value) ? value : [])
        .map(validateSearchResult)
        .filter(Boolean)
        .slice(0, MAX_PROVIDER_RESULTS);
    case "getHomePage":
      return (Array.isArray(value) ? value : []).map(validateHomeRow).filter(Boolean).slice(0, 32);
    case "load":
      return validateLoadResponse(value);
    case "loadLinks":
      return (Array.isArray(value) ? value : [])
        .map(validateStreamLink)
        .filter(Boolean)
        .slice(0, MAX_PROVIDER_LINKS);
    default:
      return null;
  }
}
