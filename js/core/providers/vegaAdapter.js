/**
 * Vega-providers adapter — runs Zenda-Cross/vega-providers (TypeScript,
 * multi-file, Vega contract) inside RuffyTV's QuickJS provider sandbox.
 *
 * Pipeline (all at install time, through the hardened service):
 *   manifest.json --isVegaRepoDocument--> normalizeVegaRepo() -> provider entries
 *   install: fetchVegaSources()  -> sucrase TS->CJS per file
 *          -> transpileVegaBundle() links the files into ONE CJS module whose
 *             module.exports speaks OUR provider contract
 *             (search/getHomePage/load/loadLinks). The existing worker
 *             executes it unchanged; the only worker addition is
 *             globalThis.__vegaAxios (axios-compatible shim over the bridged
 *             fetch) plus require("cheerio"), both injected as the Vega
 *             `providerContext`.
 *
 * Security: identical trust model to ordinary providers — the adapted code
 * runs in the QuickJS sandbox, all network goes through the SSRF-enforcing
 * service, cookie jars stay per-author. sucrase itself only parses; inputs
 * are capped (MAX_VEGA_FILES / MAX_VEGA_BYTES).
 */

import { transform } from "sucrase";

const VEGA_ENTRY_FILES = ["catalog.ts", "posts.ts", "meta.ts", "episodes.ts", "stream.ts"];
const MAX_VEGA_FILES = 48;
const MAX_VEGA_BYTES = 2 * 1024 * 1024;
const VEGA_URL_SCHEME = "vega://";

/** Vega manifests are a bare array of { display_name, value, version, ... }. */
export function isVegaRepoDocument(document) {
  return (
    Array.isArray(document) &&
    document.length > 0 &&
    document.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof entry.value === "string" &&
        entry.value.trim() !== "" &&
        typeof entry.display_name === "string"
    )
  );
}

function stableId(value) {
  let hash = 2166136261;
  const input = String(value || "");
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `prov_${(hash >>> 0).toString(36)}`;
}

/**
 * Normalize a Vega manifest.json into our provider-repo shape. Each provider
 * entry carries `vega: { repoBase, providerValue }` and a synthetic vega://
 * URL; installProvider routes those through the adapter instead of a plain
 * module download.
 */
export function normalizeVegaRepo(document, sourceUrl) {
  if (!isVegaRepoDocument(document)) return null;
  const manifestUrl = String(sourceUrl || "").trim();
  if (!manifestUrl) return null;
  const repoBase = manifestUrl.replace(/\/manifest\.json(?:[?#].*)?$/i, "");
  const providers = document
    .filter((entry) => !entry.disabled)
    .map((entry) => {
      const providerValue = String(entry.value).trim();
      return {
        name: String(entry.display_name).slice(0, 128),
        author: "vega",
        version: String(entry.version || "1.0").slice(0, 32),
        url: `${VEGA_URL_SCHEME}${encodeURIComponent(repoBase)}/${encodeURIComponent(providerValue)}`,
        description: `Vega provider (adapted): ${String(entry.display_name).slice(0, 200)}`,
        type: "other",
        vega: { repoBase, providerValue }
      };
    })
    .filter((entry) => entry.vega.providerValue)
    .slice(0, 128);
  if (!providers.length) return null;
  return {
    id: stableId(`vega::${manifestUrl}`),
    name: "Vega Providers",
    description:
      "Zenda-Cross/vega-providers — TypeScript providers adapted to the RuffyTV contract",
    url: manifestUrl,
    manifestVersion: 1,
    adapter: "vega",
    providers,
    addedAt: Date.now()
  };
}

export function isVegaProviderUrl(url) {
  return String(url || "").startsWith(VEGA_URL_SCHEME);
}

/** Join a relative import specifier onto a base file URL (no URL API — QuickJS-safe). */
export function resolveRelativeUrl(baseFileUrl, specifier) {
  let scheme = "";
  let rest = String(baseFileUrl);
  const schemeMatch = rest.match(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)/);
  if (schemeMatch) {
    scheme = schemeMatch[1];
    rest = rest.slice(scheme.length);
  }
  const slash = rest.lastIndexOf("/");
  const dir = slash >= 0 ? rest.slice(0, slash + 1) : "";
  const parts = (dir + String(specifier)).split("/");
  const out = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(part);
  }
  return scheme + out.join("/");
}

const RELATIVE_IMPORT_RE = /(?:import|export)[^'";]*?from\s*['"](\.[^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;

function scanRelativeImports(tsSource) {
  const found = new Set();
  let match;
  RELATIVE_IMPORT_RE.lastIndex = 0;
  DYNAMIC_IMPORT_RE.lastIndex = 0;
  while ((match = RELATIVE_IMPORT_RE.exec(tsSource)) !== null) found.add(match[1]);
  while ((match = DYNAMIC_IMPORT_RE.exec(tsSource)) !== null) found.add(match[1]);
  return [...found];
}

/**
 * Fetch a Vega provider's TypeScript sources: the entry files plus every
 * relatively-imported dependency, recursively. `fetchText` is injected
 * (service-backed fetch in the app, stub in tests). Missing files (404)
 * are skipped — not every provider ships every entry file.
 */
export async function fetchVegaSources(repoBase, providerValue, fetchText) {
  const base = String(repoBase || "").replace(/\/+$/, "");
  const value = String(providerValue || "").trim();
  if (!base || !value || !/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("Invalid Vega provider reference");
  }
  const dir = `${base}/providers/${value}`;
  const sources = new Map(); // fileUrl -> ts source
  const queue = VEGA_ENTRY_FILES.map((file) => `${dir}/${file}`);
  let bytes = 0;
  while (queue.length > 0) {
    if (sources.size >= MAX_VEGA_FILES) {
      throw new Error(`Vega provider exceeds the ${MAX_VEGA_FILES}-file cap`);
    }
    const fileUrl = queue.shift();
    if (sources.has(fileUrl)) continue;
    let text = null;
    try {
      text = await fetchText(fileUrl);
    } catch (_) {
      continue; // 404 / network blip on an optional file
    }
    if (typeof text !== "string" || !text.trim()) continue;
    bytes += text.length;
    if (bytes > MAX_VEGA_BYTES) {
      throw new Error(`Vega provider exceeds the ${MAX_VEGA_BYTES}-byte cap`);
    }
    sources.set(fileUrl, text);
    for (const specifier of scanRelativeImports(text)) {
      // TypeScript convention is extensionless relative imports.
      const withExt = specifier.endsWith(".ts") ? specifier : `${specifier}.ts`;
      queue.push(resolveRelativeUrl(fileUrl, withExt));
    }
  }
  if (sources.size === 0) {
    throw new Error(`No Vega sources found for provider "${value}"`);
  }
  return sources;
}

/**
 * Transpile + link a Vega provider's TS sources into ONE CommonJS module
 * string whose module.exports implements OUR provider contract
 * (search/getHomePage/load/loadLinks).
 *
 * The emitted module embeds a tiny registry: each file becomes
 * function(require, module, exports){...}; relative requires resolve
 * inside the registry, bare requires delegate to the outer (sandbox)
 * require. A facade at the end maps the Vega exports onto our contract
 * and injects the providerContext ({ axios: __vegaAxios, cheerio }).
 */
export function transpileVegaBundle(sources, providerValue) {
  const value = String(providerValue || "").trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error("Invalid Vega provider value");
  if (!(sources instanceof Map) || sources.size === 0) {
    throw new Error("transpileVegaBundle needs a non-empty source map");
  }

  const entries = [];
  for (const [fileUrl, tsSource] of sources) {
    let js;
    try {
      js = transform(String(tsSource), { transforms: ["typescript", "imports"] }).code;
    } catch (error) {
      throw new Error(`Vega transpile failed for ${fileUrl}: ${error && error.message}`);
    }
    entries.push({ fileUrl, js });
  }

  const registry = entries
    .map(
      ({ fileUrl, js }) =>
        `__vegaRegistry[${JSON.stringify(fileUrl)}] = function(require, module, exports) {\n${js}\n};`
    )
    .join("\n");

  // Minimal Buffer shim: a few providers/extractors use Buffer.from(x,"base64")
  // for obfuscated payloads. Real Uint8Array with an own toString() so both
  // `new Uint8Array(buf)` and `buf.toString("utf-8")` patterns keep working.
  // Full node:crypto (vidstuck-style) is NOT emulated — those code paths
  // throw at call time and surface as ordinary provider errors.
  const prelude = `
"use strict";
var __vegaRegistry = {};
var __vegaModuleCache = {};
function __vegaResolve(fromUrl, spec) {
  var scheme = "";
  var rest = String(fromUrl);
  var sm = rest.match(/^([a-zA-Z][a-zA-Z0-9+.-]*:\\/\\/)/);
  if (sm) { scheme = sm[1]; rest = rest.slice(scheme.length); }
  var slash = rest.lastIndexOf("/");
  var dir = slash >= 0 ? rest.slice(0, slash + 1) : "";
  var parts = (dir + String(spec)).split("/");
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (p === "" || p === ".") continue;
    if (p === "..") { if (out.length > 0) out.pop(); continue; }
    out.push(p);
  }
  return scheme + out.join("/");
}
function __vegaUtf8Decode(bytes) {
  var s = "", i = 0;
  while (i < bytes.length) {
    var b = bytes[i++];
    if (b < 128) s += String.fromCharCode(b);
    else if ((b & 224) === 192) { s += String.fromCharCode(((b & 31) << 6) | (bytes[i++] & 63)); }
    else if ((b & 240) === 224) { s += String.fromCharCode(((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63)); }
    else { i += 3; s += "\\uFFFD"; }
  }
  return s;
}
function __vegaUtf8Encode(str) {
  str = String(str);
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 128) out.push(c);
    else if (c < 2048) out.push(192 | (c >> 6), 128 | (c & 63));
    else out.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
  }
  return out;
}
// Opaque resolver tokens (e.g. autoEmbed's JSON payloads) are wrapped as
// https://vega-token.invalid/<base64url>. The .invalid TLD is RFC-reserved
// and unresolvable by construction, so the token survives http(s) contract
// validation but can never be fetched as a real URL. Unwrapped in loadLinks.
var __VEGA_TOKEN_PREFIX = "https://vega-token.invalid/";
function __vegaWrapToken(token) {
  if (typeof btoa !== "function") return "";
  var bytes = __vegaUtf8Encode(token), bin = "";
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return __VEGA_TOKEN_PREFIX + btoa(bin).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
}
function __vegaUnwrapToken(url) {
  url = String(url || "");
  if (url.indexOf(__VEGA_TOKEN_PREFIX) !== 0 || typeof atob !== "function") return null;
  try {
    var b64 = url.slice(__VEGA_TOKEN_PREFIX.length).replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    var bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 255;
    return __vegaUtf8Decode(bytes);
  } catch (e) { return null; }
}
function __vegaBytesToString(bytes, enc) {
  if (enc === "base64") {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return (typeof btoa === "function") ? btoa(s) : "";
  }
  return __vegaUtf8Decode(bytes);
}
function __vegaBufferFrom(str, enc) {
  var bytes;
  if (enc === "base64" && typeof atob === "function") {
    var bin = atob(String(str).replace(/\\s/g, ""));
    bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 255;
  } else {
    var s = String(str), tmp = [];
    for (var j = 0; j < s.length; j++) {
      var c = s.charCodeAt(j);
      if (c < 128) tmp.push(c);
      else if (c < 2048) tmp.push(192 | (c >> 6), 128 | (c & 63));
      else tmp.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
    }
    bytes = new Uint8Array(tmp);
  }
  bytes.toString = function (e) { return __vegaBytesToString(this, e || "utf-8"); };
  return bytes;
}
if (typeof Buffer === "undefined") {
  var Buffer = {
    from: __vegaBufferFrom,
    alloc: function (n) { var b = new Uint8Array(n); b.toString = function (e) { return __vegaBytesToString(this, e || "utf-8"); }; return b; },
    concat: function (list) {
      var total = 0, i, b;
      for (i = 0; i < list.length; i++) total += list[i].length;
      var out = new Uint8Array(total), off = 0;
      for (i = 0; i < list.length; i++) { b = list[i]._b || list[i]; out.set(b, off); off += b.length; }
      out.toString = function (e) { return __vegaBytesToString(this, e || "utf-8"); };
      return out;
    }
  };
}
function __vegaMakeRequire(fromUrl, outerRequire) {
  return function (name) {
    if (typeof name !== "string") throw new Error("require() needs a string");
    if (name.charAt(0) !== ".") return outerRequire(name);
    var resolved = __vegaResolve(fromUrl, name);
    var key = __vegaRegistry[resolved] ? resolved : (__vegaRegistry[resolved + ".ts"] ? resolved + ".ts" : null);
    if (!key) throw new Error("Vega module not found: " + name);
    if (!Object.prototype.hasOwnProperty.call(__vegaModuleCache, key)) {
      var module = { exports: {} };
      __vegaModuleCache[key] = module.exports;
      __vegaRegistry[key](__vegaMakeRequire(key, outerRequire), module, module.exports);
      __vegaModuleCache[key] = module.exports;
    }
    return __vegaModuleCache[key];
  };
}
`;

  const facade = `
;(function () {
  var VALUE = ${JSON.stringify(value)};
  var outerRequire = (typeof require === "function") ? require : function (n) { throw new Error("require not available: " + n); };
  var V = {};
  var __dir = ${JSON.stringify("__VEGA_DIR__")};
  var __entryFiles = ${JSON.stringify(VEGA_ENTRY_FILES)};
  for (var __i = 0; __i < __entryFiles.length; __i++) {
    var __url = __dir + "/" + __entryFiles[__i];
    if (__vegaRegistry[__url]) {
      try {
        var __ex = __vegaMakeRequire(__url, outerRequire)("./" + __entryFiles[__i]);
        for (var __k in __ex) { if (__ex[__k] !== undefined) V[__k] = __ex[__k]; }
      } catch (e) { /* an entry file failing to load must not kill the bundle */ }
    }
  }
  var __ctx = {
    axios: globalThis.__vegaAxios,
    cheerio: (function () { try { return outerRequire("cheerio"); } catch (e) { return null; } })(),
    commonHeaders: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" },
    providerValue: VALUE
  };
  // Vega Post.link values are often site-relative paths ("/download-.../").
  // Capture the response origin on every axios call so relative links can be
  // resolved to absolute URLs before contract validation.
  var __capturedOrigin = "";
  function __captureOrigin(response) {
    try {
      var u = (response && response.config && response.config.url) || "";
      var m = String(u).match(/^([a-zA-Z][a-zA-Z0-9+.-]*:\\/\\/[^/]+)/);
      if (m) __capturedOrigin = m[1];
    } catch (e) {}
  }
  if (__ctx.axios) {
    (function () {
      var raw = __ctx.axios;
      function wrap(fn) {
        return function () {
          return fn.apply(raw, arguments).then(function (r) { __captureOrigin(r); return r; });
        };
      }
      function wrappedAxios(url, config) {
        var p = (url && typeof url === "object") ? raw.request(url) : raw(url, config);
        return p.then(function (r) { __captureOrigin(r); return r; });
      }
      wrappedAxios.get = wrap(raw.get);
      wrappedAxios.post = wrap(raw.post);
      wrappedAxios.head = raw.head ? wrap(raw.head) : undefined;
      wrappedAxios.request = raw.request ? wrap(raw.request) : undefined;
      wrappedAxios.isAxiosError = raw.isAxiosError;
      __ctx.axios = wrappedAxios;
    })();
  }
  function __resolveLink(link) {
    var l = String(link || "");
    if (l.indexOf("http://") === 0 || l.indexOf("https://") === 0) return l;
    if (l.charAt(0) === "/" && __capturedOrigin) return __capturedOrigin + l;
    return l;
  }
  var __getSearchPosts = V.getSearchPosts;
  var __getPosts = V.getPosts || V.getHomePosts;
  var __getMeta = V.getMeta || V.getMetaData;
  var __getEpisodes = V.getEpisodes || V.getEpisodeLinks;
  var __getStream = V.getStream || V.GetStream;
  function __postToResult(p) {
    if (!p || !p.title || !p.link) return null;
    var url = __resolveLink(p.link);
    if (!url) return null;
    return { title: String(p.title), url: url, poster: p.image ? String(p.image) : "", type: "other" };
  }
  function __ctxCheck() {
    if (!__ctx.axios) throw new Error("Vega providerContext.axios is unavailable in this runtime");
    if (!__ctx.cheerio) throw new Error("Vega providerContext.cheerio is unavailable in this runtime");
  }
  // Vega "links" are sometimes opaque resolver tokens (e.g. autoEmbed's JSON
  // payload), not URLs. Wrap them so they survive contract validation;
  // loadLinks unwraps before calling getStream. Relative site paths are
  // resolved against the captured origin first.
  function __episodeUrl(raw) {
    var l = __resolveLink(raw);
    if (l.indexOf("http://") === 0 || l.indexOf("https://") === 0) return l;
    return __vegaWrapToken(l);
  }
  module.exports = {
    search: async function (ref) {
      __ctxCheck();
      if (!__getSearchPosts) return [];
      var posts = await __getSearchPosts({ searchQuery: ref.query, page: 1, providerValue: VALUE, providerContext: __ctx });
      return (posts || []).map(__postToResult).filter(Boolean);
    },
    getHomePage: async function () {
      __ctxCheck();
      var rails = [];
      var catalog = V.catalog || [];
      for (var i = 0; i < Math.min(catalog.length, 5); i++) {
        if (!__getPosts) break;
        try {
          var posts = await __getPosts({ filter: catalog[i].filter, page: 1, providerValue: VALUE, providerContext: __ctx });
          rails.push({ title: String(catalog[i].title || "Row"), results: (posts || []).map(__postToResult).filter(Boolean) });
        } catch (e) { /* one bad rail must not kill the home page */ }
      }
      return rails;
    },
    load: async function (ref) {
      __ctxCheck();
      if (!__getMeta) return null;
      var info = await __getMeta({ link: ref.url, provider: VALUE, providerContext: __ctx });
      if (!info) return null;
      var episodes = [];
      var links = info.linkList || [];
      for (var i = 0; i < links.length; i++) {
        var link = links[i] || {};
        var direct = link.directLinks || [];
        for (var j = 0; j < direct.length; j++) {
          if (direct[j] && direct[j].link) {
            var durl = __episodeUrl(direct[j].link);
            if (durl) episodes.push({ title: String(direct[j].title || link.title || "Part " + (j + 1)), url: durl });
          }
        }
        if (direct.length === 0 && link.episodesLink && __getEpisodes) {
          var eps = await __getEpisodes({ url: link.episodesLink, providerContext: __ctx });
          (eps || []).forEach(function (e, k) {
            if (e && e.link) {
              var eurl = __episodeUrl(e.link);
              if (eurl) episodes.push({ title: String(e.title || "Episode " + (k + 1)), url: eurl });
            }
          });
        }
      }
      return {
        title: String(info.title || ""),
        url: ref.url,
        poster: info.poster || info.image || "",
        plot: info.synopsis || "",
        type: "movie",
        episodes: episodes
      };
    },
    loadLinks: async function (ref) {
      __ctxCheck();
      if (!__getStream) return [];
      var ep = ref.episode || {};
      var link = String(ep.url || "");
      var unwrapped = __vegaUnwrapToken(link);
      if (unwrapped !== null) link = unwrapped;
      var streams = await __getStream({ link: link, type: ep.season != null ? "series" : "movie", providerContext: __ctx });
      return (streams || [])
        .filter(function (s) { return s && s.link; })
        .map(function (s) {
          return {
            url: String(s.link),
            server: s.server ? String(s.server) : "",
            quality: s.quality ? String(s.quality) : "",
            headers: s.headers || {},
            subtitles: (s.subtitles || []).map(function (t) {
              return { url: t.uri ? String(t.uri) : "", lang: t.language ? String(t.language) : "", label: t.title ? String(t.title) : "" };
            })
          };
        });
    }
  };
})();
`;

  // The provider dir URL: every source URL shares it (they were resolved
  // relative to it). Derive from any entry file that exists.
  const firstUrl = entries[0].fileUrl;
  const dirUrl = firstUrl.slice(0, firstUrl.lastIndexOf("/"));
  const body = facade.split("__VEGA_DIR__").join(dirUrl);

  return prelude + "\n" + registry + "\n" + body;
}

/**
 * Full install-time pipeline for one Vega provider: fetch TS sources,
 * transpile + link into a single CJS module speaking our contract.
 * Returns the module code string (stored as provider.code like any other).
 */
export async function installVegaProviderCode(vegaMeta, fetchText) {
  if (!vegaMeta || !vegaMeta.repoBase || !vegaMeta.providerValue) {
    throw new Error("Invalid Vega provider reference");
  }
  const sources = await fetchVegaSources(vegaMeta.repoBase, vegaMeta.providerValue, fetchText);
  const code = transpileVegaBundle(sources, vegaMeta.providerValue);
  const bytes =
    typeof TextEncoder === "function" ? new TextEncoder().encode(code).byteLength : code.length * 2;
  if (bytes > MAX_VEGA_BYTES) {
    throw new Error(`Adapted Vega provider exceeds the ${MAX_VEGA_BYTES}-byte cap`);
  }
  return code;
}
