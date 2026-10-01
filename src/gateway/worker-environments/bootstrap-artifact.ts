import {
  WORKER_BUNDLE_ARTIFACT_MODE,
  WORKER_BUNDLE_ARTIFACT_PATHS,
  WORKER_BUNDLE_CHUNK_PATH_PATTERN,
  WORKER_BUNDLE_MANIFEST_VERSION,
} from "../../shared/worker-bundle-hash.js";

const WORKER_ARTIFACT_PATHS_JS = `const artifactPaths = ${JSON.stringify(WORKER_BUNDLE_ARTIFACT_PATHS)};
const chunkPathPattern = new RegExp(${JSON.stringify(WORKER_BUNDLE_CHUNK_PATH_PATTERN.source)}, ${JSON.stringify(WORKER_BUNDLE_CHUNK_PATH_PATTERN.flags)});`;

export const SELECT_NPM_WORKER_FILES_JS = String.raw`const fs = require("node:fs");
${WORKER_ARTIFACT_PATHS_JS}
const prefix = "package/dist/worker/";
const selected = fs.readFileSync(process.argv[1], "utf8").split("\n").filter((entry) => {
  const name = entry.startsWith(prefix) ? entry.slice(prefix.length) : "";
  return artifactPaths.includes(name) || chunkPathPattern.test(name);
});
if (new Set(selected).size !== selected.length) throw new Error("duplicate worker package artifact");
process.stdout.write(selected.join("\n") + "\n");`;

// Recompute the gateway's canonical file manifest before a receipt can attest to it.
export const VERIFY_INSTALL_JS = String.raw`const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[1];
const expected = process.argv[2];
const install = process.argv[3];
${WORKER_ARTIFACT_PATHS_JS}
const entries = [];
function fail(message) {
  throw new Error(message);
}
function assertRoot() {
  const stats = fs.lstatSync(root);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    fail("unsafe worker install root");
  }
  fs.chmodSync(root, 0o700);
}
function assertDirectory(relative) {
  const absolute = path.join(root, ...relative.split("/"));
  const stats = fs.lstatSync(absolute);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    fail("unsafe worker directory: " + relative);
  }
  fs.chmodSync(absolute, 0o700);
}
function addFile(relative) {
  const parts = relative.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    assertDirectory(parts.slice(0, index).join("/"));
  }
  const absolute = path.join(root, ...relative.split("/"));
  const stats = fs.lstatSync(absolute);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    fail("unsafe worker file: " + relative);
  }
  const contents = fs.readFileSync(absolute);
  const mode = ${WORKER_BUNDLE_ARTIFACT_MODE};
  fs.chmodSync(absolute, mode);
  entries.push({
    path: relative,
    mode,
    size: contents.byteLength,
    sha256: crypto.createHash("sha256").update(contents).digest("hex"),
  });
}
try {
  assertRoot();
  if (install === "npm" || install === "bundle") {
    const allowedPaths = new Set([...artifactPaths, "bootstrap-receipt.json"]);
    for (const name of fs.readdirSync(root)) {
      if (chunkPathPattern.test(name)) {
        artifactPaths.push(name);
      } else if (!allowedPaths.has(name)) {
        fail("unexpected worker bundle path: " + name);
      }
    }
    for (const artifactPath of artifactPaths) addFile(artifactPath);
  } else {
    fail("invalid worker install channel");
  }
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const separator = String.fromCharCode(0);
  const hash = crypto.createHash("sha256");
  hash.update("${WORKER_BUNDLE_MANIFEST_VERSION}" + separator);
  for (const entry of entries) {
    hash.update(entry.path + separator + entry.mode.toString(8) + separator + entry.size + separator + entry.sha256 + separator);
  }
  process.exit(hash.digest("hex") === expected ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}`;
