/**
 * Shortcode resolver tests. Run: node js/core/providers/test-shortcodes.mjs
 */
import {
  isProviderShortCode,
  resolveProviderShortCode,
  listBuiltinShortcodes
} from "./providerShortcodes.js";

let failures = 0;
function assert(condition, label) {
  if (condition) console.log("  ok - " + label);
  else {
    failures++;
    console.log("  FAIL - " + label);
  }
}

console.log("isProviderShortCode:");
assert(isProviderShortCode("vega"), "registry code 'vega' is a shortcode");
assert(
  isProviderShortCode("github:Zenda-Cross/vega-providers"),
  "github:owner/repo is a shortcode"
);
assert(isProviderShortCode("Zenda-Cross/vega-providers"), "bare owner/repo is a shortcode");
assert(isProviderShortCode("anicompat"), "legacy-style bare code is a shortcode");
assert(!isProviderShortCode("https://example.com/repo.json"), "full URL is not a shortcode");
assert(!isProviderShortCode("http://example.com"), "http URL is not a shortcode");
assert(!isProviderShortCode(""), "empty is not a shortcode");
assert(!isProviderShortCode("a/b/c"), "two slashes is not a shortcode");
assert(!isProviderShortCode("../evil"), "path traversal is not a shortcode");
assert(!isProviderShortCode("owner/repo with space"), "spaces rejected");

console.log("resolveProviderShortCode:");
assert(
  resolveProviderShortCode("vega") ===
    "https://raw.githubusercontent.com/Zenda-Cross/vega-providers/main/manifest.json",
  "registry 'vega' resolves to the Vega manifest"
);
assert(
  resolveProviderShortCode("VEGA") ===
    "https://raw.githubusercontent.com/Zenda-Cross/vega-providers/main/manifest.json",
  "registry lookup is case-insensitive"
);
assert(
  resolveProviderShortCode("github:Zenda-Cross/vega-providers") ===
    "https://raw.githubusercontent.com/Zenda-Cross/vega-providers/main/repo.json",
  "github:owner/repo resolves to raw repo.json"
);
assert(
  resolveProviderShortCode("Zenda-Cross/vega-providers") ===
    "https://raw.githubusercontent.com/Zenda-Cross/vega-providers/main/repo.json",
  "bare owner/repo resolves to raw repo.json"
);
assert(
  resolveProviderShortCode("https://example.com/repo.json") === null,
  "full URL resolves to null"
);
assert(resolveProviderShortCode("not-a-code!") === null, "garbage resolves to null");
assert(resolveProviderShortCode("../evil") === null, "traversal resolves to null");
assert(resolveProviderShortCode("") === null, "empty resolves to null");

console.log("listBuiltinShortcodes:");
const builtins = listBuiltinShortcodes();
assert(Array.isArray(builtins) && builtins.length >= 1, "registry is non-empty");
assert(
  builtins.every((e) => e.code && e.url.startsWith("https://")),
  "registry entries are code+https URL"
);

console.log(failures === 0 ? "\nAll shortcode tests passed." : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
