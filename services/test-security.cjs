/**
 * Unit tests for the plugin HTTP service security hardening:
 * SSRF blocklist (literal hostnames + resolved addresses) and per-author
 * cookie jars. Run: node services/test-security.cjs
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

console.log("SSRF blocklist — literal hostnames:");
assert(service.isBlockedHostname("127.0.0.1") === true, "127.0.0.1 blocked");
assert(service.isBlockedHostname("127.0.0.5") === true, "127.0.0.5 blocked");
assert(service.isBlockedHostname("localhost") === true, "localhost blocked");
assert(service.isBlockedHostname("foo.localhost") === true, "*.localhost blocked");
assert(service.isBlockedHostname("10.0.0.1") === true, "10/8 blocked");
assert(service.isBlockedHostname("172.16.5.4") === true, "172.16/12 blocked");
assert(service.isBlockedHostname("172.31.255.255") === true, "172.31 blocked");
assert(service.isBlockedHostname("172.15.0.1") === false, "172.15 public (not private)");
assert(service.isBlockedHostname("192.168.1.1") === true, "192.168/16 blocked");
assert(service.isBlockedHostname("169.254.10.20") === true, "link-local blocked");
assert(service.isBlockedHostname("0.0.0.0") === true, "0.0.0.0 blocked");
assert(service.isBlockedHostname("224.0.0.1") === true, "multicast blocked");
assert(service.isBlockedHostname("::1") === true, "::1 blocked");
assert(service.isBlockedHostname("8.8.8.8") === false, "8.8.8.8 allowed");
assert(service.isBlockedHostname("1.1.1.1") === false, "1.1.1.1 allowed");
assert(service.isBlockedHostname("example.com") === false, "example.com allowed");
assert(service.isBlockedHostname("") === true, "empty hostname blocked");

console.log("SSRF blocklist — resolved addresses:");
assert(service.isBlockedAddress("127.0.0.1") === true, "127.0.0.1 blocked");
assert(service.isBlockedAddress("::ffff:127.0.0.1") === true, "IPv4-mapped loopback blocked");
assert(service.isBlockedAddress("::ffff:8.8.8.8") === false, "IPv4-mapped public allowed");
assert(service.isBlockedAddress("fe80::1") === true, "fe80::/10 blocked");
assert(service.isBlockedAddress("fc00::1") === true, "fc00::/7 blocked");
assert(service.isBlockedAddress("ff02::1") === true, "multicast v6 blocked");
assert(service.isBlockedAddress("2606:4700:4700::1111") === false, "public v6 allowed");

console.log("Per-author cookie jars:");
var jarA = service.getCookieJar("repo1\nproviderA");
var jarB = service.getCookieJar("repo1\nproviderB");
var parsed = new URL("https://example.com/path/page");
service.storeSetCookies(jarA, ["session=abc123; Path=/; Max-Age=3600"], parsed);
service.storeSetCookies(jarB, ["other=xyz; Path=/"], parsed);
var headerA = service.cookieHeaderForJar(jarA, parsed);
var headerB = service.cookieHeaderForJar(jarB, parsed);
assert(headerA === "session=abc123", "jar A serves its cookie (got: " + headerA + ")");
assert(headerB === "other=xyz", "jar B serves its cookie (got: " + headerB + ")");
assert(headerA.indexOf("other=") < 0, "jar A isolated from jar B");
assert(headerB.indexOf("session=") < 0, "jar B isolated from jar A");

// Domain scoping: cookie for example.com must not go to other.com
var otherParsed = new URL("https://other.com/");
assert(service.cookieHeaderForJar(jarA, otherParsed) === "", "no cross-domain leak");
// Subdomain scoping: parent-domain cookie goes to subdomains
service.storeSetCookies(jarA, ["wide=1; Domain=example.com; Path=/"], parsed);
var subParsed = new URL("https://sub.example.com/");
assert(
  service.cookieHeaderForJar(jarA, subParsed).indexOf("wide=1") >= 0,
  "parent-domain cookie sent to subdomain"
);
// Expiry pruning
service.storeSetCookies(jarA, ["gone=1; Max-Age=0"], parsed);
assert(
  service.cookieHeaderForJar(jarA, parsed).indexOf("gone=") < 0,
  "expired cookie pruned"
  // Secure flag
);
service.storeSetCookies(jarA, ["sec=1; Secure; Path=/"], parsed);
var httpParsed = new URL("http://example.com/");
assert(
  service.cookieHeaderForJar(jarA, httpParsed).indexOf("sec=") < 0,
  "secure cookie not sent over http"
);

if (failures) {
  console.log("\n" + failures + " FAILURES");
  process.exit(1);
}
console.log("\nAll security tests passed.");
