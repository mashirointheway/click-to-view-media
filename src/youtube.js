// ---- YouTube ads: mute the ad and auto-click "Skip" ----------------------
// Event-driven port. The 150 ms poll is gone: the player's "ad-showing" class
// signals ad start/end, subtree insertions reveal a fresh Skip button, and
// document/video events cover navigation and new video elements. A 2 s tick
// is only a safety net for players that signal none of those.
(() => {
  "use strict";

  const CTV = globalThis.CTV;
  if (!CTV || CTV.youtube) return;
  CTV.youtube = true;

  const IS_YOUTUBE = /(^|\.)youtube(?:-nocookie)?\.com$/.test(location.hostname);
  if (!IS_YOUTUBE) return;

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
  let skipClicked = false;
  let playerObserver = null;
  let skipObserver = null;
  let watchedPlayer = null;
  let skipWatchedPlayer = null;

  function getPlayer() {
    const players = document.querySelectorAll(
      "#movie_player, .html5-video-player, ytm-player, " +
      "#player-container-id, #player-container, ytd-player"
    );
    let first = null;
    for (const player of players) {
      if (!first) first = player;
      // Prefer the player actually showing an ad (miniplayer, embeds, etc.).
      if (player.classList.contains("ad-showing")) return player;
      if (player.querySelector(".ad-showing")) return player;
    }
    return first || null;
  }

  function getMainVideo(player) {
    return (player || document).querySelector("video.html5-main-video") ||
      (player || document).querySelector("video.video-stream") ||
      (player || document).querySelector("video");
  }

  function isVisible(el) {
    if (!el) return false;
    // checkVisibility walks ancestors (display/visibility/opacity) for us.
    if (typeof el.checkVisibility === "function") {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    } else {
      let node = el;
      while (node && node.nodeType === 1) {
        const computed = getComputedStyle(node);
        if (computed.display === "none" || computed.visibility === "hidden" || computed.opacity === "0") return false;
        node = node.parentElement;
      }
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  }

  function isAdShowing(player) {
    if (!player) return false;
    // Cheap checks first: the class and DOM probes below short-circuit before
    // the UI fallback, which is the only path that calls getComputedStyle.
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
    // Capture the user's pre-ad audio state once, on the element we mute,
    // so it can be restored on that same element afterwards.
    if (!savedAudio) savedAudio = { video, muted: video.muted, volume: video.volume };
    try { video.muted = true; } catch (_) {}
    try { video.volume = 0; } catch (_) {}
  }

  function restoreAudio(video) {
    const saved = savedAudio;
    if (!saved) return;
    // Restore the element we actually muted; fall back to a current one.
    const target = (saved.video && saved.video.isConnected) ? saved.video : video;
    // Nothing to restore onto right now; keep savedAudio and retry later.
    if (!target) return;
    try { target.muted = saved.muted; } catch (_) {}
    try { target.volume = saved.volume; } catch (_) {}
    savedAudio = null;
  }

  // Called when the address is disabled while an ad is already muted, or on
  // any off switch: drop all observers so a disabled site is left untouched.
  function stop() {
    adActive = false;
    restoreAudio(getMainVideo(getPlayer()));
    if (playerObserver) {
      playerObserver.disconnect();
      playerObserver = null;
    }
    if (skipObserver) {
      skipObserver.disconnect();
      skipObserver = null;
    }
    if (watchedPlayer) {
      try { watchedPlayer.removeEventListener("loadedmetadata", tick, true); } catch (_) {}
      watchedPlayer = null;
    }
    skipWatchedPlayer = null;
  }

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
    // Click the skip button once per ad instead of hammering it.
    if (skipClicked) return;
    // Throttle the search itself, not only the click: while an ad is showing,
    // the player subtree mutates constantly and finding no button must not
    // trigger a full query on every mutation.
    lastSkipClick = now;
    const button = findSkipButton(player);
    if (!button) return;
    skipClicked = true;
    try { button.click(); } catch (_) {}
  }

  function ensurePlayerObserver(player) {
    if (!player || player === watchedPlayer) return;
    if (playerObserver) playerObserver.disconnect();
    if (skipObserver) {
      skipObserver.disconnect();
      skipObserver = null;
    }
    skipWatchedPlayer = null;
    if (watchedPlayer) {
      try { watchedPlayer.removeEventListener("loadedmetadata", tick, true); } catch (_) {}
    }
    watchedPlayer = player;
    // loadedmetadata does not bubble, but a capture listener on the player
    // still sees it from the video, even when YouTube swaps the video element.
    try { player.addEventListener("loadedmetadata", tick, true); } catch (_) {}
    playerObserver = new MutationObserver(tick);
    // Ad start/end is signalled by the ad-showing class on the player.
    playerObserver.observe(player, { attributes: true, attributeFilter: ["class"] });
  }

  function ensureSkipObserver(player) {
    if (!player || (skipObserver && skipWatchedPlayer === player)) return;
    if (skipObserver) skipObserver.disconnect();
    skipWatchedPlayer = player;
    skipObserver = new MutationObserver(() => clickSkip(player));
    // Skip buttons are injected after the ad starts. Watching the subtree
    // replaces the old poll and clicks the button as soon as it is inserted.
    skipObserver.observe(player, { childList: true, subtree: true });
  }

  function tick() {
    if (CTV.state.disabled) {
      stop();
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
        skipClicked = false;
      }
      muteAd(video);
      clickSkip(player);
      ensureSkipObserver(player);
    } else if (adActive || savedAudio) {
      // Restore user audio; if there is nothing to restore onto yet,
      // savedAudio is kept and retried on a later tick.
      adActive = false;
      restoreAudio(video);
      // No ad: stop watching insertions until the next ad starts.
      if (skipObserver) {
        skipObserver.disconnect();
        skipObserver = null;
        skipWatchedPlayer = null;
      }
    }
  }

  function start() {
    CTV.onDisabledChange(disabled => {
      if (disabled) stop();
      else tick();
    });

    // These document listeners stay registered across off/on changes: tick()
    // is inert (and stops) while the site switch is off.
    document.addEventListener("yt-navigate-finish", tick, true);
    document.addEventListener("yt-page-data-updated", tick, true);
    document.addEventListener("play", event => {
      tick();
      if (!adActive) return;
      const video = event.target;
      if (!video) return;
      // Only re-mute the element we're muting, never an unrelated player.
      if (savedAudio && savedAudio.video && savedAudio.video !== video) return;
      if (!video.muted || video.volume !== 0) muteAd(video);
    }, true);
    document.addEventListener("volumechange", event => {
      if (!adActive) return;
      const video = event.target;
      if (!video) return;
      if (savedAudio && savedAudio.video && savedAudio.video !== video) return;
      if (!video.muted || video.volume !== 0) muteAd(video);
    }, true);

    // Safety net only: 2 s instead of the old 150 ms poll, and idle while the
    // tab is hidden or the site switch is off.
    setInterval(() => {
      if (document.hidden || CTV.state.disabled) return;
      tick();
    }, 2000);

    // Switched off at injection: no muting and no observers until re-enabled.
    if (CTV.state.disabled) return;
    tick();
  }

  start();
})();
