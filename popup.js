(() => {
  "use strict";

  const DEFAULT_BLUR_PX = 18;
  const MIN_BLUR_PX = 18;
  const MAX_BLUR_PX = 100;
  const slider = document.getElementById("blur");
  const valueLabel = document.getElementById("blur-value");
  const resetButton = document.getElementById("reset");
  const siteToggle = document.getElementById("site-toggle");
  const siteHint = document.getElementById("site-hint");
  let saveTimer = null;

  const isFirefoxApi = typeof browser !== "undefined" && !!browser.runtime;
  const extensionApi = isFirefoxApi
    ? browser
    : (typeof chrome !== "undefined" && chrome.storage ? chrome : null);
  let storageArea = null;
  if (extensionApi && extensionApi.storage) {
    if (isFirefoxApi) {
      storageArea = extensionApi.storage.local || extensionApi.storage.sync;
    } else {
      storageArea = extensionApi.storage.sync || extensionApi.storage.local;
    }
  }

  function normalizeBlurPx(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return DEFAULT_BLUR_PX;
    return Math.min(MAX_BLUR_PX, Math.max(MIN_BLUR_PX, Math.round(number)));
  }

  function render(value) {
    const px = normalizeBlurPx(value);
    slider.value = String(px);
    valueLabel.textContent = `${px}px`;
  }

  function storageGet(defaults) {
    if (!storageArea) return Promise.resolve(defaults);
    return new Promise(resolve => {
      let settled = false;
      const done = value => {
        if (settled) return;
        settled = true;
        resolve(value || defaults);
      };
      try {
        if (isFirefoxApi) {
          storageArea.get(defaults).then(done, () => done(defaults));
        } else {
          storageArea.get(defaults, done);
        }
      } catch (_) {
        done(defaults);
      }
    });
  }

  function storageSet(value) {
    if (!storageArea) return Promise.resolve(false);
    try {
      if (isFirefoxApi) return storageArea.set(value).then(() => true, () => false);
      return new Promise(resolve => {
        try {
          storageArea.set(value, () => {
            const ok = !(extensionApi && extensionApi.runtime && extensionApi.runtime.lastError);
            resolve(ok);
          });
        } catch (_) { resolve(false); }
      });
    } catch (_) { return Promise.resolve(false); }
  }

  function save(value) {
    storageSet({ blurPx: normalizeBlurPx(value) });
  }

  let disabledHosts = [];
  let siteKey = "";
  let storageLoaded = false;

  // Matches SITE_KEY in content.js: host (hostname plus port) for web pages,
  // the protocol for anything without a host such as file:// URLs.
  function siteKeyFromUrl(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "file:") {
        return parsed.host || parsed.protocol;
      }
    } catch (_) {}
    return "";
  }

  function renderSite() {
    const disabledHere = !!siteKey && disabledHosts.includes(siteKey);
    siteToggle.disabled = !siteKey || !storageLoaded;
    siteToggle.setAttribute("aria-pressed", String(disabledHere));
    siteToggle.textContent = !siteKey
      ? "Not available on this page"
      : (disabledHere ? "Enable on this site" : "Disable on this site");
    siteHint.textContent = !storageLoaded
      ? "Checking this page…"
      : (!siteKey
        ? "Open a web page to use this setting."
        : (disabledHere ? `Blur is off on ${siteKey}.` : `Blur is on for ${siteKey}.`));
  }

  function getActiveTab() {
    if (!extensionApi || !extensionApi.tabs) return Promise.resolve(null);
    return new Promise(resolve => {
      try {
        if (isFirefoxApi) {
          extensionApi.tabs.query({ active: true, currentWindow: true })
            .then(tabs => resolve((tabs && tabs[0]) || null), () => resolve(null));
        } else {
          extensionApi.tabs.query({ active: true, currentWindow: true }, tabs => {
            // Reading lastError keeps Chrome from logging an unchecked error
            // when the active page is not accessible (for example chrome://).
            if (extensionApi.runtime && extensionApi.runtime.lastError) {
              resolve(null);
              return;
            }
            resolve((tabs && tabs[0]) || null);
          });
        }
      } catch (_) {
        resolve(null);
      }
    });
  }

  storageGet({ blurPx: DEFAULT_BLUR_PX, disabledHosts: [] }).then(data => {
    render(data.blurPx);
    disabledHosts = Array.isArray(data.disabledHosts) ? data.disabledHosts.slice() : [];
    storageLoaded = true;
    renderSite();
  });

  getActiveTab().then(tab => {
    siteKey = tab && tab.url ? siteKeyFromUrl(tab.url) : "";
    renderSite();
  });

  siteToggle.addEventListener("click", () => {
    if (!siteKey || !storageLoaded) return;
    const next = disabledHosts.includes(siteKey)
      ? disabledHosts.filter(host => host !== siteKey)
      : disabledHosts.concat(siteKey);
    disabledHosts = next;
    renderSite();
    storageSet({ disabledHosts: next }).then(ok => {
      if (ok) return;
      // Persistence failed; re-read storage so the UI matches what's saved.
      storageGet({ disabledHosts: [] }).then(data => {
        disabledHosts = Array.isArray(data.disabledHosts) ? data.disabledHosts.slice() : [];
        renderSite();
      });
    });
  });

  slider.addEventListener("input", () => {
    const px = normalizeBlurPx(slider.value);
    render(px);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save(px), 150);
  });

  slider.addEventListener("change", () => {
    clearTimeout(saveTimer);
    save(Number(slider.value));
  });

  resetButton.addEventListener("click", () => {
    clearTimeout(saveTimer);
    render(DEFAULT_BLUR_PX);
    save(DEFAULT_BLUR_PX);
  });
})();
