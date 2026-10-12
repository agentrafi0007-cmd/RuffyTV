var http = require("http");
var https = null;
var dns = null;
var net = null;
var urlModule = null;
var zlib = null;

function loadRuntimeModule(name) {
  return require(name);
}

function getUrlModule() {
  if (!urlModule) urlModule = loadRuntimeModule("url");
  return urlModule;
}

function getNetModule() {
  if (!net) net = loadRuntimeModule("net");
  return net;
}

function getDnsModule() {
  if (!dns) dns = loadRuntimeModule("dns");
  return dns;
}

function getHttpsModule() {
  if (!https) https = loadRuntimeModule("https");
  return https;
}

function getZlibModule() {
  if (!zlib) zlib = loadRuntimeModule("zlib");
  return zlib;
}

var MAX_REQUEST_BYTES = 1024 * 1024;
var MAX_SERVICE_REQUEST_BYTES = Math.ceil(MAX_REQUEST_BYTES / 3) * 4 + 64 * 1024;
var DEFAULT_RESPONSE_BYTES = 1024 * 1024;
// Keep the service envelope consistent with the modern app policy. Plugin
// fetches still request the Android 1 MiB cap; this upper bound is for
// manifest/code management responses.
var MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
var MAX_WIRE_RESPONSE_BYTES = MAX_RESPONSE_BYTES;
var MAX_REDIRECTS = 20;
// Android gives each provider request a 60-second budget; the caller still
// enforces the separate 120-second global plugin-search deadline.
var DEFAULT_TIMEOUT_MS = 60000;
// Match Android's OkHttp connect timeout while leaving the existing 60-second
// request/read timeout unchanged. This is the per-address budget used when a
// DNS route fails before a response is received.
var CONNECT_ATTEMPT_TIMEOUT_MS = 30000;
var MAX_FAILED_ROUTES = 256;
var MAX_IDLE_CONNECTIONS = 5;
var PLUGIN_PROTOCOL_VERSION = 1;
var MAX_ACTIVE_REQUESTS = 10;
// Keep the active network cap unchanged, but queue the burst generated when
// one scraper issues several fetches. Android queues eligible scraper work;
// rejecting overflow here turns otherwise independent providers into failures.
var MAX_QUEUED_REQUESTS = 128;
var MAX_REQUESTS_PER_SCRAPER_PER_MINUTE = 60;
var CIRCUIT_FAILURE_LIMIT = 3;
var CIRCUIT_OPEN_MS = 30000;

function emitTrace(trace, event, details) {
  if (typeof trace !== "function") return;
  try {
    trace(event, details || {});
  } catch (_) {
    // Diagnostics must never affect the network service.
  }
}

function traceError(error) {
  var result = {
    name: error && error.name ? String(error.name) : "Error",
    message: error && error.message ? String(error.message) : String(error || "Unknown error")
  };
  if (error && error.code) result.code = String(error.code);
  if (error && error.stack) result.stack = String(error.stack).slice(0, 1200);
  return result;
}

function traceRequestDetails(payload, parsed, redirects) {
  var method = String((payload && payload.method) || "GET").toUpperCase();
  var details = {
    requestId: String((payload && payload.requestId) || "").slice(0, 128),
    method: method.slice(0, 12),
    redirect: Number(redirects) || 0
  };
  if (parsed) {
    details.protocol = String(parsed.protocol || "");
    details.host = String(parsed.hostname || "").slice(0, 255);
    details.port = Number(parsed.port || 0) || (parsed.protocol === "https:" ? 443 : 80);
    // Never include query strings: plugin URLs may contain configuration data.
    details.path = String(parsed.pathname || "/").slice(0, 512);
  }
  return details;
}

function isLoopbackAddress(value) {
  var address = String(value || "")
    .trim()
    .toLowerCase();
  if (!address) return false;
  address = address.split("%", 1)[0];
  if (address === "::1" || address === "0:0:0:0:0:0:0:1") return true;
  address = address.replace(/^::ffff:/, "");
  return /^127(?:\.\d{1,3}){3}$/.test(address);
}

function isLoopbackRequest(request) {
  var socket = request && (request.socket || request.connection);
  return isLoopbackAddress(socket && socket.remoteAddress);
}

/**
 * SSRF blocklist — Vega parity (see vega-desktop providerSandbox).
 * Rejects loopback, private, link-local, multicast and other non-public
 * ranges for OUTGOING provider fetch targets. Checked both against literal
 * IP hostnames and against every DNS-resolved address (fail-closed against
 * DNS rebinding: if ANY resolved address is non-public, the request dies).
 */
function isPrivateIPv4(address) {
  var parts = String(address || "").split(".");
  if (parts.length !== 4) return false;
  var nums = [];
  for (var i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return false;
    var n = Number(parts[i]);
    if (n < 0 || n > 255) return false;
    nums.push(n);
  }
  // 127.0.0.0/8 loopback
  if (nums[0] === 127) return true;
  // 10.0.0.0/8 private
  if (nums[0] === 10) return true;
  // 172.16.0.0/12 private
  if (nums[0] === 172 && nums[1] >= 16 && nums[1] <= 31) return true;
  // 192.168.0.0/16 private
  if (nums[0] === 192 && nums[1] === 168) return true;
  // 169.254.0.0/16 link-local
  if (nums[0] === 169 && nums[1] === 254) return true;
  // 0.0.0.0/8 "this network"
  if (nums[0] === 0) return true;
  // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  if (nums[0] >= 224) return true;
  // 192.88.99.0/24 6to4 relay, 192.0.2.0/24 TEST-NET-1,
  // 198.51.100.0/24 TEST-NET-2, 203.0.113.0/24 TEST-NET-3
  if (nums[0] === 192 && nums[1] === 88 && nums[2] === 99) return true;
  if (nums[0] === 192 && nums[1] === 0 && nums[2] === 2) return true;
  if (nums[0] === 198 && nums[1] === 51 && nums[2] === 100) return true;
  if (nums[0] === 203 && nums[1] === 0 && nums[2] === 113) return true;
  return false;
}

function isPrivateIPv6(address) {
  var addr = String(address || "")
    .trim()
    .toLowerCase()
    .split("%", 1)[0];
  if (!addr || addr.indexOf(":") < 0) return false;
  // ::1 loopback (and its expanded form)
  if (addr === "::1" || addr === "0:0:0:0:0:0:0:1") return true;
  // ::ffff:0:0/96 IPv4-mapped — check the embedded IPv4
  var mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  // fe80::/10 link-local
  if (/^fe[89ab][0-9a-f]:/i.test(addr)) return true;
  // fc00::/7 unique-local
  if (/^f[c-d][0-9a-f]{2}:/i.test(addr)) return true;
  // ::/128 unspecified
  if (/^(0+:)+0+$/.test(addr.replace(/:/g, ":").split(":").length ? addr : "")) return true;
  // ff00::/8 multicast
  if (/^ff[0-9a-f]{2}:/i.test(addr)) return true;
  return false;
}

/** True when the address must never be an outgoing fetch target. */
function isBlockedAddress(address) {
  var value = String(address || "").trim();
  if (!value) return true;
  if (value.indexOf(":") >= 0) return isPrivateIPv6(value);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) return isPrivateIPv4(value);
  return false;
}

/** True when the URL hostname is a blocked literal (IP or .localhost). */
function isBlockedHostname(hostname) {
  var host = String(hostname || "")
    .trim()
    .toLowerCase();
  if (!host) return true;
  // Strip IPv6 brackets: new URL("http://[::1]/").hostname === "[::1]" in
  // Node, and the bracketed form must not slip past the literal check below.
  if (host.charAt(0) === "[" && host.charAt(host.length - 1) === "]") {
    host = host.slice(1, -1);
  }
  if (host === "localhost" || /\.localhost$/.test(host)) return true;
  return isBlockedAddress(host);
}

/**
 * Per-author cookie jars — Vega parity (providerCookieJar).
 * Key: repositoryId + scraperId, so providers cannot read each other's
 * sessions. Domain-matched, expiry-pruned, capped at 500 cookies per jar.
 * Stored in service memory only (never persisted, never sent to the UI).
 */
var cookieJars = Object.create(null);
var MAX_COOKIES_PER_JAR = 500;

function cookieJarKey(payload) {
  var repo = String((payload && payload.repositoryId) || "").slice(0, 128);
  var scraper = String((payload && payload.scraperId) || "").slice(0, 128);
  return repo + "\n" + scraper;
}

function getCookieJar(key) {
  var jar = cookieJars[key];
  if (!jar) {
    jar = { cookies: [] };
    cookieJars[key] = jar;
  }
  return jar;
}

function pruneCookieJar(jar) {
  var now = Date.now();
  jar.cookies = jar.cookies.filter(function (entry) {
    return !entry.expiresAt || entry.expiresAt > now;
  });
  if (jar.cookies.length > MAX_COOKIES_PER_JAR) {
    jar.cookies = jar.cookies.slice(jar.cookies.length - MAX_COOKIES_PER_JAR);
  }
}

function cookieDomainMatches(requestHost, cookieDomain) {
  requestHost = String(requestHost || "").toLowerCase();
  cookieDomain = String(cookieDomain || "")
    .toLowerCase()
    .replace(/^\./, "");
  if (!requestHost || !cookieDomain) return false;
  return (
    requestHost === cookieDomain ||
    requestHost.slice(-cookieDomain.length - 1) === "." + cookieDomain
  );
}

function cookieHeaderForJar(jar, parsed) {
  pruneCookieJar(jar);
  var host = String(parsed.hostname || "").toLowerCase();
  var path = String(parsed.pathname || "/");
  var secure = parsed.protocol === "https:";
  var pairs = [];
  jar.cookies.forEach(function (entry) {
    if (!cookieDomainMatches(host, entry.domain)) return;
    if (path.indexOf(entry.path) !== 0) return;
    if (entry.secure && !secure) return;
    pairs.push(entry.name + "=" + entry.value);
  });
  return pairs.length ? pairs.join("; ") : "";
}

function storeSetCookies(jar, setCookieHeaders, parsed) {
  if (!setCookieHeaders) return;
  var headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  var defaultDomain = String(parsed.hostname || "").toLowerCase();
  var defaultPath = String(parsed.pathname || "/");
  var slash = defaultPath.lastIndexOf("/");
  defaultPath = slash > 0 ? defaultPath.slice(0, slash) : "/";
  headers.forEach(function (header) {
    var parts = String(header || "").split(";");
    var nameValue = parts.shift() || "";
    var eq = nameValue.indexOf("=");
    if (eq <= 0) return;
    var name = nameValue.slice(0, eq).trim();
    var value = nameValue.slice(eq + 1).trim();
    if (!name) return;
    var cookie = {
      name: name.slice(0, 256),
      value: value.slice(0, 4096),
      domain: defaultDomain,
      path: defaultPath,
      secure: false,
      expiresAt: 0
    };
    parts.forEach(function (attr) {
      var pair = String(attr || "")
        .trim()
        .split("=");
      var attrName = String(pair[0] || "")
        .trim()
        .toLowerCase();
      var attrValue = String(pair[1] || "").trim();
      if (attrName === "domain" && attrValue) {
        var domain = attrValue.toLowerCase().replace(/^\./, "");
        // Simplified supercookie protection: only accept domains that
        // the request host is actually within.
        if (cookieDomainMatches(defaultDomain, domain)) cookie.domain = domain;
      } else if (attrName === "path" && attrValue.charAt(0) === "/") {
        cookie.path = attrValue.slice(0, 128);
      } else if (attrName === "secure") {
        cookie.secure = true;
      } else if (attrName === "max-age") {
        var secs = Number(attrValue);
        if (isFinite(secs)) cookie.expiresAt = secs <= 0 ? 1 : Date.now() + secs * 1000;
      } else if (attrName === "expires") {
        var when = Date.parse(attrValue);
        if (!isNaN(when)) cookie.expiresAt = when;
      }
    });
    // Remove any existing cookie with the same name/domain/path, then
    // store (unless this Set-Cookie deletes it).
    jar.cookies = jar.cookies.filter(function (entry) {
      return !(
        entry.name === cookie.name &&
        entry.domain === cookie.domain &&
        entry.path === cookie.path
      );
    });
    if (cookie.expiresAt !== 1) jar.cookies.push(cookie);
    pruneCookieJar(jar);
  });
}

/**
 * WAF / Cloudflare challenge handling.
 *
 * HONEST LIMITS (hard rules for this service — do not "improve" by adding
 * bypasses):
 * - Interactive JS challenges (the __cf_chl "managed challenge" and
 *   Cloudflare Turnstile) CANNOT be solved service-side. The on-TV service
 *   has no webview and executes no challenge JavaScript, so a fresh
 *   clearance token can never be computed here.
 * - This flow therefore handles exactly two cases:
 *   (a) a valid cf_clearance cookie is already in the per-author jar
 *       (harvested from an earlier response) — the request just succeeds;
 *   (b) the challenge response itself carries a cf_clearance Set-Cookie —
 *       it is stored in the existing jar and the request is retried
 *       EXACTLY ONCE with the jar's cookies attached.
 * - Everything else surfaces {wafBlocked: true, vendor, url} so the caller
 *   UI can show "source is protected" instead of a generic failure.
 * - Deliberately NOT attempted: headless browsers, challenge-solver
 *   scripts, or third-party bypass APIs (ToS-hostile, usually paid, and
 *   out of scope for this free on-TV network boundary).
 */
var WAF_DETECTION_SNIPPET_BYTES = 16384;

/**
 * Pure, exported, unit-testable WAF challenge detector.
 * Input: {status, headers, bodySnippet} — headers may use any casing.
 * Returns {challenged: bool, vendor} where vendor is a lowercase vendor
 * name ("cloudflare", "incapsula", "akamai", "sucuri", "datadome") or
 * null when no challenge was detected.
 *
 * Precision rules (diagnose before retrying):
 * - Strong signals (cf-mitigated: challenge header on 403/503; __cf_chl,
 *   cf-challenge, or a "Just a moment..." title in the body) always count.
 * - Weaker signals (cf_clearance references in challenge JS,
 *   server: cloudflare + turnstile/managed-challenge fingerprints, other
 *   vendors' fingerprints) are gated on a 403/503 status so normal pages
 *   that merely mention a WAF vendor are never flagged.
 */
function detectWafChallenge(input) {
  var status = Number((input && input.status) || 0);
  var headers = (input && input.headers) || {};
  var snippet = String((input && input.bodySnippet) || "");
  var loweredSnippet = snippet.toLowerCase();
  function challenged(vendor) {
    return { challenged: true, vendor: vendor };
  }
  function clear() {
    return { challenged: false, vendor: null };
  }
  var isChallengeStatus = status === 403 || status === 503;
  // 1) Explicit Cloudflare mitigation header — the strongest signal.
  if (
    isChallengeStatus &&
    String(headerValue(headers, "cf-mitigated") || "")
      .toLowerCase()
      .indexOf("challenge") >= 0
  ) {
    return challenged("cloudflare");
  }
  // 2) Strong body markers — these only exist on real challenge pages.
  if (
    loweredSnippet.indexOf("__cf_chl") >= 0 ||
    loweredSnippet.indexOf("cf-challenge") >= 0 ||
    /<title[^>]*>\s*just a moment/.test(loweredSnippet)
  ) {
    return challenged("cloudflare");
  }
  if (isChallengeStatus) {
    // cf_clearance referenced by challenge JavaScript.
    if (loweredSnippet.indexOf("cf_clearance") >= 0) {
      return challenged("cloudflare");
    }
    var server = String(headerValue(headers, "server") || "").toLowerCase();
    // server: cloudflare + interactive-challenge fingerprints.
    if (
      server.indexOf("cloudflare") >= 0 &&
      (loweredSnippet.indexOf("turnstile") >= 0 ||
        loweredSnippet.indexOf("challenges.cloudflare.com") >= 0 ||
        loweredSnippet.indexOf("managed challenge") >= 0)
    ) {
      return challenged("cloudflare");
    }
    // Other well-known WAF vendors (best-effort fingerprints).
    if (loweredSnippet.indexOf("incapsula") >= 0 || loweredSnippet.indexOf("_incap_ses") >= 0) {
      return challenged("incapsula");
    }
    if (
      loweredSnippet.indexOf("_abck") >= 0 ||
      (loweredSnippet.indexOf("akamai") >= 0 && loweredSnippet.indexOf("reference #") >= 0)
    ) {
      return challenged("akamai");
    }
    if (loweredSnippet.indexOf("sucuri") >= 0 || loweredSnippet.indexOf("cloudproxy") >= 0) {
      return challenged("sucuri");
    }
    if (loweredSnippet.indexOf("datadome") >= 0) {
      return challenged("datadome");
    }
  }
  return clear();
}

/** Cookie names from a Set-Cookie header value (string, array, or missing). */
function setCookieNames(setCookieHeaders) {
  var list =
    setCookieHeaders == null
      ? []
      : Array.isArray(setCookieHeaders)
        ? setCookieHeaders
        : [setCookieHeaders];
  var names = [];
  list.forEach(function (header) {
    var pair = String(header || "").split(";", 1)[0];
    var eq = pair.indexOf("=");
    var name = (eq > 0 ? pair.slice(0, eq) : pair).trim().toLowerCase();
    if (name) names.push(name);
  });
  return names;
}

/**
 * Pure, exported, unit-testable cookie-harvesting retry decision.
 * Input: {status, headers, bodySnippet, setCookieHeaders, alreadyRetried, url}.
 * Returns one of:
 * - {action: "pass"} — not a WAF challenge; normal response handling.
 * - {action: "retry", vendor} — challenge seen AND a fresh cf_clearance
 *   Set-Cookie was issued; the caller should store cookies (already done
 *   by the response-begin harvesting) and retry the request exactly once.
 * - {action: "blocked", vendor, url} — challenge persists (already retried,
 *   or no clearance cookie issued). alreadyRetried caps this at one retry
 *   per fetch chain (the flag propagates across redirects), so no infinite
 *   retry loop is possible.
 */
function decideWafAction(input) {
  var detection = detectWafChallenge(input);
  if (!detection.challenged) return { action: "pass", vendor: null };
  var alreadyRetried = Boolean(input && input.alreadyRetried);
  var clearanceIssued =
    setCookieNames(input && input.setCookieHeaders).indexOf("cf_clearance") >= 0;
  if (clearanceIssued && !alreadyRetried) {
    return { action: "retry", vendor: detection.vendor };
  }
  return {
    action: "blocked",
    vendor: detection.vendor,
    url: String((input && input.url) || "")
  };
}

function parseUrl(value) {
  var parsed;
  try {
    parsed = new (getUrlModule().URL)(String(value || ""));
  } catch (_) {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed;
}

function resolveUrl(value, base) {
  return new (getUrlModule().URL)(String(value || ""), String(base || "")).toString();
}

function normalizeHeaders(headers) {
  var result = {};
  Object.keys(headers || {}).forEach(function (key) {
    var name = String(key || "");
    var lower = name.toLowerCase();
    var value = headers[key];
    if (!name || value == null || lower === "accept-encoding") return;
    result[name] = String(value);
  });
  if (
    !Object.keys(result).some(function (key) {
      return key === "User-Agent";
    })
  ) {
    result["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
  }
  return result;
}

function headerValue(headers, wantedName) {
  var wanted = String(wantedName || "").toLowerCase();
  var key = Object.keys(headers || {}).find(function (name) {
    return String(name).toLowerCase() === wanted;
  });
  return key ? headers[key] : null;
}

function hasHeader(headers, wantedName) {
  var wanted = String(wantedName || "").toLowerCase();
  return Object.keys(headers || {}).some(function (name) {
    return String(name).toLowerCase() === wanted;
  });
}

function removeHeader(headers, wantedName) {
  var wanted = String(wantedName || "").toLowerCase();
  Object.keys(headers || {}).forEach(function (name) {
    if (String(name).toLowerCase() === wanted) delete headers[name];
  });
}

function validatePayload(payload) {
  var parsed = parseUrl(payload && payload.url);
  if (!parsed)
    return {
      ok: false,
      error: "Only valid HTTP(S) URLs are allowed"
    };
  var requestedMethod = String((payload && payload.method) || "GET").toUpperCase();
  var method =
    ["POST", "PUT", "PATCH", "DELETE"].indexOf(requestedMethod) >= 0 ? requestedMethod : "GET";
  var body = typeof (payload && payload.body) === "string" ? payload.body : "";
  var hasBinaryBody = payload && Object.prototype.hasOwnProperty.call(payload, "bodyBase64");
  var encodedBody = hasBinaryBody ? payload.bodyBase64 : "";
  if (
    hasBinaryBody &&
    (typeof encodedBody !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encodedBody))
  )
    return { ok: false, error: "Invalid binary request body" };
  var bodyKind = payload && payload.bodyKind;
  if (bodyKind === undefined || bodyKind === null) {
    bodyKind = hasBinaryBody ? "base64" : method === "DELETE" || !body ? "none" : "text";
  }
  if (["none", "text", "base64"].indexOf(bodyKind) < 0)
    return { ok: false, error: "Unsupported request body type" };
  if ((bodyKind === "base64") !== Boolean(hasBinaryBody))
    return { ok: false, error: "Invalid binary request body" };
  var requestBody =
    bodyKind === "base64"
      ? Buffer.from(encodedBody, "base64")
      : bodyKind === "text"
        ? Buffer.from(body, "utf8")
        : Buffer.alloc(0);
  if (requestBody.length > MAX_REQUEST_BYTES)
    return { ok: false, error: "Request body exceeds the plugin quota" };
  var headers = normalizeHeaders(payload && payload.headers);
  // Android's OkHttp RequestBody supplies these defaults when a plugin does
  // not provide Content-Type. Keep the exact media types and do not append a
  // charset, because some providers include the value in a signature.
  if (!headerValue(headers, "Content-Type")) {
    if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (["PUT", "PATCH"].indexOf(method) >= 0 || (method === "DELETE" && bodyKind !== "none")) {
      headers["Content-Type"] = "application/json";
    }
  }
  return {
    ok: true,
    url: parsed.toString(),
    method: method,
    headers: headers,
    bodyKind: bodyKind,
    body: requestBody,
    responseEncoding: payload && payload.responseEncoding === "base64" ? "base64" : "text",
    requestId: String((payload && payload.requestId) || "").slice(0, 128),
    executionId: String((payload && payload.executionId) || "").slice(0, 128),
    profileId: String((payload && payload.profileId) || "").slice(0, 64),
    repositoryId: String((payload && payload.repositoryId) || "").slice(0, 128),
    scraperId: String((payload && payload.scraperId) || "").slice(0, 128),
    maxResponseBytes: Math.max(
      1,
      Math.min(
        MAX_RESPONSE_BYTES,
        Number(payload && (payload.maxResponseBytes || payload.maxBodyBytes)) ||
          DEFAULT_RESPONSE_BYTES
      )
    ),
    timeoutMs: Math.max(
      1000,
      Math.min(DEFAULT_TIMEOUT_MS, Number(payload && payload.timeoutMs) || DEFAULT_TIMEOUT_MS)
    )
  };
}

function lookupHost(parsed, callback) {
  var netModule;
  var dnsModule;
  try {
    netModule = getNetModule();
    dnsModule = getDnsModule();
  } catch (error) {
    callback(error);
    return;
  }
  var host = String(parsed.hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (netModule.isIP(host)) {
    callback(null, [host]);
    return;
  }
  var done = false;
  function finish(error, addresses) {
    if (done) return;
    done = true;
    callback(error || null, addresses || null);
  }
  try {
    dnsModule.lookup(host, { all: true, verbatim: true }, function (error, addresses) {
      if (error) {
        finish(error);
        return;
      }
      var values = Array.isArray(addresses) ? addresses : [{ address: addresses }];
      values = values
        .filter(function (entry) {
          return entry && entry.address;
        })
        .sort(function (left, right) {
          return netModule.isIPv4(left.address) === netModule.isIPv4(right.address)
            ? 0
            : netModule.isIPv4(left.address)
              ? -1
              : 1;
        });
      if (!values.length) {
        finish(new Error("DNS lookup returned no address"));
        return;
      }
      finish(
        null,
        values.map(function (entry) {
          return String(entry.address || "");
        })
      );
    });
  } catch (_) {
    try {
      dnsModule.lookup(host, function (error, address) {
        finish(error || null, address ? [String(address)] : null);
      });
    } catch (error) {
      finish(error);
    }
  }
}

function responseHeaders(response) {
  var result = {};
  var truncationSuffix = "\n...[truncated]";
  Object.keys((response && response.headers) || {}).forEach(function (key) {
    var value = response.headers[key];
    var text = Array.isArray(value) ? value.join(",") : String(value == null ? "" : value);
    if (text.length > 8192) {
      text = text.slice(0, 8192 - truncationSuffix.length) + truncationSuffix;
    }
    result[String(key).toLowerCase()] = text;
  });
  return result;
}

function responseCharset(contentType) {
  var match = String(contentType || "").match(/(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/i);
  if (!match) return "utf8";
  var charset = String(match[1] || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  if (["utf8", "utf-8"].indexOf(charset) >= 0) return "utf8";
  if (
    [
      "iso88591",
      "iso-8859-1",
      "latin1",
      "latin-1",
      "windows1252",
      "windows-1252",
      "cp1252",
      "cp-1252"
    ].indexOf(charset) >= 0
  )
    return "latin1";
  if (["utf16le", "utf-16le", "ucs2", "ucs-2"].indexOf(charset) >= 0) return "utf16le";
  return "utf8";
}

function routeDatabaseKey(parsed, address) {
  return JSON.stringify([
    String((parsed && parsed.protocol) || "").toLowerCase(),
    String((parsed && parsed.hostname) || "").toLowerCase(),
    Number((parsed && parsed.port) || 0) || (parsed && parsed.protocol === "https:" ? 443 : 80),
    String(address || "")
  ]);
}

function orderResolvedAddresses(networkState, parsed, addresses) {
  var failedRoutes = networkState && networkState.failedRoutes;
  if (!failedRoutes || !failedRoutes.size) return addresses;
  var available = [];
  var postponed = [];
  addresses.forEach(function (address) {
    (failedRoutes.has(routeDatabaseKey(parsed, address)) ? postponed : available).push(address);
  });
  return available.concat(postponed);
}

function rememberFailedRoute(networkState, parsed, address) {
  var failedRoutes = networkState && networkState.failedRoutes;
  if (!failedRoutes || !address) return;
  var key = routeDatabaseKey(parsed, address);
  failedRoutes.delete(key);
  failedRoutes.set(key, true);
  while (failedRoutes.size > MAX_FAILED_ROUTES) {
    failedRoutes.delete(failedRoutes.keys().next().value);
  }
}

function rememberConnectedRoute(networkState, parsed, address) {
  var failedRoutes = networkState && networkState.failedRoutes;
  if (!failedRoutes || !address) return;
  failedRoutes.delete(routeDatabaseKey(parsed, address));
}

function hasActiveAgentSockets(agent) {
  var sockets = agent && agent.sockets;
  return Object.keys(sockets || {}).some(function (name) {
    return Array.isArray(sockets[name]) && sockets[name].length > 0;
  });
}

function requestAgent(networkState, transport, parsed, address) {
  var agents = networkState && networkState.agents;
  if (!agents || !transport || typeof transport.Agent !== "function") return false;
  var key = routeDatabaseKey(parsed, address);
  var agent = agents.get(key);
  if (agent) {
    agents.delete(key);
    agents.set(key, agent);
    return agent;
  }
  if (agents.size >= MAX_IDLE_CONNECTIONS) {
    var oldestIdleKey = null;
    agents.forEach(function (candidate, candidateKey) {
      if (oldestIdleKey === null && !hasActiveAgentSockets(candidate)) {
        oldestIdleKey = candidateKey;
      }
    });
    if (oldestIdleKey !== null) {
      var staleAgent = agents.get(oldestIdleKey);
      agents.delete(oldestIdleKey);
      if (staleAgent && typeof staleAgent.destroy === "function") staleAgent.destroy();
    }
  }
  if (agents.size >= MAX_IDLE_CONNECTIONS) return false;
  agent = new transport.Agent({
    keepAlive: true,
    maxSockets: MAX_ACTIVE_REQUESTS,
    maxFreeSockets: 1
  });
  agents.set(key, agent);
  return agent;
}

function destroyRouteAgents(networkState) {
  var agents = networkState && networkState.agents;
  if (!agents) return;
  agents.forEach(function (agent) {
    if (agent && typeof agent.destroy === "function") agent.destroy();
  });
  agents.clear();
}

function performFetch(payload, callback, redirects, trace, networkState) {
  var requestTrace = null;
  var finish = once(function (error, result) {
    emitTrace(
      trace,
      error ? "fetch callback failed" : "fetch callback success",
      Object.assign({}, requestTrace || {}, {
        status: result && result.status ? Number(result.status) : 0,
        error: error ? traceError(error) : undefined
      })
    );
    return callback(error, result);
  });
  if (callback && typeof callback.registerRequest === "function") {
    finish.registerRequest = callback.registerRequest;
  }
  var redirected = false;
  var validation = validatePayload(payload);
  if (!validation.ok) {
    emitTrace(trace, "fetch validation failed", {
      requestId: String((payload && payload.requestId) || "").slice(0, 128),
      error: validation.error
    });
    finish(new Error(validation.error));
    return;
  }
  var parsed = parseUrl(validation.url);
  requestTrace = traceRequestDetails(payload, parsed, redirects);
  // SSRF guard (1/2): reject blocked literal hostnames before DNS. This
  // stops plugins from reaching the plugin service itself
  // (http://127.0.0.1:2721/...) or scanning the LAN by literal IP.
  if (parsed && isBlockedHostname(parsed.hostname)) {
    emitTrace(trace, "fetch blocked: non-public hostname", requestTrace);
    finish(new Error("URL hostname is not allowed (private/loopback address)"));
    return;
  }
  emitTrace(trace, "fetch begin", requestTrace);
  // Keep one budget across Smart's address attempts. The per-address connect
  // budget below matches Android's 30-second connect timeout; resetting this
  // outer budget would exceed the existing 60-second PluginService contract.
  var requestDeadline = Date.now() + validation.timeoutMs;
  function continueWithResolvedHost(lookupError, addresses) {
    if (lookupError) {
      emitTrace(
        trace,
        "fetch dns failed",
        Object.assign({}, requestTrace, { error: traceError(lookupError) })
      );
      finish(lookupError);
      return;
    }
    var resolvedAddresses = (Array.isArray(addresses) ? addresses : [addresses])
      .map(function (address) {
        return String(address || "");
      })
      .filter(function (address, index, list) {
        return address && list.indexOf(address) === index;
      });
    resolvedAddresses = orderResolvedAddresses(networkState, parsed, resolvedAddresses);
    if (!resolvedAddresses.length) {
      var missingAddressError = new Error("DNS lookup returned no address");
      emitTrace(
        trace,
        "fetch dns failed",
        Object.assign({}, requestTrace, { error: traceError(missingAddressError) })
      );
      finish(missingAddressError);
      return;
    }
    // SSRF guard (2/2): fail closed against DNS rebinding. If ANY resolved
    // address is non-public, the whole request dies — a hostname that
    // resolves to both public and private IPs is treated as hostile.
    var blockedResolved = resolvedAddresses.filter(isBlockedAddress);
    if (blockedResolved.length) {
      emitTrace(
        trace,
        "fetch blocked: DNS resolved to non-public address",
        Object.assign({}, requestTrace, { blockedCount: blockedResolved.length })
      );
      finish(new Error("URL resolves to a private/loopback address"));
      return;
    }
    var address = resolvedAddresses[0];
    emitTrace(
      trace,
      "fetch dns success",
      Object.assign({}, requestTrace, {
        address: address || null,
        addressCount: resolvedAddresses.length
      })
    );
    var transport;
    try {
      transport = parsed.protocol === "https:" ? getHttpsModule() : http;
      emitTrace(trace, "fetch transport selected", {
        requestId: requestTrace.requestId,
        transport: parsed.protocol === "https:" ? "https" : "http"
      });
    } catch (error) {
      emitTrace(
        trace,
        "fetch transport module failed",
        Object.assign({}, requestTrace, { error: traceError(error) })
      );
      finish(error);
      return;
    }
    var requestHeaders = Object.assign({}, validation.headers);
    // Per-author cookie jar: attach domain-matched cookies for this
    // provider unless it set its own Cookie header explicitly.
    var jar = getCookieJar(cookieJarKey(payload));
    if (!hasHeader(requestHeaders, "Cookie")) {
      var jarCookieHeader = cookieHeaderForJar(jar, parsed);
      if (jarCookieHeader) requestHeaders["Cookie"] = jarCookieHeader;
    }
    var hasRequestBody =
      ["POST", "PUT", "PATCH"].indexOf(validation.method) >= 0 ||
      (validation.method === "DELETE" && validation.bodyKind !== "none");
    if (hasRequestBody) {
      // Android builds its RequestBody from the exact request bytes. Keep the
      // caller's Content-Type (or the platform default), set the byte length,
      // and remove Transfer-Encoding to match that transport.
      var contentType =
        headerValue(validation.headers, "Content-Type") ||
        (validation.method === "POST" ? "application/x-www-form-urlencoded" : "application/json");
      removeHeader(requestHeaders, "Content-Type");
      requestHeaders["Content-Type"] = contentType;
      removeHeader(requestHeaders, "Content-Length");
      removeHeader(requestHeaders, "Transfer-Encoding");
    } else {
      // Android calls Request.Builder.get()/delete() without a RequestBody.
      // OkHttp's bridge consequently removes body-only headers even when a
      // plugin supplied them explicitly.
      removeHeader(requestHeaders, "Content-Type");
      removeHeader(requestHeaders, "Content-Length");
      removeHeader(requestHeaders, "Transfer-Encoding");
    }
    // OkHttp adds transparent gzip negotiation after removing any caller
    // supplied Accept-Encoding. Node's client does not, so add the same
    // transport header at the final socket boundary.
    if (!hasHeader(requestHeaders, "Range")) requestHeaders["Accept-Encoding"] = "gzip";
    if (!hasHeader(requestHeaders, "Host")) {
      requestHeaders.Host = parsed.host;
    }
    if (!hasHeader(requestHeaders, "Connection")) requestHeaders.Connection = "Keep-Alive";
    if (hasRequestBody && !hasHeader(requestHeaders, "Content-Length")) {
      requestHeaders["Content-Length"] = String(validation.body.length);
    }
    function isRetryableAddressError(error) {
      return (
        [
          "ECONNABORTED",
          "ECONNREFUSED",
          "ECONNRESET",
          "EHOSTUNREACH",
          "ENETUNREACH",
          "ETIMEDOUT",
          "EPIPE"
        ].indexOf(String((error && error.code) || "")) >= 0
      );
    }
    var responseStarted = false;
    var attemptComplete = false;
    var request = null;
    var connectTimer = null;
    function clearConnectTimer() {
      if (connectTimer !== null) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
    }
    function settleAttempt() {
      if (attemptComplete) return false;
      attemptComplete = true;
      clearConnectTimer();
      return true;
    }
    function failTransport(error) {
      if (attemptComplete) return;
      var retryableAddressError = isRetryableAddressError(error);
      if (!responseStarted && retryableAddressError) {
        rememberFailedRoute(networkState, parsed, address);
      }
      var canTryNextAddress =
        !responseStarted &&
        retryableAddressError &&
        resolvedAddresses.length > 1 &&
        requestDeadline > Date.now();
      if (canTryNextAddress) {
        settleAttempt();
        emitTrace(
          trace,
          "fetch address fallback",
          Object.assign({}, requestTrace, {
            address: address,
            nextAddress: resolvedAddresses[1],
            remainingMs: Math.max(0, requestDeadline - Date.now()),
            error: traceError(error)
          })
        );
        continueWithResolvedHost(null, resolvedAddresses.slice(1));
        return;
      }
      settleAttempt();
      if (!redirected) finish(error);
    }
    var requestOptions = {
      protocol: parsed.protocol,
      // Keep the original Host/SNI while using the Android-compatible
      // IPv4-first DNS result for the actual socket connection.
      hostname: address || parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: String(parsed.pathname || "/") + String(parsed.search || ""),
      method: validation.method,
      headers: requestHeaders,
      servername: String(parsed.hostname || "").replace(/^\[|\]$/g, ""),
      agent: requestAgent(networkState, transport, parsed, address)
    };
    var requestSent = false;
    try {
      emitTrace(
        trace,
        "fetch transport request begin",
        Object.assign({}, requestTrace, { address: address })
      );
      request = transport.request(requestOptions, function (response) {
        responseStarted = true;
        clearConnectTimer();
        rememberConnectedRoute(networkState, parsed, address);
        emitTrace(
          trace,
          "fetch response begin",
          Object.assign({}, requestTrace, {
            status: Number(response && response.statusCode) || 0,
            encoding: String(
              (response && response.headers && response.headers["content-encoding"]) || ""
            )
          })
        );
        var responseDone = once(function (error, result) {
          settleAttempt();
          emitTrace(
            trace,
            error ? "fetch response failed" : "fetch response ended",
            Object.assign({}, requestTrace, {
              status: Number((result && result.status) || (response && response.statusCode)) || 0,
              error: error ? traceError(error) : undefined
            })
          );
          finish(error, result);
        });
        var wireLength = 0;
        response.on("data", function (chunk) {
          wireLength += chunk.length;
          if (wireLength > MAX_WIRE_RESPONSE_BYTES) {
            responseDone(new Error("Plugin provider response exceeds the wire quota"));
            response.destroy();
          }
        });
        response.on("error", function (error) {
          emitTrace(
            trace,
            "fetch response error",
            Object.assign({}, requestTrace, { error: traceError(error) })
          );
          responseDone(error);
        });
        var headers = responseHeaders(response);
        // Harvest Set-Cookie into the per-author jar (raw headers; the
        // redacted `headers` map joins multi-values and is unsuitable).
        try {
          storeSetCookies(jar, response.headers["set-cookie"], parsed);
        } catch (_) {
          // Cookie bookkeeping must never fail a fetch.
        }
        var bodyEncoding = responseCharset(response.headers["content-type"]);
        var location = headers.location;
        if (response.statusCode >= 300 && response.statusCode < 400) {
          response.resume();
          if (!location) {
            responseDone(new Error("Plugin provider redirect has no location"));
            return;
          }
          if ((redirects || 0) >= MAX_REDIRECTS) {
            responseDone(new Error("Plugin provider redirect limit exceeded"));
            return;
          }
          var nextUrl;
          try {
            nextUrl = resolveUrl(location, validation.url);
          } catch (_) {
            responseDone(new Error("Invalid redirect URL"));
            return;
          }
          redirected = true;
          settleAttempt();
          var redirectedPayload = Object.assign({}, payload, { url: nextUrl });
          var previousUrl = parseUrl(validation.url);
          var redirectedUrl = parseUrl(nextUrl);
          var crossOrigin =
            previousUrl &&
            redirectedUrl &&
            (previousUrl.protocol !== redirectedUrl.protocol ||
              previousUrl.hostname !== redirectedUrl.hostname ||
              (previousUrl.port || "") !== (redirectedUrl.port || ""));
          var redirectedHeaders = Object.assign({}, payload && payload.headers);
          if (crossOrigin) {
            // OkHttp does not forward credentials to a different origin during
            // a follow-up request. Keep all other plugin headers intact.
            removeHeader(redirectedHeaders, "Authorization");
          }
          // OkHttp changes non-GET methods to GET for 301/302/303 redirects and
          // drops the request body/content headers.  307/308 keep the original
          // method and body, matching the native follow-up behavior.
          if (
            [301, 302, 303].indexOf(Number(response.statusCode)) >= 0 &&
            validation.method !== "GET"
          ) {
            redirectedPayload.method = "GET";
            redirectedPayload.bodyKind = "none";
            redirectedPayload.body = "";
            delete redirectedPayload.bodyBase64;
            Object.keys(redirectedHeaders).forEach(function (headerName) {
              if (
                ["content-length", "content-type", "transfer-encoding"].indexOf(
                  String(headerName).toLowerCase()
                ) >= 0
              ) {
                delete redirectedHeaders[headerName];
              }
            });
            redirectedPayload.headers = redirectedHeaders;
          } else if (crossOrigin) {
            redirectedPayload.headers = redirectedHeaders;
          }
          emitTrace(
            trace,
            "fetch redirect",
            Object.assign({}, requestTrace, {
              status: Number(response.statusCode) || 0,
              targetHost: String((redirectedUrl && redirectedUrl.hostname) || "").slice(0, 255),
              targetPath: String((redirectedUrl && redirectedUrl.pathname) || "/").slice(0, 512),
              redirect: (redirects || 0) + 1
            })
          );
          performFetch(redirectedPayload, finish, (redirects || 0) + 1, trace, networkState);
          return;
        }

        var stream = response;
        var encoding = String(response.headers["content-encoding"] || "").toLowerCase();
        var transparentGzip = !hasHeader(requestHeaders, "Range");
        if (transparentGzip && encoding === "gzip") {
          delete headers["content-encoding"];
          delete headers["content-length"];
        }
        try {
          if (encoding === "gzip") {
            stream = response.pipe(getZlibModule().createGunzip());
          } else if (encoding === "deflate") {
            stream = response.pipe(getZlibModule().createInflate());
          }
        } catch (error) {
          responseDone(error);
          response.resume();
          return;
        }
        var chunks = [];
        var length = 0;
        var truncated = false;
        var finishTruncated = function () {
          if (truncated) return;
          truncated = true;
          var responseBytes = Buffer.concat(chunks);
          responseDone(null, {
            returnValue: true,
            // Android keeps the original HTTP response metadata when its body
            // cap is reached; truncation is an orthogonal flag.
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            statusText: response.statusMessage || "",
            url: validation.url,
            body: responseBytes.toString(bodyEncoding),
            bodyBase64:
              validation.responseEncoding === "base64"
                ? responseBytes.toString("base64")
                : undefined,
            headers: headers,
            truncated: true
          });
          stream.destroy();
          if (stream !== response) response.destroy();
        };
        stream.on("data", function (chunk) {
          if (length >= validation.maxResponseBytes) {
            finishTruncated();
            return;
          }
          var remaining = validation.maxResponseBytes - length;
          var part = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
          chunks.push(part);
          length += part.length;
          if (part.length < chunk.length) {
            finishTruncated();
          }
        });
        stream.on("error", function (error) {
          emitTrace(
            trace,
            "fetch response stream error",
            Object.assign({}, requestTrace, { error: traceError(error) })
          );
          responseDone(error);
        });
        stream.on("end", function () {
          var responseBytes = Buffer.concat(chunks);
          var bodyText = responseBytes.toString(bodyEncoding);
          // WAF challenge handling: detect a Cloudflare/WAF challenge page
          // and, when the response itself issued a fresh cf_clearance cookie
          // (already harvested into the per-author jar at response begin
          // above), retry the request exactly once with the jar attached.
          // See detectWafChallenge/decideWafAction for the documented limits.
          var wafDecision = decideWafAction({
            status: response.statusCode,
            headers: headers,
            bodySnippet: bodyText.slice(0, WAF_DETECTION_SNIPPET_BYTES),
            setCookieHeaders: response.headers["set-cookie"],
            alreadyRetried: Boolean(payload && payload._wafRetried),
            url: validation.url
          });
          if (wafDecision.action === "retry") {
            settleAttempt();
            emitTrace(
              trace,
              "fetch waf challenge retry",
              Object.assign({}, requestTrace, {
                status: Number(response.statusCode) || 0,
                vendor: wafDecision.vendor,
                url: validation.url
              })
            );
            // The fresh cf_clearance cookie is already in the author's jar;
            // the retry re-attaches jar cookies in continueWithResolvedHost.
            // _wafRetried caps this at one retry per fetch chain (it
            // propagates across redirects), so no infinite loop is possible.
            performFetch(
              Object.assign({}, payload, { _wafRetried: true }),
              finish,
              redirects || 0,
              trace,
              networkState
            );
            return;
          }
          var wafResult = {
            returnValue: true,
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            statusText: response.statusMessage || "",
            url: validation.url,
            body: bodyText,
            bodyBase64:
              validation.responseEncoding === "base64"
                ? responseBytes.toString("base64")
                : undefined,
            headers: headers,
            truncated: truncated
          };
          if (wafDecision.action === "blocked") {
            emitTrace(
              trace,
              "fetch waf blocked",
              Object.assign({}, requestTrace, {
                status: Number(response.statusCode) || 0,
                vendor: wafDecision.vendor,
                url: validation.url
              })
            );
            // Structured "source is protected" signal for the UI. Returned
            // as a result (not an error) so wafBlocked/vendor survive the
            // service's JSON envelope; ok:false keeps failure semantics.
            wafResult.ok = false;
            wafResult.wafBlocked = true;
            wafResult.vendor = wafDecision.vendor;
          }
          responseDone(null, wafResult);
        });
      });
      emitTrace(
        trace,
        "fetch transport request created",
        Object.assign({}, requestTrace, { address: address })
      );
      request.on("socket", function (socket) {
        if (!socket || socket.connecting === false) {
          clearConnectTimer();
          return;
        }
        var connectTimeoutMs = Math.min(
          CONNECT_ATTEMPT_TIMEOUT_MS,
          Math.max(1, requestDeadline - Date.now())
        );
        connectTimer = setTimeout(function () {
          if (attemptComplete || responseStarted) return;
          var timeoutError = new Error("Plugin provider connection timed out");
          timeoutError.code = "ETIMEDOUT";
          emitTrace(
            trace,
            "fetch transport connect timeout",
            Object.assign({}, requestTrace, {
              address: address,
              timeoutMs: connectTimeoutMs
            })
          );
          failTransport(timeoutError);
          if (request && typeof request.destroy === "function") request.destroy(timeoutError);
        }, connectTimeoutMs);
        if (typeof socket.once === "function") socket.once("connect", clearConnectTimer);
      });
      request.setTimeout(validation.timeoutMs, function () {
        if (attemptComplete) return;
        var timeoutError = new Error("Plugin provider request timed out");
        timeoutError.code = "ETIMEDOUT";
        emitTrace(
          trace,
          "fetch transport timeout",
          Object.assign({}, requestTrace, {
            address: address,
            timeoutMs: validation.timeoutMs
          })
        );
        failTransport(timeoutError);
        request.destroy(timeoutError);
      });
      request.on("error", function (error) {
        emitTrace(
          trace,
          "fetch transport error",
          Object.assign({}, requestTrace, { address: address, error: traceError(error) })
        );
        failTransport(error);
      });
      if (validation.requestId && typeof finish.registerRequest === "function") {
        finish.registerRequest(validation.requestId, request);
      }
      if (hasRequestBody && validation.body.length > 0) request.write(validation.body);
      request.end();
      requestSent = true;
      emitTrace(
        trace,
        "fetch transport request sent",
        Object.assign({}, requestTrace, { address: address })
      );
    } catch (error) {
      emitTrace(
        trace,
        "fetch transport request threw",
        Object.assign({}, requestTrace, { address: address, error: traceError(error) })
      );
      if (requestSent) {
        settleAttempt();
        finish(error);
      } else {
        failTransport(error);
      }
    }
  }
  emitTrace(trace, "fetch dns begin", requestTrace);
  lookupHost(parsed, continueWithResolvedHost);
}

function once(callback) {
  var called = false;
  var wrapped = function () {
    if (called) return;
    called = true;
    return callback.apply(null, arguments);
  };
  if (callback && typeof callback.registerRequest === "function") {
    wrapped.registerRequest = callback.registerRequest;
  }
  return wrapped;
}

function memoryUsage() {
  try {
    if (typeof process !== "undefined" && process && typeof process.memoryUsage === "function") {
      return process.memoryUsage();
    }
  } catch (_) {
    // Some lightweight Web Service runtimes do not expose process memory APIs.
  }
  return {};
}

function createPluginHttpServer({ port = 2711, logger = console, trace } = {}) {
  var networkState = { failedRoutes: new Map(), agents: new Map() };
  var activeRequests = {};
  var inFlightRequests = {};
  var queuedRequests = [];
  var activeRequestCount = 0;
  var scraperRequestWindows = {};
  var hostCircuits = {};
  var recentDiagnostics = [];

  function recordDiagnostic(event, details) {
    var entry = {
      event: String(event || "unknown").slice(0, 96),
      at: Date.now(),
      details: details || {}
    };
    recentDiagnostics.push(entry);
    if (recentDiagnostics.length > 32) recentDiagnostics.shift();
    emitTrace(trace, entry.event, entry.details);
  }

  function hostForPayload(payload) {
    try {
      var parsed = parseUrl(payload && payload.url);
      return parsed ? String(parsed.hostname || "").toLowerCase() : "";
    } catch (_) {
      return "";
    }
  }

  function pruneCircuit(host, now) {
    var circuit = hostCircuits[host];
    if (circuit && circuit.openUntil && circuit.openUntil <= now) {
      delete hostCircuits[host];
      circuit = null;
    }
    return circuit;
  }

  function admitRequest(payload, requestId) {
    var now = Date.now();
    if (requestId && inFlightRequests[requestId]) {
      return { ok: false, status: 409, error: "Duplicate plugin request id" };
    }
    var shouldQueue = activeRequestCount >= MAX_ACTIVE_REQUESTS || queuedRequests.length > 0;
    if (shouldQueue && queuedRequests.length >= MAX_QUEUED_REQUESTS) {
      return { ok: false, status: 429, error: "Plugin service concurrency quota exceeded" };
    }
    var scraperId = String((payload && payload.scraperId) || "").slice(0, 128);
    if (scraperId) {
      var window = scraperRequestWindows[scraperId] || [];
      window = window.filter(function (timestamp) {
        return now - timestamp < 60000;
      });
      if (window.length >= MAX_REQUESTS_PER_SCRAPER_PER_MINUTE) {
        scraperRequestWindows[scraperId] = window;
        return { ok: false, status: 429, error: "Plugin scraper request-rate quota exceeded" };
      }
      window.push(now);
      scraperRequestWindows[scraperId] = window;
    }
    var host = hostForPayload(payload);
    var circuit = pruneCircuit(host, now);
    if (host && circuit && circuit.openUntil > now) {
      return { ok: false, status: 503, error: "Plugin provider circuit is temporarily open" };
    }
    inFlightRequests[requestId] = {
      request: null,
      host: host,
      cancelled: false,
      started: false,
      queued: shouldQueue,
      finished: false,
      response: null,
      requestDetails: null,
      payload: null
    };
    return { ok: true, host: host, queued: shouldQueue };
  }

  function recordHostResult(host, error, result) {
    if (!host) return;
    var failed = Boolean(error) || Number((result && result.status) || 0) >= 500;
    if (!failed) {
      delete hostCircuits[host];
      return;
    }
    var circuit = hostCircuits[host] || { failures: 0, openUntil: 0 };
    circuit.failures += 1;
    if (circuit.failures >= CIRCUIT_FAILURE_LIMIT) circuit.openUntil = Date.now() + CIRCUIT_OPEN_MS;
    hostCircuits[host] = circuit;
  }

  function send(response, status, body) {
    var data = JSON.stringify(body || {});
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(data, "utf8"),
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store"
    });
    response.end(data);
  }

  function removeQueuedRequest(state) {
    var index = queuedRequests.indexOf(state);
    if (index >= 0) queuedRequests.splice(index, 1);
  }

  function finishQueuedRequest(state, errorText) {
    if (!state || state.finished) return;
    state.cancelled = true;
    state.finished = true;
    removeQueuedRequest(state);
    delete inFlightRequests[state.requestId];
    if (state.response && !state.response.writableEnded && !state.response.destroyed) {
      send(state.response, 502, {
        returnValue: false,
        errorText: errorText || "Plugin request cancelled",
        requestId: state.requestId
      });
    }
  }

  function pumpQueue() {
    while (activeRequestCount < MAX_ACTIVE_REQUESTS && queuedRequests.length) {
      var state = queuedRequests.shift();
      if (
        !state ||
        state.finished ||
        state.cancelled ||
        inFlightRequests[state.requestId] !== state
      ) {
        continue;
      }
      startRequest(state);
    }
  }

  function cancelRequest(state) {
    if (!state || state.finished) return false;
    state.cancelled = true;
    if (!state.started) {
      finishQueuedRequest(state, "Plugin request cancelled");
      pumpQueue();
      return true;
    }
    if (state.request && typeof state.request.destroy === "function") {
      state.request.destroy(new Error("Plugin request cancelled"));
    }
    return true;
  }

  function startRequest(state) {
    if (!state || state.finished || state.cancelled) return;
    state.started = true;
    state.queued = false;
    activeRequestCount += 1;
    var requestId = state.requestId;
    var response = state.response;
    var requestDetails = state.requestDetails;
    var callback = function (error, result) {
      if (state.finished) return;
      state.finished = true;
      if (requestId) delete activeRequests[requestId];
      delete inFlightRequests[requestId];
      activeRequestCount = Math.max(0, activeRequestCount - 1);
      recordHostResult(state.host, state.cancelled ? null : error, result);
      recordDiagnostic(
        "fetch response sent",
        Object.assign({}, requestDetails, {
          httpStatus: error ? 502 : 200,
          providerStatus: Number(result && result.status) || 0,
          error: error ? traceError(error) : undefined
        })
      );
      if (!response || response.writableEnded || response.destroyed) {
        pumpQueue();
        return;
      }
      if (error) {
        send(response, 502, {
          returnValue: false,
          errorText: error.message || String(error),
          requestId: requestId
        });
      } else {
        send(response, 200, Object.assign({ requestId: requestId }, result));
      }
      pumpQueue();
    };
    callback.registerRequest = function (id, activeRequest) {
      activeRequests[id] = activeRequest;
      state.request = activeRequest;
      if (state.cancelled) activeRequest.destroy(new Error("Plugin request cancelled"));
    };
    try {
      performFetch(
        Object.assign({}, state.payload, { requestId: requestId }),
        callback,
        0,
        recordDiagnostic,
        networkState
      );
    } catch (error) {
      recordDiagnostic(
        "fetch route threw",
        Object.assign({}, requestDetails, { error: traceError(error) })
      );
      callback(error);
    }
  }

  function readBody(request, callback) {
    var chunks = [];
    var length = 0;
    request.on("data", function (chunk) {
      length += chunk.length;
      if (length <= MAX_SERVICE_REQUEST_BYTES) chunks.push(chunk);
    });
    request.on("end", function () {
      if (length > MAX_SERVICE_REQUEST_BYTES) {
        callback(new Error("Plugin service request is too large"));
        return;
      }
      try {
        callback(null, JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        callback(error);
      }
    });
  }
  var server = http.createServer(function (request, response) {
    if (!isLoopbackRequest(request)) {
      send(response, 403, {
        returnValue: false,
        errorText: "Plugin service accepts loopback clients only"
      });
      return;
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type"
      });
      response.end();
      return;
    }
    if (request.url === "/health" && request.method === "GET") {
      var memory = memoryUsage();
      send(response, 200, {
        returnValue: true,
        service: "nuvio-plugin-network",
        protocolVersion: PLUGIN_PROTOCOL_VERSION,
        serviceVersion: 1,
        runtimeVersion: "nuvio-plugin-network/1",
        quickjsVersion: "quickjs-emscripten/0.32.0 (app-worker)",
        workerSupport: true,
        maxConcurrency: MAX_ACTIVE_REQUESTS,
        memoryTier: "bounded",
        defaultResponseBytes: DEFAULT_RESPONSE_BYTES,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        memory: { rssBytes: Number(memory.rss || 0), heapUsedBytes: Number(memory.heapUsed || 0) },
        jsPluginCapability: true,
        networkBoundary: true,
        port: port
      });
      return;
    }
    if (request.url === "/capabilities" && request.method === "GET") {
      send(response, 200, {
        returnValue: true,
        protocolVersion: PLUGIN_PROTOCOL_VERSION,
        serviceVersion: 1,
        runtimeVersion: "nuvio-plugin-network/1",
        quickjsVersion: "quickjs-emscripten/0.32.0 (app-worker)",
        workerSupport: true,
        maxConcurrency: MAX_ACTIVE_REQUESTS,
        memoryTier: "bounded",
        defaultResponseBytes: DEFAULT_RESPONSE_BYTES,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        jsPluginCapability: true,
        networkBoundary: true
      });
      return;
    }
    if (request.url === "/diagnostics" && request.method === "GET") {
      send(response, 200, {
        returnValue: true,
        protocolVersion: PLUGIN_PROTOCOL_VERSION,
        activeRequests: Object.keys(activeRequests).length,
        queuedRequests: queuedRequests.length,
        memory: memoryUsage(),
        recentEvents: recentDiagnostics.slice(-16)
      });
      return;
    }
    if (request.url === "/cache/clear" && request.method === "POST") {
      send(response, 200, { returnValue: true, cleared: true });
      return;
    }
    if ((request.url === "/cancel" || request.url === "/fetch") && request.method === "POST") {
      readBody(request, function (bodyError, payload) {
        if (bodyError) {
          send(response, 400, { returnValue: false, errorText: bodyError.message });
          return;
        }
        if (request.url === "/cancel") {
          var cancelId = String(payload.requestId || "");
          var state = inFlightRequests[cancelId];
          var active = activeRequests[cancelId];
          var cancelled = cancelRequest(state);
          if (!cancelled && active) active.destroy(new Error("Plugin request cancelled"));
          send(response, 200, {
            returnValue: true,
            requestId: cancelId,
            cancelled: Boolean(cancelled || active)
          });
          return;
        }
        var requestId =
          String(payload.requestId || "").slice(0, 128) ||
          `service-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        var requestDetails = traceRequestDetails(payload, parseUrl(payload && payload.url), 0);
        requestDetails.requestId = requestId;
        recordDiagnostic("fetch received", requestDetails);
        var admission = admitRequest(payload, requestId);
        if (!admission.ok) {
          recordDiagnostic(
            "fetch admission rejected",
            Object.assign({}, requestDetails, {
              status: admission.status,
              error: admission.error
            })
          );
          send(response, admission.status, {
            returnValue: false,
            errorText: admission.error,
            requestId: requestId
          });
          return;
        }
        var state = inFlightRequests[requestId];
        state.requestId = requestId;
        state.response = response;
        state.requestDetails = requestDetails;
        state.payload = payload;
        response.on("close", function () {
          if (!state.finished && !state.started) finishQueuedRequest(state);
          else if (!state.finished && state.started) cancelRequest(state);
        });
        if (admission.queued) {
          recordDiagnostic(
            "fetch queued",
            Object.assign({}, requestDetails, { queueSize: queuedRequests.length + 1 })
          );
          queuedRequests.push(state);
        } else {
          startRequest(state);
        }
      });
      return;
    }
    send(response, 404, { returnValue: false, errorText: "Plugin service route not found" });
  });
  server.on("error", function (error) {
    if (logger && typeof logger.warn === "function")
      logger.warn("Plugin service error", error.message || error);
  });
  server.on("close", function () {
    destroyRouteAgents(networkState);
  });
  return server;
}

module.exports = {
  createPluginHttpServer: createPluginHttpServer,
  // Exported for unit tests and diagnostics.
  isBlockedAddress: isBlockedAddress,
  isBlockedHostname: isBlockedHostname,
  cookieJarKey: cookieJarKey,
  getCookieJar: getCookieJar,
  cookieHeaderForJar: cookieHeaderForJar,
  storeSetCookies: storeSetCookies,
  detectWafChallenge: detectWafChallenge,
  decideWafAction: decideWafAction
};
