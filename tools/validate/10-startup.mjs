/**
 * Zotero → SiYuan — the static checks for Startup and the self test.
 *
 * Part of `node tools/validate.mjs`: this file runs when it is imported, and
 * the entry point prints the summary. `check()` and `section()` come from
 * `harness.mjs`, together with the source readers.
 */

import {
  ROOT,
  allSource,
  selfTestSource,
  check,
  section,
} from "./harness.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ---------------------- 3b. the plugin keeps quiet ---------------------- */

section("Startup and self test");
{
  const prefs = readFileSync(join(ROOT, "addon", "prefs.js"), "utf8");
  const index = allSource;
  const selfTest = selfTestSource();

  check(
    "the self test is off by default",
    /pref\("selfTest",\s*"0"\)/.test(prefs) &&
      /prefFlag\("selfTest"\)/.test(index),
  );
  check(
    "nothing is spawned and nothing is scanned at startup",
    // Resolving the CLI runs a process; a full index scan walks the whole
    // workspace with a query no index can help with.
    !/resolveExecutable\(\)/.test(
      index.slice(
        index.indexOf("async onStartup()"),
        index.indexOf("async onShutdown()"),
      ),
    ) &&
      !/this\.refreshIndex\(\)/.test(
        index.slice(
          index.indexOf("async onStartup()"),
          index.indexOf("async onShutdown()"),
        ),
      ),
  );
  check(
    "the reader is only touched when the test was asked for",
    selfTest.includes("if (!ui)") &&
      index.includes("ui: false"),
  );
  check(
    "the test's own send does not announce itself",
    /if \(!hooks\) \{\s*\n\s*this\._flash/.test(index) &&
      index.includes("this._notify(result, doc)") &&
      index.includes("if (!hooks) {"),
  );
  check(
    "the self test asks for the sibling blocks it has to delete",
    // A note is usually more than one block, and the test deletes what it
    // wrote — so it is the one caller that wants the whole list. A real
    // send does not, because that list costs a process.
    selfTest.includes("{ collectBlocks: true }") &&
      index.includes("collectBlocks: !!options.collectBlocks"),
  );
  check(
    "the sidebar watcher does not run on the startup path",
    // The first look costs a process (the index query) when a reader is
    // open, so it waits until the window is up.
    index.includes("setTimeout(tick, WATCH_FIRST_DELAY)") &&
      !/_startSidebarWatcher\(\)\s*\{[\s\S]{0,200}?\n\s*tick\(\);/.test(index),
  );
  check(
    "the sidebar watcher stops once nothing is left to patch",
    // A sidebar that is drawn with the plugin listening brings its own
    // event, so polling on after every reader is dealt with is a query per
    // second for nothing. The minimum number of looks covers a session that
    // is still being restored.
    /!state\.patched\s*&&\s*\n\s*!state\.pending/.test(index) &&
      index.includes("WATCH_MIN_TICKS") &&
      index.includes("WATCH_WINDOW_MS"),
  );
  check(
    "the watcher is not even started when no PDF is open",
    // Nothing to patch then, and every reader from now on draws its sidebar
    // with the plugin listening — polling would be a query for nobody.
    /_startSidebarWatcher\(\)\s*\{[\s\S]*?if \(!this\._openReaders\(\)\.length\)[\s\S]{0,200}?return;/
      .test(index),
  );
  check(
    "the watcher stops when the last reader is closed",
    /const readers = this\._openReaders\(\);[\s\S]{0,200}?if \(!readers\.length\)/.test(
      index,
    ),
  );
  check(
    "a reader without annotations does not keep the watcher alive",
    // The only reason to keep looking is a reader that is still loading. A
    // PDF that has nothing to show never will from here: an annotation
    // added later makes the reader draw the sidebar again, and that render
    // reaches the plugin.
    (() => {
      const body = (index.match(
        /async _patchReaderSidebars\(readers\)\s*\{([\s\S]*?)\r?\n  \},/,
      ) || ["", ""])[1];
      // The walk over the boxes of one reader, up to the end of the
      // "no boxes at all" case.
      const boxes = (body.match(
        /const boxes = doc\.querySelectorAll\("\.custom-sections"\);([\s\S]*?)\r?\n      \}/,
      ) || ["", ""])[1];
      return boxes !== "" && !boxes.includes("pending++");
    })(),
    "a reader with no annotations still counts as pending",
  );
  check(
    "the watcher gives up long before three minutes",
    (() => {
      const constants = readFileSync(
        join(ROOT, "src", "app", "constants.js"),
        "utf8",
      );
      const value = Number(
        (constants.match(/WATCH_WINDOW_MS\s*=\s*(\d+)/) || [])[1],
      );
      return value > 0 && value <= 60000;
    })(),
    "the ceiling is a safety net, not a working window",
  );
}
