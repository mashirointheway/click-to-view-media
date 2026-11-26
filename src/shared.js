// Shared configuration, storage and event plumbing.
//
// Loaded as a classic script by the content script (before media.js and
// youtube.js) and by the popup (before popup.js). Everything hangs off a
// single global namespace so the plain-script files can share state without a
// bundler, and so a second injection of the same file is a no-op.
(() => {
  "use strict";

  const CTV = (globalThis.CTV = globalThis.CTV || {});
  if (CTV.config) return;

  // ---- configuration ------------------------------------------------------
  // One source of truth for values that used to be copied into content.js,
  // popup.js and popup.html (and could drift apart).
  const config = Object.freeze({
    DEFAULT_BLUR_PX: 18,
    MIN_BLUR_PX: 18,
    MAX_BLUR_PX: 100,
    MIN_OVERLAY_SIDE_PX: 150,
    BLUR_KEY: "blurPx",
    OFF_PREFIX: "off:",
    DEBUG_KEY: "debug"
  });
  CTV.config = config;

  CTV.normalizeBlurPx = value => {
    const number = Number(value);
    if (!Number.isFinite(number)) return config.DEFAULT_BLUR_PX;
    return Math.min(config.MAX_BLUR_PX, Math.max(config.MIN_BLUR_PX, Math.round(number)));
  };

  // The popup works from a tab URL, the content script from its own location.
  // Both must produce the same key for the same address: host plus port, or
  // the protocol for pages without a host (file://).
  CTV.siteKeyFromUrl = url => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "file:") {
        return parsed.host || parsed.protocol;
      }
    } catch (_) {
      // Not a URL we can key a setting on.
    }
    return "";
  };

  CTV.siteKeyForLocation = locationLike => {
    if (!locationLike) return "";
    return locationLike.host || locationLike.protocol || "";
  };

  CTV.offKey = siteKey => config.OFF_PREFIX + siteKey;

  // ---- logging ------------------------------------------------------------
  // Silent catches stay silent unless the user turns on debug in storage.
  let debug = false;
  CTV.log = (...args) => {
    if (debug) console.debug("[click-to-view]", ...args);
  };

  // ---- storage ------------------------------------------------------------
  // One area for both browsers. Chrome's storage.sync caps each item at 8 KB
  // (a long disabled-host list silently fails to save) and Firefox Android
  // already used local, so local is the single, predictable path.
  const api = globalThis.browser || globalThis.chrome || null;
  const area = (api && api.storage && (api.storage.local || api.storage.sync)) || null;
  const areaName = api && api.storage ? (api.storage.local ? "local" : "sync") : "";

  CTV.storage = {
    available: Boolean(area),
    areaName,

    // Always resolves: a broken storage backend must not stop the page from
    // being blurred with default settings.
    async get(defaults) {
      if (!area) return { ...defaults };
      try {
        const value = await area.get(defaults);
        return value && typeof value === "object" ? value : { ...defaults };
      } catch (error) {
        CTV.log("storage.get failed", error);
        return { ...defaults };
      }
    },

    // Resolves false when the write did not happen, so the popup can put its
    // controls back instead of showing a setting that was never saved.
    async set(values) {
      if (!area) return false;
      try {
        await area.set(values);
        return true;
      } catch (error) {
        CTV.log("storage.set failed", error);
        return false;
      }
    },

    async remove(keys) {
      if (!area) return false;
      try {
        await area.remove(keys);
        return true;
      } catch (error) {
        CTV.log("storage.remove failed", error);
        return false;
      }
    },

    onChanged(callback) {
      const onChanged = api && api.storage && api.storage.onChanged;
      if (!onChanged) return () => {};
      const listener = (changes, changedArea) => {
        if (areaName && changedArea && changedArea !== areaName) return;
        callback(changes);
      };
      onChanged.addListener(listener);
      return () => onChanged.removeListener(listener);
    }
  };

  // ---- per-site settings --------------------------------------------------
  // Reads blur and the site's off switch once, then follows storage changes.
  // `ready` settles after the first read, for callers that must wait.
  CTV.watchSiteSettings = ({ onBlurPx, onDisabled, locationLike } = {}) => {
    const siteKey = CTV.siteKeyForLocation(locationLike || globalThis.location);
    const offKey = CTV.offKey(siteKey);
    const ready = CTV.storage.get({
      [config.BLUR_KEY]: config.DEFAULT_BLUR_PX,
      [offKey]: false,
      [config.DEBUG_KEY]: false
    }).then(data => {
      debug = Boolean(data[config.DEBUG_KEY]);
      if (onBlurPx) onBlurPx(data[config.BLUR_KEY]);
      if (onDisabled) onDisabled(Boolean(data[offKey]));
      return data;
    });

    CTV.storage.onChanged(changes => {
      if (changes[config.DEBUG_KEY]) debug = Boolean(changes[config.DEBUG_KEY].newValue);
      if (changes[config.BLUR_KEY] && onBlurPx) onBlurPx(changes[config.BLUR_KEY].newValue);
      if (offKey in changes && onDisabled) onDisabled(Boolean(changes[offKey].newValue));
    });

    return { siteKey, offKey, ready };
  };

  // ---- shared state -------------------------------------------------------
  // The media engine owns the site on/off decision; the YouTube module only
  // listens, so both features stop together without either reading storage
  // twice or polling.
  CTV.state = { disabled: false };
  const disabledListeners = new Set();

  CTV.onDisabledChange = listener => {
    disabledListeners.add(listener);
    return () => disabledListeners.delete(listener);
  };

  CTV.setDisabled = value => {
    const next = Boolean(value);
    if (next === CTV.state.disabled) return;
    CTV.state.disabled = next;
    for (const listener of disabledListeners) {
      try {
        listener(next);
      } catch (error) {
        CTV.log("disabled listener failed", error);
      }
    }
  };

  // ---- top-level site key -------------------------------------------------
  // The popup toggles the address bar's site, but this script also runs in
  // iframes, which have their own host. Ask the background worker for the tab
  // URL so a frame can follow the top document's switch too.
  CTV.getTopSiteKey = () =>
    new Promise(resolve => {
      if (!api || !api.runtime || !api.runtime.sendMessage) {
        resolve("");
        return;
      }
      try {
        const result = api.runtime.sendMessage({ type: "ctv:top-url" });
        if (result && typeof result.then === "function") {
          result.then(
            response => resolve(response && response.url ? CTV.siteKeyFromUrl(response.url) : ""),
            () => resolve("")
          );
        } else {
          resolve("");
        }
      } catch (error) {
        CTV.log("top-url lookup failed", error);
        resolve("");
      }
    });
})();
