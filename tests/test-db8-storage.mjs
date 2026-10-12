/**
 * Unit tests for the db8 persistence migration (Task A).
 *
 * Run: node ./tests/test-db8-storage.mjs
 *
 * Since there is no real webOS TV here, globalThis.webOS.service.request is
 * replaced with an in-memory mock of com.webos.service.db (putKind/put/
 * find/del semantics), and globalThis.localStorage is shimmed. Each scenario
 * imports the modules fresh via a cache-busting query string so singleton
 * state (LocalStore cache, Platform detection) is isolated.
 *
 * Scenarios:
 *  A. db8 client: ensureKind idempotency, set/get/remove, upsert-without-
 *     duplicates, getAll.
 *  B. LocalStore on webOS: ready() hydrates from db8; first-run migration
 *     copies legacy localStorage keys into db8 (localStorage kept);
 *     write-through (set/remove/clear) hits cache + db8 + localStorage
 *     mirror; writes issued before ready() are not clobbered by hydration.
 *  C. Total db8 failure: ready() still resolves, falls back to localStorage.
 *  D. Browser (non-webOS): pure-localStorage behavior, byte-for-byte the old
 *     semantics (JSON round-trip, defaultValue, corrupt JSON -> default).
 *  E. providerRepository uses LocalStore (no raw localStorage): full
 *     add/install/enable/remove round trip persists under the same STORE_KEY.
 */

import assert from "node:assert/strict";

const REPO = new URL("..", import.meta.url).href;
let failures = 0;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  PASS ${name}`))
    .catch((error) => {
      failures++;
      console.error(`  FAIL ${name}\n       ${error.stack || error}`);
    });
}

function installLocalStorageShim() {
  const map = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: {
      getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
      setItem: (k, v) => void map.set(String(k), String(v)),
      removeItem: (k) => void map.delete(String(k)),
      clear: () => void map.clear(),
      key: (i) => [...map.keys()][i] ?? null,
      get length() {
        return map.size;
      }
    }
  });
  return map;
}

function simulateWebOS() {
  globalThis.PalmSystem = {};
  globalThis.webOSSystem = {};
}

function simulateBrowser() {
  delete globalThis.PalmSystem;
  delete globalThis.webOSSystem;
  delete globalThis.webOS;
}

/** In-memory mock of luna://com.webos.service.db */
function createDb8Mock({ failAll = false } = {}) {
  const state = { kinds: new Set(), objects: [], nextId: 1 };
  const calls = [];
  function request(serviceUrl, opts = {}) {
    calls.push({ serviceUrl, method: opts.method });
    const handle = { cancel() {} };
    queueMicrotask(() => {
      if (failAll) {
        opts.onFailure?.({ returnValue: false, errorText: "mock luna failure" });
        return;
      }
      const { method, parameters } = opts;
      const ok = (payload) => opts.onSuccess?.({ returnValue: true, ...payload });
      const fail = (errorText) => opts.onFailure?.({ returnValue: false, errorText });
      if (method === "putKind") {
        if (state.kinds.has(parameters.id)) return fail("kind already exists");
        state.kinds.add(parameters.id);
        return ok();
      }
      if (method === "put") {
        const ids = [];
        for (const obj of parameters.objects || []) {
          const existing = obj._id
            ? state.objects.find((o) => o._id === obj._id)
            : state.objects.find((o) => o._kind === obj._kind && o.key === obj.key);
          if (existing) Object.assign(existing, obj);
          else {
            const created = { ...obj, _id: `mock_${state.nextId++}` };
            state.objects.push(created);
            ids.push(created._id);
          }
        }
        return ok({ ids });
      }
      if (method === "find") {
        const where = parameters?.query?.where;
        const results = where
          ? state.objects.filter((o) =>
              where.every((w) => (w.op === "=" ? o[w.prop] === w.val : true))
            )
          : [...state.objects];
        return ok({ results });
      }
      if (method === "del") {
        const where = parameters?.query?.where || [];
        state.objects = state.objects.filter(
          (o) => !where.every((w) => (w.op === "=" ? o[w.prop] === w.val : true))
        );
        return ok();
      }
      return fail(`unknown method ${method}`);
    });
    return handle;
  }
  return { state, calls, request };
}

function installLunaMock(mock) {
  globalThis.webOS = { service: { request: mock.request } };
}

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- Scenario A
console.log("A. db8 client (mocked Luna)");
await check("ensureKind registers, second call is a benign no-op", async () => {
  simulateWebOS();
  installLunaMock(createDb8Mock());
  const db8 = await import(`${REPO}js/platform/webos/webosDb8Store.js?scenario=a1`);
  const first = await db8.db8EnsureKind();
  assert.equal(first.returnValue, true);
  const second = await db8.db8EnsureKind(); // "already registered" path
  assert.equal(second, null);
});

await check("set/get/remove round trip + upsert keeps one object per key", async () => {
  const mock = createDb8Mock();
  simulateWebOS();
  installLunaMock(mock);
  const db8 = await import(`${REPO}js/platform/webos/webosDb8Store.js?scenario=a2`);
  await db8.db8EnsureKind();
  assert.equal(await db8.db8Get("missing"), null);
  await db8.db8Set("k1", { n: 1, s: "x" });
  assert.deepEqual(await db8.db8Get("k1"), { n: 1, s: "x" });
  await db8.db8Set("k1", { n: 2 });
  assert.deepEqual(await db8.db8Get("k1"), { n: 2 });
  assert.equal(
    mock.state.objects.filter((o) => o.key === "k1").length,
    1,
    "upsert must not duplicate"
  );
  await db8.db8Set("k2", [1, 2, 3]);
  const all = await db8.db8GetAll();
  assert.deepEqual(
    all.sort((a, b) => (a.key < b.key ? -1 : 1)),
    [
      { key: "k1", value: { n: 2 } },
      { key: "k2", value: [1, 2, 3] }
    ]
  );
  await db8.db8Remove("k1");
  assert.equal(await db8.db8Get("k1"), null);
  assert.equal(mock.state.objects.length, 1);
});

await check("client throws a clear error when Luna is unavailable", async () => {
  simulateBrowser();
  const db8 = await import(`${REPO}js/platform/webos/webosDb8Store.js?scenario=a3`);
  await assert.rejects(() => db8.db8Get("k"), /Luna service unavailable/);
});

// ---------------------------------------------------------------- Scenario B
console.log("B. LocalStore on webOS: hydrate + migration + write-through");
await check(
  "ready() migrates legacy localStorage keys into db8 and keeps localStorage",
  async () => {
    const ls = installLocalStorageShim();
    ls.set("legacy.settings", JSON.stringify({ theme: "dark" }));
    ls.set("legacy.counter", "42");
    const mock = createDb8Mock();
    simulateWebOS();
    installLunaMock(mock);
    const { LocalStore } = await import(`${REPO}js/core/storage/localStore.js?scenario=b1`);
    // Write issued before ready(): must survive hydration, not be clobbered.
    LocalStore.set("early.write", "early-value");
    await LocalStore.ready();
    assert.deepEqual(LocalStore.get("legacy.settings"), { theme: "dark" });
    assert.equal(LocalStore.get("legacy.counter"), 42);
    assert.equal(LocalStore.get("early.write"), "early-value");
    assert.equal(LocalStore.get("nope", "dflt"), "dflt");
    await tick();
    // Migration landed in db8...
    const db8 = await import(`${REPO}js/platform/webos/webosDb8Store.js?scenario=b1reader`);
    const all = await db8.db8GetAll();
    const keys = all.map((e) => e.key).sort();
    assert.ok(keys.includes("legacy.settings"), `db8 keys: ${keys}`);
    assert.ok(keys.includes("legacy.counter"), `db8 keys: ${keys}`);
    assert.ok(keys.includes("early.write"), `db8 keys: ${keys}`);
    // ...but localStorage was NOT deleted (safe fallback).
    assert.notEqual(ls.get("legacy.settings"), null);
    assert.notEqual(ls.get("legacy.counter"), null);
    // Migration marker landed in db8 exactly once.
    assert.equal(all.filter((e) => e.key === "__nuvio_localstorage_migrated_v1").length, 1);
  }
);

await check("set/remove/clear write through to cache, db8 and localStorage mirror", async () => {
  const ls = installLocalStorageShim();
  const mock = createDb8Mock();
  simulateWebOS();
  installLunaMock(mock);
  const { LocalStore } = await import(`${REPO}js/core/storage/localStore.js?scenario=b2`);
  await LocalStore.ready();
  LocalStore.set("wt.key", { a: [1] });
  assert.deepEqual(LocalStore.get("wt.key"), { a: [1] }, "sync read hits cache immediately");
  await tick();
  const db8 = await import(`${REPO}js/platform/webos/webosDb8Store.js?scenario=b2reader`);
  assert.deepEqual(await db8.db8Get("wt.key"), { a: [1] }, "db8 persisted");
  assert.equal(ls.get("wt.key"), JSON.stringify({ a: [1] }), "localStorage mirror written");
  LocalStore.remove("wt.key");
  assert.equal(LocalStore.get("wt.key"), null);
  await tick();
  assert.equal(await db8.db8Get("wt.key"), null, "db8 removal persisted");
  assert.equal(localStorage.getItem("wt.key"), null, "localStorage mirror removed");
  LocalStore.set("wt.a", 1);
  LocalStore.set("wt.b", 2);
  await tick();
  LocalStore.clear();
  await tick(50);
  assert.deepEqual(await db8.db8GetAll(), [], "db8 cleared");
  assert.equal(LocalStore.get("wt.a", "x"), "x");
});

// ---------------------------------------------------------------- Scenario C
console.log("C. db8 total failure: boot never crashes, localStorage fallback");
await check("ready() resolves and reads fall back to localStorage", async () => {
  const ls = installLocalStorageShim();
  ls.set("fallback.key", JSON.stringify({ ok: true }));
  simulateWebOS();
  installLunaMock(createDb8Mock({ failAll: true }));
  const { LocalStore } = await import(`${REPO}js/core/storage/localStore.js?scenario=c1`);
  await LocalStore.ready(); // must not throw
  assert.deepEqual(LocalStore.get("fallback.key"), { ok: true });
  LocalStore.set("fallback.new", 7);
  assert.equal(LocalStore.get("fallback.new"), 7);
  assert.equal(ls.get("fallback.new"), "7");
});

// ---------------------------------------------------------------- Scenario D
console.log("D. browser mode: pure localStorage, old semantics preserved");
await check("get/set/remove/clear behave exactly as before", async () => {
  installLocalStorageShim();
  simulateBrowser();
  const { LocalStore } = await import(`${REPO}js/core/storage/localStore.js?scenario=d1`);
  await LocalStore.ready(); // no-op off webOS
  assert.equal(LocalStore.get("absent"), null);
  assert.equal(LocalStore.get("absent", "d"), "d");
  LocalStore.set("obj", { x: [1, 2] });
  assert.deepEqual(LocalStore.get("obj"), { x: [1, 2] });
  LocalStore.set("n", 5);
  assert.equal(LocalStore.get("n"), 5);
  localStorage.setItem("corrupt", "{not json");
  assert.equal(LocalStore.get("corrupt", "dflt"), "dflt", "corrupt JSON -> defaultValue");
  LocalStore.remove("n");
  assert.equal(LocalStore.get("n"), null);
  LocalStore.clear();
  assert.equal(LocalStore.get("obj"), null);
});

// ---------------------------------------------------------------- Scenario E
console.log("E. providerRepository persists through LocalStore (no raw localStorage)");
await check("add/list/install/enable round trip under the same STORE_KEY", async () => {
  const ls = installLocalStorageShim();
  simulateBrowser(); // exercises the localStorage-backed path of LocalStore
  const repo = await import(`${REPO}js/core/providers/providerRepository.js?scenario=e1`);
  assert.deepEqual(repo.listProviderRepositories(), []);
  const doc = {
    type: "PROVIDER_JS",
    name: "Test Repo",
    providers: [{ name: "P1", author: "A", version: "1.0.0", url: "https://example.com/p1.js" }]
  };
  const normalized = repo.normalizeProviderRepo(doc, "https://example.com/repo.json");
  assert.ok(normalized, "repo doc normalizes");
  repo.addProviderRepository(normalized);
  assert.equal(repo.listProviderRepositories().length, 1);
  const [entry] = repo.listProviderRepositories();
  const [provider] = entry.providers;
  await repo.installProvider(entry.id, provider.id, async () => "console.log('p1');");
  const active = repo.listActiveProviders();
  assert.equal(active.length, 1);
  assert.equal(active[0].code, "console.log('p1');");
  assert.ok(repo.setProviderEnabled(entry.id, provider.id, false));
  assert.deepEqual(repo.listActiveProviders(), []);
  assert.notEqual(ls.get("nuvio.providerRepositories.v1"), null, "same STORE_KEY persisted");
  repo.removeProviderRepository(entry.id);
  assert.deepEqual(repo.listProviderRepositories(), []);
});

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
