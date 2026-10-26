/**
 * Zotero → SiYuan — the static checks for The Fluent messages the plugin asks for.
 *
 * Part of `node tools/validate.mjs`: this file runs when it is imported, and
 * the entry point prints the summary. `check()` and `section()` come from
 * `harness.mjs`, together with the source readers.
 */

import {
  ROOT,
  NAMESPACE,
  files,
  paneSource,
  check,
  section,
} from "./harness.mjs";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";

/* ----------------------- 3. Fluent ids resolve -------------------------- */

section("Fluent messages");
function ftlIds(file) {
  const ids = new Set();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([a-zA-Z][\w-]*)\s*=/);
    if (m) ids.add(m[1]);
  }
  return ids;
}
const localeFiles = {
  "en-US": join(ROOT, "addon", "locale", "en-US", "addon.ftl"),
  "zh-CN": join(ROOT, "addon", "locale", "zh-CN", "addon.ftl"),
};
const localeIds = {};
for (const [loc, file] of Object.entries(localeFiles)) {
  check(`${loc}/addon.ftl exists`, existsSync(file));
  if (existsSync(file)) localeIds[loc] = ftlIds(file);
}
if (localeIds["en-US"] && localeIds["zh-CN"]) {
  const en = localeIds["en-US"];
  const zh = localeIds["zh-CN"];
  check(
    "en-US and zh-CN define the same message ids",
    en.size === zh.size && [...en].every((id) => zh.has(id)),
    `en=${en.size} zh=${zh.size}`,
  );
  const used = new Set();
  for (const file of files.filter((f) => extname(f) === ".js" && f.includes("src"))) {
    // `_label()` asks for a message as well — it caches the answer, but the
    // id still has to exist in both locales.
    for (const m of readFileSync(file, "utf8").matchAll(
      /(?:getString|_label)\(\s*"([^"]+)"/g,
    )) {
      used.add(m[1]);
    }
  }
  for (const id of used) {
    const bare = id.startsWith(`${NAMESPACE}-`) ? id.slice(NAMESPACE.length + 1) : id;
    check(
      `message "${id}" is defined in both locales`,
      en.has(bare) && zh.has(bare),
    );
  }
}

/* ---- 3b. the Fluent files must really parse ------------------------- */

section("Fluent syntax");
{
  // A regular expression is not enough here: Fluent reads `{` as the start
  // of a placeable, so a message whose text contains `{{variable}}` is not
  // a message at all — it is junk, and it never reaches the interface. The
  // real parser is the only thing that notices.
  const { parse } = await import("@fluent/syntax");
  for (const loc of ["en-US", "zh-CN"]) {    for (const name of ["addon.ftl", "preferences.ftl"]) {
      const file = join(ROOT, "addon", "locale", loc, name);
      if (!existsSync(file)) {
        continue;
      }
      const resource = parse(readFileSync(file, "utf8"));
      const junk = resource.body
        .filter((entry) => entry.type === "Junk")
        .map((entry) => {
          const content = entry.content;
          return typeof content === "string"
            ? content.split("\n")[0]
            : JSON.stringify(content).slice(0, 80);
        });
      check(
        `${loc}/${name} parses without junk`,
        junk.length === 0,
        junk.join(" | "),
      );
    }
  }

  // Every id the preferences pane asks for has to exist — and the ids have
  // to be the ones the interface really asks for.
  const xhtml = readFileSync(
    join(ROOT, "addon", "content", "preferences.xhtml"),
    "utf8",
  );
  const asked = [...xhtml.matchAll(/data-l10n-id="([^"]+)"/g)].map(
    (m) => m[1],
  );
  const defined = new Set();
  for (const loc of ["en-US", "zh-CN"]) {
    const file = join(ROOT, "addon", "locale", loc, "preferences.ftl");
    if (!existsSync(file)) {
      continue;
    }
    for (const entry of parse(readFileSync(file, "utf8")).body) {
      if (entry.type === "Message") {
        defined.add(entry.id.name);
      }
    }
  }
  for (const id of asked) {
    check(
      `the preferences pane's "${id}" is a real message`,
      defined.has(id),
    );
  }

  // The preferences pane has its own file, and a message that is only
  // translated in one language is a half-translated interface.
  {
    const ids = {};
    for (const loc of ["en-US", "zh-CN"]) {
      const file = join(ROOT, "addon", "locale", loc, "preferences.ftl");
      ids[loc] = existsSync(file) ? ftlIds(file) : new Set();
    }
    const en = ids["en-US"];
    const zh = ids["zh-CN"];
    check(
      "en-US and zh-CN define the same preference messages",
      en.size === zh.size && [...en].every((id) => zh.has(id)),
      `en=${en.size} zh=${zh.size}`,
    );

    // The pane's own script asks for messages too — not through
    // `data-l10n-id`, but through `_text("…")`. A key that is only in the
    // script is a half-translated interface, and the English fallback in
    // the call hides it.
    const pane = paneSource();
    const askedByScript = new Set(
      [...pane.matchAll(/_text\(\s*"(zoteroSiYuan-[^"]+)"/g)].map((m) => m[1]),
    );
    for (const id of askedByScript) {
      const bare = id.startsWith(`${NAMESPACE}-`)
        ? id.slice(NAMESPACE.length + 1)
        : id;
      check(
        `the pane's script has a message for "${id}"`,
        en.has(bare) && zh.has(bare),
      );
    }
  }
}
