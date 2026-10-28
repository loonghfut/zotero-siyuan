/**
 * Zotero → SiYuan — the checks for sending without being asked.
 *
 * Automatic sending is the one feature that writes by itself, so its rules
 * are pure functions and are tested as such: the filters, the pending
 * queue, and the local copy of the sent markers. The pane side is checked
 * as markup, because a missing id is a control that silently does nothing.
 *
 * Part of `node tools/validate.mjs`: this file runs when it is imported, and
 * the entry point prints the summary.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, check, section } from "./harness.mjs";

/* ------------------------- 12a. the filters ----------------------------- */

section("Automatic sending — the filters");
{
  const filter = await import(
    new URL("../../src/modules/auto-filter.js", import.meta.url).href
  );

  check(
    "a filter can be split on commas, semicolons and newlines",
    filter.splitFilter("red, blue；green\norange").join("|") ===
      "red|blue|green|orange",
  );
  check(
    "the same value twice is kept once",
    filter.splitFilter("Book, book ,BOOK").length === 1,
  );
  check("an empty filter is an empty list", filter.splitFilter("").length === 0);

  const tags = filter.filterTags([{ tag: "Methods" }, { name: "Review" }, "x"]);
  check(
    "tags are read from both shapes and lowercased",
    tags.join("|") === "methods|review|x",
    tags.join("|"),
  );

  const red = { color: "#ff6666", type: "highlight", tags: [{ tag: "key" }] };
  check(
    "empty filters let everything through",
    filter.matchesAutoFilters(red, "journalArticle", {}) === true,
  );
  check(
    "a colour that matches passes",
    filter.matchesAutoFilters(red, "journalArticle", {
      colors: ["#ff6666"],
    }) === true,
  );
  check(
    "a colour that does not match is refused",
    filter.matchesAutoFilters(red, "journalArticle", {
      colors: ["#ffd400"],
    }) === false,
  );
  check(
    "the colours are compared case-insensitively",
    filter.matchesAutoFilters(
      { ...red, color: "#FF6666" },
      "",
      { colors: ["#ff6666"] },
    ) === true,
  );
  check(
    "an annotation kind that does not match is refused",
    filter.matchesAutoFilters(red, "", { types: ["note"] }) === false,
  );
  check(
    "a matching tag passes",
    filter.matchesAutoFilters(red, "", { tags: ["key"] }) === true,
  );
  check(
    "a non-matching tag is refused",
    filter.matchesAutoFilters(red, "", { tags: ["other"] }) === false,
  );
  check(
    "the item category is matched",
    filter.matchesAutoFilters(red, "book", { itemTypes: ["book"] }) === true,
  );
  check(
    "every non-empty dimension has to match",
    filter.matchesAutoFilters(red, "book", {
      colors: ["#ff6666"],
      types: ["highlight"],
      itemTypes: ["journalArticle"],
    }) === false,
  );
  check(
    "an annotation without a colour fails a colour filter",
    filter.matchesAutoFilters(
      { color: "", type: "note", tags: [] },
      "",
      { colors: ["#ff6666"] },
    ) === false,
  );
}

/* --------------------------- 12b. the queue ----------------------------- */

section("Automatic sending — the pending queue");
{
  const queue = await import(
    new URL("../../src/modules/pending-queue.js", import.meta.url).href
  );

  check("an empty queue parses", queue.parsePendingQueue("[]").length === 0);
  check(
    "a queue that does not parse is empty",
    queue.parsePendingQueue("{not json").length === 0,
  );
  check(
    "a queue that is not a list is empty",
    queue.parsePendingQueue('{"key":"ABC"}').length === 0,
  );
  check(
    "an entry with a bad key is left out",
    queue.parsePendingQueue(
      JSON.stringify([{ key: "not a key" }, { key: "ABCD1234" }]),
    ).length === 1,
  );

  let list = queue.parsePendingQueue("[]");
  let added = queue.addPending(list, "ABCD1234", 1000);
  check("a key is added", added.added && added.list.length === 1);
  check("the queue remembers when it was added", added.list[0].at === 1000);
  let again = queue.addPending(added.list, "ABCD1234", 2000);
  check("the same key is not added twice", again.added === false);

  const many = [];
  for (let i = 0; i < queue.MAX_PENDING + 5; i++) {
    many.push({ key: `KEY${i}`, attempts: 0, at: i });
  }
  const written = JSON.parse(queue.serializePendingQueue(many));
  check(
    "the queue is capped",
    written.length === queue.MAX_PENDING,
    String(written.length),
  );
  check(
    "the newest are kept",
    written[0].key === `KEY${queue.MAX_PENDING + 4}`,
    written[0].key,
  );

  const failed = queue.failPending(
    [{ key: "ABCD1234", attempts: 2 }],
    "ABCD1234",
  );
  check("a failure counts", failed[0].attempts === 3);
  check(
    "a failure for another key changes nothing",
    queue.failPending([{ key: "ABCD1234", attempts: 2 }], "ZZZZ")[0]
      .attempts === 2,
  );
  check(
    "a key can be taken out",
    queue.removePending(
      [{ key: "ABCD1234" }, { key: "EFGH5678" }],
      "ABCD1234",
    ).length === 1,
  );

  check(
    "a bad key cannot be queued",
    queue.addPending([], "../etc/passwd").added === false,
  );
}

/* --------------------- 12c. the local copy of the index ----------------- */

section("Automatic sending — the local sent cache");
{
  const cache = await import(
    new URL("../../src/modules/sent-cache.js", import.meta.url).href
  );

  const parsed = cache.parseSentCache(
    JSON.stringify({
      key: "cli|workspace",
      entries: [
        {
          annotationKey: "ABCD1234",
          blockID: "20260101000000-abcdefg",
          documentID: "20260101000000-hijklmn",
          at: 5,
        },
        { annotationKey: "EFGH5678", blockID: "not-a-block" },
        { annotationKey: "bad key", blockID: "20260101000000-abcdefg" },
      ],
    }),
  );
  check("the workspace key is read", parsed.key === "cli|workspace");
  check(
    "an entry without a real block is left out",
    parsed.entries.length === 1,
    String(parsed.entries.length),
  );
  check("the surviving entry is the real one", parsed.entries[0].at === 5);

  check(
    "a cache that does not parse is empty",
    cache.parseSentCache("not json").entries.length === 0,
  );
  check(
    "a cache that is a list is empty",
    cache.parseSentCache("[]").entries.length === 0,
  );

  const written = JSON.parse(
    cache.serializeSentCache("cli|workspace", [
      { annotationKey: "AAAA", blockID: "20260101000000-aaaaaaa", at: 1 },
      { annotationKey: "BBBB", blockID: "20260101000000-bbbbbbb", at: 9 },
    ]),
  );
  check(
    "the cache is written newest first",
    written.entries[0].annotationKey === "BBBB",
  );
  check(
    "the cache remembers its workspace",
    written.key === "cli|workspace",
  );
  check(
    "a workspace key is stable",
    cache.sentCacheKey(" /usr/bin/siyuan ", " /w ") === "/usr/bin/siyuan|/w",
  );

  const entries = cache.sentCacheEntries(
    new Map([["AAAA", "20260101000000-aaaaaaa"]]),
    new Map([["AAAA", { documentID: "20260101000000-hijklmn" }]]),
    7,
  );
  check(
    "an index entry becomes a cache entry",
    entries.length === 1 &&
      entries[0].blockID === "20260101000000-aaaaaaa" &&
      entries[0].documentID === "20260101000000-hijklmn",
  );
}

/* ------------------- 12d. the index tells its listener ------------------ */

section("Automatic sending — the index listener");
{
  const { SiYuanIndex } = await import(
    new URL("../../src/modules/siyuan-index.js", import.meta.url).href
  );

  const changes = [];
  const index = new SiYuanIndex({ onChange: (change) => changes.push(change) });
  index.seed([
    { annotationKey: "AAAA", blockID: "20260101000000-aaaaaaa" },
    { annotationKey: "", blockID: "20260101000000-bbbbbbb" },
  ]);
  check("the seed fills the index", index.get("AAAA") !== "");
  check("a seed entry without a key is ignored", index.size === 1);
  check("seeding does not tell the listener", changes.length === 0);

  index.add("BBBB", "20260101000000-bbbbbbb", {
    documentID: "20260101000000-hijklmn",
  });
  check(
    "an added entry reaches the listener",
    changes.length === 1 &&
      changes[0].type === "add" &&
      changes[0].key === "BBBB" &&
      changes[0].documentID === "20260101000000-hijklmn",
  );

  index.remove("BBBB");
  check(
    "a removed entry reaches the listener",
    changes.length === 2 && changes[1].type === "remove",
  );

  index.add("CCCC", "20260101000000-ccccccc");
  index.remove("CCCC");
  check("the index forgets what was removed", index.get("CCCC") === "");
}

/* --------------------------- 12f. the item menu ------------------------- */

section("The item list menu");
{
  const menu = readFileSync(
    join(ROOT, "src", "app", "item-menu.js"),
    "utf8",
  );
  const bootstrap = readFileSync(
    join(ROOT, "addon", "bootstrap.js"),
    "utf8",
  );
  const entry = readFileSync(join(ROOT, "src", "index.js"), "utf8");
  // This is a real trap: `bootstrap.js` hands the hook the window itself,
  // not Zotero's `{ window }` payload, so the hook has to accept both.
  check(
    "bootstrap calls the hook with the window itself",
    /hooks\.onMainWindowLoad\(window\)/.test(bootstrap),
  );
  check(
    "the menu hook accepts the window itself",
    /onMainWindowLoad\(event[\s\S]{0,240}event\.window/.test(menu),
  );
  // Zotero only calls `onMainWindowLoad` for windows opened after the plugin
  // started, so a plugin installed into a running Zotero heard nothing about
  // the window that was already there.
  check(
    "the menu can find the windows that are already open",
    /getMainWindows\(\)/.test(menu) && /installItemMenus/.test(menu),
  );
  check(
    "startup installs the menu into the open windows",
    /this\.installItemMenus\(\)/.test(entry),
  );
  check(
    "a window that is still loading is waited for",
    /readyState === "complete"/.test(menu),
  );
  check(
    "the menu is put into the item list's own popup",
    menu.includes('"zotero-itemmenu"'),
  );
  check(
    "the menu is installed and removed in pairs",
    menu.includes("_installItemMenu") && menu.includes("_removeItemMenu"),
  );
  check(
    "every item action is on the menu",
    [
      "_sendItemInfo",
      "_sendItemAbstract",
      "_sendItemNotes",
      "_sendItemAnnotations",
      "_createItemNoteDocument",
    ].every((method) => menu.includes(`"${method}"`)),
  );
}


/* --------------------------- 12e. the pane ------------------------------ */

section("Automatic sending — the preferences pane");
{
  const filter = await import(
    new URL("../../src/modules/auto-filter.js", import.meta.url).href
  );
  const xhtml = readFileSync(
    join(ROOT, "addon", "content", "preferences.xhtml"),
    "utf8",
  );
  const pane = readFileSync(
    join(ROOT, "addon", "content", "preferences-sending.js"),
    "utf8",
  );

  for (const id of [
    "notebook",
    "auto-send",
    "auto-colors",
    "auto-tags",
    "auto-types",
    "auto-item-types",
    "auto-queue-retry",
    "auto-queue-clear",
    "auto-queue-status",
  ]) {
    check(
      `the pane has ${id}`,
      xhtml.includes(`id="zotero-prefpane-zoteroSiYuan-${id}"`),
    );
  }
  check(
    "the notebook is a dropdown, not free text",
    xhtml.includes('id="zotero-prefpane-zoteroSiYuan-notebook"') &&
      /<html:select[\s\S]{0,200}zoteroSiYuan-notebook[\s\S]{0,200}<\/html:select>/.test(
        xhtml,
      ),
  );
  check(
    "the notebook dropdown does not also write itself",
    !/<html:select[\s\S]{0,220}zoteroSiYuan-notebook[\s\S]{0,80}preference=/.test(
      xhtml,
    ),
  );
  check(
    "the web-side select carries an automatic choice",
    xhtml.includes('data-l10n-id="pref-notebook-auto"'),
  );

  // The boxes are static markup so Zotero can translate their names; the
  // values are the ones the filter matches, and the two lists must agree.
  for (const value of filter.AUTO_SEND_COLORS) {
    check(
      `the pane offers the colour ${value}`,
      xhtml.includes(`data-auto-color="${value}"`),
    );
  }
  for (const value of filter.AUTO_SEND_TYPES) {
    check(
      `the pane offers the kind ${value}`,
      xhtml.includes(`data-auto-type="${value}"`),
    );
  }
  check(
    "a colour is shown as a swatch, not as a hex value",
    /data-auto-color="#ffd400"[\s\S]{0,200}class="zsi-swatch/.test(xhtml),
  );
  const css = readFileSync(
    join(ROOT, "addon", "content", "styles.css"),
    "utf8",
  );
  const swatchRules = (css.match(/\.zsi-swatch-[a-z]+\s*\{/g) || []).length;
  check(
    "every swatch has a colour of its own",
    swatchRules >= filter.AUTO_SEND_COLORS.length,
    String(swatchRules),
  );
  check(
    "the colour boxes carry localizable names",
    xhtml.includes('data-l10n-id="pref-auto-color-yellow"'),
  );

  for (const method of [
    "_loadNotebooks",
    "_renderNotebooks",
    "_saveNotebook",
    "_restoreAutoSendSettings",
    "_renderAutoFilters",
    "_tickAutoFilterBox",
    "_toggleAutoFilter",
    "_saveAutoFilterText",
    "_saveAutoSend",
    "_refreshQueueStatus",
    "_retryAutoQueue",
    "_clearAutoQueue",
  ]) {
    check(
      `the pane implements ${method}`,
      pane.includes(`${method}: `) ||
        pane.includes(`${method}: async function`),
    );
  }
}
