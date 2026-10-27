/**
 * Zotero → SiYuan — the static checks for The packaged XPI.
 *
 * Part of `node tools/validate.mjs`: this file runs when it is imported, and
 * the entry point prints the summary. `check()` and `section()` come from
 * `harness.mjs`, together with the source readers.
 */

import {
  ROOT,
  NAMESPACE,
  check,
  section,
} from "./harness.mjs";
import zlib from "node:zlib";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/* --------------------------- 4. packaged XPI ---------------------------- */

section("Packaged XPI");
const xpi = join(ROOT, "zotero-siyuan.xpi");
if (!existsSync(xpi)) {
  check("zotero-siyuan.xpi exists (run `npm run build`)", false);
} else {
  const raw = readFileSync(xpi);
  check("zotero-siyuan.xpi is a ZIP archive", raw[0] === 0x50 && raw[1] === 0x4b);
  const text = raw.toString("latin1");
  for (const needed of [
    "manifest.json",
    "bootstrap.js",
    "prefs.js",
    `content/scripts/${NAMESPACE}.js`,
    `locale/en-US/${NAMESPACE}-addon.ftl`,
    `locale/zh-CN/${NAMESPACE}-addon.ftl`,
  ]) {
    check(`XPI contains ${needed}`, text.includes(needed));
  }
  // The local header names are enough to read manifest.json / prefs.js back.
  const readFromArchive = (name) => {
    const marker = Buffer.from(name, "utf8");
    let at = 0;
    while ((at = raw.indexOf(marker, at)) !== -1) {
      const localHeader = at - 30;
      if (localHeader >= 0 && raw.readUInt32LE(localHeader) === 0x04034b50) {
        const method = raw.readUInt16LE(localHeader + 8);
        const compSize = raw.readUInt32LE(localHeader + 18);
        const start = at + marker.length;
        const data = raw.subarray(start, start + compSize);
        if (method === 0) return data.toString("utf8");
        return zlibInflateRaw(data).toString("utf8");
      }
      at += marker.length;
    }
    return null;
  };
  const manifestText = readFromArchive("manifest.json");
  if (manifestText) {
    let manifest = null;
    try {
      manifest = JSON.parse(manifestText);
    }
    catch (e) {
      /* reported below */
    }
    if (!manifest) {
      check("manifest.json is valid JSON", false);
    } else {
      const z = (manifest.applications || {}).zotero || {};
      check("manifest has applications.zotero.id", typeof z.id === "string" && z.id.includes("@"), z.id);
      check("manifest has strict_min_version", typeof z.strict_min_version === "string", z.strict_min_version);
      check("manifest has strict_max_version", typeof z.strict_max_version === "string", z.strict_max_version);
      check("manifest_version is 2", manifest.manifest_version === 2);
      // Firefox caches an installed extension by its id *and version*: replace
      // the .xpi in the profile with the same version and the old code keeps
      // running. So the version has to move with every build.
      const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
      check(
        "the manifest version matches package.json",
        manifest.version === pkg.version,
        `manifest ${manifest.version} vs package ${pkg.version}`,
      );
      // The version is also written into the code, so the running plugin
      // can say which build it is. The addon's own cache cannot be
      // trusted for that.
      const versionFile = join(ROOT, "src", "version.js");
      const inCode = existsSync(versionFile)
        ? /export const VERSION = "([^"]+)";/.exec(
          readFileSync(versionFile, "utf8"),
        )
        : null;
      check(
        "the version in the code matches the manifest",
        !!inCode && inCode[1] === manifest.version,
        inCode ? inCode[1] : "no version in the code",
      );
      // The lock file names the version as well, and `npm ci` compares
      // it with package.json: a lock file that was left behind makes the
      // install step fail with a version mismatch. It did exactly that
      // here — the lock file sat at 0.2.54 while everything else was at
      // 0.2.95 — so the fourth place is checked as well.
      const lock = JSON.parse(
        readFileSync(join(ROOT, "package-lock.json"), "utf8"),
      );
      check(
        "the lock file's version matches package.json",
        lock.version === pkg.version,
        `lock ${lock.version} vs package ${pkg.version}`,
      );
      check(
        "the lock file's root package matches package.json",
        !!lock.packages &&
          !!lock.packages[""] &&
          lock.packages[""].version === pkg.version,
        lock.packages && lock.packages[""]
          ? lock.packages[""].version
          : "no root package in the lock file",
      );
    }
  } else {
    check("manifest.json readable from the XPI", false);
  }
  const prefsText = readFromArchive("prefs.js");
  if (prefsText) {
    const bad = prefsText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//") && !l.startsWith("#") && !/^pref\("/.test(l));
    check(
      "prefs.js only contains double-quoted pref(...) lines",
      bad.length === 0,
      bad.join(" | "),
    );
  } else {
    check("prefs.js readable from the XPI", false);
  }
}

// Minimal raw-deflate inflater (the archive stores deflate streams).
function zlibInflateRaw(buf) {
  return zlib.inflateRawSync(buf);
}
