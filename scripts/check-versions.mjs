import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file), "utf8");

const pkgVersion = JSON.parse(read("package.json")).version;

const sources = [];
for (const file of ["manifest.json", "manifest.firefox.json"]) {
  sources.push({ source: file, versions: [JSON.parse(read(file)).version] });
}

const readmeMatch = read("README.md").match(/\*\*(\d+\.\d+\.\d+)\*\*/);
if (!readmeMatch) {
  console.error("README.md has no version line in the form **x.y.z**.");
  process.exit(1);
}
sources.push({ source: "README.md", versions: [readmeMatch[1]] });

const indexVersions = new Set();
for (const match of read("index.html").matchAll(/\b(?:v|version )(\d+\.\d+\.\d+)\b/gi)) {
  indexVersions.add(match[1]);
}
if (indexVersions.size === 0) {
  console.error("index.html has no version string like v1.6.0 or version 1.6.0.");
  process.exit(1);
}
sources.push({ source: "index.html", versions: [...indexVersions] });

const mismatches = [];
for (const { source, versions } of sources) {
  for (const version of versions) {
    if (version !== pkgVersion) mismatches.push({ source, version });
  }
}

if (mismatches.length > 0) {
  console.log(`package.json: ${pkgVersion}`);
  for (const { source, versions } of sources) {
    console.log(`${source}: ${versions.join(", ")}`);
  }
  console.error(
    "Version mismatch. package.json is the source of truth; update the other files or run npm run version:sync."
  );
  process.exit(1);
}

console.log(`Versions match: ${pkgVersion}`);
process.exit(0);
