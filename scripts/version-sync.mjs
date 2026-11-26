import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

// Only the two manifest files are touched; docs are updated by hand.
for (const file of ["manifest.json", "manifest.firefox.json"]) {
  const path = join(root, file);
  const source = readFileSync(path, "utf8");
  const match = source.match(/("version"\s*:\s*)"([^"]*)"/);
  if (!match) {
    throw new Error(`Could not find a version field in ${file}.`);
  }
  if (match[2] === version) {
    console.log(`${file}: already ${version}`);
  } else {
    writeFileSync(path, source.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`));
    console.log(`${file}: ${match[2]} -> ${version}`);
  }
}
