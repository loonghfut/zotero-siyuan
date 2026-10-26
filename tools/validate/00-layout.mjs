/**
 * Zotero → SiYuan — the static checks for the project's own layout.
 *
 * The code is split by concern, and a split only stays useful if nothing
 * quietly falls out of it: a module nobody mixes in never runs, a pane script
 * nobody registers is dead weight, and a file that grows back to a thousand
 * lines is the problem this layout was meant to solve.
 *
 * Part of `node tools/validate.mjs`: this file runs when it is imported, and
 * the entry point prints the summary.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { ROOT, SRC_DIR, PANE_SCRIPTS, check, section } from "./harness.mjs";

section("Project layout");

/* ---- 1. no file turns back into a monolith ------------------------------ */

{
  // The ceiling is a smell test, not a rule for its own sake: a file that
  // reaches for it is usually two files.
  const LIMITS = { src: 650, tools: 700, addon: 650 };
  for (const [dir, limit] of Object.entries(LIMITS)) {
    const offenders = [];
    const walkDir = (at) => {
      for (const entry of readdirSync(at, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".scaffold") continue;
        const full = join(at, entry.name);
        if (entry.isDirectory()) {
          walkDir(full);
        }
        else if (/\.(js|mjs)$/.test(entry.name)) {
          const count = readFileSync(full, "utf8").split("\n").length;
          if (count > limit) offenders.push(`${basename(full)} (${count})`);
        }
      }
    };
    walkDir(join(ROOT, dir));
    check(
      `no file in ${dir}/ is over ${limit} lines`,
      offenders.length === 0,
      offenders.join(", ") || "none",
    );
  }
}

/* ---- 2. every behaviour module is really mixed in ---------------------- */

{
  const appDir = join(SRC_DIR, "app");
  const index = readFileSync(join(SRC_DIR, "index.js"), "utf8");
  const mixed = index.match(/Object\.assign\(\s*ZoteroSiYuanAddon\.prototype,([\s\S]*?)\);/);
  const mixedNames = new Set(
    (mixed ? mixed[1] : "")
      .split(/[\s,]+/)
      .map((n) => n.trim())
      .filter(Boolean),
  );
  const files = readdirSync(appDir)
    .filter((f) => f.endsWith(".js") && f !== "constants.js")
    .sort();
  const missing = files
    .map((f) => f.replace(/\.js$/, "").replace(/-(\w)/g, (_, c) => c.toUpperCase()))
    .filter((name) => !mixedNames.has(name));
  check(
    "every module in src/app is mixed into the addon",
    missing.length === 0,
    missing.length ? `not mixed in: ${missing.join(", ")}` : `${files.length} modules`,
  );
}

/* ---- 3. the preferences pane loads every part, and starts last --------- */

{
  const index = readFileSync(join(SRC_DIR, "index.js"), "utf8");
  const array = index.match(/scripts:\s*\[([\s\S]*?)\]/);
  const registered = (array ? array[1] : "")
    .split(",")
    .map((s) => s.trim().replace(/^"content\//, "").replace(/"$/, ""))
    .filter(Boolean);

  check(
    "the pane scripts are registered in the order the checks expect",
    registered.join("|") === PANE_SCRIPTS.join("|"),
    `registered: ${registered.join(", ")}`,
  );
  check(
    "the pane is started by the last script",
    registered[registered.length - 1] === "preferences-boot.js",
    registered[registered.length - 1] || "nothing registered",
  );
  const absent = PANE_SCRIPTS.filter(
    (name) => !existsSync(join(ROOT, "addon", "content", name)),
  );
  check(
    "every registered pane script exists",
    absent.length === 0,
    absent.join(", ") || "none missing",
  );
}

/* ---- 4. every self-test step file is imported -------------------------- */

{
  const stepsDir = join(SRC_DIR, "modules", "selftest", "steps");
  const index = readFileSync(join(SRC_DIR, "modules", "selftest", "index.js"), "utf8");
  const files = readdirSync(stepsDir).filter((f) => f.endsWith(".js"));
  const orphans = [];
  for (const file of files) {
    const source = readFileSync(join(stepsDir, file), "utf8");
    const fns = [...source.matchAll(/^export async function (\w+)\(/gm)].map((m) => m[1]);
    if (!fns.length) {
      orphans.push(`${file} has no steps`);
      continue;
    }
    const unused = fns.filter((fn) => !new RegExp(`\\b${fn}\\b`).test(index));
    if (unused.length) orphans.push(`${file}: ${unused.join(", ")}`);
  }
  check(
    "every self-test step is called by the run",
    orphans.length === 0,
    orphans.join(" | ") || `${files.length} files`,
  );
}

/* ---- 5. every doc comment belongs to a method --------------------------- */

{
  // A doc comment that sits at the end of a file — or between two members
  // with no member of its own — is a comment that was left behind when a
  // method moved. It reads as if it documented its neighbour, which is
  // worse than no comment at all.
  const stray = [];
  for (const file of readdirSync(join(SRC_DIR, "app")).filter((f) => f.endsWith(".js"))) {
    const lines = readFileSync(join(SRC_DIR, "app", file), "utf8").split("\n");
    // The block at the top of the file is the file's own header.
    const firstCode = lines.findIndex(
      (l) => l.trim() !== "" && !l.trim().startsWith("/*") && !l.trim().startsWith("*"),
    );
    for (let i = firstCode; i < lines.length; i++) {
      if (!lines[i].trim().startsWith("/**")) continue;
      let j = i;
      while (j < lines.length && !lines[j].trim().endsWith("*/")) j++;
      let k = j + 1;
      while (k < lines.length && lines[k].trim() === "") k++;
      const next = (lines[k] || "").trim();
      const documents =
        /^(async )?[A-Za-z_$][\w$]*\s*\(/.test(next) ||
        /^export (const|let|var|function|class|async function)\b/.test(next);
      if (!documents) {
        stray.push(`${file}:${i + 1}`);
      }
      i = j;
    }
  }
  check(
    "every doc comment sits directly above a method",
    stray.length === 0,
    stray.join(", "),
  );
}
