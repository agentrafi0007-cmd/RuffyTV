/**
 * LocalStore — synchronous key/value store with the same API everywhere.
 *
 * API (unchanged for all 83+ importers):
 *   get(key, defaultValue = null), set(key, value), remove(key), clear()
 *   ready() -> Promise, resolved once durable storage is hydrated.
 *
 * Platforms:
 * - webOS: the sync read path is an in-memory Map cache; writes update the
 *   cache immediately and persist to db8 (com.webos.service.db) fire-and-
 *   forget (errors logged, never thrown). localStorage is kept as a secondary
 *   mirror / safe fallback. On boot, ready() registers the db8 kind,
 *   hydrates the cache from db8, and — first-run migration (tracked by a
 *   marker object in db8, so it runs exactly once) — copies every legacy
 *   localStorage key into db8 (localStorage is NOT deleted).
 * - everywhere else (browser/Tizen dev): pure localStorage, exactly as before.
 *
 * Boot: bootstrapApp() awaits LocalStore.ready() before any LocalStore.get
 * runs. ready() never rejects — any db8 failure falls back to localStorage
 * with a console warning so storage can never crash boot.
 */

import { Platform } from "../../platform/index.js";
import { db8EnsureKind, db8GetAll, db8Remove, db8Set } from "../../platform/webos/webosDb8Store.js";

const cache = new Map();
// Keys written via set/remove/clear since module load. ready() hydration
// must not overwrite these with stale db8/localStorage values (e.g. app.js
// calls LocalStore.remove() at import time, before ready() runs).
const touchedKeys = new Set();
// Marker object stored in db8 once the first-run localStorage migration has
// run. A plain "db8 is empty" check is racy: a set() issued before ready()
// can land its put before hydration's getAll, which would otherwise skip
// migration of legacy localStorage keys entirely.
const MIGRATION_MARKER_KEY = "__nuvio_localstorage_migrated_v1";
let readyPromise = null;

function usesDb8() {
  return Platform.isWebOS();
}

function warnDb8Write(operation, key, error) {
  console.warn(
    `LocalStore: db8 ${operation} failed for key "${key}", ` + `localStorage fallback in use:`,
    error?.errorText || error?.message || error
  );
}

function readLocalStorage(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw !== null ? JSON.parse(raw) : undefined;
  } catch (_) {
    return undefined;
  }
}

function writeLocalStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.error("LocalStore set error:", e);
  }
}

function readAllLocalStorage() {
  const entries = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key === null) continue;
      entries.push({ key, value: readLocalStorage(key) });
    }
  } catch (e) {
    console.warn("LocalStore: localStorage enumeration failed:", e);
  }
  return entries;
}

export const LocalStore = {
  get(key, defaultValue = null) {
    if (usesDb8()) {
      return cache.has(key) ? cache.get(key) : defaultValue;
    }
    try {
      const value = localStorage.getItem(key);
      return value !== null ? JSON.parse(value) : defaultValue;
    } catch (e) {
      console.error("LocalStore get error:", e);
      return defaultValue;
    }
  },

  set(key, value) {
    if (usesDb8()) {
      cache.set(key, value);
      touchedKeys.add(key);
      // localStorage mirror: safe fallback if db8 is down; also keeps the
      // value readable before ready() resolves.
      writeLocalStorage(key, value);
      db8Set(key, value).catch((error) => warnDb8Write("set", key, error));
      return;
    }
    writeLocalStorage(key, value);
  },

  remove(key) {
    if (usesDb8()) {
      cache.delete(key);
      touchedKeys.add(key);
      try {
        localStorage.removeItem(key);
      } catch (_) {
        // Ignore: removal from the cache + db8 is what matters.
      }
      db8Remove(key).catch((error) => warnDb8Write("remove", key, error));
      return;
    }
    localStorage.removeItem(key);
  },

  clear() {
    if (usesDb8()) {
      for (const key of cache.keys()) touchedKeys.add(key);
      cache.clear();
      try {
        localStorage.clear();
      } catch (_) {
        // Ignore: removal from the cache + db8 is what matters.
      }
      db8GetAll()
        .then((entries) => Promise.allSettled(entries.map((entry) => db8Remove(entry.key))))
        .catch((error) => warnDb8Write("clear", "<all>", error));
      return;
    }
    localStorage.clear();
  },

  /**
   * Hydrate the cache on webOS (db8 kind registration + read + first-run
   * localStorage migration). No-op off webOS. Never rejects.
   */
  ready() {
    if (!readyPromise) {
      readyPromise = hydrate().catch((error) => {
        // hydrate() already falls back to localStorage internally; this is a
        // final guard so a db8 failure can never crash boot.
        console.warn(
          "LocalStore: storage hydration failed, using localStorage fallback:",
          error?.message || error
        );
      });
    }
    return readyPromise;
  }
};

async function hydrate() {
  if (!usesDb8()) {
    return;
  }
  try {
    await db8EnsureKind();
    const entries = await db8GetAll();
    const db8Keys = new Set();
    for (const entry of entries) {
      db8Keys.add(entry.key);
      if (!touchedKeys.has(entry.key)) {
        cache.set(entry.key, entry.value);
      }
    }
    if (!db8Keys.has(MIGRATION_MARKER_KEY)) {
      await migrateLocalStorageToDb8(db8Keys);
    }
  } catch (error) {
    console.warn(
      "LocalStore: db8 unavailable, falling back to localStorage:",
      error?.errorText || error?.message || error
    );
    // Fallback: seed the cache from localStorage so sync reads keep working.
    for (const entry of readAllLocalStorage()) {
      if (!touchedKeys.has(entry.key) && !cache.has(entry.key)) {
        cache.set(entry.key, entry.value);
      }
    }
  }
}

/**
 * First-run migration: copy every legacy localStorage key into db8 (except
 * keys already in db8 and keys written since module load, which are already
 * on their way via set()). localStorage is kept as-is as a safe fallback.
 * A marker object is written last so this runs exactly once.
 */
async function migrateLocalStorageToDb8(db8Keys) {
  const writes = [];
  for (const entry of readAllLocalStorage()) {
    if (entry.key === MIGRATION_MARKER_KEY) continue;
    if (touchedKeys.has(entry.key) || db8Keys.has(entry.key)) continue;
    cache.set(entry.key, entry.value);
    writes.push(
      db8Set(entry.key, entry.value).catch((error) => warnDb8Write("migrate", entry.key, error))
    );
  }
  writes.push(
    db8Set(MIGRATION_MARKER_KEY, { migrated: true, at: Date.now() }).catch((error) =>
      warnDb8Write("migrate", MIGRATION_MARKER_KEY, error)
    )
  );
  if (writes.length > 1) {
    console.info(`LocalStore: migrating ${writes.length - 1} localStorage key(s) to db8`);
  }
  await Promise.allSettled(writes);
}
