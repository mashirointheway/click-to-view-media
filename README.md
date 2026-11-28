# Click to View Media

**Images and video stay blurred until you click. Click again to hide. YouTube ads get muted and skipped.**

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-1f56ff?style=flat-square)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![Firefox Android](https://img.shields.io/badge/Firefox%20Android-142%2B-ff7139?style=flat-square&logo=firefoxbrowser&logoColor=white)](https://www.mozilla.org/firefox/browsers/mobile/android/)
[![No data collection](https://img.shields.io/badge/Data%20collection-none-2ea043?style=flat-square&labelColor=121620)](#permissions--privacy)

Click to View Media treats every page like someone is reading over your shoulder. Images, video, and likely CSS background images start blurred and dimmed. One click reveals the exact item you clicked — everything else stays hidden. Click it again when you're done.

Built for Chrome and Firefox for Android Beta. Everything runs locally: no account, no server, no telemetry.

- **Landing page:** https://mashirointheway.github.io/click-to-view-media/
- **Source:** https://github.com/mashirointheway/click-to-view-media

---

## Features

| Feature | What it does |
|---|---|
| **Per-item toggle** | Every image and video is independent. Revealing one never reveals the rest of the page. Click the same item again to blur it. Media stacked in the same spot — a placeholder image under the real one, a thumbnail under a preview video — counts as one item, so one click covers the whole stack and one button serves it. |
| **Reveal button on large media** | Images and video at least 150px wide and tall show a translucent **Click to view** button above the page's own overlays, so media covered by tag markers or other controls can still be revealed. |
| **Adjustable blur** | Set blur from **18px to 100px** in the popup. The value is saved and applied to media already on the page; if a write fails, the popup says so instead of silently dropping it. |
| **Per-address off switch** | Turn blur off for the current address from the popup — YouTube muting and skipping stop there too. The choice is remembered per site; every other site stays blurred. It also covers iframes in that tab: each frame follows the address bar's site, so media in a cross-origin iframe of a disabled site is no longer blurred and a YouTube embed stops its ad handling. |
| **Broad media coverage** | `<img>`, `<video>`, `<input type="image">`, SVG `<image>`, chat emotes and emoji (including CSS-background emotes), and heuristic CSS `background-image` elements such as avatars, banners, thumbnails, and `role="img"`. |
| **Dynamic pages** | Lazy-loaded media, single-page navigation, and open shadow roots are picked up as they appear — media and the **Click to view** button inside an open shadow root are covered too, because the overlay styles are adopted into each shadow root. New media is blurred in the same tick it is inserted, so it never flashes unblurred; layout reads are batched into one animation frame instead of running in the mutation observer. |
| **YouTube ads** | Ads are muted when they start, your previous mute/volume state is restored afterwards, and Skip is clicked as soon as it appears. Works on desktop YouTube and `m.youtube.com`. |
| **Local by design** | No network calls and no data collection. Everything is in `browser.storage.local` on both Chrome and Firefox: settings are per device and no longer sync across Chrome profiles. Per-site exceptions use one key per host, so there is no list-size limit and no write race between popup windows. |

Revealing and hiding only undo our own changes: saved inline styles, titles, and video properties are restored only if the page has not replaced them in the meantime.

---

## Install on Chrome

1. Download the repository ZIP:
   https://github.com/mashirointheway/click-to-view-media/archive/refs/heads/main.zip
2. Unzip it somewhere permanent — Chrome reads the extension from that folder.
3. Open `chrome://extensions` and turn on **Developer mode**.
4. Click **Load unpacked** and select the folder that contains `manifest.json`.
5. Pin the extension, open its popup, and choose your blur intensity. Refresh open tabs to apply it everywhere.

The same folder also works in other Chromium browsers that support MV3 unpacked extensions, such as Edge and Brave.

**Upgrading from 1.5.x or 1.6.x:** 2.0.0 changes the storage layout, so your old per-site exception list is ignored and per-site exceptions are reset. Re-toggle the sites you want blur turned off on.

---

## Install on Firefox for Android (Beta) — local only

This build is **not published or signed on AMO**. It installs temporarily over USB with [`web-ext`](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/). That makes it a development install, not a store install.

### Requirements

- Firefox **Beta** for Android, version **142 or newer**
- Node.js **18 or newer** on your computer
- A USB cable
- **Developer options** and **USB debugging** enabled on the phone
- `adb` available on your `PATH`

### Steps

```bash
# 1. Build the Firefox version into dist/firefox
npm run build:firefox

# 2. Confirm the phone is visible
adb devices

# 3. Install and launch the temporary add-on
npm run run:android
```

There is nothing to install first. Node.js 18+ is enough; the first `web-ext` command is fetched on demand by `npx` and cached for later runs.

`run:android` targets `org.mozilla.firefox_beta` and keeps running in the terminal while you test. Leave it open.

Then, in Firefox on the phone:

1. Open the menu.
2. Go to **Extensions**.
3. Tap **Click to View Media** to open the blur popup.

### Good to know

- The web-ext install is **temporary**. Firefox removes the add-on when the browser process ends. Re-run `npm run run:android` to load it again.
- A permanent Android install would require an AMO-signed XPI. This project deliberately does not produce one.
- If more than one device is connected, append `--adb-device=<serial>` to the `web-ext` command.
- If web-ext cannot find Firefox Beta, confirm the APK name is `org.mozilla.firefox_beta` or pass `--firefox-apk=org.mozilla.firefox_beta`.
- Settings are stored in `browser.storage.local` on both Chrome and Firefox, so they stay on that device — they no longer sync across Chrome profiles. Per-site exceptions are reset when upgrading from 1.5.x/1.6.x (see above).

---

## Usage

- **Reveal:** click or tap a blurred image or video. Only that item is revealed. Several media elements stacked in the same spot reveal and hide together, so a placeholder under the real picture does not need a second click. Large media also shows a translucent **Click to view** button that works even when the page puts its own controls or tag markers on top of the media.
- **Hide:** click or tap the revealed item again. It returns to its original blur. Media inside a button or link is the exception: once revealed, the next click goes to the control so it can be used — but large media revealed with the **Click to view** button always hides again.
- **Blur amount:** open the toolbar popup (Chrome) or the Extensions menu (Firefox Android) and move the slider. Changes apply immediately to open pages.
- **Per-address off switch:** open the popup and turn off **Blur on this site**. Blur and YouTube ad handling stop on that address immediately; turn it back on to restore them. The exception is saved per address (host, including port) and also applies inside iframes of that tab: a frame follows the address bar's site, so media in a cross-origin iframe of a disabled site is no longer blurred and a YouTube embed stops its ad handling too.
- **YouTube:** ad audio is muted automatically while an ad is playing, previous volume is restored when it ends, and the Skip button is clicked when available.

The first click on a blurred image is always used to reveal it, even when the image is wrapped in a button or link. Once it is revealed, the next click reaches the control, so image buttons and linked thumbnails still work. A revealed image that is not part of a control hides again instead. Large media revealed with the **Click to view** button is the exception: clicking it again hides it, even when the page puts its own clickable overlay above the image.

---

## Build, lint, and package

```bash
npm test                  # dependency-free Node tests + the version check
npm run test:dom          # optional: run the media engine and popup in jsdom
npm run check:versions    # verify package.json, both manifests, README and index.html agree
npm run version:sync      # write package.json's version into both manifests
npm run build:firefox     # copy shared files + Firefox manifest into dist/firefox
npm run lint:firefox      # web-ext lint (runs the build first)
npm run package:firefox   # unsigned zip in web-ext-artifacts/
npm run run:android       # build + install on Firefox Android Beta over USB
npm run icons             # regenerate icons/icon-{16,32,48,128}.png
```

`package.json` is the single source of truth for the version. `npm run version:sync` writes it into both manifests; `npm run check:versions` verifies `package.json`, both manifests, `README.md`, and `index.html`. `build:firefox` also fails if a manifest's version drifts from `package.json`.

`build:firefox`, `version:sync`, `check:versions`, `test`, and `icons` use plain Node. The `web-ext` commands (`lint`, `package`, `run:android`) run through `npx` and are downloaded on first use, then cached by npm — no `npm install` or `node_modules` needed. The tests live in `test/` and cover the shared config/storage module and the project wiring (manifest references, file layout, syntax checks). `npm run test:dom` is optional and exercises the real blur engine and popup in jsdom; it needs `npm i --no-save jsdom` first.

### Project structure

```
src/shared.js           config, storage and event plumbing (loaded by content scripts and popup)
src/media.js            blur / reveal / overlay engine
src/youtube.js          event-driven YouTube ad mute/skip
src/popup.js            popup logic
popup.html              shared popup UI, responsive for Android
background.js           MV3 background service worker; answers "what is this tab's top-level URL?"
manifest.json           Chrome MV3 manifest
manifest.firefox.json   Firefox MV3 manifest (gecko id, Android minimum)
icons/                  generated 16/32/48/128 px icons
scripts/                Firefox build, icon and version scripts
test/                   dependency-free Node tests (shared config/storage, project wiring)
index.html              GitHub Pages landing page
dist/firefox/           generated Firefox build (git ignored)
web-ext-artifacts/      generated zips (git ignored)
```

The Chrome and Firefox builds share the same `src/` scripts, `popup.html`, and `background.js`. Only the manifest differs. Both manifests must have the same version as `package.json`; the build script fails if they drift.

---

## Permissions & privacy

- **`storage`** — saves the blur value and the per-site off switches (one key per host) in `browser.storage.local` on both Chrome and Firefox. Storage is local-only; nothing syncs between devices or Chrome profiles.
- **`<all_urls>` host permission** — required for the content script to blur media on any page you visit, and for the background worker to read the tab's URL.
- **Background service worker** — content scripts in iframes ask it for the tab's top-level URL so they can follow the address bar's site switch. It reads `sender.tab.url` in memory and replies; nothing is stored or sent anywhere.
- **No data collection.** `manifest.firefox.json` declares `browser_specific_settings.gecko.data_collection_permissions.required: ["none"]`.
- **No network requests** are made by the extension. Nothing is sent anywhere.

YouTube ad handling is best-effort and depends on YouTube's current player markup. It may need updating when YouTube changes its player.

---

## Limitations

- CSS `background-image` detection is heuristic. Complex compositions, canvas-rendered media, and closed shadow roots may not be covered.
- Sites that aggressively re-render media may need a refresh before the blur applies.
- Clicking a revealed video toggles it back to blurred; native video controls are affected by the same click.
- Mobile YouTube player markup changes more often than desktop, so ad skipping is less reliable there.
- The Firefox Android install is temporary by design (see above).

---

## Version

**2.0.0** — Chrome MV3 · Firefox for Android Beta 142+ · local-only settings on both browsers.

Not affiliated with YouTube or Google.
