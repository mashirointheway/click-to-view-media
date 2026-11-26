// Unit tests for src/shared.js.
//
// shared.js is a classic script that captures `globalThis.browser ||
// globalThis.chrome` at load time, so the fake must be installed BEFORE the
// single dynamic import below. The fake stays mutable: failure tests swap a
// method and restore it in a finally block.

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

// ---- fake browser API (installed before the import) ------------------------

const store = {};

globalThis.chrome = {
  storage: {
    local: {
      async get(defaults) {
        return { ...(defaults || {}), ...store };
      },
      async set(values) {
        Object.assign(store, values);
      },
      async remove(keys) {
        for (const key of [].concat(keys)) delete store[key];
      },
    },
    onChanged: {
      listeners: new Set(),
      addListener(fn) {
        this.listeners.add(fn);
      },
      removeListener(fn) {
        this.listeners.delete(fn);
      },
    },
  },
  runtime: {
    sendMessage: async () => ({ url: "https://example.com/page" }),
  },
};

delete globalThis.browser;
delete globalThis.CTV;
await import("../src/shared.js");

const CTV = globalThis.CTV;

// ---- helpers ---------------------------------------------------------------

function clearStore() {
  for (const key of Object.keys(store)) delete store[key];
}

function fireOnChanged(changes, area = "local") {
  for (const listener of [...globalThis.chrome.storage.onChanged.listeners]) {
    listener(changes, area);
  }
}

// No test may leave the shared on/off state set.
afterEach(() => {
  CTV.state.disabled = false;
});

// ---- tests -----------------------------------------------------------------

test("normalizeBlurPx clamps, rounds and falls back to the default", () => {
  CTV.state.disabled = false;
  assert.equal(CTV.normalizeBlurPx("not a number"), 18);
  assert.equal(CTV.normalizeBlurPx(5), 18);
  assert.equal(CTV.normalizeBlurPx(500), 100);
  assert.equal(CTV.normalizeBlurPx(42.6), 43);
  assert.equal(CTV.normalizeBlurPx("55"), 55);
  assert.equal(CTV.normalizeBlurPx(undefined), 18);
});

test("siteKeyFromUrl keys on host plus port, or protocol when hostless", () => {
  CTV.state.disabled = false;
  assert.equal(CTV.siteKeyFromUrl("https://example.com:8443/a/b"), "example.com:8443");
  assert.equal(CTV.siteKeyFromUrl("https://example.com"), "example.com");
  assert.equal(CTV.siteKeyFromUrl("file:///C:/x.html"), "file:");
  assert.equal(CTV.siteKeyFromUrl("about:blank"), "");
  assert.equal(CTV.siteKeyFromUrl("not a url"), "");
  assert.equal(CTV.siteKeyFromUrl("chrome://extensions"), "");
});

test("siteKeyForLocation prefers host, then protocol", () => {
  CTV.state.disabled = false;
  assert.equal(CTV.siteKeyForLocation({ host: "a.example:8080", protocol: "https:" }), "a.example:8080");
  assert.equal(CTV.siteKeyForLocation({ protocol: "file:" }), "file:");
  assert.equal(CTV.siteKeyForLocation(null), "");
});

test("offKey prefixes the site key", () => {
  CTV.state.disabled = false;
  assert.equal(CTV.offKey("example.com"), "off:example.com");
});

test("storage reports a local area and performs get/set/remove", async () => {
  CTV.state.disabled = false;
  clearStore();
  assert.equal(CTV.storage.available, true);
  assert.equal(CTV.storage.areaName, "local");

  const defaults = { blurPx: 18, untouched: "default" };
  assert.deepEqual(await CTV.storage.get(defaults), { blurPx: 18, untouched: "default" });

  store.blurPx = 42;
  assert.deepEqual(await CTV.storage.get(defaults), { blurPx: 42, untouched: "default" });

  assert.equal(await CTV.storage.set({ blurPx: 55, extra: 1 }), true);
  assert.equal(store.blurPx, 55);
  assert.equal(store.extra, 1);

  assert.equal(await CTV.storage.remove(["extra"]), true);
  assert.equal("extra" in store, false);
  assert.equal(store.blurPx, 55);
});

test("storage.get returns defaults when the backend throws", async () => {
  CTV.state.disabled = false;
  clearStore();
  const original = globalThis.chrome.storage.local.get;
  globalThis.chrome.storage.local.get = async () => {
    throw new Error("get failed");
  };
  try {
    const defaults = { blurPx: 18, "off:example.com": false };
    assert.deepEqual(await CTV.storage.get(defaults), defaults);
  } finally {
    globalThis.chrome.storage.local.get = original;
  }
});

test("storage.set resolves false when the backend throws", async () => {
  CTV.state.disabled = false;
  clearStore();
  const original = globalThis.chrome.storage.local.set;
  globalThis.chrome.storage.local.set = async () => {
    throw new Error("set failed");
  };
  try {
    assert.equal(await CTV.storage.set({ blurPx: 30 }), false);
  } finally {
    globalThis.chrome.storage.local.set = original;
  }
});

test("storage.onChanged forwards local changes and unsubscribes cleanly", () => {
  CTV.state.disabled = false;
  const listeners = globalThis.chrome.storage.onChanged.listeners;
  const calls = [];
  const unsubscribe = CTV.storage.onChanged(changes => calls.push(changes));
  const withOurListener = listeners.size;
  try {
    const changes = { blurPx: { newValue: 30 } };
    fireOnChanged(changes, "local");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], changes);

    fireOnChanged(changes, "sync");
    assert.equal(calls.length, 1, "a sync change must be ignored");
  } finally {
    unsubscribe();
  }
  assert.equal(listeners.size, withOurListener - 1, "unsubscribe removes the listener");
  fireOnChanged({ blurPx: { newValue: 99 } }, "local");
  assert.equal(calls.length, 1, "no callbacks after unsubscribe");
});

test("watchSiteSettings reads stored settings and follows later changes", async () => {
  CTV.state.disabled = false;
  clearStore();
  Object.assign(store, { blurPx: 42, "off:example.com": true });

  const listeners = globalThis.chrome.storage.onChanged.listeners;
  const before = new Set(listeners);
  const blurValues = [];
  const disabledValues = [];

  try {
    const watch = CTV.watchSiteSettings({
      onBlurPx: value => blurValues.push(value),
      onDisabled: value => disabledValues.push(value),
      locationLike: { host: "example.com", protocol: "https:" },
    });

    assert.equal(watch.siteKey, "example.com");
    assert.equal(watch.offKey, "off:example.com");
    await watch.ready;
    assert.deepEqual(blurValues, [42]);
    assert.deepEqual(disabledValues, [true]);

    fireOnChanged(
      { blurPx: { newValue: 55 }, "off:example.com": { newValue: false } },
      "local"
    );
    assert.deepEqual(blurValues, [42, 55]);
    assert.deepEqual(disabledValues, [true, false]);
  } finally {
    // shared.js does not expose this watcher's listener, so drop any listener
    // this test added to keep later tests independent.
    for (const listener of [...listeners]) {
      if (!before.has(listener)) listeners.delete(listener);
    }
  }
});

test("setDisabled notifies once per real change; unsubscribe stops updates", () => {
  CTV.state.disabled = false;
  clearStore();
  const seen = [];
  const unsubscribe = CTV.onDisabledChange(value => seen.push(value));
  try {
    CTV.setDisabled(true);
    assert.deepEqual(seen, [true]);
    assert.equal(CTV.state.disabled, true);

    CTV.setDisabled(true);
    assert.deepEqual(seen, [true], "repeating the same value is a no-op");

    CTV.setDisabled(false);
    assert.deepEqual(seen, [true, false]);
    assert.equal(CTV.state.disabled, false);

    unsubscribe();
    CTV.setDisabled(true);
    assert.deepEqual(seen, [true, false], "no callbacks after unsubscribe");
  } finally {
    unsubscribe();
    CTV.state.disabled = false;
  }
});

test("getTopSiteKey uses the background response", async () => {
  CTV.state.disabled = false;
  assert.equal(await CTV.getTopSiteKey(), "example.com");
});

test("log does not throw while debug is off", () => {
  CTV.state.disabled = false;
  assert.doesNotThrow(() => CTV.log("test message", { detail: 1 }));
});
