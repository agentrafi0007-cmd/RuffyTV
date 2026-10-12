/**
 * PeerTube provider — federated open video via the Sepia Search index.
 *
 * Uses only public APIs:
 *   - https://search.joinpeertube.org/api/v1/search/videos  (index search)
 *   - https://<instance>/api/v1/videos/<uuid>                (per-instance files)
 *
 * PeerTube hosts openly-licensed and Creative Commons video. Streams are
 * direct progressive MP4/WebM files served by the originating instance —
 * natively playable on webOS, no remux needed.
 *
 * Implements the provider contract (see ../PROVIDERS.md):
 *   search(query) -> SearchResult[]
 *   getHomePage() -> HomeRow[]
 *   load(url)     -> LoadResponse
 *   loadLinks(episode) -> StreamLink[]
 *
 * Run inside the QuickJS sandbox: network ONLY via the bridged `fetch`
 * (SSRF blocklist + per-author cookie jars enforced by the plugin service).
 */

var SEPIA = "https://search.joinpeertube.org";
var COUNT = 24;

async function fetchJson(url) {
  var response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("PeerTube request failed: " + response.status);
  return response.json();
}

function hostOf(video) {
  var account = video.account || {};
  var channel = video.channel || {};
  return account.host || channel.host || "";
}

function watchUrl(video) {
  var host = hostOf(video);
  if (!host || !video.uuid) return null;
  return "https://" + host + "/videos/watch/" + video.uuid;
}

function toSearchResult(video) {
  if (!video || !video.uuid) return null;
  var url = watchUrl(video);
  if (!url) return null;
  var licence = video.licence && video.licence.label ? video.licence.label : "";
  return {
    title: String(video.name || video.uuid),
    url: url,
    poster: video.thumbnailUrl || undefined,
    type: video.isLive ? "live" : "movie",
    year: video.publishedAt
      ? Number(String(video.publishedAt).slice(0, 4)) || undefined
      : undefined,
    _licence: licence
  };
}

async function searchVideos(query) {
  var data = await fetchJson(
    SEPIA + "/api/v1/search/videos?search=" + encodeURIComponent(query) + "&count=" + COUNT
  );
  return ((data && data.data) || []).map(toSearchResult).filter(Boolean);
}

async function search(args) {
  var query = String((args && args.query) || "").trim();
  if (!query) return [];
  return searchVideos(query);
}

async function getHomePage() {
  // Recently published, openly-licensed videos across the federation.
  var recent = await searchVideos("creative commons");
  var films = await searchVideos("documentary");
  return [
    { title: "Creative Commons picks", results: recent.slice(0, 12) },
    { title: "Documentaries", results: films.slice(0, 12) }
  ].filter(function (row) {
    return row.results.length > 0;
  });
}

function parseWatchUrl(url) {
  var match = String(url || "").match(/^https:\/\/([^/]+)\/videos\/watch\/([0-9a-f-]{36})/i);
  if (!match) return null;
  return { host: match[1], uuid: match[2] };
}

async function load(args) {
  var url = String((args && args.url) || "");
  var parsed = parseWatchUrl(url);
  if (!parsed) throw new Error("Not a PeerTube watch URL: " + url);
  var data = await fetchJson("https://" + parsed.host + "/api/v1/videos/" + parsed.uuid);
  var files = (data.files || []).filter(function (f) {
    return f && f.fileUrl && /^https:\/\//.test(f.fileUrl);
  });
  // Highest resolution first; keep the rest as selectable episodes.
  files.sort(function (a, b) {
    return Number(b.size || 0) - Number(a.size || 0);
  });
  var description = data.description || "";
  return {
    title: String(data.name || parsed.uuid),
    url: url,
    poster: data.thumbnailUrl || undefined,
    plot: String(description).slice(0, 2000),
    year: data.publishedAt ? Number(String(data.publishedAt).slice(0, 4)) || undefined : undefined,
    type: "movie",
    episodes: files.map(function (f) {
      var label = (f.resolution && f.resolution.label) || "source";
      return {
        title: String(label),
        url: String(f.fileUrl),
        poster: data.thumbnailUrl || undefined
      };
    })
  };
}

async function loadLinks(args) {
  var episode = (args && args.episode) || {};
  var url = String(episode.url || "");
  if (!url || !/^https:\/\//.test(url)) return [];
  return [
    {
      server: "PeerTube",
      url: url,
      quality: String(episode.title || "source"),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    }
  ];
}

// CommonJS-style export (the QuickJS worker wraps modules this way).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { search: search, getHomePage: getHomePage, load: load, loadLinks: loadLinks };
}
