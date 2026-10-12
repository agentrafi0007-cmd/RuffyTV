/**
 * Wikimedia Commons provider — openly-licensed media repository.
 *
 * Uses only the public MediaWiki API (no key, no scraping):
 *   https://commons.wikimedia.org/w/api.php
 * with generator=search + prop=imageinfo so each result carries its direct
 * upload.wikimedia.org file URL in a single request.
 *
 * All content on Commons is freely licensed (CC / public domain). Streams
 * are direct progressive WebM/MP4/OGV files — natively playable on webOS.
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

var API = "https://commons.wikimedia.org/w/api.php";
var ROWS = 24;

function apiUrl(params) {
  var parts = ["action=query", "format=json", "formatversion=2"];
  for (var key in params) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(params[key]));
    }
  }
  return API + "?" + parts.join("&");
}

async function fetchJson(url) {
  var response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("Commons API request failed: " + response.status);
  return response.json();
}

function cleanUrl(url) {
  // Strip analytics query params the API appends; keep the raw file URL.
  return String(url || "").split("?")[0];
}

function cleanTitle(pageTitle) {
  var title = String(pageTitle || "").replace(/^File:/, "");
  // Drop the extension and tidy separators: "Big Buck Bunny 4K.webm" -> "Big Buck Bunny 4K"
  title = title
    .replace(/\.[a-z0-9]{2,4}$/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return title || pageTitle;
}

function filePageUrl(pageTitle) {
  return (
    "https://commons.wikimedia.org/wiki/File:" +
    encodeURIComponent(
      String(pageTitle)
        .replace(/^File:/, "")
        .replace(/ /g, "_")
    )
  );
}

function toSearchResult(page) {
  if (!page) return null;
  var info = (page.imageinfo && page.imageinfo[0]) || {};
  var url = cleanUrl(info.url);
  var mime = String(info.mime || "");
  if (!url || mime.indexOf("video/") !== 0) return null;
  return {
    title: cleanTitle(page.title),
    url: filePageUrl(page.title),
    poster: info.thumburl ? cleanUrl(info.thumburl) : undefined,
    type: "movie"
  };
}

async function searchFiles(query, limit) {
  var data = await fetchJson(
    apiUrl({
      generator: "search",
      gsrsearch: query + " filetype:video",
      gsrnamespace: 6,
      gsrlimit: limit || ROWS,
      prop: "imageinfo",
      iiprop: "url|size|mime",
      iiurlwidth: 320
    })
  );
  var pages = (data.query && data.query.pages) || [];
  return pages.map(toSearchResult).filter(Boolean);
}

async function search(args) {
  var query = String((args && args.query) || "").trim();
  if (!query) return [];
  return searchFiles(query, ROWS);
}

async function getHomePage() {
  var openMovies = await searchFiles("blender foundation open movie", 12);
  var nature = await searchFiles("nature documentary", 12);
  return [
    { title: "Blender open movies", results: openMovies },
    { title: "Nature footage", results: nature }
  ].filter(function (row) {
    return row.results.length > 0;
  });
}

function parseFileTitle(url) {
  var match = String(url || "").match(/\/wiki\/File:([^?#]+)/i);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]).replace(/_/g, " ");
  } catch (_) {
    return null;
  }
}

async function load(args) {
  var url = String((args && args.url) || "");
  var fileTitle = parseFileTitle(url);
  if (!fileTitle) throw new Error("Not a Commons file URL: " + url);
  var data = await fetchJson(
    apiUrl({
      titles: "File:" + fileTitle,
      prop: "imageinfo",
      iiprop: "url|size|mime|extmetadata",
      iiextmetadatafilter: "ImageDescription"
    })
  );
  var pages = (data.query && data.query.pages) || [];
  var page = pages[0];
  if (!page) throw new Error("File not found: " + fileTitle);
  var info = (page.imageinfo && page.imageinfo[0]) || {};
  var fileUrl = cleanUrl(info.url);
  if (!fileUrl) throw new Error("No playable file for: " + fileTitle);
  var desc =
    info.extmetadata &&
    info.extmetadata.ImageDescription &&
    info.extmetadata.ImageDescription.value;
  var size = info.size ? Math.round(Number(info.size) / 1048576) + " MB" : "";
  return {
    title: cleanTitle(page.title),
    url: url,
    poster: info.thumburl ? cleanUrl(info.thumburl) : undefined,
    plot: String(desc || "")
      .replace(/<[^>]*>/g, "")
      .slice(0, 2000),
    type: "movie",
    episodes: [
      {
        title: [String(info.mime || "video"), size].filter(Boolean).join(" · "),
        url: fileUrl
      }
    ]
  };
}

async function loadLinks(args) {
  var episode = (args && args.episode) || {};
  var url = String(episode.url || "");
  if (!url || !/^https:\/\//.test(url)) return [];
  return [
    {
      server: "Wikimedia Commons",
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
