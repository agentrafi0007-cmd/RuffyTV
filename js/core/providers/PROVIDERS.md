# Provider System

Plain-JavaScript content providers for the webOS TV app. Shaped by
CloudStream's `MainAPI` (search / home page / load / load links) and Vega
Desktop's provider threat model. Coexists with the Stremio addon path and the
existing `NUVIO_JS` / `EXTERNAL_DEX` repository types — nothing about those
changes.

## For provider authors

A provider is a single `.js` file (`.cjs` / `.mjs` also accepted). `module.exports` (or globals) may implement
any subset of these entry points. All may be `async` (or return a Promise).
Missing entry points resolve to empty results.

```js
// search(query: string) -> SearchResult[]
async function search({ query }) {
  const res = await fetch("https://example.com/search?q=" + encodeURIComponent(query));
  const data = await res.json();
  return data.items.map((item) => ({
    title: item.title, // required
    url: item.pageUrl, // required, http(s)
    poster: item.posterUrl, // optional
    type: "movie", // movie | series | anime | live | audio | other
    year: 2024 // optional
  }));
}

// getHomePage() -> HomeRow[]  — rails on the home screen
async function getHomePage() {
  return [{ title: "Trending", results: [/* SearchResult */] }];
}

// load(url: string) -> LoadResponse — detail page + episodes
async function load({ url }) {
  return {
    title: "Example Movie", // required
    url, // required
    poster: "https://…", // optional
    plot: "…", // optional
    year: 2024, // optional
    type: "movie",
    episodes: [
      // Episode[] (movies: the playable files)
      { title: "1080p", url: "https://…", season: 1, episode: 1 }
    ]
  };
}

// loadLinks(episode: Episode) -> StreamLink[] — playable streams
async function loadLinks({ episode }) {
  return [
    {
      url: "https://…/video.m3u8", // required, http(s), directly playable HLS/progressive
      server: "CDN 1", // optional label
      quality: "1080p", // optional label
      headers: { Referer: "https://example.com/" }, // optional (Cookie/Host stripped)
      subtitles: [{ url: "https://…/en.vtt", lang: "en", label: "English" }]
    }
  ];
}

module.exports = { search, getHomePage, load, loadLinks };
```

### What's available inside the sandbox

- `fetch(url, options)` — Response-like (`ok`, `status`, `json()`, `text()`).
  **All requests route through the plugin HTTP service.** SSRF blocklist and
  per-author cookie jars are enforced there, not in your code.
- Cheerio-style HTML parsing (`__cheerio_load` bridge) for scrapers.
- `CryptoJS` for obfuscated sources.
- A Chrome User-Agent is sent by default; set `Referer` per request as needed.

### What's NOT available

- No `require`, no `process`, no `XMLHttpRequest`, no `WebSocket`, no DOM,
  no `localStorage`, no timers beyond the call deadline.
- No direct network: every HTTP request goes through the service, where
  private/loopback/link-local/multicast targets are rejected, responses are
  capped (5 MB), and calls time out (60 s).
- Module source cap: 2 MB. Per-call deadline: 60 s (configurable by quota).

### Constraints that shape provider design (webOS realities)

- **Streams must be directly playable.** There is no on-device remux/transcode
  (no ffmpeg on webOS). Resolve to HLS (`.m3u8`) or progressive MP4/WebM that
  the TV's native pipeline can play. Filter unplayable containers at resolve time.
- **Subtitles:** WebVTT plays natively; ASS/SSA is rendered by the app's
  custom renderer — prefer exposing VTT when the source offers both.
- Docs rule of thumb (from CloudStream's scraping guide): **verify you can
  scrape the video links first** — they're the most protected part; without
  them the provider is useless.

## For integrators — repository format (repo.json)

```json
{
  "name": "Example Providers",
  "description": "…",
  "manifestVersion": 1,
  "type": "PROVIDER_JS",
  "providers": [
    {
      "name": "Internet Archive",
      "author": "example",
      "version": "1.0.0",
      "url": "https://example.com/providers/internet-archive.js",
      "description": "Public-domain and openly-licensed video"
    }
  ]
}
```

- Add via the Extensions UI: paste the repo.json URL or a shortcode.
- `type: "PROVIDER_JS"` is explicit; a `providers` array of `.js` URLs is
  auto-detected even without it.
- Installing a provider downloads its JS (2 MB cap, validated) into the
  provider store. Providers are enabled/disabled individually. Re-adding a
  repo preserves install state.

### Shortcodes

Instead of pasting a full URL, the "+" dialog accepts:

| Form                   | Example                             | Resolves to                                                       |
| ---------------------- | ----------------------------------- | ----------------------------------------------------------------- |
| Built-in registry code | `vega`                              | pinned manifest URL (branch verified)                             |
| `github:owner/repo`    | `github:Zenda-Cross/vega-providers` | `https://raw.githubusercontent.com/<owner>/<repo>/main/repo.json` |
| Bare `owner/repo`      | `Zenda-Cross/vega-providers`        | same as `github:` form                                            |

Resolution is pure (no network): the registry pins exact URLs, the GitHub
forms construct a `raw.githubusercontent` URL. The add flow tries the
`main` branch first and falls back to `master`. Unknown codes fall through
to the legacy cutt.ly short-code resolver before failing.

### Vega providers (adapted)

`Zenda-Cross/vega-providers` ships TypeScript multi-file providers on the
Vega contract — incompatible with ours. Adding its `manifest.json` (or the
`vega` shortcode) routes it through the adapter
(`js/core/providers/vegaAdapter.js`):

1. The Vega manifest is detected (`display_name`/`value` entries) and each
   provider becomes an installable entry (marked `adapter: "vega"`).
2. At install time the adapter fetches the provider's `.ts` sources
   (entry files + relative imports, 48-file / 2 MB caps) through the
   hardened service, transpiles them with sucrase, and links them into one
   CommonJS module whose `module.exports` speaks **our** contract
   (`search`/`getHomePage`/`load`/`loadLinks`). The existing QuickJS worker
   executes it unchanged.
3. The Vega `providerContext` is injected: `axios` is a shim over the
   bridged fetch (so SSRF/cookie rules still apply), `cheerio` is the
   worker's existing bridge. Vega `Post.link` values are often site-relative
   paths — the adapter resolves them against the captured response origin.
   Opaque resolver tokens (e.g. autoEmbed's JSON payloads) are wrapped as
   unresolvable `https://vega-token.invalid/<base64url>` URLs so they
   survive contract validation, and unwrapped in `loadLinks`.

Known limits: providers needing interactive WAF solving (`openWebView`),
`node:crypto`-style native extractors, or `Aes` (null even in Vega proper)
fail as ordinary provider errors. Sites behind Cloudflare return no
results — same as upstream.

## Architecture notes

- Execution: `providerManager.js` → `pluginRuntime.executeProvider()` →
  QuickJS Web-Worker sandbox (`pluginWorker.js`), one fresh context per call.
  The worker accepts a generic `entryPoint`; the legacy `getStreams`
  contract keeps its old calling convention untouched.
- Results are validated by `providerContract.js` before reaching the UI —
  malformed provider output is dropped, never rendered.
- Cookie jars live in the plugin HTTP service, keyed by
  `repositoryId + scraperId`. Jars are domain-matched, expiry-pruned, capped
  at 500 cookies, and never leave the service.

## Reference implementation

`examples/internet-archive.cjs` — full loop against the Internet Archive's
public JSON APIs (public-domain / openly-licensed content only). Test it with:

```
node js/core/providers/test-provider.mjs
```
