// Optional DOM smoke test: runs the real media engine and popup in jsdom.
//
//   npm i --no-save jsdom
//   npm run test:dom
//
// It is not part of `npm test` so the project stays dependency-free.
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const sharedSrc = readFileSync(join(repo, "src/shared.js"), "utf8");
const mediaSrc = readFileSync(join(repo, "src/media.js"), "utf8");
const popupSrc = readFileSync(join(repo, "src/popup.js"), "utf8");
const popupHtml = readFileSync(join(repo, "popup.html"), "utf8");

let passed = 0;
const failures = [];
function ok(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}`);
  }
}
const wait = ms => new Promise(r => setTimeout(r, ms));

function makeStorage(store) {
  return {
    local: {
      async get(defaults) {
        const out = { ...defaults };
        for (const key of Object.keys(defaults)) if (key in store) out[key] = store[key];
        return out;
      },
      async set(values) { Object.assign(store, values); },
      async remove(keys) { for (const key of [].concat(keys)) delete store[key]; },
    },
    onChanged: {
      listeners: new Set(),
      addListener(fn) { this.listeners.add(fn); },
      removeListener(fn) { this.listeners.delete(fn); },
    },
  };
}

function fireChange(win, changes) {
  for (const fn of win.chrome.storage.onChanged.listeners) fn(changes, "local");
}

// ---------------------------------------------------------------- media ----
{
  const store = {};
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <img id="pic" src="a.png" alt="a">
      <div id="bg" class="avatar" style="background-image: url(bg.png)"></div>
      <video id="vid" autoplay preload="auto"></video>
      <a id="link" href="#x"><img id="linked" src="b.png" alt="b"></a>
      <div id="host"></div>
    </body></html>`,
    { url: "https://example.com/page", runScripts: "outside-only", pretendToBeVisual: true }
  );
  const { window } = dom;
  const { document } = window;
  const errors = [];
  window.addEventListener("error", event => errors.push(String(event.error || event.message)));

  window.chrome = { storage: makeStorage(store), runtime: { sendMessage: async () => ({ url: "https://example.com/page" }) } };
  window.Element.prototype.getBoundingClientRect = function () {
    // Give each media a distinct size so the test can tell their overlay
    // buttons apart.
    const size = this.id === "vid" ? 300 : this.id === "bg" ? 250 : 200;
    return { left: 0, top: 0, right: size, bottom: size, width: size, height: size, x: 0, y: 0, toJSON() {} };
  };

  const shadowRoot = document.getElementById("host").attachShadow({ mode: "open" });
  shadowRoot.innerHTML = '<img id="shadow-pic" src="c.png" alt="c">';

  window.eval(sharedSrc);
  window.eval(mediaSrc);
  await wait(300);

  console.log("media engine");
  const pic = document.getElementById("pic");
  const vid = document.getElementById("vid");
  const bg = document.getElementById("bg");
  const linked = document.getElementById("linked");
  const shadowPic = shadowRoot.getElementById("shadow-pic");

  ok(errors.length === 0, `no uncaught errors (${errors.join("; ") || "none"})`);
  ok(pic.getAttribute("data-click-to-view-media") === "hidden", "img is marked hidden");
  ok(pic.style.getPropertyValue("filter").includes("blur"), "img has the blur filter");
  ok(pic.getAttribute("title") === "Click to reveal this media", "img gets the reveal title");
  ok(vid.getAttribute("data-click-to-view-media") === "hidden", "video is marked hidden");
  ok(vid.getAttribute("autoplay") === null, "video autoplay removed");
  ok(vid.getAttribute("preload") === "none", "video preload set to none");
  ok(shadowPic.getAttribute("data-click-to-view-media") === "hidden", "shadow DOM img is marked hidden");
  const bgHidden = bg.getAttribute("data-click-to-view-media") === "hidden";
  ok(bgHidden, `CSS background is marked hidden (computed: ${window.getComputedStyle(bg).backgroundImage || "n/a"})`);

  const overlay = document.querySelector("[data-click-to-view-overlay]");
  ok(!!overlay, "overlay button exists for the large image");
  ok(!!overlay && overlay.parentElement === pic.parentElement, "overlay button sits next to the image");
  ok(!!overlay && overlay.getAttribute("aria-label") === "Click to view media", "overlay button is labelled");

  // reveal by clicking the image
  pic.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
  await wait(50);
  ok(pic.getAttribute("data-click-to-view-revealed") === "true", "click reveals the img");
  ok(pic.getAttribute("data-click-to-view-media") === null, "revealed img drops the hidden mark");
  ok(pic.style.getPropertyValue("filter") === "", "revealed img drops the blur");
  ok(pic.getAttribute("title") === null, "revealed img restores the title");

  // hide again
  pic.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
  await wait(50);
  ok(pic.getAttribute("data-click-to-view-media") === "hidden", "second click hides the img again");
  ok(pic.getAttribute("data-click-to-view-revealed") === null, "hidden img drops the revealed mark");

  // media inside a link: first click reveals, second passes through
  linked.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
  await wait(50);
  ok(linked.getAttribute("data-click-to-view-revealed") === "true", "linked img reveals on first click");
  linked.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
  await wait(50);
  ok(linked.getAttribute("data-click-to-view-revealed") === "true", "linked img stays revealed so the link can be used");

  // shadow DOM click
  shadowPic.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
  await wait(50);
  ok(shadowPic.getAttribute("data-click-to-view-revealed") === "true", "shadow DOM img reveals on click");

  // overlay button click (pic is hidden again after step 3)
  const overlay2 = [...document.querySelectorAll("[data-click-to-view-overlay]")]
    .find(button => button.style.width === "200px");
  ok(!!overlay2, "overlay button is back after re-hiding");
  if (overlay2) {
    overlay2.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
    await wait(50);
    ok(pic.getAttribute("data-click-to-view-revealed") === "true", "overlay click reveals the media");
    // A second click on the revealed media hides it again.
    pic.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
    await wait(50);
    ok(pic.getAttribute("data-click-to-view-media") === "hidden", "revealed media hides again on click");
  }

  // blur setting change
  fireChange(window, { blurPx: { newValue: 40 } });
  await wait(50);
  ok(document.documentElement.style.getPropertyValue("--click-to-view-blur") === "40px", "blur change applies to the page");

  // per-site off switch
  fireChange(window, { "off:example.com": { newValue: true } });
  await wait(100);
  ok(pic.getAttribute("data-click-to-view-media") === null, "site off switch unblurs media");
  ok(vid.getAttribute("data-click-to-view-media") === null, "site off switch unblurs video");
  ok(!document.querySelector("[data-click-to-view-overlay]"), "site off switch removes overlay buttons");

  fireChange(window, { "off:example.com": { newValue: false } });
  await wait(200);
  ok(pic.getAttribute("data-click-to-view-media") === "hidden", "site on switch blurs again");
  ok(vid.getAttribute("data-click-to-view-media") === "hidden", "site on switch blurs video again");
}

// ---------------------------------------------------------------- popup ----
{
  const store = {};
  const dom = new JSDOM(popupHtml, { url: "https://example.com/", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const { document } = window;
  const errors = [];
  window.addEventListener("error", event => errors.push(String(event.error || event.message)));
  window.chrome = {
    storage: makeStorage(store),
    tabs: { query: async () => [{ url: "https://example.com/article" }] },
    runtime: { lastError: null },
  };

  window.eval(sharedSrc);
  window.eval(popupSrc);
  await wait(150);

  console.log("popup");
  const slider = document.getElementById("blur");
  const output = document.getElementById("blur-value");
  const hint = document.getElementById("blur-hint");
  const reset = document.getElementById("reset");
  const toggle = document.getElementById("site-enabled");
  const siteHint = document.getElementById("site-hint");
  const saveStatus = document.getElementById("save-status");

  ok(errors.length === 0, `no uncaught errors (${errors.join("; ") || "none"})`);
  ok(slider.min === "18" && slider.max === "100", "slider bounds come from config");
  ok(slider.value === "18" && output.textContent === "18px", "slider renders the default");
  ok(hint.textContent.includes("Minimum is 18px"), "blur hint is filled from config");
  ok(reset.textContent === "Reset to 18px", "reset label is filled from config");
  ok(toggle.checked === true && toggle.disabled === false, "site switch starts on");
  ok(siteHint.textContent === "Blur is on for example.com.", "site hint names the site");

  toggle.checked = false;
  toggle.dispatchEvent(new window.Event("change", { bubbles: true }));
  await wait(100);
  ok(store["off:example.com"] === true, "switching off writes the per-site key");
  ok(siteHint.textContent === "Blur is off on example.com.", "site hint follows the switch");

  toggle.checked = true;
  toggle.dispatchEvent(new window.Event("change", { bubbles: true }));
  await wait(100);
  ok(!("off:example.com" in store), "switching on removes the per-site key");

  const realRemove = window.chrome.storage.local.remove;
  window.chrome.storage.local.remove = async () => { throw new Error("quota"); };
  toggle.checked = false;
  toggle.dispatchEvent(new window.Event("change", { bubbles: true }));
  await wait(100);
  toggle.checked = true;
  toggle.dispatchEvent(new window.Event("change", { bubbles: true }));
  await wait(100);
  ok(toggle.checked === false, "failed write reverts the switch");
  ok(saveStatus.hidden === false && saveStatus.textContent.includes("Could not save"), "failed write is reported");
  window.chrome.storage.local.remove = realRemove;

  slider.value = "55";
  slider.dispatchEvent(new window.Event("change", { bubbles: true }));
  await wait(100);
  ok(store.blurPx === 55, "slider change saves the blur value");
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("failures:\n" + failures.map(f => " - " + f).join("\n"));
  process.exit(1);
}
process.exit(0);
