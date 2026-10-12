/**
 * Provider contract test harness. Run: node js/core/providers/test-provider.mjs
 *
 * Exercises the Internet Archive test provider end-to-end in Node
 * (Node 18+ global fetch stands in for the sandbox bridged fetch),
 * then validates every result through providerContract.js.
 */
import { createRequire } from "node:module";
import { validateProviderResult, PROVIDER_ENTRY_POINTS } from "./providerContract.js";

const require = createRequire(import.meta.url);
const provider = require("./examples/internet-archive.cjs");

let failures = 0;
function assert(condition, label) {
  if (condition) console.log("  ok - " + label);
  else {
    failures++;
    console.log("  FAIL - " + label);
  }
}

console.log("contract entry points:", PROVIDER_ENTRY_POINTS.join(", "));

console.log("search('charlie chaplin'):");
const searchResults = validateProviderResult(
  "search",
  await provider.search({ query: "charlie chaplin" })
);
assert(
  Array.isArray(searchResults) && searchResults.length > 0,
  `got ${searchResults.length} results`
);
assert(
  searchResults.every((r) => r.title && r.url),
  "every result has title + url"
);
console.log("  first:", JSON.stringify(searchResults[0]).slice(0, 160));

console.log("getHomePage():");
const homeRows = validateProviderResult("getHomePage", await provider.getHomePage());
assert(Array.isArray(homeRows) && homeRows.length > 0, `got ${homeRows.length} rows`);
assert(homeRows[0].results.length > 0, `first row has ${homeRows[0].results.length} results`);

console.log("load(first search result):");
const detail = validateProviderResult("load", await provider.load({ url: searchResults[0].url }));
assert(detail && detail.title, "detail has title");
assert(
  Array.isArray(detail.episodes) && detail.episodes.length > 0,
  `got ${detail.episodes.length} episodes/files`
);
console.log("  title:", detail.title.slice(0, 80));

console.log("loadLinks(first episode):");
const links = validateProviderResult(
  "loadLinks",
  await provider.loadLinks({ episode: detail.episodes[0] })
);
assert(Array.isArray(links) && links.length > 0, `got ${links.length} stream links`);
assert(links[0].url.startsWith("https://"), "stream URL is https");
console.log("  stream:", links[0].url.slice(0, 120));

// Contract rejects malformed provider output (defense in depth).
console.log("contract validation (malformed input):");
assert(
  validateProviderResult("search", [{ title: "", url: "not a url" }]).length === 0,
  "bad search results dropped"
);
assert(
  validateProviderResult("loadLinks", [{ url: "http://127.0.0.1/x" }]).length === 1,
  "127.0.0.1 passes contract (service blocklist is the enforcer)"
);
assert(
  validateProviderResult("loadLinks", [{ url: "ftp://x/y" }]).length === 0,
  "non-http(s) dropped"
);
assert(validateProviderResult("bogus", []) === null, "unknown entry point -> null");

if (failures) {
  console.log(`\n${failures} FAILURES`);
  process.exit(1);
}
console.log("\nAll provider tests passed.");
