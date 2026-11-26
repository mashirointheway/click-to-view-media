(() => {
  "use strict";

  const MARK = "data-click-to-view-media";
  const STYLE_ID = "click-to-view-media-style";
  const REVEALED = "data-click-to-view-revealed";
  const BG_MARK = "data-click-to-view-bg";
  const OVERLAY_ATTR = "data-click-to-view-overlay";

  // Large media gets a translucent "Click to view" button on top. Pages such as
  // Instagram posts with tagged accounts paint their own controls over the
  // media, so a click never reaches the blurred element itself.
  const MIN_OVERLAY_SIDE_PX = 150;

  // Per-address off switch. The popup writes the same list of hosts to storage.
  const SITE_KEY = location.host || location.protocol;

  const MEDIA_SELECTOR = "img, video, input[type='image'], image";
  const BG_TAGS = new Set([
    "div", "span", "header", "section", "article", "li", "td", "th", "figure"
  ]);
  // Elements that are likely to use a CSS background image. Only these are
  // checked with getComputedStyle so we don't walk the whole page's styles.
  const EMOTE_HINT_SELECTOR = [
    '[class*="emote" i]',
    '[class*="emoji" i]',
    '[alt*="emote" i]',
    '[alt*="emoji" i]'
  ].join(", ");

  // Controls whose clicks should still reach the page once their media is
  // revealed, so an image used as a button can actually be used.
  const INTERACTIVE_SELECTOR = [
    "a[href]",
    "button",
    "input",
    "select",
    "textarea",
    "summary",
    "label",
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="tab"]',
    "[onclick]"
  ].join(", ");

  const BG_CANDIDATE_SELECTOR = [
    '[style*="background-image"]',
    '[data-testid*="avatar" i]',
    '[data-testid*="banner" i]',
    '[data-testid*="profile" i]',
    '[class*="avatar" i]',
    '[class*="banner" i]',
    '[class*="profile" i]',
    '[class*="photo" i]',
    '[class*="thumb" i]',
    '[class*="image" i]',
    EMOTE_HINT_SELECTOR,
    '[role="img"]'
  ].join(", ");

  const savedStyles = new WeakMap();
  const savedTitles = new WeakMap();
  const revealedByOverlay = new Set();

  const DEFAULT_BLUR_PX = 18;
  const MIN_BLUR_PX = 18;
  const MAX_BLUR_PX = 100;

  let disabled = false;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    :root { --click-to-view-blur: ${DEFAULT_BLUR_PX}px; }
    [${MARK}="hidden"] {
      filter: blur(var(--click-to-view-blur, ${DEFAULT_BLUR_PX}px)) !important;
      opacity: .12 !important;
      cursor: pointer !important;
    }
    video[${MARK}="hidden"] { visibility: visible !important; }
    [${MARK}="hidden"]::selection { background: transparent; }
    [${OVERLAY_ATTR}] {
      position: absolute !important;
      z-index: 2147483000 !important;
      margin: 0 !important;
      padding: 0 !important;
      border: 1px solid rgba(255, 255, 255, .35) !important;
      border-radius: 4px !important;
      background: rgba(10, 12, 16, .16) !important;
      color: #fff !important;
      font: 600 13px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif !important;
      align-items: center !important;
      justify-content: center !important;
      box-sizing: border-box !important;
      overflow: hidden !important;
      cursor: pointer !important;
      pointer-events: auto !important;
      appearance: none !important;
      -webkit-appearance: none !important;
      text-align: center !important;
    }
    [${OVERLAY_ATTR}] > span {
      padding: 6px 12px !important;
      border-radius: 999px !important;
      background: rgba(0, 0, 0, .6) !important;
      box-shadow: 0 1px 4px rgba(0, 0, 0, .45) !important;
      text-shadow: 0 1px 2px rgba(0, 0, 0, .6) !important;
      white-space: nowrap !important;
      pointer-events: none !important;
    }
    [${OVERLAY_ATTR}]:focus-visible {
      outline: 2px solid #fff !important;
      outline-offset: -2px !important;
    }
  `;
  // Chrome 157+: at document_start document.documentElement is null, and
  // appending the style to `document` then makes it the document element
  // while the parser never creates the page's <html>/<body> — every page
  // breaks. Wait for the parser to create the document element first.
  function appendStyle() {
    (document.documentElement || document).appendChild(style);
  }
  if (document.documentElement) {
    appendStyle();
  } else {
    document.addEventListener("DOMContentLoaded", appendStyle, { once: true });
  }

  function normalizeBlurPx(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return DEFAULT_BLUR_PX;
    return Math.min(MAX_BLUR_PX, Math.max(MIN_BLUR_PX, Math.round(number)));
  }

  function applyBlurPx(value) {
    const px = normalizeBlurPx(value);
    if (document.documentElement) {
      document.documentElement.style.setProperty("--click-to-view-blur", `${px}px`);
    }
  }

  const isFirefoxApi = typeof browser !== "undefined" && !!browser.runtime;
  const extensionApi = isFirefoxApi
    ? browser
    : (typeof chrome !== "undefined" && chrome.storage ? chrome : null);
  let storageAreaName = "sync";
  let storageArea = null;
  if (extensionApi && extensionApi.storage) {
    if (isFirefoxApi && extensionApi.storage.local) {
      storageArea = extensionApi.storage.local;
      storageAreaName = "local";
    } else if (extensionApi.storage.sync) {
      storageArea = extensionApi.storage.sync;
      storageAreaName = "sync";
    } else if (extensionApi.storage.local) {
      storageArea = extensionApi.storage.local;
      storageAreaName = "local";
    }
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

  function storageOnChanged(callback) {
    if (!extensionApi || !extensionApi.storage || !extensionApi.storage.onChanged) return;
    extensionApi.storage.onChanged.addListener((changes, area) => {
      if (area === storageAreaName) callback(changes);
    });
  }

  function isSiteDisabled(list) {
    return Array.isArray(list) && list.includes(SITE_KEY);
  }

  applyBlurPx(DEFAULT_BLUR_PX);
  storageGet({ blurPx: DEFAULT_BLUR_PX, disabledHosts: [] }).then(data => {
    applyBlurPx(data.blurPx);
    setDisabled(isSiteDisabled(data.disabledHosts));
  });
  storageOnChanged(changes => {
    if (changes.blurPx) applyBlurPx(changes.blurPx.newValue);
    if (changes.disabledHosts) setDisabled(isSiteDisabled(changes.disabledHosts.newValue));
  });

  function isMediaElement(el) {
    const tag = el.localName;
    if (tag === "img" || tag === "video" || tag === "image") return true;
    return tag === "input" && el.type === "image";
  }

  function isBackgroundImage(el) {
    if (!el || !el.isConnected) return false;
    if (!BG_TAGS.has(el.localName)) return false;
    if (el.childElementCount > 0) return false;
    const text = el.textContent;
    if (text && text.trim()) return false;

    let backgroundImage = "";
    try {
      backgroundImage = getComputedStyle(el).backgroundImage;
    } catch (_) {
      return false;
    }
    if (!backgroundImage || backgroundImage === "none" || !/url\(/i.test(backgroundImage)) return false;

    const rect = el.getBoundingClientRect();
    // Emotes can be rendered as very small background images (16-32px), so
    // they get a lower size floor than avatars and thumbnails.
    const minSize = el.matches(EMOTE_HINT_SELECTOR) ? 8 : 16;
    return rect.width >= minSize && rect.height >= minSize;
  }

  function applyHiddenStyle(el) {
    if (!savedStyles.has(el)) {
      savedStyles.set(el, {
        filter: el.style.getPropertyValue("filter"),
        filterPriority: el.style.getPropertyPriority("filter"),
        opacity: el.style.getPropertyValue("opacity"),
        opacityPriority: el.style.getPropertyPriority("opacity"),
        cursor: el.style.getPropertyValue("cursor"),
        cursorPriority: el.style.getPropertyPriority("cursor"),
        transition: el.style.getPropertyValue("transition"),
        transitionPriority: el.style.getPropertyPriority("transition")
      });
    }
    el.style.setProperty("filter", `blur(var(--click-to-view-blur, ${DEFAULT_BLUR_PX}px))`, "important");
    el.style.setProperty("opacity", "0.12", "important");
    el.style.setProperty("cursor", "pointer", "important");
    // Keep the blur instant: a site's own transition would otherwise fade the
    // blur in and show the media unblurred for a moment.
    el.style.setProperty("transition", "none", "important");
  }

  function restoreHiddenStyle(el) {
    const saved = savedStyles.get(el);
    if (!saved) return;
    savedStyles.delete(el);

    const restore = (property, value, priority) => {
      if (value) el.style.setProperty(property, value, priority);
      else el.style.removeProperty(property);
    };

    restore("filter", saved.filter, saved.filterPriority);
    restore("opacity", saved.opacity, saved.opacityPriority);
    restore("cursor", saved.cursor, saved.cursorPriority);
    restore("transition", saved.transition, saved.transitionPriority);
  }

  function hiddenStyleIsApplied(el) {
    return el.style.getPropertyValue("filter") === `blur(var(--click-to-view-blur, ${DEFAULT_BLUR_PX}px))` &&
      el.style.getPropertyPriority("filter") === "important" &&
      el.style.getPropertyValue("opacity") === "0.12" &&
      el.style.getPropertyPriority("opacity") === "important" &&
      el.style.getPropertyValue("transition") === "none";
  }

  function restoreTitle(el) {
    if (!savedTitles.has(el)) {
      el.removeAttribute("title");
      return;
    }
    const title = savedTitles.get(el);
    savedTitles.delete(el);
    if (title === null) el.removeAttribute("title");
    else el.setAttribute("title", title);
  }

  // Lift the blur from everything we hid, without marking it as revealed, so
  // turning the site back on blurs it again.
  function resetElement(el) {
    el.removeAttribute(MARK);
    el.removeAttribute(BG_MARK);
    removeOverlay(el);
    revealedByOverlay.delete(el);
    restoreTitle(el);
    restoreHiddenStyle(el);
  }

  let stopAdHandling = null;

  function setDisabled(value) {
    const next = Boolean(value);
    if (next === disabled) return;
    disabled = next;

    if (disabled) {
      for (const root of knownRoots) {
        if (root !== document && !root.isConnected) {
          knownRoots.delete(root);
          continue;
        }
        root.querySelectorAll(`[${MARK}="hidden"]`).forEach(resetElement);
      }
      if (stopAdHandling) stopAdHandling();
      removeAllOverlays();
    } else {
      scan(document);
    }
  }

  function hide(el) {
    if (disabled) return;
    if (!(el instanceof Element) || el.hasAttribute(REVEALED)) return;

    if (el.hasAttribute(MARK)) {
      // Keep inline hiding in place if a site rewrites the element's styles.
      if ((isMediaElement(el) || el.hasAttribute(BG_MARK)) && !hiddenStyleIsApplied(el)) {
        applyHiddenStyle(el);
      }
      scheduleOverlay(el);
      return;
    }

    const media = isMediaElement(el);
    if (!media && !isBackgroundImage(el)) return;

    if (!savedTitles.has(el)) savedTitles.set(el, el.getAttribute("title"));
    if (!media) el.setAttribute(BG_MARK, "hidden");
    el.setAttribute(MARK, "hidden");
    el.setAttribute("title", "Click to reveal this media");
    applyHiddenStyle(el);

    // Stop videos from playing before the user reveals them.
    if (el.localName === "video") {
      try { el.pause(); } catch (_) {}
      el.autoplay = false;
      el.removeAttribute("autoplay");
      el.preload = "none";
    }

    scheduleOverlay(el);
  }

  function scan(root, includeShadowRoots = true) {
    if (!root || !root.querySelectorAll) return;

    if (root.matches && (root.matches(MEDIA_SELECTOR) || root.matches(BG_CANDIDATE_SELECTOR))) {
      hide(root);
    }
    root.querySelectorAll(MEDIA_SELECTOR).forEach(hide);
    root.querySelectorAll(BG_CANDIDATE_SELECTOR).forEach(hide);

    if (!includeShadowRoots) return;
    const doc = root.ownerDocument || (root.nodeType === Node.DOCUMENT_NODE ? root : document);
    let walker;
    try {
      walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    } catch (_) {
      return;
    }
    const budget = root === document || root === document.documentElement ? 20000 : 3000;
    let inspected = 0;
    while (walker.nextNode()) {
      const el = walker.currentNode;
      if (el.shadowRoot) {
        scan(el.shadowRoot);
        observeRoot(el.shadowRoot);
      }
      if (++inspected >= budget) break;
    }
  }

  const pendingScanNodes = new Set();
  let scanFrame = 0;
  const requestFrame = typeof requestAnimationFrame === "function"
    ? callback => requestAnimationFrame(callback)
    : callback => setTimeout(callback, 16);

  // Hide newly inserted media right away instead of waiting for the batched
  // scan below. Otherwise a freshly loaded chat message, emote, or lazy image
  // is painted unblurred for at least one frame. The limits keep this cheap on
  // large insertions (initial hydration, infinite scroll); anything past them
  // is still picked up by the requestAnimationFrame scan.
  const IMMEDIATE_MEDIA_LIMIT = 200;
  const IMMEDIATE_BG_LIMIT = 60;

  function hideImmediately(node) {
    if (node.matches(MEDIA_SELECTOR) || node.matches(BG_CANDIDATE_SELECTOR)) {
      hide(node);
    }
    const media = node.querySelectorAll(MEDIA_SELECTOR);
    const mediaLimit = Math.min(media.length, IMMEDIATE_MEDIA_LIMIT);
    for (let i = 0; i < mediaLimit; i++) hide(media[i]);
    const candidates = node.querySelectorAll(BG_CANDIDATE_SELECTOR);
    const candidateLimit = Math.min(candidates.length, IMMEDIATE_BG_LIMIT);
    for (let i = 0; i < candidateLimit; i++) hide(candidates[i]);
  }

  function scheduleScan(node) {
    if (!node) return;
    pendingScanNodes.add(node);
    if (scanFrame) return;
    scanFrame = requestFrame(() => {
      scanFrame = 0;
      const nodes = Array.from(pendingScanNodes);
      pendingScanNodes.clear();
      for (const queued of nodes) {
        if (queued.isConnected) scan(queued);
      }
    });
  }

  // ---- Click-to-view buttons for large media --------------------------------
  // The button lives in the page's own stacking context, over the media, so a
  // modal or any other page layer correctly covers it. It sits above the
  // media's siblings, which keeps it clickable when a site (Instagram posts
  // with tagged accounts, for example) paints its own controls on top.
  let overlaySyncFrame = 0;
  const overlayRecords = new Map();
  const pendingOverlayMedia = new Set();
  const overlayContainers = new Map();
  const overlayMediaByButton = new WeakMap();
  const overlayResizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(entries => {
        for (const entry of entries) {
          const record = overlayRecords.get(entry.target);
          if (record) positionOverlay(record);
        }
      })
    : null;

  function isOverlayableElement(el) {
    const tag = el.localName;
    return tag === "img" || tag === "video" ||
      (tag === "input" && el.type === "image") ||
      el.hasAttribute(BG_MARK);
  }

  function overlayContainerFor(el) {
    let container = el.parentElement;
    while (container && container !== document.documentElement) {
      let display = "";
      try {
        display = getComputedStyle(container).display;
      } catch (_) {}
      if (display !== "contents") break;
      container = container.parentElement;
    }
    if (!container) return null;
    // Avoid nesting the button inside a control or a <picture>, which would be
    // invalid markup and could steal the control's own click handling.
    if (container.localName === "picture" || container.matches(INTERACTIVE_SELECTOR)) {
      container = container.parentElement;
    }
    return container && container !== document ? container : null;
  }

  function acquireOverlayContainer(container) {
    let entry = overlayContainers.get(container);
    if (entry) {
      entry.count++;
      return entry;
    }
    entry = { count: 1, changed: false, position: "", priority: "" };
    let computed = null;
    try {
      computed = getComputedStyle(container);
    } catch (_) {}
    if (computed && computed.position === "static") {
      entry.changed = true;
      entry.position = container.style.getPropertyValue("position");
      entry.priority = container.style.getPropertyPriority("position");
      container.style.setProperty("position", "relative");
    }
    overlayContainers.set(container, entry);
    return entry;
  }

  function releaseOverlayContainer(record) {
    const entry = record.containerEntry;
    const container = record.container;
    if (!entry || !container) return;
    entry.count--;
    if (entry.count > 0) return;
    overlayContainers.delete(container);
    if (entry.changed) {
      if (entry.position) container.style.setProperty("position", entry.position, entry.priority);
      else container.style.removeProperty("position");
    }
  }

  function shouldShowOverlay(el) {
    if (disabled || !el.isConnected) return false;
    if (el.hasAttribute(REVEALED) || el.getAttribute(MARK) !== "hidden") return false;
    if (!isOverlayableElement(el)) return false;
    const rect = el.getBoundingClientRect();
    // A zero-sized rect usually means the media has not been laid out yet.
    // Keep a button ready so it can appear as soon as the media has a size.
    if (rect.width === 0 || rect.height === 0) return true;
    return rect.width >= MIN_OVERLAY_SIDE_PX && rect.height >= MIN_OVERLAY_SIDE_PX;
  }

  function positionOverlay(record) {
    const media = record.media;
    const container = record.container;
    const button = record.button;
    if (!media.isConnected || !container || !container.isConnected) {
      button.style.display = "none";
      return;
    }
    const rect = media.getBoundingClientRect();
    if (rect.width < MIN_OVERLAY_SIDE_PX || rect.height < MIN_OVERLAY_SIDE_PX) {
      button.style.display = "none";
      return;
    }

    let computed = null;
    try {
      computed = getComputedStyle(container);
    } catch (_) {}
    const containerRect = container.getBoundingClientRect();
    const borderLeft = computed ? parseFloat(computed.borderLeftWidth) || 0 : 0;
    const borderTop = computed ? parseFloat(computed.borderTopWidth) || 0 : 0;
    // Absolutely positioned children are placed from the padding box before
    // the container's own scroll offset.
    const scrollLeft = container === document.documentElement ? 0 : container.scrollLeft;
    const scrollTop = container === document.documentElement ? 0 : container.scrollTop;

    button.style.display = "flex";
    button.style.left = `${rect.left - containerRect.left - borderLeft + scrollLeft}px`;
    button.style.top = `${rect.top - containerRect.top - borderTop + scrollTop}px`;
    button.style.width = `${rect.width}px`;
    button.style.height = `${rect.height}px`;
  }

  function createOverlay(media) {
    const container = overlayContainerFor(media);
    if (!container) return null;

    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute(OVERLAY_ATTR, "");
    button.setAttribute("aria-label", "Click to view media");
    button.title = "Click to view this media";

    const label = document.createElement("span");
    label.textContent = "Click to view";
    label.setAttribute("aria-hidden", "true");
    button.appendChild(label);

    const record = { media, button, container };
    record.containerEntry = acquireOverlayContainer(container);
    overlayMediaByButton.set(button, media);

    overlayRecords.set(media, record);
    if (overlayResizeObserver) overlayResizeObserver.observe(media);
    container.appendChild(button);
    positionOverlay(record);
    return record;
  }

  function removeOverlay(el) {
    const record = overlayRecords.get(el);
    if (!record) return;
    overlayRecords.delete(el);
    pendingOverlayMedia.delete(el);
    if (overlayResizeObserver) overlayResizeObserver.unobserve(el);
    overlayMediaByButton.delete(record.button);
    record.button.remove();
    releaseOverlayContainer(record);
  }

  function removeAllOverlays() {
    for (const [media, record] of overlayRecords) {
      if (overlayResizeObserver) overlayResizeObserver.unobserve(media);
      record.button.remove();
      releaseOverlayContainer(record);
    }
    overlayRecords.clear();
    pendingOverlayMedia.clear();
  }

  function syncOverlay(el) {
    if (!shouldShowOverlay(el)) {
      removeOverlay(el);
      return;
    }
    const record = overlayRecords.get(el);
    if (!record) {
      createOverlay(el);
    } else if (record.button.isConnected) {
      positionOverlay(record);
    } else {
      record.container.appendChild(record.button);
      positionOverlay(record);
    }
  }

  // Site re-renders can replace the container, remove the button, or drop the
  // media entirely. Repair or forget the overlay on the next sync pass.
  function repairOverlays() {
    for (const [media, record] of overlayRecords) {
      if (!media.isConnected) {
        removeOverlay(media);
        continue;
      }
      if (record.container && record.container.isConnected && record.container.contains(media)) {
        if (!record.button.isConnected) {
          record.container.appendChild(record.button);
          positionOverlay(record);
        }
        continue;
      }
      releaseOverlayContainer(record);
      const container = overlayContainerFor(media);
      if (!container) {
        removeOverlay(media);
        continue;
      }
      record.container = container;
      record.containerEntry = acquireOverlayContainer(container);
      container.appendChild(record.button);
      positionOverlay(record);
    }
  }

  function scheduleOverlay(el) {
    pendingOverlayMedia.add(el);
    if (overlaySyncFrame) return;
    overlaySyncFrame = requestFrame(() => {
      overlaySyncFrame = 0;
      const media = Array.from(pendingOverlayMedia);
      pendingOverlayMedia.clear();
      for (const el of media) syncOverlay(el);
      repairOverlays();
    });
  }

  function handleRecords(records) {
    for (const record of records) {
      if (record.type === "childList") {
        record.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            hideImmediately(node);
            scheduleScan(node);
            if (node.shadowRoot) {
              scheduleScan(node.shadowRoot);
              observeRoot(node.shadowRoot);
            }
          } else if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
            scheduleScan(node);
          }
        });
        record.removedNodes.forEach(node => {
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          revealedByOverlay.delete(node);
          if (overlayRecords.has(node)) removeOverlay(node);
          node.querySelectorAll(MEDIA_SELECTOR).forEach(el => {
            revealedByOverlay.delete(el);
            if (overlayRecords.has(el)) removeOverlay(el);
          });
        });
      } else if (record.type === "attributes") {
        const el = record.target;
        if (!(el instanceof Element) || el.hasAttribute(REVEALED)) continue;

        if (record.attributeName === MARK) {
          // If the page removes our marker, put it back.
          if (!el.hasAttribute(MARK)) hide(el);
          continue;
        }

        if (isMediaElement(el) || (el.matches && el.matches(BG_CANDIDATE_SELECTOR))) {
          // If a site swaps the media URL or toggles a background image, keep it hidden.
          hide(el);
        }
      }
    }
  }

  const observer = new MutationObserver(handleRecords);

  // Every root we have marked media in, so a site-wide disable can reach media
  // inside shadow roots too.
  const knownRoots = new Set([document]);

  function observeRoot(root) {
    if (!root || root.__clickToViewObserved) return;
    root.__clickToViewObserved = true;
    for (const known of knownRoots) {
      if (known !== document && !known.isConnected) knownRoots.delete(known);
    }
    knownRoots.add(root);
    try {
      observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["src", "srcset", "poster", "class", "style", MARK]
      });
    } catch (_) {}
    // Clicks inside a shadow root are handled by the root itself, so media
    // inside shadow roots toggles even when the click event is not composed.
    if (root !== document) {
      try {
        root.addEventListener("click", handleMediaClick, true);
      } catch (_) {}
    }
  }

  observeRoot(document);
  if (document.documentElement) scan(document.documentElement);

  // Catch media that appears after hydration or without attribute mutations.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => scan(document), { once: true });
  }
  window.addEventListener("load", () => scan(document), { once: true });
  const catchUpTimer = setInterval(() => scan(document, false), 1000);
  setTimeout(() => clearInterval(catchUpTimer), 10000);

  // ---- YouTube ads: mute the ad and auto-click "Skip" ----------------------
  const IS_YOUTUBE = /(^|\.)youtube(?:-nocookie)?\.com$/.test(location.hostname);

  if (IS_YOUTUBE) {
    const SKIP_SELECTORS = [
      "button.ytp-ad-skip-button",
      "button.ytp-skip-ad-button",
      "button.ytp-ad-skip-button-modern",
      ".ytp-ad-skip-button",
      ".ytp-skip-ad-button",
      ".ytp-ad-skip-button-modern",
      ".ytp-ad-skip-button-container button",
      // Mobile web (m.youtube.com) player variants.
      "button.ytm-ad-skip-button",
      ".ytm-ad-skip-button",
      "ytm-button-renderer.ad-skip-button button",
      ".ad-skip-button",
      "ytm-player .ytp-ad-skip-button",
      "ytd-button-renderer#skip-button button",
      "#skip-button button",
      "ytd-button-renderer#skip-button",
      "#skip-button"
    ];

    let adActive = false;
    let savedAudio = null;
    let lastSkipClick = 0;
    let playerObserver = null;
    let watchedPlayer = null;

    function getPlayer() {
      return document.querySelector(
        "#movie_player, .html5-video-player, ytm-player, " +
        "#player-container-id, #player-container, ytd-player"
      );
    }

    function getMainVideo(player) {
      return (player || document).querySelector("video.html5-main-video") ||
        (player || document).querySelector("video.video-stream") ||
        (player || document).querySelector("video");
    }

    function isVisible(el) {
      if (!el) return false;
      const computed = getComputedStyle(el);
      if (computed.display === "none" || computed.visibility === "hidden" || computed.opacity === "0") return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1;
    }

    function isAdShowing(player) {
      if (!player) return false;
      if (player.classList.contains("ad-showing")) return true;
      if (player.closest && player.closest(".ad-showing")) return true;
      if (player.querySelector(".ad-showing")) return true;
      // Mobile web may flag the ad on the surrounding player container.
      if (document.querySelector(
        "#movie_player.ad-showing, .html5-video-player.ad-showing, ytm-player.ad-showing, " +
        "#player-container-id.ad-showing, #player-container.ad-showing"
      )) return true;
      // Fallback for player variants that omit the ad-showing class.
      const adUi = player.querySelector(
        ".ytp-ad-player-overlay, .ytp-ad-progress, .ytp-ad-skip-button, " +
        ".ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytm-ad-skip-button, " +
        ".ad-skip-button, .ytp-ad-text"
      );
      return !!adUi && isVisible(adUi);
    }

    function muteAd(video) {
      if (!video) return;
      if (!savedAudio) savedAudio = { muted: video.muted, volume: video.volume };
      try { video.muted = true; } catch (_) {}
      try { video.volume = 0; } catch (_) {}
    }

    function restoreAudio(video) {
      if (!savedAudio) return;
      const saved = savedAudio;
      savedAudio = null;
      if (!video) return;
      try { video.muted = saved.muted; } catch (_) {}
      try { video.volume = saved.volume; } catch (_) {}
    }

    // Called when the address is disabled while an ad is already muted.
    stopAdHandling = function () {
      if (!adActive) return;
      adActive = false;
      restoreAudio(getMainVideo(getPlayer()));
    };

    function findSkipButton(player) {
      const roots = [player, document].filter(Boolean);
      for (const root of roots) {
        for (const selector of SKIP_SELECTORS) {
          for (const button of root.querySelectorAll(selector)) {
            if (!isVisible(button)) continue;
            if (button.disabled || button.getAttribute("aria-disabled") === "true") continue;
            return button;
          }
        }
      }
      // Text fallback, restricted to the player while an ad is active.
      if (player) {
        const candidates = player.querySelectorAll(
          'button, [role="button"], ytm-button-renderer'
        );
        for (const button of candidates) {
          if (!isVisible(button)) continue;
          if (button.getAttribute("aria-disabled") === "true") continue;
          const text = (button.textContent || "").trim().toLowerCase();
          if (/^skip(?:\s+(?:ad|ads|advertisement))?$/.test(text)) return button;
        }
      }
      return null;
    }

    function clickSkip(player) {
      if (!adActive) return;
      const now = Date.now();
      if (now - lastSkipClick < 500) return;
      const button = findSkipButton(player);
      if (!button) return;
      lastSkipClick = now;
      try { button.click(); } catch (_) {}
    }

    function ensurePlayerObserver(player) {
      if (!player || player === watchedPlayer) return;
      if (playerObserver) playerObserver.disconnect();
      watchedPlayer = player;
      playerObserver = new MutationObserver(tick);
      // Ad start/end is signalled by the ad-showing class on the player.
      playerObserver.observe(player, { attributes: true, attributeFilter: ["class"] });
    }

    function tick() {
      if (disabled) {
        if (stopAdHandling) stopAdHandling();
        return;
      }
      const player = getPlayer();
      if (!player) return;
      ensurePlayerObserver(player);
      const showing = isAdShowing(player);
      const video = getMainVideo(player);

      if (showing) {
        if (!adActive) {
          adActive = true;
          lastSkipClick = 0;
        }
        muteAd(video);
        clickSkip(player);
      } else if (adActive) {
        adActive = false;
        restoreAudio(video);
      }
    }

    function start() {
      tick();
      document.addEventListener("yt-navigate-finish", tick, true);
      document.addEventListener("yt-page-data-updated", tick, true);
      document.addEventListener("play", event => {
        tick();
        if (!adActive) return;
        const video = getMainVideo(getPlayer());
        if (event.target === video && (!video.muted || video.volume !== 0)) muteAd(video);
      }, true);
      document.addEventListener("volumechange", event => {
        if (!adActive) return;
        const video = getMainVideo(getPlayer());
        if (event.target === video && (!video.muted || video.volume !== 0)) muteAd(video);
      }, true);
      setInterval(tick, 150);
    }

    start();
  }

  // Capture clicks before page handlers. Clicking a hidden item reveals it;
  // clicking that same revealed item again hides it. Each element toggles on
  // its own, so revealing one image never affects the rest of the page.
  function findTogglable(start) {
    let el = start instanceof Element ? start : (start && start.parentElement);
    while (el) {
      if (el.hasAttribute(REVEALED)) return { el, reveal: false };
      if (el.getAttribute(MARK) === "hidden") return { el, reveal: true };
      if (el.parentElement) {
        el = el.parentElement;
      } else {
        const root = el.getRootNode ? el.getRootNode() : null;
        el = root && root.host ? root.host : null;
      }
    }
    return null;
  }

  function revealElement(el, fromOverlay = false) {
    if (fromOverlay) revealedByOverlay.add(el);
    else revealedByOverlay.delete(el);
    el.setAttribute(REVEALED, "true");
    el.removeAttribute(MARK);
    el.removeAttribute(BG_MARK);
    removeOverlay(el);
    restoreTitle(el);
    restoreHiddenStyle(el);
    if (el.localName === "video") {
      el.controls = true;
      el.preload = "metadata";
    }
  }

  function unrevealElement(el) {
    revealedByOverlay.delete(el);
    el.removeAttribute(REVEALED);
    hide(el);
  }

  function findInteractive(start) {
    let el = start instanceof Element ? start : (start && start.parentElement);
    while (el) {
      if (el.matches && el.matches(INTERACTIVE_SELECTOR)) return el;
      if (el.parentElement) {
        el = el.parentElement;
      } else {
        const root = el.getRootNode ? el.getRootNode() : null;
        el = root && root.host ? root.host : null;
      }
    }
    return null;
  }

  // Some sites paint controls over the media (Instagram tag markers, for
  // example), so the click lands on a sibling of the revealed image. Match the
  // revealed media under the pointer and close to the clicked element, so a
  // click on a modal does not reach media behind it.
  function findRevealedAtPoint(event) {
    if (!event.detail || !(event.target instanceof Element)) return null;
    const target = event.target;

    const nearby = new Set();
    let ancestor = target;
    for (let depth = 0; ancestor && depth <= 4; depth++) {
      nearby.add(ancestor);
      ancestor = ancestor.parentElement;
    }

    const x = event.clientX;
    const y = event.clientY;
    for (const el of revealedByOverlay) {
      if (!el.isConnected) {
        revealedByOverlay.delete(el);
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
      for (const node of nearby) {
        if (node.contains(el)) return { el, reveal: false };
      }
    }
    return null;
  }

  function handleMediaClick(event) {
    if (disabled) return;

    // The overlay button is handled in the capture phase so the page's own
    // listeners never see the click (tag markers, post links, and so on).
    const overlay = event.target instanceof Element
      ? event.target.closest(`[${OVERLAY_ATTR}]`)
      : null;
    if (overlay) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const media = overlayMediaByButton.get(overlay);
      if (media && media.isConnected) revealElement(media, true);
      return;
    }

    const toggled = findTogglable(event.target) || findRevealedAtPoint(event);
    if (!toggled) return;

    // The first click on a blurred item only reveals it. After that, an item
    // that is part of a button or link hands the click to the page instead of
    // hiding itself again, otherwise the control could never be activated.
    // Media revealed with the overlay button always hides again, so the
    // button has a matching way to undo itself.
    if (!toggled.reveal && !revealedByOverlay.has(toggled.el) && findInteractive(event.target)) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (toggled.reveal) revealElement(toggled.el);
    else unrevealElement(toggled.el);
  }

  document.addEventListener("click", handleMediaClick, true);
})();
