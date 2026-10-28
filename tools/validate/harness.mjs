/**
 * Zotero → SiYuan — the harness the checks share.
 *
 * Every suite in `tools/validate/` imports `check()` and `section()` from
 * here, together with the readers that hand it the plugin's own source. The
 * counters live here too, so a suite only has to record its results — the
 * entry point decides what to print and what to exit with.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

// `tools/validate/harness.mjs` sits two levels below the project root.
export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const NAMESPACE = "zoteroSiYuan";

let failures = 0;
let checks = 0;

export function check(name, ok, detail) {
  checks++;
  if (ok) {
    console.log(`  [OK]   ${name}`);
  } else {
    failures++;
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}

export function section(title) {
  console.log(`\n=== ${title} ===`);
}

export function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".scaffold") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

export const files = walk(ROOT);

/*
 * The plugin's own source, as one string.
 *
 * A check that asks "does the plugin do X" must not care which file X lives
 * in — the code is split by concern, and moving a method from one file to
 * another is not a behaviour change.
 */
export const SRC_DIR = join(ROOT, "src");
export const srcFiles = walk(SRC_DIR).filter((f) => extname(f) === ".js");
export const readSrc = (rel) => readFileSync(join(SRC_DIR, rel), "utf8");
export const allSource = srcFiles.map((f) => readFileSync(f, "utf8")).join("\n");

/*
 * The preferences pane, as one string.
 *
 * Zotero loads these scripts into a single scope, in this order: the first
 * one creates the object, the middle ones add their methods to it, and the
 * last one starts the pane. A check that asks "does the pane do X" has to
 * look at all of them — and the order here is the order of registration.
 */
export const PANE_SCRIPTS = [
  "preferences.js",
  "preferences-template.js",
  "preferences-variables.js",
  "preferences-pictures.js",
  "preferences-sending.js",
  "preferences-actions.js",
  "preferences-boot.js",
];
/*
 * The self test, as one string.
 *
 * It lives in a package: the run itself, the report, the fixtures, the
 * preferences pane test, and one file per group of steps. A check that asks
 * "does the self test do X" has to look at all of them.
 */
export const selfTestSource = () =>
  [
    join(SRC_DIR, "modules", "selftest", "index.js"),
    ...walk(join(SRC_DIR, "modules", "selftest")).filter((f) =>
      extname(f) === ".js",
    ),
  ]
    .filter((f, i, all) => all.indexOf(f) === i)
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");

export const paneSource = () =>
  PANE_SCRIPTS.map((name) =>
    readFileSync(join(ROOT, "addon", "content", name), "utf8"),
  ).join("\n");

/*
 * The picture package, as one string.
 *
 * `src/modules/siyuan-image.js` is only the face of it — the work lives in
 * `src/modules/picture/`, one file per concern. A check that asks what the
 * plugin does with a picture has to read all of it.
 */
export const PICTURE_PARTS = ["annotation.js", "bytes.js", "assets.js"];
export const pictureParts = () =>
  PICTURE_PARTS.map((name) => join(SRC_DIR, "modules", "picture", name));
export const pictureSource = () =>
  pictureParts()
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");

/** Print the result and exit — a failing check fails the build. */
export function report() {
  console.log(
    `\n${failures ? "FAILED" : "PASSED"}: ${checks - failures}/${checks} checks passed`,
  );
  // Setting the code lets Node close the handles the checks opened (the
  // kernel probe's HTTP connection) before it exits. `process.exit()` here
  // made Windows Node abort on a closing handle, so a run that had passed
  // every check still ended with a non-zero status.
  process.exitCode = failures ? 1 : 0;
}
