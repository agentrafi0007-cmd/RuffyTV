/**
 * Unit tests for WAF/Cloudflare challenge handling in the plugin HTTP
 * service: detectWafChallenge detection cases, cf_clearance cookie-jar
 * storage, and the cookie-harvesting retry-once decision (decideWafAction).
 * Run: node services/test-waf.cjs
 */
var service = require("./plugin-http.cjs");

var failures = 0;

function assert(condition, label) {
  if (condition) {
    console.log("  ok - " + label);
  } else {
    failures++;
    console.log("  FAIL - " + label);
  }
}

assert(typeof service.detectWafChallenge === "function", "detectWafChallenge exported");
assert(typeof service.decideWafAction === "function", "decideWafAction exported");

var cfHtml =
  "<html><head><title>Just a moment...</title></head>" +
  '<body><form id="challenge-form" action="/cdn-cgi/challenge" class="cf-challenge">' +
  '<script>var s="__cf_chl";</script></body></html>';

console.log("detectWafChallenge — challenge pages:");
var d1 = service.detectWafChallenge({
  status: 503,
  headers: { server: "cloudflare" },
  bodySnippet: cfHtml
});
assert(d1.challenged === true && d1.vendor === "cloudflare", "classic CF challenge page detected");

var d2 = service.detectWafChallenge({
  status: 403,
  headers: { "cf-mitigated": "challenge" },
  bodySnippet: "Forbidden"
});
assert(
  d2.challenged === true && d2.vendor === "cloudflare",
  "cf-mitigated: challenge header detected"
);

var d3 = service.detectWafChallenge({
  status: 403,
  headers: { "CF-Mitigated": "Challenge" },
  bodySnippet: "Forbidden"
});
assert(d3.challenged === true && d3.vendor === "cloudflare", "header matching is case-insensitive");

var d4 = service.detectWafChallenge({
  status: 403,
  headers: {},
  bodySnippet: "var c=document.cookie; cf_clearance=abc123;"
});
assert(
  d4.challenged === true && d4.vendor === "cloudflare",
  "cf_clearance in challenge JS detected"
);

var d5 = service.detectWafChallenge({
  status: 403,
  headers: { server: "cloudflare" },
  bodySnippet:
    '<div class="cf-turnstile" data-sitekey="x"></div>' +
    '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>'
});
assert(
  d5.challenged === true && d5.vendor === "cloudflare",
  "server: cloudflare + turnstile fingerprints detected"
);

var d6 = service.detectWafChallenge({
  status: 403,
  headers: {},
  bodySnippet: "Request unsuccessful. Incapsula incident ID 12345"
});
assert(d6.challenged === true && d6.vendor === "incapsula", "incapsula fingerprint detected");

console.log("detectWafChallenge — not challenged:");
var ok1 = service.detectWafChallenge({
  status: 200,
  headers: { server: "nginx" },
  bodySnippet: "<html><head><title>Movies</title></head><body>list</body></html>"
});
assert(ok1.challenged === false && ok1.vendor === null, "normal 200 page not challenged");

var ok2 = service.detectWafChallenge({
  status: 403,
  headers: { server: "nginx" },
  bodySnippet: "Forbidden: rate limited"
});
assert(ok2.challenged === false, "403 without WAF markers not challenged");

var ok3 = service.detectWafChallenge({
  status: 200,
  headers: {},
  bodySnippet: "we use cloudflare for dns on this blog"
});
assert(ok3.challenged === false, "page merely mentioning cloudflare not challenged");

var ok4 = service.detectWafChallenge({ status: 200, headers: {}, bodySnippet: "" });
assert(ok4.challenged === false, "empty body not challenged");

console.log("cf_clearance jar storage:");
var jar = service.getCookieJar("repoX\nscraperY");
var parsed = new URL("https://protected.example/");
service.storeSetCookies(jar, ["cf_clearance=tok123; Path=/; Max-Age=1800; Secure"], parsed);
var jarHeader = service.cookieHeaderForJar(jar, parsed);
assert(jarHeader.indexOf("cf_clearance=tok123") >= 0, "cf_clearance stored in per-author jar");
// Isolation: a different author's jar must not see it.
var otherJar = service.getCookieJar("repoX\nscraperZ");
assert(
  service.cookieHeaderForJar(otherJar, parsed).indexOf("cf_clearance=") < 0,
  "cf_clearance isolated to its author's jar"
);

console.log("decideWafAction — retry-once decision:");
var retry = service.decideWafAction({
  status: 403,
  headers: { "cf-mitigated": "challenge" },
  bodySnippet: "Forbidden",
  setCookieHeaders: ["cf_clearance=tok123; Path=/; Secure"],
  alreadyRetried: false,
  url: "https://protected.example/"
});
assert(
  retry.action === "retry" && retry.vendor === "cloudflare",
  "challenge + fresh cf_clearance -> retry once"
);

var retrySingleString = service.decideWafAction({
  status: 503,
  headers: { server: "cloudflare" },
  bodySnippet: cfHtml,
  setCookieHeaders: "cf_clearance=tok123; Path=/",
  alreadyRetried: false,
  url: "https://protected.example/"
});
assert(retrySingleString.action === "retry", "single-string Set-Cookie also triggers retry");

var blocked1 = service.decideWafAction({
  status: 403,
  headers: { "cf-mitigated": "challenge" },
  bodySnippet: "Forbidden",
  setCookieHeaders: ["cf_clearance=tok123; Path=/"],
  alreadyRetried: true,
  url: "https://protected.example/"
});
assert(
  blocked1.action === "blocked" && blocked1.vendor === "cloudflare",
  "already-retried challenge -> blocked (no infinite loop)"
);

var blocked2 = service.decideWafAction({
  status: 503,
  headers: { server: "cloudflare" },
  bodySnippet: cfHtml,
  setCookieHeaders: [],
  alreadyRetried: false,
  url: "https://protected.example/"
});
assert(blocked2.action === "blocked", "challenge without clearance cookie -> blocked");

var blocked3 = service.decideWafAction({
  status: 403,
  headers: { "cf-mitigated": "challenge" },
  bodySnippet: "Forbidden",
  setCookieHeaders: ["other=1; Path=/"],
  alreadyRetried: false,
  url: "https://protected.example/"
});
assert(blocked3.action === "blocked", "challenge with unrelated cookies only -> blocked");

var pass = service.decideWafAction({
  status: 200,
  headers: {},
  bodySnippet: "<html>ok</html>",
  setCookieHeaders: [],
  alreadyRetried: false,
  url: "https://protected.example/"
});
assert(pass.action === "pass", "normal page -> pass");

if (failures) {
  console.log("\n" + failures + " FAILURES");
  process.exit(1);
}
console.log("\nAll WAF tests passed.");
