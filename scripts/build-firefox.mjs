import {
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  cpSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "dist", "firefox");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const chromeManifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const firefoxManifest = JSON.parse(readFileSync(join(root, "manifest.firefox.json"), "utf8"));

// package.json is the single source of truth for the version.
for (const [name, manifest] of [
  ["manifest.json", chromeManifest],
  ["manifest.firefox.json", firefoxManifest],
]) {
  if (manifest.version !== pkg.version) {
    throw new Error(
      `Version mismatch: ${name} is ${manifest.version} but package.json is ${pkg.version}.\n` +
      `Run npm run version:sync to sync the manifests, or fix ${name} manually.`
    );
  }
}

const files = new Set();
const addFile = (value) => {
  if (typeof value === "string" && value) files.add(value.replace(/^\.\//, ""));
};

// Collect files referenced by the Chrome manifest.
for (const entry of chromeManifest.content_scripts ?? []) {
  for (const file of entry.js ?? []) addFile(file);
  for (const file of entry.css ?? []) addFile(file);
}

const background = chromeManifest.background ?? {};
if (background.service_worker) addFile(background.service_worker);
for (const file of background.scripts ?? []) addFile(file);

const popup = chromeManifest.action?.default_popup;
addFile(popup);

for (const file of Object.values(chromeManifest.icons ?? {})) addFile(file);

// Collect local src/href references from the popup HTML.
if (popup) {
  const popupPath = join(root, popup);
  if (!existsSync(popupPath)) {
    throw new Error(`Missing popup file referenced by manifest.json: ${popup}`);
  }
  const html = readFileSync(popupPath, "utf8");
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    let ref = match[1].replace(/^\.\//, "");
    if (ref.startsWith("#") || ref.startsWith("//")) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) continue; // absolute URLs, including data:
    ref = ref.split(/[?#]/)[0];
    if (ref) addFile(ref);
  }
}

// Every referenced file must exist before we start writing the output.
for (const file of files) {
  if (!existsSync(join(root, file))) {
    throw new Error(`Missing referenced file: ${file} (referenced by a manifest or the popup).`);
  }
}

const iconsDir = "icons";
if (!existsSync(join(root, iconsDir))) {
  throw new Error(`Missing icons directory: ${iconsDir}`);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const file of files) {
  const destination = join(outDir, file);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(join(root, file), destination);
}

// Always include the whole icons directory, not just the sizes named in the manifest.
cpSync(join(root, iconsDir), join(outDir, iconsDir), { recursive: true });

function countFiles(directory) {
  let count = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    count += entry.isDirectory() ? countFiles(path) : 1;
  }
  return count;
}
const copied = countFiles(outDir);

// The Firefox build uses the Firefox manifest as its manifest.json.
firefoxManifest.version = pkg.version;
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(firefoxManifest, null, 2) + "\n");

console.log(`Firefox build ready: ${outDir} (v${pkg.version}), ${copied} files copied`);
