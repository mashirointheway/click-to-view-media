// Minimal background worker: lets every content-script frame learn the
// TOP-LEVEL page key for the per-address off switch. Frames in cross-origin
// iframes can't read window.top.location, but `sender.tab.url` here can.
// Keep in sync with SITE_KEY / siteKeyFromUrl.
(() => {
  "use strict";

  const api = (typeof browser !== "undefined" && browser.runtime) ? browser : chrome;

  function keyFromUrl(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "file:") {
        return parsed.host || parsed.protocol;
      }
    } catch (_) {}
    return "";
  }

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "click-to-view-top-key") return;
    const tabUrl = sender && sender.tab && sender.tab.url ? sender.tab.url : "";
    const key = keyFromUrl(tabUrl);
    // Chrome uses a callback; Firefox uses a returned promise.
    if (api === chrome) {
      sendResponse({ key });
      return true;
    }
    return Promise.resolve({ key });
  });
})();
