/**
 * Internet Archive provider — TEST / REFERENCE provider.
 *
 * Uses only the Internet Archive's public JSON APIs over openly-licensed
 * and public-domain content. No scraping, no copyrighted sources.
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

var BASE = "https://archive.org";
var VIDEO_EXTENSIONS = /\.(mp4|ogv|ogm|webm|m4v|mov)$/i;

async function fetchJson(url) {
  var response = await fetch(url, {
    headers: { Accept: "application/json" }
  });
  if (!response.ok) throw new Error("Archive.org request failed: " + response.status);
  return response.json();
}

function posterFor(identifier) {
  return BASE + "/services/img/" + identifier;
}

function toSearchResult(doc) {
  if (!doc || !doc.identifier) return null;
  var title = doc.title;
  if (Array.isArray(title)) title = title[0];
  title = String(title || doc.identifier);
  return {
    title: title,
    url: BASE + "/details/" + doc.identifier,
    poster: posterFor(doc.identifier),
    type: "movie",
    year: doc.year ? Number(doc.year) : undefined
  };
}

async function search(args) {
  var query = String((args && args.query) || "").trim();
  if (!query) return [];
  var q = encodeURIComponent("mediatype:movies AND (" + query + ")");
  var data = await fetchJson(
    BASE +
      "/advancedsearch.php?q=" +
      q +
      "&fl[]=identifier&fl[]=title&fl[]=year&rows=24&output=json"
  );
  var docs = (data && data.response && data.response.docs) || [];
  return docs.map(toSearchResult).filter(Boolean);
}

async function getHomePage() {
  // Featured: most-downloaded movies this week (public API sort).
  var data = await fetchJson(
    BASE +
      "/advancedsearch.php?q=" +
      encodeURIComponent("mediatype:movies") +
      "&fl[]=identifier&fl[]=title&fl[]=year&rows=24&output=json" +
      "&sort[]=downloads desc"
  );
  var docs = (data && data.response && data.response.docs) || [];
  return [
    {
      title: "Most downloaded this week",
      results: docs.map(toSearchResult).filter(Boolean)
    }
  ];
}

async function load(args) {
  var url = String((args && args.url) || "");
  var match = url.match(/\/details\/([^/?#]+)/);
  if (!match) throw new Error("Not an archive.org details URL: " + url);
  var identifier = match[1];
  var data = await fetchJson(BASE + "/metadata/" + encodeURIComponent(identifier));
  var metadata = data.metadata || {};
  var title = metadata.title;
  if (Array.isArray(title)) title = title[0];
  var plot = metadata.description;
  if (Array.isArray(plot)) plot = plot[0];
  var files = (data.files || []).filter(function (file) {
    return file && VIDEO_EXTENSIONS.test(String(file.name || "")) && file.name.indexOf("/") < 0;
  });
  // Prefer the smallest playable file first (bandwidth-friendly default),
  // keep the rest as episodes so the user can pick quality.
  files.sort(function (a, b) {
    return Number(a.size || 0) - Number(b.size || 0);
  });
  return {
    title: String(title || identifier),
    url: url,
    poster: posterFor(identifier),
    plot: String(plot || "").slice(0, 2000),
    year: metadata.year ? Number(metadata.year) : undefined,
    type: "movie",
    episodes: files.map(function (file) {
      return {
        title: String(file.name),
        url: BASE + "/download/" + identifier + "/" + encodeURIComponent(String(file.name)),
        poster: posterFor(identifier)
      };
    })
  };
}

async function loadLinks(args) {
  var episode = (args && args.episode) || {};
  var url = String(episode.url || "");
  if (!url) return [];
  return [
    {
      server: "Internet Archive",
      url: url,
      quality: "source",
      headers: {
        // Archive.org serves range requests; the native player handles them.
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    }
  ];
}

// CommonJS-style export (the QuickJS worker wraps modules this way).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { search: search, getHomePage: getHomePage, load: load, loadLinks: loadLinks };
}
