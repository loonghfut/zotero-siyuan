/**
 * Zotero → SiYuan — the static checks for The index of sent annotations, the launcher, the package.
 *
 * Part of `node tools/validate.mjs`: this file runs when it is imported, and
 * the entry point prints the summary. `check()` and `section()` come from
 * `harness.mjs`, together with the source readers.
 */

import {
  allSource,
  check,
  section,
} from "./harness.mjs";

/* --------------------- 9. the index of sent annotations ------------------ */

section("Sent-annotation index");
{
  const {
    SiYuanIndex,
    parseAnnotationKey,
    annotationDeepLink,
    ZOTERO_LINK_PREFIX,
  } = await import(
    new URL("../../src/modules/siyuan-index.js", import.meta.url).href
  );

  check(
    "the annotation key is read out of a deep link",
    parseAnnotationKey(
      "作者：X  来源：[论文](zotero://open/library/items/ATTACH01?annotation=ABCD1234&page=3)",
    ) === "ABCD1234",
    parseAnnotationKey(
      "来源：[论文](zotero://open/library/items/ATTACH01?annotation=ABCD1234&page=3)",
    ),
  );
  check(
    "a block without a deep link has no annotation key",
    parseAnnotationKey("作者：X  年份：2025") === "",
  );
  check(
    "a deep link without an annotation has no annotation key",
    parseAnnotationKey(`[x](${ZOTERO_LINK_PREFIX}ATTACH01)`) === "",
  );
  check(
    "the deep link points at the annotation",
    annotationDeepLink("ATTACH01", "ABCD1234", 3) ===
      "zotero://open/library/items/ATTACH01?annotation=ABCD1234&page=3",
    annotationDeepLink("ATTACH01", "ABCD1234", 3),
  );
  check(
    "a deep link without a page has no page",
    !/page=/.test(annotationDeepLink("ATTACH01", "ABCD1234", 0)),
  );

  const index = new SiYuanIndex();
  index.add("ABCD1234", "20260101000000-abcdefg");
  check("the index finds a block by annotation key", index.get("ABCD1234") === "20260101000000-abcdefg");
  check("the index knows nothing about an unknown annotation", index.get("NOPE") === "");
  check("the index ignores an empty key", index.get("") === "");
}

/* ------------- 9b. one scan of the workspace, not one per PDF ----------- */

section("Index scans");
{
  const { SiYuanIndex: Index, parseAttachmentKey } = await import(
    new URL("../../src/modules/siyuan-index.js", import.meta.url).href
  );

  check(
    "the PDF is read out of a deep link",
    parseAttachmentKey(
      "[a](zotero://open/library/items/ATTACH01?annotation=ABCD1234)",
    ) === "ATTACH01" && parseAttachmentKey("no link here") === "",
  );
  check(
    "a note sent from a group library is read too",
    // Zotero has a second URL shape for group libraries, and a note with
    // that link used to be invisible to the index: the marker never came
    // back after a restart.
    parseAttachmentKey(
      "[a](zotero://open/groups/123456/items/ATTACH02?annotation=ABCD1234)",
    ) === "ATTACH02",
  );

  // The query behind the index is a `LIKE '%…%'`, which no index can help
  // with: it reads the whole table whether it is narrowed to one PDF or
  // not. So it is asked once per session, and every PDF is answered from
  // that one answer.
  const rows = [
    {
      id: "20260101000000-aaaaaaa",
      markdown: "x](zotero://open/library/items/ATTACH01?annotation=KEYAA111&page=1)",
      type: "b",
    },
    {
      id: "20260101000000-bbbbbbb",
      markdown: "x](zotero://open/library/items/ATTACH01?annotation=KEYAA111&page=1)",
      type: "p",
    },
    {
      id: "20260101000000-ccccccc",
      markdown: "x](zotero://open/library/items/ATTACH02?annotation=KEYBB222&page=2)",
      type: "p",
    },
  ];
  const counting = (delay = 0) => {
    const cli = {
      queries: 0,
      async runJSON() {
        cli.queries++;
        if (delay) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        return rows;
      },
    };
    return cli;
  };

  const cli = counting();
  const single = new Index();
  const first = await single.refreshForAttachment(cli, "ATTACH01");
  const second = await single.refreshForAttachment(cli, "ATTACH02");
  check(
    "a PDF is answered from one scan of the workspace",
    first === 1 && second === 1 && cli.queries === 1,
    `${cli.queries} query/queries, ${first}/${second}`,
  );
  check(
    "the index takes the newest block of an annotation",
    single.get("KEYAA111") === "20260101000000-aaaaaaa",
    single.get("KEYAA111"),
  );
  check(
    "a scan is reused for a while",
    (await single.ensureScanned(cli)) === false,
    "the second call scanned again",
  );
  check(
    "a forced scan reads the workspace again",
    (await single.ensureScanned(cli, { force: true })) === true &&
      cli.queries === 2,
    `${cli.queries} query/queries`,
  );

  // A restored session draws several sidebars at once: eight tabs must not
  // start eight scans of the same table.
  {
    const slow = counting(20);
    const many = new Index();
    await Promise.all([
      many.refreshForAttachment(slow, "ATTACH01"),
      many.refreshForAttachment(slow, "ATTACH02"),
      many.refreshForAttachment(slow, "ATTACH01"),
    ]);
    check(
      "sidebars that are drawn together share one scan",
      slow.queries === 1,
      `${slow.queries} query/queries`,
    );
  }

  // A workspace that cannot be read as a whole still has to give this PDF
  // its markers.
  {
    let attempts = 0;
    const flaky = {
      async runJSON(args) {
        attempts++;
        if (attempts === 1) {
          throw new Error("the workspace query failed");
        }
        return rows.filter((row) => row.markdown.includes("ATTACH02"));
      },
    };
    const fallback = new Index();
    const found = await fallback.refreshForAttachment(flaky, "ATTACH02");
    check(
      "a scan that fails falls back to the PDF's own query",
      found === 1 && attempts === 2,
      `${found} found after ${attempts} attempt(s)`,
    );
  }

  // And a failure must not be remembered: the next sidebar tries again.
  {
    let attempts = 0;
    const broken = {
      async runJSON() {
        attempts++;
        throw new Error("no workspace");
      },
    };
    const retried = new Index();
    for (let i = 0; i < 2; i++) {
      try {
        await retried.refreshForAttachment(broken, "ATTACH01");
      }
      catch (e) {
        // the sidebar simply has no markers
      }
    }
    check(
      "a failed scan is tried again by the next sidebar",
      retried.scanned === false && attempts === 4,
      `${attempts} attempt(s), scanned: ${retried.scanned}`,
    );
  }
}

/* --------------------- 10. opening SiYuan without a prompt -------------- */

section("SiYuan launcher");
{
  const { parseHandlerExecutable } = await import(
    new URL("../../src/modules/siyuan-launcher.js", import.meta.url).href
  );

  check(
    "a quoted handler yields the executable",
    parseHandlerExecutable(
      '"C:\\Program Files\\SiYuan\\SiYuan.exe" "%1"',
    ) === "C:\\Program Files\\SiYuan\\SiYuan.exe",
    parseHandlerExecutable('"C:\\Program Files\\SiYuan\\SiYuan.exe" "%1"'),
  );
  check(
    "an unquoted handler yields the executable",
    parseHandlerExecutable("C:\\SiYuan\\SiYuan.exe %1") ===
      "C:\\SiYuan\\SiYuan.exe",
    parseHandlerExecutable("C:\\SiYuan\\SiYuan.exe %1"),
  );
  check(
    "a single executable is handled",
    parseHandlerExecutable("C:\\SiYuan\\SiYuan.exe") ===
      "C:\\SiYuan\\SiYuan.exe",
  );
  check(
    "an empty handler yields nothing",
    parseHandlerExecutable("") === "" && parseHandlerExecutable(null) === "",
  );
}

/* --------------------- 11. the chrome package and its icon --------------- */

section("Chrome package");
{
  const {
    SIYUAN_ICON_SHAPES,
    SIYUAN_ICON_VIEWBOX,
    SVG_NS,
  } = await import(new URL("../../src/modules/icons.js", import.meta.url).href);

  check(
    "the logo is inline SVG",
    SVG_NS === "http://www.w3.org/2000/svg" &&
      SIYUAN_ICON_SHAPES.length === 4,
    `${SIYUAN_ICON_SHAPES.length} shapes`,
  );
  check(
    "every shape of the logo has points and a colour",
    SIYUAN_ICON_SHAPES.every(
      (s) => typeof s.points === "string" && /^#[0-9A-F]{6}$/i.test(s.fill),
    ),
  );
  check(
    "the logo uses SiYuan's own colours",
    SIYUAN_ICON_SHAPES.some((s) => s.fill.toLowerCase() === "#da3939") &&
      SIYUAN_ICON_SHAPES.some((s) => s.fill.toLowerCase() === "#3b3e43"),
  );
  check(
    "the logo has a viewBox",
    /^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/.test(SIYUAN_ICON_VIEWBOX),
    SIYUAN_ICON_VIEWBOX,
  );
  check(
    "the logo is not referenced by URL",
    // A chrome:// URL for a plugin-registered package is unreadable in the
    // reader's content process, so the logo has to be inline.
    !allSource.includes(
      "chrome://${CHROME_PACKAGE}",
    ),
  );
}
