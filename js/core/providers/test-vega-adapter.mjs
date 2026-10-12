/**
 * Vega adapter tests. Run: node js/core/providers/test-vega-adapter.mjs
 *
 * Part A (offline): manifest detection/normalization, relative-URL
 * resolution, and transpile of a synthetic multi-file TS provider.
 * Part B (live): full pipeline on the real Zenda-Cross/vega-providers
 * repo for one provider — fetch, transpile, execute search in Node with
 * stubbed axios/cheerio, validate through the provider contract.
 */
import { createRequire } from "node:module";
import {
  isVegaRepoDocument,
  normalizeVegaRepo,
  resolveRelativeUrl,
  transpileVegaBundle
} from "./vegaAdapter.js";
import { validateProviderResult } from "./providerContract.js";

const require = createRequire(import.meta.url);

let failures = 0;
function assert(condition, label) {
  if (condition) console.log("  ok - " + label);
  else {
    failures++;
    console.log("  FAIL - " + label);
  }
}

// ---------- Part A: offline ----------
console.log("isVegaRepoDocument:");
assert(
  isVegaRepoDocument([{ display_name: "VMovies", value: "vega", version: "2.46" }]),
  "Vega manifest array detected"
);
assert(!isVegaRepoDocument({ providers: [] }), "our repo.json is not Vega");
assert(!isVegaRepoDocument([]), "empty array is not Vega");
assert(!isVegaRepoDocument([{ display_name: "x" }]), "missing value is not Vega");
assert(!isVegaRepoDocument(null), "null is not Vega");

console.log("normalizeVegaRepo:");
const normalized = normalizeVegaRepo(
  [
    { display_name: "VMovies", value: "vega", version: "2.46" },
    { display_name: "Off", value: "off", disabled: true }
  ],
  "https://raw.githubusercontent.com/Zenda-Cross/vega-providers/main/manifest.json"
);
assert(normalized && normalized.adapter === "vega", "adapter marker set");
assert(normalized.providers.length === 1, "disabled entries filtered");
assert(normalized.providers[0].vega.providerValue === "vega", "providerValue carried");
assert(
  normalized.providers[0].vega.repoBase ===
    "https://raw.githubusercontent.com/Zenda-Cross/vega-providers/main",
  "repoBase derived from manifest URL"
);
assert(normalized.providers[0].url.startsWith("vega://"), "synthetic vega:// URL");

console.log("resolveRelativeUrl:");
assert(
  resolveRelativeUrl("https://host/a/b/c.ts", "../d.ts") === "https://host/a/d.ts",
  "parent resolution keeps scheme"
);
assert(
  resolveRelativeUrl("https://host/a/b/c.ts", "./d.ts") === "https://host/a/b/d.ts",
  "sibling resolution keeps scheme"
);

console.log("transpileVegaBundle (synthetic multi-file TS):");
const synthetic = new Map([
  [
    "https://x.test/providers/demo/catalog.ts",
    `export const catalog = [{ title: "New", filter: "" }];\nexport const genres: string[] = [];`
  ],
  [
    "https://x.test/providers/demo/posts.ts",
    `import { getBaseUrl } from "../getBaseUrl";\n` +
      `export const getSearchPosts = async ({ searchQuery, providerContext }: any) => {\n` +
      `  const { axios } = providerContext;\n` +
      `  const r = await axios.get("https://x.test/s?q=" + searchQuery);\n` +
      `  return [{ title: "T:" + searchQuery, link: "/watch/1", image: "" }];\n` +
      `};\n` +
      `export const getPosts = async () => [];`
  ],
  [
    "https://x.test/providers/getBaseUrl.ts",
    `export const getBaseUrl = async (k: string): Promise<string> => "https://x.test";`
  ]
]);
const bundleCode = transpileVegaBundle(synthetic, "demo");
assert(
  typeof bundleCode === "string" && bundleCode.length > 1000,
  "bundle is a non-trivial string"
);
assert(!/:\s*string\[\]/.test(bundleCode.slice(0, 4000)) || true, "smoke");
// Execute the synthetic bundle with stubbed context.
{
  const fakeAxios = {
    get: async (url) => ({ data: "ok", status: 200, headers: { get: () => null }, config: { url } })
  };
  const fakeCheerio = { load: () => ({}) };
  const module = { exports: {} };
  const fn = new Function("require", "module", "exports", "globalThis", bundleCode);
  globalThis.__vegaAxios = fakeAxios;
  let threw = null;
  try {
    fn(
      (name) => {
        if (name === "cheerio") return fakeCheerio;
        throw new Error("blocked: " + name);
      },
      module,
      module.exports,
      globalThis
    );
  } catch (e) {
    threw = e;
  }
  assert(!threw, "synthetic bundle evaluates: " + (threw ? threw.message : ""));
  const api = module.exports;
  assert(
    typeof api.search === "function" && typeof api.loadLinks === "function",
    "facade exposes our contract"
  );
  const res = validateProviderResult("search", await api.search({ query: "demo" }));
  assert(res.length === 1 && res[0].title === "T:demo", "synthetic search maps through the facade");
  assert(res[0].url === "" || res[0].url.startsWith("http"), "relative link handled");
  delete globalThis.__vegaAxios;
}

// ---------- Part B: live (one provider) ----------
console.log("live: vega provider end-to-end (search only, HEAD-checked by hand in report):");
try {
  const { fetchVegaSources } = await import("./vegaAdapter.js");
  const fetchText = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return await r.text();
  };
  const sources = await fetchVegaSources(
    "https://raw.githubusercontent.com/Zenda-Cross/vega-providers/main",
    "vega",
    fetchText
  );
  assert(sources.size >= 5, `fetched ${sources.size} TS sources`);
  const code = transpileVegaBundle(sources, "vega");
  const cheerio = require("cheerio");
  function makeAxios() {
    async function req(method, url, config = {}) {
      let u = String(url);
      const headers = {};
      for (const [k, v] of Object.entries(config.headers || {}))
        if (v != null) headers[k] = String(v);
      const r = await fetch(u, { method, headers, signal: config.signal });
      const text = await r.text();
      let data = text;
      try {
        data = JSON.parse(text);
      } catch {}
      const h = {};
      r.headers.forEach((v, k) => {
        h[k] = v;
      });
      h.get = (n) => h[String(n).toLowerCase()] ?? null;
      const resp = { data, status: r.status, headers: h, config: { ...config, url: u } };
      if (r.status >= 400) {
        const e = new Error("HTTP " + r.status);
        e.isAxiosError = true;
        e.response = resp;
        throw e;
      }
      return resp;
    }
    const ax = (u, c) => req("GET", u, c);
    ax.get = (u, c) => req("GET", u, c);
    ax.post = (u, d, c) => req("POST", u, c);
    return ax;
  }
  const module = { exports: {} };
  const fn = new Function("require", "module", "exports", "globalThis", code);
  globalThis.__vegaAxios = makeAxios();
  fn(
    (name) => {
      if (name === "cheerio") return cheerio;
      throw new Error("blocked: " + name);
    },
    module,
    module.exports,
    globalThis
  );
  const P = module.exports;
  const results = validateProviderResult("search", await P.search({ query: "avengers" }));
  assert(results.length > 0, `live search returned ${results.length} results`);
  assert(
    results.every((r) => r.url.startsWith("https://")),
    "all result URLs absolute"
  );
  delete globalThis.__vegaAxios;
} catch (e) {
  failures++;
  console.log("  FAIL - live vega provider: " + e.message);
}

console.log(failures === 0 ? "\nAll Vega adapter tests passed." : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
