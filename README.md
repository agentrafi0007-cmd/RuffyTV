<div align="center">

  <img src="icon.png" alt="RuffyTV" width="120" />

  <h1>RuffyTV</h1>

  <p>
    <strong>A free, open-source streaming app for LG webOS TVs.</strong>
    <br />
    Bring your own sources — RuffyTV turns them into a TV library with artwork, subtitles, and your place saved on every screen.
  </p>

  <p>
    <img src="https://img.shields.io/badge/platform-webOS%20TV-blue" alt="webOS TV" />
    <img src="https://img.shields.io/badge/license-GPL--3.0-green" alt="GPL-3.0" />
  </p>

</div>

> **Forked from [NuvioMedia/NuvioWeb](https://github.com/NuvioMedia/NuvioWeb)** (GPL-3.0).
> Upstream source and releases remain at [NuvioMedia/NuvioTVSmart](https://github.com/NuvioMedia/NuvioTVSmart).
> RuffyTV rebrands the app, adds a provider runtime with a Vega/CloudStream-style extension system,
> migrates storage to db8, and hardens the webOS service layer. See [CHANGELOG.md](./CHANGELOG.md).

> **Disclaimer:** RuffyTV hosts no media and operates no streaming sources.
> All providers are independent third-party code; the authors claim no ownership
> of, or responsibility for, any provider or the content it references.
> See [DISCLAIMER.md](./DISCLAIMER.md).

## Features

- **Provider runtime** — JavaScript providers with a CloudStream-shaped contract
  (`search` → `getHomePage` → `load` → `loadLinks`), executed in sandboxed QuickJS workers.
  See [js/core/providers/PROVIDERS.md](./js/core/providers/PROVIDERS.md).
- **Repositories & shortcodes** — install providers from `repo.json` manifests.
  The `+` dialog accepts full URLs, `github:owner/repo`, bare `owner/repo`, or shortcodes like `vega`.
- **Stremio addons** — catalog, meta, and stream resources from any Stremio addon URL.
- **Vega adapter** — runs Zenda-Cross/vega-providers TypeScript providers on webOS
  (in-app transpile + contract bridge, same sandbox).
- **db8 persistence** — providers, library, watch history, and settings survive app updates
  (localStorage is wiped on webOS updates; db8 is not).
- **WAF handling** — Cloudflare/Incapsula/Akamai/DataDome challenge detection with
  `cf_clearance` cookie harvesting and one automatic retry. Interactive JS challenges
  (managed challenge / Turnstile) cannot be solved on a TV — documented, not faked.
- **Hardened service** — the Luna HTTP service enforces an SSRF blocklist
  (loopback, private nets, cloud metadata, DNS-rebinding checks on every resolved address),
  per-provider-author cookie jars, response-size caps, and timeouts.
- **Subtitles** — native WebVTT plus ASS/SSA rendering (webOS has no native ASS path).
- **TV-first UI** — 5-way remote navigation, Magic Remote pointer support, focus memory per screen.

RuffyTV ships with legal, tested providers only (Internet Archive, PeerTube, Wikimedia Commons,
plus the Stremio path). Third-party scraper repos are never bundled — adding one is a
ten-second repo-URL or shortcode paste, and that choice is yours.

## Get RuffyTV

RuffyTV targets **LG webOS TVs (webOS 5+, Chromium 68+)**. It is distributed by
**sideloading**, not through the LG Content Store.

**Install on your TV** (full guide: [docs/INSTALL.md](./docs/INSTALL.md)):

1. Enable **Developer Mode** on the TV (LG account + the Developer Mode app).
2. Install [webOS Dev Manager](https://github.com/webosbrew/dev-manager-desktop) on your computer.
3. Build the `.ipk` below (or grab one from GitHub Releases) and install it with Dev Manager.
4. Open RuffyTV → Settings → Provider Manager → `+` → add a repo URL or shortcode.

> Developer Mode sessions last ~1000 hours. When one expires, sideloaded apps are
> removed — renew Developer Mode periodically to keep RuffyTV installed.

## Build from source

Prerequisites: **Node.js 18+** (or [Bun](https://bun.sh)).

```bash
git clone <this-repo> ruffytv
cd ruffytv
bun install          # or: npm install
npm run build
```

Package for webOS:

```bash
npm run package:webos
# → com.ruffytv.webos_1.2.3_all.ipk
```

The `.ipk` is a build artifact and is never committed — build it locally and
sideload it with Dev Manager. Other scripts: `npm run lint`, `npm run package:tizen`
(upstream Tizen pipeline, retained as-is).

## Writing a provider

Providers are plain JavaScript modules implementing four entry points:

```js
module.exports = {
  async search({ query }) {
    /* → [{ title, url, poster }] */
  },
  async getHomePage() {
    /* → [{ title, results: [...] }] */
  },
  async load({ url }) {
    /* → { title, episodes: [...] } */
  },
  async loadLinks({ episode }) {
    /* → [{ url, quality, headers, subtitles }] */
  }
};
```

Full contract, sandbox capabilities/limits, `repo.json` format, and webOS constraints
(directly-playable streams, VTT preference) are documented in
[js/core/providers/PROVIDERS.md](./js/core/providers/PROVIDERS.md).
A working reference implementation lives at
[js/core/providers/examples/internet-archive.cjs](./js/core/providers/examples/internet-archive.cjs);
test yours with `node js/core/providers/test-provider.mjs`.

## Project structure

```
├── index.html                  # TV app entry
├── appinfo.json                # webOS manifest (com.ruffytv.webos)
├── js/
│   ├── core/providers/         # provider runtime: contract, manager, repos,
│   │                           # shortcodes, Vega adapter (vegaAdapter.js)
│   ├── core/player/            # player, plugin worker (QuickJS sandbox),
│   │                           # pluginManager (Stremio + provider installs)
│   ├── core/storage/           # LocalStore (db8 write-through on webOS)
│   ├── platform/webos/         # webOS specifics: db8 store, services
│   └── ui/                     # TV UI screens and components
├── services/
│   ├── plugin-http.cjs         # Luna HTTP service: SSRF blocklist, cookie
│   │                           # jars, WAF detection (test-security.cjs)
│   └── webos/                  # packaged webOS services
├── scripts/                    # build, package:webos, ares helpers
└── assets/                     # icons, splash
```

## Known limitations (honest list)

- **CloudStream `.cs3` plugins are Android-only** (compiled Kotlin/DEX) and can never
  execute on webOS — the app classifies them as such instead of failing obscurely.
- **Interactive WAF challenges** (managed challenge, Turnstile) are unsolvable without a
  webview; the service detects them and reports `wafBlocked` rather than hanging.
- **No on-TV ffmpeg/remux/transcode** — webOS exposes no such path; playback is native
  HLS/progressive (+ MSE where the platform allows).
- **No VPN/WARP/DoH stack on-device** — the service makes direct requests.
- **Dev-mode expiry** (~1000h) removes sideloaded apps; renew periodically.
- The provider-settings UI is not yet surfaced; provider code runs through the sandbox,
  which is verified by tests and code inspection — the final proof is the on-TV run.

## Security

Untrusted third-party provider code is expected input to this app, not an edge case.
The sandbox boundary (no direct network in workers, SSRF blocklist with DNS-rebinding
protection, per-author cookie isolation, memory/time limits) is covered by
`services/test-security.cjs` (32 tests) and `services/test-waf.cjs` (20 tests).
If you find a sandbox escape, please report it.

## License

[GNU General Public License v3.0](./LICENSE) — same as upstream.
