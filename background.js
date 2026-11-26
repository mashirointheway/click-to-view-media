// MV3 background worker: content scripts in frames ask for the tab's top-level
// URL so they can follow the address bar's per-site switch. Host permissions
// let this read sender.tab.url, so the answer is available synchronously.
(() => {
  "use strict";

  const api = globalThis.browser || globalThis.chrome;
  if (!api || !api.runtime || !api.runtime.onMessage) return;

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "ctv:top-url") return;
    sendResponse({ url: (sender.tab && sender.tab.url) || null });
  });
})();
