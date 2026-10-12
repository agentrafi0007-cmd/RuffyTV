/**
 * Provider repositories — CloudStream-style repo.json distribution for JS providers.
 *
 * A provider repository is a JSON document (repo.json):
 *   {
 *     "name": "Example Providers",
 *     "description": "...",
 *     "manifestVersion": 1,
 *     "type": "PROVIDER_JS",          // optional; auto-detected from `providers`
 *     "providers": [
 *       { "name": "...", "author": "...", "version": "1.0.0",
 *         "url": "https://.../provider.js", "description": "..." }
 *     ]
 *   }
 *
 * Flow: addRepository(url | shortcode) -> fetch + normalize repo.json ->
 * list providers -> installProvider() downloads the JS module ->
 * enable/disable per provider. Installed providers are executed by
 * providerManager.js through the QuickJS sandbox.
 *
 * This coexists with (never replaces) the Stremio addon path and the
 * NUVIO_JS / EXTERNAL_DEX repository types in pluginManager.js.
 */

import { validateProviderMetadata } from "./providerContract.js";
import { installVegaProviderCode } from "./vegaAdapter.js";
import { LocalStore } from "../storage/localStore.js";

const STORE_KEY = "nuvio.providerRepositories.v1";
const MAX_PROVIDERS_PER_REPO = 128;
const MAX_PROVIDER_CODE_BYTES = 2 * 1024 * 1024; // Vega parity: 2 MB module cap

function text(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function loadStore() {
  try {
    // LocalStore handles JSON serialization and routes through db8 on webOS
    // (same STORE_KEY, so provider installs survive app updates).
    const parsed = LocalStore.get(STORE_KEY, null);
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.repositories)) {
      return parsed;
    }
  } catch (_) {
    // Corrupt store -> start fresh rather than crash the settings screen.
  }
  return { repositories: [] };
}

function saveStore(store) {
  try {
    LocalStore.set(STORE_KEY, store);
  } catch (_) {
    // Storage full/blocked: provider installs become session-only.
  }
}

function stableId(value) {
  let hash = 2166136261;
  const input = String(value || "");
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `prov_${(hash >>> 0).toString(36)}`;
}

/** True when a fetched JSON document is a provider repo.json. */
export function isProviderRepoDocument(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) return false;
  const declared = text(document.type)
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  if (declared === "PROVIDER_JS" || declared === "PROVIDER" || declared === "REPO_JSON") {
    return true;
  }
  // Auto-detect: a `providers` array whose entries resolve to .js modules.
  if (Array.isArray(document.providers) && document.providers.length > 0) {
    return document.providers.every((entry) => {
      const url = text(entry && entry.url);
      return /\.(?:mjs|cjs|js)(?:$|[?#])/i.test(url);
    });
  }
  return false;
}

/** Normalize a repo.json document into { id, name, description, url, providers[] }. */
export function normalizeProviderRepo(document, sourceUrl) {
  if (!isProviderRepoDocument(document)) return null;
  const url = text(sourceUrl);
  if (!url) return null;
  const providers = document.providers
    .map((entry) => {
      // Resolve relative provider URLs against the repo.json location BEFORE
      // validation, so hosted repos can use portable relative paths.
      let resolved = entry;
      if (entry && typeof entry.url === "string" && !/^[a-z][a-z0-9+.-]*:/i.test(entry.url)) {
        try {
          resolved = { ...entry, url: new URL(entry.url, url).toString() };
        } catch (_) {
          return null;
        }
      }
      const meta = validateProviderMetadata(resolved);
      if (!meta) return null;
      return { ...meta, id: stableId(`${url}::${meta.url}`), enabled: true, installedAt: 0 };
    })
    .filter(Boolean)
    .slice(0, MAX_PROVIDERS_PER_REPO);
  return {
    id: stableId(url),
    name: text(document.name, "Provider repository").slice(0, 128),
    description: text(document.description).slice(0, 512),
    url,
    manifestVersion: Number(document.manifestVersion || 1) || 1,
    providers,
    addedAt: Date.now()
  };
}

export function listProviderRepositories() {
  return loadStore().repositories;
}

export function getProviderRepository(repositoryId) {
  return listProviderRepositories().find((entry) => entry.id === repositoryId) || null;
}

export function addProviderRepository(normalizedRepo) {
  const store = loadStore();
  const existing = store.repositories.findIndex((entry) => entry.id === normalizedRepo.id);
  const record = {
    ...normalizedRepo,
    providers: normalizedRepo.providers.map((provider) => {
      const previous = store.repositories
        .flatMap((repo) => repo.providers || [])
        .find((item) => item.id === provider.id);
      // Preserve install state across repo refreshes.
      return previous
        ? {
            ...provider,
            enabled: previous.enabled,
            installedAt: previous.installedAt,
            code: previous.code
          }
        : provider;
    })
  };
  if (existing >= 0) store.repositories[existing] = record;
  else store.repositories.push(record);
  saveStore(store);
  return record;
}

export function removeProviderRepository(repositoryId) {
  const store = loadStore();
  store.repositories = store.repositories.filter((entry) => entry.id !== repositoryId);
  saveStore(store);
}

export function listProviders(repositoryId) {
  const repo = getProviderRepository(repositoryId);
  return repo ? repo.providers || [] : [];
}

export function setProviderEnabled(repositoryId, providerId, enabled) {
  const store = loadStore();
  const repo = store.repositories.find((entry) => entry.id === repositoryId);
  if (!repo) return false;
  const provider = (repo.providers || []).find((entry) => entry.id === providerId);
  if (!provider) return false;
  provider.enabled = Boolean(enabled);
  saveStore(store);
  return true;
}

/**
 * Download + validate a provider's JS module. The code is NOT executed here;
 * execution happens later through providerManager's sandboxed worker.
 * `fetchText` is injected so this module stays UI-testable without the
 * Luna service (tests can pass a stub).
 */
export async function installProvider(repositoryId, providerId, fetchText) {
  const store = loadStore();
  const repo = store.repositories.find((entry) => entry.id === repositoryId);
  if (!repo) throw new Error("Provider repository not found");
  const provider = (repo.providers || []).find((entry) => entry.id === providerId);
  if (!provider) throw new Error("Provider not found in repository");
  let code;
  if (provider.vega && provider.vega.providerValue) {
    // Vega-providers entry: fetch TypeScript sources and adapt to our contract.
    code = await installVegaProviderCode(provider.vega, fetchText);
  } else {
    code = await fetchText(provider.url);
    if (typeof code !== "string" || !code.trim()) {
      throw new Error("Downloaded provider module is empty");
    }
  }
  const byteLength =
    typeof TextEncoder === "function" ? new TextEncoder().encode(code).byteLength : code.length * 2;
  if (byteLength > MAX_PROVIDER_CODE_BYTES) {
    throw new Error(`Provider module exceeds the ${MAX_PROVIDER_CODE_BYTES}-byte cap`);
  }
  provider.code = code;
  provider.installedAt = Date.now();
  provider.enabled = true;
  saveStore(store);
  return provider;
}

/** All installed (code present) + enabled providers across repositories. */
export function listActiveProviders() {
  return listProviderRepositories().flatMap((repo) =>
    (repo.providers || [])
      .filter((provider) => provider.enabled && typeof provider.code === "string" && provider.code)
      .map((provider) => ({ ...provider, repositoryId: repo.id, repositoryName: repo.name }))
  );
}
