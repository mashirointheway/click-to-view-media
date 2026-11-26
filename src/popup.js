// Popup controls for blur intensity and the per-site on/off switch.
// src/shared.js is loaded first and owns the config and storage adapter.
(() => {
  "use strict";

  const CTV = globalThis.CTV;
  if (!CTV) return;

  const { config, normalizeBlurPx, siteKeyFromUrl, offKey, storage } = CTV;
  const api = globalThis.browser || globalThis.chrome || null;

  const slider = document.getElementById("blur");
  const valueLabel = document.getElementById("blur-value");
  const blurHint = document.getElementById("blur-hint");
  const saveStatus = document.getElementById("save-status");
  const resetButton = document.getElementById("reset");
  const siteEnabled = document.getElementById("site-enabled");
  const siteHint = document.getElementById("site-hint");
  if (!slider || !valueLabel || !blurHint || !saveStatus || !resetButton || !siteEnabled || !siteHint) return;

  let saveTimer = null;
  let siteKey = "";
  let disabled = false; // Off for this site; the switch is checked when blur is on.

  function render(value) {
    const px = normalizeBlurPx(value);
    slider.value = String(px);
    valueLabel.textContent = `${px}px`;
  }

  function showSaveError(message) {
    saveStatus.textContent = message;
    saveStatus.hidden = false;
  }

  function hideSaveStatus() {
    saveStatus.hidden = true;
    saveStatus.textContent = "";
  }

  // All bounds and fixed copy come from config, so the HTML has no blur numbers.
  slider.min = String(config.MIN_BLUR_PX);
  slider.max = String(config.MAX_BLUR_PX);
  slider.step = "1";
  blurHint.textContent = `Minimum is ${config.MIN_BLUR_PX}px. Higher values hide more detail.`;
  resetButton.textContent = `Reset to ${config.DEFAULT_BLUR_PX}px`;
  render(config.DEFAULT_BLUR_PX); // Never show an empty slider while settings load.

  function renderSite() {
    siteEnabled.disabled = !siteKey || !storage.available;
    siteEnabled.checked = !disabled; // checked = blur on for this site
    siteHint.textContent = !siteKey
      ? "Open a web page to use this setting."
      : (disabled ? `Blur is off on ${siteKey}.` : `Blur is on for ${siteKey}.`);
  }

  // Awaiting tabs.query works in Firefox and in Chrome MV3; any failure just
  // means there is no site to key a setting on.
  async function getActiveTab() {
    if (!api || !api.tabs || !api.tabs.query) return null;
    try {
      const tabs = await api.tabs.query({ active: true, currentWindow: true });
      return (tabs && tabs[0]) || null;
    } catch (_) {
      return null;
    }
  }

  async function save(px) {
    const value = normalizeBlurPx(px);
    const ok = await storage.set({ [config.BLUR_KEY]: value });
    if (!ok) {
      // Failure handling: keep the chosen slider position, but say plainly
      // that it was not saved and leave a debug trace when debug is enabled.
      showSaveError("Could not save the blur setting. Try again.");
      CTV.log("blur setting save failed", value);
      return;
    }
    hideSaveStatus();
  }

  // One read after the site key is known: blur plus this site's off marker.
  (async () => {
    const tab = await getActiveTab();
    siteKey = tab && tab.url ? siteKeyFromUrl(tab.url) : "";

    const defaults = { [config.BLUR_KEY]: config.DEFAULT_BLUR_PX };
    if (siteKey) defaults[offKey(siteKey)] = false;
    const data = await storage.get(defaults);
    render(data[config.BLUR_KEY]);
    disabled = siteKey ? Boolean(data[offKey(siteKey)]) : false;
    renderSite();
  })();

  siteEnabled.addEventListener("change", async () => {
    if (!siteKey || !storage.available) return;

    // checked = blur on: remove the off marker to enable, write true to disable.
    const enabled = siteEnabled.checked;
    const key = offKey(siteKey);
    const ok = enabled
      ? await storage.remove([key])
      : await storage.set({ [key]: true });

    if (!ok) {
      // Revert the control so the UI never claims a setting that was not saved.
      siteEnabled.checked = !enabled;
      showSaveError("Could not save this setting. Try again.");
      CTV.log("site switch save failed", { siteKey, enabled });
      return;
    }

    disabled = !enabled;
    hideSaveStatus();
    renderSite();
  });

  slider.addEventListener("input", () => {
    const px = normalizeBlurPx(slider.value);
    render(px);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { save(px); }, 150);
  });

  slider.addEventListener("change", () => {
    clearTimeout(saveTimer);
    save(Number(slider.value)); // Fire and forget: the UI never waits on storage.
  });

  resetButton.addEventListener("click", () => {
    clearTimeout(saveTimer);
    render(config.DEFAULT_BLUR_PX);
    save(config.DEFAULT_BLUR_PX);
  });
})();
