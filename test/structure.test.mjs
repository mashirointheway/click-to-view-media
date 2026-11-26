// Structural checks for the extension layout and its metadata.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(name) {
  return JSON.parse(readFileSync(join(ROOT, name), "utf8"));
}

function readText(name) {
  return readFileSync(join(ROOT, name), "utf8");
}

// Collect every file path a manifest can cause the browser to load.
function manifestFiles(manifest) {
  const files = [];
  for (const contentScript of manifest.content_scripts || []) {
    for (const file of contentScript.js || []) files.push(file);
  }
  if (manifest.background && manifest.background.service_worker) {
    files.push(manifest.background.service_worker);
  }
  for (const file of (manifest.background && manifest.background.scripts) || []) {
    files.push(file);
  }
  if (manifest.action && manifest.action.default_popup) {
    files.push(manifest.action.default_popup);
  }
  for (const icons of [manifest.icons, manifest.action && manifest.action.default_icon]) {
    if (icons) {
      for (const value of Object.values(icons)) files.push(value);
    }
  }
  return files;
}

test("metadata versions agree and docs advertise the same version", () => {
  const pkg = readJson("package.json");
  const chrome = readJson("manifest.json");
  const firefox = readJson("manifest.firefox.json");
  const version = pkg.version;

  assert.ok(version, "package.json must declare a version");
  assert.equal(chrome.version, version, "manifest.json version drifted");
  assert.equal(firefox.version, version, "manifest.firefox.json version drifted");

  assert.ok(
    readText("README.md").includes(`**${version}**`),
    `README.md must contain **${version}**`
  );

  const index = readText("index.html");
  assert.ok(
    index.includes(`v${version}`) || index.includes(`version ${version}`),
    `index.html must contain v${version} or version ${version}`
  );
});

test("Chrome manifest declares the shared content scripts in order", () => {
  const manifest = readJson("manifest.json");
  const contentScript = manifest.content_scripts && manifest.content_scripts[0];
  assert.ok(contentScript, "manifest.json must have a content_scripts entry");

  assert.deepEqual(contentScript.js, ["src/shared.js", "src/media.js", "src/youtube.js"]);
  assert.ok(contentScript.matches.includes("<all_urls>"), "matches must include <all_urls>");
  assert.equal(contentScript.run_at, "document_start");
  assert.equal(contentScript.all_frames, true);
});

test("both manifests point at a real background entry file", () => {
  const chrome = readJson("manifest.json");
  const firefox = readJson("manifest.firefox.json");

  const worker = chrome.background && chrome.background.service_worker;
  assert.ok(worker, "manifest.json must declare background.service_worker");
  assert.ok(existsSync(join(ROOT, worker)), `${worker} must exist`);

  const script = firefox.background && firefox.background.scripts && firefox.background.scripts[0];
  assert.ok(script, "manifest.firefox.json must declare background.scripts[0]");
  assert.ok(existsSync(join(ROOT, script)), `${script} must exist`);
});

test("the popup is declared and loads shared.js before popup.js", () => {
  const manifest = readJson("manifest.json");
  const popup = manifest.action && manifest.action.default_popup;
  assert.ok(popup, "action.default_popup must be set");
  assert.ok(existsSync(join(ROOT, popup)), `${popup} must exist`);

  const html = readText("popup.html");
  const sharedIndex = html.indexOf("src/shared.js");
  const popupIndex = html.indexOf("src/popup.js");
  assert.ok(sharedIndex !== -1, "popup.html must reference src/shared.js");
  assert.ok(popupIndex !== -1, "popup.html must reference src/popup.js");
  assert.ok(sharedIndex < popupIndex, "src/shared.js must come before src/popup.js");
});

test("legacy root-level scripts no longer exist", () => {
  assert.equal(existsSync(join(ROOT, "content.js")), false, "content.js should be removed");
  assert.equal(existsSync(join(ROOT, "popup.js")), false, "popup.js should be removed");
});

test("every file referenced by either manifest exists on disk", () => {
  for (const name of ["manifest.json", "manifest.firefox.json"]) {
    const files = manifestFiles(readJson(name));
    assert.ok(files.length > 0, `${name} must reference at least one file`);
    for (const file of files) {
      assert.ok(existsSync(join(ROOT, file)), `${name} references missing file: ${file}`);
    }
  }
});

test("background.js and every src/*.js file pass node --check", () => {
  const srcDir = join(ROOT, "src");
  const files = [
    "background.js",
    ...readdirSync(srcDir)
      .filter(name => name.endsWith(".js"))
      .map(name => join("src", name)),
  ];

  assert.ok(files.length > 1, "expected background.js plus at least one src/*.js file");
  for (const file of files) {
    try {
      execFileSync(process.execPath, ["--check", join(ROOT, file)], { stdio: "pipe" });
    } catch (error) {
      const detail = (error.stderr && error.stderr.toString()) || error.message;
      assert.fail(`${file} failed node --check: ${detail.trim()}`);
    }
  }
});
