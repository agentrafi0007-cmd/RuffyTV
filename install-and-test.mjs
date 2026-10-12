/**
 * Real install-flow driver: repo add -> provider install -> enable,
 * exactly as the Extensions UI does (providerRepository.js), then
 * end-to-end execution of every installed provider.
 *
 * Usage: node install-and-test.mjs  (starts its own file server)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const examplesDir = path.join(here, "js/core/providers/examples");

// Node has no localStorage (app targets webOS/browser) — minimal in-memory
// shim so the real LocalStore/providerRepository code paths run unmodified.
{
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(String(k)) ? mem.get(String(k)) : null),
    setItem: (k, v) => mem.set(String(k), String(v)),
    removeItem: (k) => mem.delete(String(k)),
    clear: () => mem.clear(),
    key: (i) => [...mem.keys()][i] ?? null,
    get length() {
      return mem.size;
    }
  };
}

// ---- 1. serve the examples dir over HTTP (stands in for a hosted repo) ----
const server = http.createServer((req, res) => {
  const name = path.basename(req.url.split("?")[0]);
  const file = path.join(examplesDir, name);
  if (!name || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404);
    res.end("nope");
    return;
  }
  const type = name.endsWith(".json") ? "application/json" : "text/javascript";
  res.writeHead(200, { "Content-Type": type });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
console.log("repo server at", base);

// ---- 2. REAL install flow (same calls the UI makes) ----
const repo = await import("./js/core/providers/providerRepository.js");
const { validateProviderResult } = await import("./js/core/providers/providerContract.js");
const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);

const fetchText = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${res.status} for ${url}`);
  return res.text();
};

// addRepository(url)
const doc = await (await fetch(`${base}/repo.json`)).json();
const normalized = repo.normalizeProviderRepo(doc, `${base}/repo.json`);
if (!normalized) throw new Error("repo.json not recognized as provider repo");
const record = repo.addProviderRepository(normalized);
console.log(`repo added: "${record.name}" with ${record.providers.length} providers`);

// installProvider + setProviderEnabled for each
for (const p of record.providers) {
  await repo.installProvider(record.id, p.id, fetchText);
  repo.setProviderEnabled(record.id, p.id, true);
  console.log(`installed+enabled: ${p.name} (${p.version})`);
}

const active = repo.listActiveProviders();
console.log(`active providers: ${active.length}`);

// ---- 3. execute every installed provider end-to-end ----
// (Direct Node execution of the installed code — same modules the QuickJS
// sandbox runs on TV; sandbox isolation verified separately by security tests.)
const QUERIES = {
  "Internet Archive": "charlie chaplin",
  PeerTube: "blender",
  "Wikimedia Commons": "space"
};
let pass = 0,
  fail = 0;
for (const p of active) {
  console.log(`\n### ${p.name}`);
  try {
    const mod = require(p.url.replace(base, examplesDir));
    const q = QUERIES[p.name] || "test";
    const search = validateProviderResult("search", await mod.search({ query: q }));
    console.log(`  search("${q}"): ${search.length} results`);
    if (!search.length) throw new Error("no search results");
    const home = validateProviderResult("getHomePage", await mod.getHomePage());
    console.log(`  getHomePage: ${home.length} rows`);
    const detail = validateProviderResult("load", await mod.load({ url: search[0].url }));
    console.log(`  load: "${detail.title.slice(0, 50)}" | episodes: ${detail.episodes.length}`);
    if (!detail.episodes.length) throw new Error("no episodes");
    const links = validateProviderResult(
      "loadLinks",
      await mod.loadLinks({ episode: detail.episodes[0] })
    );
    console.log(`  loadLinks: ${links.length} links`);
    if (!links.length) throw new Error("no stream links");
    const head = await fetch(links[0].url, { method: "HEAD" });
    console.log(`  HEAD ${head.status} -> ${head.ok ? "STREAM OK" : "STREAM FAIL"}`);
    if (!head.ok) throw new Error("stream HEAD failed");
    console.log(`  PASS`);
    pass++;
  } catch (e) {
    console.log(`  FAIL: ${e.message}`);
    fail++;
  }
}
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
server.close();
process.exit(fail ? 1 : 0);
