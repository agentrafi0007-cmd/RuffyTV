# Installing RuffyTV on your LG TV

RuffyTV is distributed by **sideloading** — it is not in the LG Content Store.

**What you need:** an LG webOS TV (webOS 5+), a PC/Mac on the same network, ~15 minutes.

## Steps

1. **Enable Developer Mode on the TV**
   Install the **"Developer Mode"** app from the LG Content Store on the TV →
   sign in with an LG Developer account → toggle **Developer Mode ON**
   (the TV reboots). Note the TV's IP address
   (Settings → Network → Wi-Fi/Ethernet connection).

2. **Install webOS Dev Manager on your computer**
   Download [webOS Dev Manager](https://github.com/webosbrew/dev-manager-desktop)
   (Windows / macOS / Linux). No LG CLI tools needed.

3. **Add your TV and install the app**
   In Dev Manager, add your TV with its IP address, then install the `.ipk`:
   `com.ruffytv.webos_1.2.3_all.ipk`. RuffyTV appears in the TV's app list.
   (Build the `.ipk` yourself with `npm run package:webos`, or grab one from
   the project's GitHub Releases.)

4. **Add sources**
   Open RuffyTV → Settings → Provider Manager → `+` → paste a `repo.json` URL
   or a shortcode (e.g. `vega`, `github:owner/repo`, `owner/repo`) → install
   providers. The app ships with legal/tested providers only — third-party
   sources are yours to add, same model as CloudStream/Vega.

## Renewal (important)

The Developer Mode session lasts **1000 hours (~6 weeks)**. Before it expires,
open the Developer Mode app on the TV and hit **EXTEND** — otherwise the TV
**uninstalls all sideloaded apps**, RuffyTV included.

Your library, watch history, providers, and settings live in the TV's **db8**
database, so they survive app _updates_ — but not a dev-mode wipe.
Reinstalling after a wipe means starting fresh.

## Updating RuffyTV

Build (or download) the new `.ipk` and reinstall over the old one via
Dev Manager. Settings, providers, watch history, and library carry over (db8);
data from the old localStorage era migrates automatically on first boot.
