/**
 * ProviderManager — executes provider modules through the QuickJS sandbox.
 *
 * Providers are plain JS modules implementing the provider contract
 * (see providerContract.js): search / getHomePage / load / loadLinks.
 * Execution reuses the existing hardened plugin worker
 * (js/core/player/pluginWorker.js): each call runs in a fresh QuickJS
 * context inside a Web Worker, memory-limited and deadline-bounded, with
 * network access ONLY via the bridged fetch -> plugin HTTP service
 * (SSRF blocklist + per-author cookie jars enforced there).
 *
 * This module is the Vega `ProviderManager.executeModule()` equivalent,
 * adapted to the fork's worker which historically only spoke the
 * `getStreams(tmdbId, mediaType, season, episode)` contract. The worker now
 * accepts a generic `entryPoint`; `getStreams` keeps its legacy calling
 * convention for backward compatibility.
 */

import { pluginRuntime } from "../player/pluginRuntime.js";
import { PROVIDER_ENTRY_POINTS, validateProviderResult } from "./providerContract.js";

function text(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

/**
 * Execute one provider entry point in the sandbox.
 *
 * @param {object} options
 * @param {string} options.code        provider JS source
 * @param {string} options.entryPoint  one of PROVIDER_ENTRY_POINTS
 * @param {object} options.args        arguments passed to the entry point
 * @param {string} options.providerId  stable provider id (cookie jar key)
 * @param {string} options.repositoryId repository id (cookie jar key)
 * @param {object} [options.settings]  provider settings
 * @param {object} [options.quota]     execution quotas (defaults apply)
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<any>} validated result for the entry point
 */
export async function executeProviderEntry({
  code,
  entryPoint,
  args = {},
  providerId = "",
  repositoryId = "",
  settings = {},
  quota,
  timeoutMs,
  signal = null
} = {}) {
  if (!PROVIDER_ENTRY_POINTS.includes(entryPoint)) {
    throw new Error(`Unknown provider entry point: ${entryPoint}`);
  }
  if (typeof code !== "string" || !code.trim()) {
    throw new Error("Provider code is empty");
  }
  const raw = await pluginRuntime.executeProvider({
    code,
    entryPoint,
    args,
    scraperId: text(providerId, "provider"),
    repositoryId: text(repositoryId),
    settings,
    quota,
    timeoutMs,
    signal
  });
  if (raw && typeof raw === "object" && raw.__nuvioError) {
    throw new Error(`Provider ${entryPoint} failed: ${raw.__nuvioError}`);
  }
  return validateProviderResult(entryPoint, raw);
}

/** provider.search(query) -> SearchResult[] */
export function providerSearch(provider, query, options = {}) {
  return executeProviderEntry({
    ...options,
    code: provider.code,
    providerId: provider.id,
    repositoryId: provider.repositoryId,
    entryPoint: "search",
    args: { query: text(query) }
  });
}

/** provider.getHomePage() -> HomeRow[] */
export function providerHomePage(provider, options = {}) {
  return executeProviderEntry({
    ...options,
    code: provider.code,
    providerId: provider.id,
    repositoryId: provider.repositoryId,
    entryPoint: "getHomePage",
    args: {}
  });
}

/** provider.load(url) -> LoadResponse */
export function providerLoad(provider, url, options = {}) {
  return executeProviderEntry({
    ...options,
    code: provider.code,
    providerId: provider.id,
    repositoryId: provider.repositoryId,
    entryPoint: "load",
    args: { url: text(url) }
  });
}

/** provider.loadLinks(episode) -> StreamLink[] */
export function providerLoadLinks(provider, episode, options = {}) {
  return executeProviderEntry({
    ...options,
    code: provider.code,
    providerId: provider.id,
    repositoryId: provider.repositoryId,
    entryPoint: "loadLinks",
    args: { episode: episode && typeof episode === "object" ? episode : { url: text(episode) } }
  });
}
