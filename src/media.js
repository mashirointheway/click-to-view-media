// Blur engine: marks media, reveals it per item, and paints the "Click to
// view" button for large media.
//
// Layout of this file:
//   1. styles and constants
//   2. per-element state (saved styles, title, video props)
//   3. hide / reveal / reset
//   4. overlays
//   5. mutation handling and the batched flush
//   6. click handling
//
// The two rules that keep it cheap: never read layout in the observer
// callback, and never do more than one read pass per frame.
(() => {
  "use strict";

  const CTV = globalThis.CTV;
  if (!CTV || CTV.mediaLoaded) return;
  CTV.mediaLoaded = true;

  const { config } = CTV;

  const MARK = "data-click-to-view-media";
  const REVEALED = "data-click-to-view-revealed";
  const BG_MARK = "data-click-to-view-bg";
  const OVERLAY_ATTR = "data-click-to-view-overlay";
  const STYLE_ID = "click-to-view-media-style";

  const MEDIA_SELECTOR = "img, video, input[type='image'], image";
  const BG_TAGS = new Set(["div", "span", "header", "section", "article", "li", "td", "th", "figure"]);

  // Only elements likely to use a CSS background image are checked with
  // getComputedStyle, so the page's whole style sheet is not resolved.
  const EMOTE_HINT_SELECTOR = [
    '[class*="emote" i]',
    '[class*="emoji" i]',
    '[alt*="emote" i]',
    '[alt*="emoji" i]'
  ].join(", ");

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

  const BLUR = `blur(var(--click-to-view-blur, ${config.DEFAULT_BLUR_PX}px))`;
  const HIDDEN_TITLE = "Click to reveal this media";

  // What we write on every hidden element. Kept in one place so the inline
  // values and the checks that recognise them cannot drift apart.
  const HIDDEN_STYLE = Object.freeze({
    filter: BLUR,
    opacity: "0.12",
    cursor: "pointer",
    transition: "none"
  });

  const requestFrame = typeof requestAnimationFrame === "function"
    ? callback => requestAnimationFrame(callback)
    : callback => setTimeout(callback, 16);

  // ---- 1. styles -----------------------------------------------------------

  const CSS = `
    :root { --click-to-view-blur: ${config.DEFAULT_BLUR_PX}px; }
    [${MARK}="hidden"] {
      filter: ${BLUR} !important;
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
    /* High-contrast mode can drop the blur effect; hide the media outright
       instead of leaving it readable. */
    @media (forced-colors: active) {
      [${MARK}="hidden"] { filter: none !important; opacity: 0 !important; }
    }
  `;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;

  // Chrome can run document_start scripts before the parser creates <html>.
  // Appending the style to `document` at that point makes it the document
  // element and breaks the page, so wait for the real root instead.
  let mountAttempts = 0;
  function mountStyle() {
    const root = document.documentElement;
    if (!root) {
      if (mountAttempts++ < 100) setTimeout(mountStyle, 0);
      return;
    }
    if (!style.isConnected) root.appendChild(style);
  }
  mountStyle();

  // Document styles do not cross shadow boundaries, so every shadow root gets
  // its own copy (adopted sheet where supported, a <style> otherwise).
  let overlaySheet = null;
  if (typeof CSSStyleSheet === "function" && "replaceSync" in CSSStyleSheet.prototype) {
    try {
      overlaySheet = new CSSStyleSheet();
      overlaySheet.replaceSync(CSS);
    } catch (_) {
      overlaySheet = null;
    }
  }

  const styledRoots = new WeakSet();
  function styleShadowRoot(root) {
    if (!root || root === document || styledRoots.has(root)) return;
    styledRoots.add(root);
    if (overlaySheet && "adoptedStyleSheets" in root) {
      try {
        root.adoptedStyleSheets = [...root.adoptedStyleSheets, overlaySheet];
        return;
      } catch (_) {
        // Fall through to a style element.
      }
    }
    const node = document.createElement("style");
    node.textContent = CSS;
    root.appendChild(node);
  }

  function applyBlurPx(value) {
    const px = CTV.normalizeBlurPx(value);
    if (document.documentElement) {
      document.documentElement.style.setProperty("--click-to-view-blur", `${px}px`);
    }
  }

  // ---- 2. per-element state ------------------------------------------------

  // el -> { title, styles: { prop: [value, priority] }, video: {...} }
  const hiddenState = new WeakMap();
  const revealedByOverlay = new Set();

  function remember(el) {
    let state = hiddenState.get(el);
    if (state) return state;

    const styles = {};
    for (const prop of Object.keys(HIDDEN_STYLE)) {
      styles[prop] = [el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)];
    }

    state = { title: el.getAttribute("title"), styles, video: null };
    if (el.localName === "video") {
      state.video = {
        autoplay: el.getAttribute("autoplay"),
        preload: el.getAttribute("preload"),
        controls: el.controls
      };
    }
    hiddenState.set(el, state);
    return state;
  }

  function setHiddenStyle(el) {
    for (const prop of Object.keys(HIDDEN_STYLE)) {
      const value = HIDDEN_STYLE[prop];
      if (el.style.getPropertyValue(prop) === value && el.style.getPropertyPriority(prop) === "important") continue;
      el.style.setProperty(prop, value, "important");
    }
  }

  function hiddenStyleIsApplied(el) {
    for (const prop of Object.keys(HIDDEN_STYLE)) {
      if (el.style.getPropertyValue(prop) !== HIDDEN_STYLE[prop]) return false;
      if (el.style.getPropertyPriority(prop) !== "important") return false;
    }
    return true;
  }

  function restoreHiddenStyle(el, state) {
    for (const prop of Object.keys(HIDDEN_STYLE)) {
      // If the page replaced our value while the media was hidden, the page
      // owns it now; restoring the old value would undo the page's update.
      if (el.style.getPropertyValue(prop) !== HIDDEN_STYLE[prop]) continue;
      const [value, priority] = state.styles[prop];
      if (value) el.style.setProperty(prop, value, priority);
      else el.style.removeProperty(prop);
    }
  }

  function restoreTitle(el, state) {
    if (el.getAttribute("title") !== HIDDEN_TITLE) return;
    if (state.title === null) el.removeAttribute("title");
    else el.setAttribute("title", state.title);
  }

  function freezeVideo(el) {
    try { el.pause(); } catch (_) {}
    el.autoplay = false;
    el.removeAttribute("autoplay");
    el.preload = "none";
  }

  function restoreVideo(el, state) {
    if (!state.video) return;
    el.controls = state.video.controls;
    if (state.video.preload === null) el.removeAttribute("preload");
    else el.setAttribute("preload", state.video.preload);
    if (state.video.autoplay === null) el.removeAttribute("autoplay");
    else el.setAttribute("autoplay", state.video.autoplay);
  }

  // ---- 3. hide / reveal / reset --------------------------------------------

  function isMediaElement(el) {
    const tag = el.localName;
    if (tag === "img" || tag === "video" || tag === "image") return true;
    return tag === "input" && el.type === "image";
  }

  // Sites often stack media in the same spot: a placeholder under the real
  // image, a thumbnail under a preview video, a picture under its own blurred
  // copy. Those look like one item to the reader, so a click should reveal or
  // hide the whole stack. Rects within this overlap count as one item.
  const STACK_OVERLAP = 0.7;

  function rectOverlapRatio(a, b) {
    const overlapWidth = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const overlapHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (overlapWidth <= 0 || overlapHeight <= 0) return 0;
    const overlap = overlapWidth * overlapHeight;
    const union = a.width * a.height + b.width * b.height - overlap;
    return union > 0 ? overlap / union : 0;
  }

  function stackMates(el) {
    const base = el.getBoundingClientRect();
    if (!base.width || !base.height) return [];

    // Hit-testing at the media's center finds whatever is stacked on top of
    // it, however the DOM wraps those elements.
    const x = base.left + base.width / 2;
    const y = base.top + base.height / 2;
    const root = el.getRootNode ? el.getRootNode() : document;
    const probe = root && typeof root.elementsFromPoint === "function"
      ? root.elementsFromPoint.bind(root)
      : document.elementsFromPoint.bind(document);

    const mates = [];
    for (const other of probe(x, y)) {
      if (other === el || !other.hasAttribute) continue;
      if (!other.hasAttribute(MARK) && !other.hasAttribute(REVEALED)) continue;
      const rect = other.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      if (rectOverlapRatio(base, rect) >= STACK_OVERLAP) mates.push(other);
    }
    return mates;
  }

  // Cheap rejection before the expensive getComputedStyle + rect work.
  function bgPrecheck(el) {
    if (!el || !el.isConnected) return false;
    if (!BG_TAGS.has(el.localName)) return false;
    if (el.childElementCount > 0) return false;
    const text = el.textContent;
    return !(text && text.trim());
  }

  function isBackgroundImage(el, rect) {
    if (!bgPrecheck(el)) return false;

    let backgroundImage = "";
    try {
      backgroundImage = getComputedStyle(el).backgroundImage;
    } catch (_) {
      return false;
    }
    if (!backgroundImage || backgroundImage === "none" || !/url\(/i.test(backgroundImage)) return false;

    // Emotes can be 16-32px background images, so they get a lower floor than
    // avatars and thumbnails.
    const box = rect || el.getBoundingClientRect();
    const minSize = el.matches(EMOTE_HINT_SELECTOR) ? 8 : 16;
    return box.width >= minSize && box.height >= minSize;
  }

  function hide(el, rect) {
    if (CTV.state.disabled) return;
    if (!(el instanceof Element) || el.hasAttribute(REVEALED)) return;

    if (el.hasAttribute(MARK)) {
      // Keep inline hiding in place if a site rewrites the element's styles.
      // The overlay needs no work here: every hidden element is watched by the
      // ResizeObserver, which re-evaluates its size.
      if ((isMediaElement(el) || el.hasAttribute(BG_MARK)) && !hiddenStyleIsApplied(el)) {
        setHiddenStyle(el);
      }
      return;
    }

    const media = isMediaElement(el);
    if (!media && !isBackgroundImage(el, rect)) return;

    remember(el);
    if (!media) el.setAttribute(BG_MARK, "hidden");
    el.setAttribute(MARK, "hidden");
    el.setAttribute("title", HIDDEN_TITLE);
    setHiddenStyle(el);
    if (el.localName === "video") freezeVideo(el);
    watchOverlay(el);
  }

  function resetElement(el) {
    const state = hiddenState.get(el);
    el.removeAttribute(MARK);
    el.removeAttribute(BG_MARK);
    removeOverlay(el);
    unwatchOverlay(el);
    revealedByOverlay.delete(el);
    if (!state) return;
    restoreTitle(el, state);
    restoreHiddenStyle(el, state);
    restoreVideo(el, state);
    hiddenState.delete(el);
  }

  function revealElement(el, fromOverlay = false) {
    for (const item of [el, ...stackMates(el)]) revealOne(item, fromOverlay);
  }

  function revealOne(el, fromOverlay) {
    if (fromOverlay) revealedByOverlay.add(el);
    else revealedByOverlay.delete(el);

    el.setAttribute(REVEALED, "true");
    el.removeAttribute(MARK);
    el.removeAttribute(BG_MARK);
    removeOverlay(el);
    unwatchOverlay(el);

    const state = hiddenState.get(el);
    if (state) {
      restoreTitle(el, state);
      restoreHiddenStyle(el, state);
      hiddenState.delete(el);
    }

    if (el.localName === "video") {
      el.controls = true;
      el.preload = "metadata";
    }
  }

  function unrevealElement(el) {
    for (const item of [el, ...stackMates(el)]) unrevealOne(item);
  }

  function unrevealOne(el) {
    revealedByOverlay.delete(el);
    el.removeAttribute(REVEALED);
    hide(el);
  }

  // ---- 4. overlays ---------------------------------------------------------

  const overlayRecords = new Map();
  const overlayMediaByButton = new WeakMap();
  const overlayQueue = new Set();
  const overlayContainers = new Map();

  const overlayResizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(entries => {
        const records = [];
        for (const entry of entries) {
          const el = entry.target;
          const record = overlayRecords.get(el);
          if (record) {
            records.push(record);
          } else if (shouldShowOverlay(el)) {
            // Media that was too small for a button may have grown.
            queueOverlay(el);
          }
        }
        positionRecords(records);
      })
    : null;

  // Every hidden image and video is observed, not only the ones that already
  // have a button: that is how a small image that grows large gets one without
  // re-measuring every element on every mutation.
  function watchOverlay(el) {
    if (!isOverlayableElement(el)) return;
    if (overlayResizeObserver) overlayResizeObserver.observe(el);
    queueOverlay(el);
  }

  function unwatchOverlay(el) {
    if (overlayResizeObserver) overlayResizeObserver.unobserve(el);
  }

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

  // The button is absolutely positioned inside the media's container, so the
  // container needs a positioning context. Only static containers are touched,
  // and the original value is restored when the last button leaves.
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
    if (!entry.changed) return;
    if (entry.position) container.style.setProperty("position", entry.position, entry.priority);
    else container.style.removeProperty("position");
  }

  function measureContainer(record) {
    let computed = null;
    try {
      computed = getComputedStyle(record.container);
    } catch (_) {}
    record.borderLeft = computed ? parseFloat(computed.borderLeftWidth) || 0 : 0;
    record.borderTop = computed ? parseFloat(computed.borderTopWidth) || 0 : 0;
  }

  function shouldShowOverlay(el) {
    if (CTV.state.disabled || !el.isConnected) return false;
    if (el.hasAttribute(REVEALED) || el.getAttribute(MARK) !== "hidden") return false;
    if (!isOverlayableElement(el)) return false;
    const rect = el.getBoundingClientRect();
    // A zero-sized rect usually means the media has not been laid out yet.
    // Keep a button ready so it can appear as soon as the media has a size.
    if (rect.width === 0 || rect.height === 0) return true;
    return rect.width >= config.MIN_OVERLAY_SIDE_PX && rect.height >= config.MIN_OVERLAY_SIDE_PX;
  }

  function applyPosition(record, mediaRect, containerRect) {
    const { button, container } = record;
    const scrollLeft = container === document.documentElement ? 0 : container.scrollLeft;
    const scrollTop = container === document.documentElement ? 0 : container.scrollTop;
    const left = mediaRect.left - containerRect.left - record.borderLeft + scrollLeft;
    const top = mediaRect.top - containerRect.top - record.borderTop + scrollTop;

    const key = `${left}|${top}|${mediaRect.width}|${mediaRect.height}`;
    if (record.lastKey === key && button.style.display === "flex") return;
    record.lastKey = key;

    button.style.display = "flex";
    button.style.left = `${left}px`;
    button.style.top = `${top}px`;
    button.style.width = `${mediaRect.width}px`;
    button.style.height = `${mediaRect.height}px`;
  }

  // One read pass for every record, then one write pass.
  function positionRecords(records) {
    if (!records.length) return;
    const measurements = [];

    for (const record of records) {
      const { media, container, button } = record;
      if (!media.isConnected || !container || !container.isConnected) {
        if (button.style.display !== "none") button.style.display = "none";
        continue;
      }
      const mediaRect = media.getBoundingClientRect();
      if (mediaRect.width < config.MIN_OVERLAY_SIDE_PX || mediaRect.height < config.MIN_OVERLAY_SIDE_PX) {
        if (button.style.display !== "none") button.style.display = "none";
        continue;
      }
      measurements.push({ record, mediaRect, containerRect: container.getBoundingClientRect() });
    }

    for (const { record, mediaRect, containerRect } of measurements) {
      applyPosition(record, mediaRect, containerRect);
    }
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

    const record = {
      media,
      button,
      container,
      containerEntry: null,
      borderLeft: 0,
      borderTop: 0,
      lastKey: ""
    };
    record.containerEntry = acquireOverlayContainer(container);
    overlayMediaByButton.set(button, media);
    overlayRecords.set(media, record);
    measureContainer(record);
    if (overlayResizeObserver) overlayResizeObserver.observe(media);
    container.appendChild(button);
    positionRecords([record]);
    return record;
  }

  function removeOverlay(el) {
    const record = overlayRecords.get(el);
    if (!record) return;
    overlayRecords.delete(el);
    overlayQueue.delete(el);
    if (overlayResizeObserver) overlayResizeObserver.unobserve(el);
    overlayMediaByButton.delete(record.button);
    record.button.remove();
    releaseOverlayContainer(record);
  }

  function removeAllOverlays() {
    if (overlayResizeObserver) overlayResizeObserver.disconnect();
    for (const [media, record] of overlayRecords) {
      if (overlayResizeObserver) overlayResizeObserver.unobserve(media);
      overlayMediaByButton.delete(record.button);
      record.button.remove();
      releaseOverlayContainer(record);
    }
    overlayRecords.clear();
    overlayQueue.clear();
  }

  function ensureOverlay(el) {
    if (!shouldShowOverlay(el)) {
      removeOverlay(el);
      return null;
    }
    const record = overlayRecords.get(el);
    if (record) {
      if (!record.button.isConnected) {
        record.container.appendChild(record.button);
        record.lastKey = "";
      }
      return record;
    }
    // One button per visual stack: a placeholder image and the real image on
    // top of it should not each paint their own button.
    if (hasOverlayMate(el)) return null;
    return createOverlay(el);
  }

  function hasOverlayMate(el) {
    const parent = el.parentElement;
    if (!parent) return false;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    for (const record of overlayRecords.values()) {
      if (record.media.parentElement !== parent) continue;
      const other = record.media.getBoundingClientRect();
      if (!other.width || !other.height) continue;
      if (rectOverlapRatio(rect, other) >= STACK_OVERLAP) return true;
    }
    return false;
  }

  // Site re-renders can replace the container, remove the button, or drop the
  // media entirely. Repair or forget the overlay on the next flush.
  function repairOverlays() {
    for (const [media, record] of overlayRecords) {
      if (!media.isConnected) {
        removeOverlay(media);
        continue;
      }
      if (record.container && record.container.isConnected && record.container.contains(media)) {
        if (!record.button.isConnected) {
          record.container.appendChild(record.button);
          record.lastKey = "";
          positionRecords([record]);
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
      measureContainer(record);
      record.lastKey = "";
      container.appendChild(record.button);
      positionRecords([record]);
    }
  }

  function queueOverlay(el) {
    overlayQueue.add(el);
    schedule();
  }

  // ---- 5. mutation handling ------------------------------------------------

  const pendingHide = new Set();
  const pendingScan = new Set();
  let frame = 0;

  function schedule() {
    if (frame) return;
    frame = requestFrame(flush);
  }

  function scan(root, { shadowRoots = true } = {}) {
    if (!root || !root.querySelectorAll) return;

    if (root.matches && (root.matches(MEDIA_SELECTOR) || root.matches(BG_CANDIDATE_SELECTOR))) {
      hide(root);
    }

    // Read first: the background-image check is the only one that needs
    // layout, so measure every candidate before touching any element.
    const candidates = root.querySelectorAll(BG_CANDIDATE_SELECTOR);
    const rects = new Map();
    for (const el of candidates) {
      if (!bgPrecheck(el)) continue;
      try {
        rects.set(el, el.getBoundingClientRect());
      } catch (_) {}
    }

    for (const el of root.querySelectorAll(MEDIA_SELECTOR)) hide(el);
    for (const el of candidates) hide(el, rects.get(el));

    if (!shadowRoots) return;
    const doc = root.ownerDocument || (root.nodeType === Node.DOCUMENT_NODE ? root : document);
    let walker;
    try {
      walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    } catch (_) {
      return;
    }
    const budget = root === document || root === document.documentElement ? 20000 : 2000;
    let inspected = 0;
    while (walker.nextNode()) {
      const el = walker.currentNode;
      if (el.shadowRoot) {
        styleShadowRoot(el.shadowRoot);
        scan(el.shadowRoot);
        observeRoot(el.shadowRoot);
      }
      if (++inspected >= budget) break;
    }
  }

  // Hide freshly inserted images and videos in the observer callback so they
  // never paint unblurred. Background candidates are left to the frame scan:
  // testing them here would force a synchronous layout on every insertion.
  const IMMEDIATE_MEDIA_LIMIT = 200;
  const IMMEDIATE_CHILD_LIMIT = 200;

  function hideMediaImmediately(node) {
    if (node.matches(MEDIA_SELECTOR)) hide(node);
    if (node.childElementCount === 0 || node.childElementCount > IMMEDIATE_CHILD_LIMIT) return;
    const media = node.querySelectorAll(MEDIA_SELECTOR);
    const limit = Math.min(media.length, IMMEDIATE_MEDIA_LIMIT);
    for (let i = 0; i < limit; i++) hide(media[i]);
  }

  function cleanupRemoved(node) {
    revealedByOverlay.delete(node);
    if (overlayRecords.has(node)) removeOverlay(node);
    unwatchOverlay(node);
    node.querySelectorAll(`[${MARK}]`).forEach(el => {
      revealedByOverlay.delete(el);
      if (overlayRecords.has(el)) removeOverlay(el);
      unwatchOverlay(el);
    });
  }

  function handleRecords(records) {
    for (const record of records) {
      if (record.type === "childList") {
        for (const node of record.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          hideMediaImmediately(node);
          pendingScan.add(node);
          if (node.shadowRoot) {
            styleShadowRoot(node.shadowRoot);
            observeRoot(node.shadowRoot);
            pendingScan.add(node.shadowRoot);
          }
        }
        for (const node of record.removedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) cleanupRemoved(node);
        }
      } else if (record.type === "attributes") {
        const el = record.target;
        if (!(el instanceof Element) || el.hasAttribute(REVEALED)) continue;
        if (el.hasAttribute(OVERLAY_ATTR)) continue;
        if (record.attributeName === MARK) {
          // If the page removes our marker, put it back.
          if (!el.hasAttribute(MARK)) pendingHide.add(el);
          continue;
        }
        // Skip unrelated elements: the observer sees every class and style
        // change on the page, but only media and background candidates can
        // become hidden.
        if (!el.matches(MEDIA_SELECTOR) && !el.matches(BG_CANDIDATE_SELECTOR) && !el.hasAttribute(MARK)) continue;
        pendingHide.add(el);
      }
    }
    schedule();
  }

  function flush() {
    frame = 0;

    const hides = [...pendingHide];
    pendingHide.clear();
    const scans = [...pendingScan];
    pendingScan.clear();
    const overlays = [...overlayQueue];
    overlayQueue.clear();

    // Read phase.
    const rects = new Map();
    for (const el of hides) {
      if (!bgPrecheck(el)) continue;
      try {
        rects.set(el, el.getBoundingClientRect());
      } catch (_) {}
    }

    // Write phase.
    for (const el of hides) hide(el, rects.get(el));
    for (const root of scans) {
      if (root.isConnected) scan(root);
    }

    const records = [];
    for (const el of overlays) {
      const record = ensureOverlay(el);
      if (record) records.push(record);
    }
    positionRecords(records);
    // Repairing walks every record, so only do it when an overlay changed or
    // new DOM landed (a re-render may have replaced a button's container);
    // the periodic maintain() covers everything else.
    if (overlays.length || scans.length) repairOverlays();
  }

  const observer = new MutationObserver(handleRecords);

  const knownRoots = new Set([document]);
  const observedRoots = new WeakSet();

  function observeRoot(root) {
    if (!root) return;
    // Keep the root reachable for a site-wide disable even when it is being
    // re-observed after a disconnect.
    knownRoots.add(root);
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    styleShadowRoot(root);
    try {
      observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["src", "srcset", "poster", "class", "style", MARK]
      });
    } catch (error) {
      CTV.log("could not observe root", error);
    }
    // Clicks inside a shadow root are handled by the root itself, so media
    // there still toggles when the click event is not composed.
    if (root !== document) {
      try {
        root.addEventListener("click", handleMediaClick, true);
      } catch (_) {}
    }
  }

  // ---- 6. click handling ---------------------------------------------------

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
    if (CTV.state.disabled) return;

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

  // ---- start ---------------------------------------------------------------

  // Two independent reasons to be off: this frame's own site switch and the
  // top document's (the popup toggles the address bar's site).
  const siteState = { own: false, top: false };
  function syncDisabled() {
    CTV.setDisabled(siteState.own || siteState.top);
  }

  CTV.watchSiteSettings({
    onBlurPx: applyBlurPx,
    onDisabled: disabled => {
      siteState.own = disabled;
      syncDisabled();
    }
  });

  if (window.top !== window) {
    CTV.getTopSiteKey().then(topKey => {
      const ownKey = CTV.siteKeyForLocation(location);
      if (!topKey || topKey === ownKey) return;
      const offKey = CTV.offKey(topKey);
      CTV.storage.get({ [offKey]: false }).then(data => {
        siteState.top = Boolean(data[offKey]);
        syncDisabled();
      });
      CTV.storage.onChanged(changes => {
        if (!(offKey in changes)) return;
        siteState.top = Boolean(changes[offKey].newValue);
        syncDisabled();
      });
    });
  }

  function disableEverything() {
    for (const root of knownRoots) {
      if (root !== document && !root.isConnected) {
        knownRoots.delete(root);
        continue;
      }
      root.querySelectorAll(`[${MARK}]`).forEach(resetElement);
    }
    removeAllOverlays();
  }

  CTV.onDisabledChange(disabled => {
    if (disabled) disableEverything();
    else scan(document);
  });

  // Cheap upkeep: put the style back if the page removed it, forget detached
  // roots and overlays, and repair buttons whose media is still there.
  function maintain() {
    if (!style.isConnected) mountStyle();
    if (CTV.state.disabled) return;
    for (const root of knownRoots) {
      if (root !== document && !root.isConnected) knownRoots.delete(root);
    }
    for (const el of revealedByOverlay) {
      if (!el.isConnected) revealedByOverlay.delete(el);
    }
    for (const media of overlayRecords.keys()) {
      if (!media.isConnected) removeOverlay(media);
    }
    repairOverlays();
  }

  observeRoot(document);
  applyBlurPx(config.DEFAULT_BLUR_PX);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => scan(document), { once: true });
  } else {
    scan(document);
  }
  window.addEventListener("load", () => scan(document), { once: true });
  setTimeout(() => {
    if (!document.hidden) scan(document);
  }, 1500);

  document.addEventListener("click", handleMediaClick, true);
  setInterval(maintain, 5000);
})();
