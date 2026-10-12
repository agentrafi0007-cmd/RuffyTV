/**
 * webOS db8 persistence client (`com.webos.service.db`).
 *
 * On webOS TV, localStorage is wiped when the app updates; the Luna db8
 * database survives updates, so all durable app state should live here.
 * Every call goes through WebOsLunaService.request (Promise-based) and is
 * guarded by WebOsLunaService.isAvailable() so this module is safe to import
 * (and call) on non-webOS platforms — the guards throw a clear error there
 * instead of hanging on a missing Luna bridge.
 *
 * Schema: one kind, one object per key:
 *   kind:    "com.ruffytv.webos.store:1"  (owner: "com.ruffytv.webos")
 *   objects: { _kind, key, value: <JSON string>, updated: <epoch ms> }
 */

import { WebOsLunaService } from "./webosLunaService.js";

const DB_SERVICE = "luna://com.webos.service.db";
const STORE_KIND = "com.ruffytv.webos.store:1";
const STORE_OWNER = "com.ruffytv.webos";

function serialize(value) {
  try {
    const json = JSON.stringify(value === undefined ? null : value);
    return typeof json === "string" ? json : "null";
  } catch (_) {
    return "null";
  }
}

function deserialize(raw) {
  if (raw === undefined || raw === null) return null;
  try {
    return JSON.parse(String(raw));
  } catch (_) {
    return null;
  }
}

function ensureLunaAvailable() {
  if (!WebOsLunaService.isAvailable()) {
    throw new Error("webosDb8Store: Luna service unavailable (not running on webOS)");
  }
}

function checkReturnValue(payload, method) {
  if (!payload || payload.returnValue === false) {
    const error = new Error(
      `webosDb8Store: db8 ${method} failed: ${payload?.errorText || "unknown error"}`
    );
    error.cause = payload;
    throw error;
  }
  return payload;
}

/**
 * Register the store kind. Idempotent — an already-registered kind is a
 * benign warning, never an error.
 */
export async function db8EnsureKind() {
  ensureLunaAvailable();
  try {
    const payload = await WebOsLunaService.request(DB_SERVICE, {
      method: "putKind",
      parameters: {
        id: STORE_KIND,
        owner: STORE_OWNER,
        indexes: [{ name: "key", props: [{ name: "key" }] }]
      }
    });
    return checkReturnValue(payload, "putKind");
  } catch (error) {
    // putKind is called on every boot; "kind already exists" (and any other
    // putKind-level rejection) must not fail startup.
    console.warn("webosDb8Store: putKind ignored:", error?.errorText || error?.message || error);
    return null;
  }
}

async function findObjectsByKey(key) {
  const payload = await WebOsLunaService.request(DB_SERVICE, {
    method: "find",
    parameters: {
      query: {
        from: STORE_KIND,
        where: [{ prop: "key", op: "=", val: key }]
      }
    }
  });
  checkReturnValue(payload, "find");
  return Array.isArray(payload.results) ? payload.results : [];
}

/**
 * Read one key. Resolves to the parsed value, or null when absent.
 */
export async function db8Get(key) {
  ensureLunaAvailable();
  const results = await findObjectsByKey(key);
  const first = results[0];
  return first ? deserialize(first.value) : null;
}

/**
 * Upsert one key/value. Finds the existing object first so `put` reuses its
 * `_id` (true upsert, no duplicates).
 */
export async function db8Set(key, value) {
  ensureLunaAvailable();
  const results = await findObjectsByKey(key);
  const object = {
    _kind: STORE_KIND,
    key,
    value: serialize(value),
    updated: Date.now()
  };
  if (results[0] && results[0]._id) {
    object._id = results[0]._id;
  }
  const payload = await WebOsLunaService.request(DB_SERVICE, {
    method: "put",
    parameters: { objects: [object] }
  });
  return checkReturnValue(payload, "put");
}

/**
 * Delete every object for one key.
 */
export async function db8Remove(key) {
  ensureLunaAvailable();
  const payload = await WebOsLunaService.request(DB_SERVICE, {
    method: "del",
    parameters: {
      query: {
        from: STORE_KIND,
        where: [{ prop: "key", op: "=", val: key }]
      }
    }
  });
  return checkReturnValue(payload, "del");
}

/**
 * Read every stored key/value. Used for boot hydration and first-run
 * localStorage migration. Resolves to [{ key, value }, ...] (values parsed).
 */
export async function db8GetAll() {
  ensureLunaAvailable();
  const payload = await WebOsLunaService.request(DB_SERVICE, {
    method: "find",
    parameters: { query: { from: STORE_KIND } }
  });
  checkReturnValue(payload, "find");
  const results = Array.isArray(payload.results) ? payload.results : [];
  return results
    .filter((object) => object && typeof object.key === "string")
    .map((object) => ({ key: object.key, value: deserialize(object.value) }));
}
