/**
 * Zotero → SiYuan — the attributes a sent note carries.
 *
 * The index used to depend on the template writing a Zotero link. These
 * checks guard the second way in — the block IAL — and the idempotent
 * sections of a literature-note document.
 *
 * Part of `node tools/validate.mjs`: this file runs when it is imported, and
 * the entry point prints the summary.
 */

import { check, readSrc, section } from "./harness.mjs";

const { blockAttrs, indexModule, batchModule, itemModule, transportModule } =
  await (async () => {
    const blockAttrs = await import(
      new URL("../../src/modules/block-attrs.js", import.meta.url).href
    );
    const indexModule = await import(
      new URL("../../src/modules/siyuan-index.js", import.meta.url).href
    );
    const batchModule = await import(
      new URL("../../src/app/send-batch.js", import.meta.url).href
    );
    const itemModule = await import(
      new URL("../../src/app/item-send.js", import.meta.url).href
    );
    const transportModule = await import(
      new URL("../../src/app/transport.js", import.meta.url).href
    );
    return { blockAttrs, indexModule, batchModule, itemModule, transportModule };
  })();

/* ---------------------- 13a. the attribute line itself ------------------ */

section("Block attributes — the IAL");
{
  const {
    ANNOTATION_KEY_ATTR,
    ATTACHMENT_KEY_ATTR,
    COLOR_ATTR,
    ITEM_KEY_ATTR,
    MODIFIED_ATTR,
    PAGE_ATTR,
    TAGS_ATTR,
    annotationAttributes,
    attributeLine,
    parseAttributes,
  } = blockAttrs;

  const vars = {
    annotationId: "ABCD1234",
    itemKey: "ITEM0001",
    attachmentKey: "ATTACH01",
    annotationColor: "#ffd400",
    pageNumber: 3,
    annotationTags: "重要, 方法",
    annotationModified: "2026-10-26 03:12:00",
  };
  const attrs = annotationAttributes(vars);
  const line = attributeLine(attrs);
  const parsed = parseAttributes(line);

  check(
    "every annotation fact is written to the block",
    parsed[ANNOTATION_KEY_ATTR] === "ABCD1234" &&
      parsed[ITEM_KEY_ATTR] === "ITEM0001" &&
      parsed[ATTACHMENT_KEY_ATTR] === "ATTACH01" &&
      parsed[COLOR_ATTR] === "#ffd400" &&
      parsed[PAGE_ATTR] === "3" &&
      parsed[TAGS_ATTR] === "重要, 方法" &&
      parsed[MODIFIED_ATTR] === "2026-10-26 03:12:00",
    line,
  );
  check(
    "the attributes are one block IAL line",
    /^\{: .*\}$/.test(line) && !line.includes("\n"),
    line,
  );
  check(
    "an empty value is not written",
    !attributeLine({ [COLOR_ATTR]: "", [PAGE_ATTR]: null }).includes(COLOR_ATTR),
  );
  check(
    "a quote cannot break the attribute line",
    // SiYuan does not treat a backslash as an escape here: the first quote
    // would close the value and the rest of the IAL would be lost.
    !attributeLine({ [TAGS_ATTR]: 'a"b\\c' }).includes('a"b'),
    attributeLine({ [TAGS_ATTR]: 'a"b\\c' }),
  );
  check(
    "the page is written as a number, not a label",
    parsed[PAGE_ATTR] === "3",
    parsed[PAGE_ATTR],
  );
}

/* ------------------- 13b. where the attribute line goes ----------------- */

section("Block attributes — placement");
{
  const { annotationAttributes, insertAttributes, parseAttributes, ANNOTATION_KEY_ATTR } =
    blockAttrs;
  const attrs = annotationAttributes({
    annotationId: "ABCD1234",
    itemKey: "ITEM0001",
    attachmentKey: "ATTACH01",
  });

  const note = [
    "> [!quote] 摘录 · Title",
    "> the quote",
    "",
    "> [!note] 批注",
    "> the comment",
  ].join("\n");
  const marked = insertAttributes(note, attrs);
  const lines = marked.split("\n");
  const at = lines.findIndex((line) => line.startsWith("{: "));
  check(
    "the attributes follow the first block",
    at === 2 && lines[0].startsWith(">") && lines[1].startsWith(">"),
    `line ${at}: ${lines[at]}`,
  );
  check(
    "the attribute line is not part of the callout",
    !lines[at].startsWith(">"),
  );
  check(
    "the attributes name this annotation",
    parseAttributes(lines[at])[ANNOTATION_KEY_ATTR] === "ABCD1234",
    lines[at],
  );
  check(
    "the rest of the note is unchanged",
    marked.includes("> [!note] 批注"),
  );

  const single = insertAttributes("> only one block", attrs);
  check(
    "a one-block note keeps its attributes after it",
    single.startsWith("> only one block\n{: ") &&
      parseAttributes(single.split("\n")[1])["custom-zotero-annotation-key"] ===
        "ABCD1234",
    single,
  );

  const heading = insertAttributes("## Heading\ntext", attrs);
  check(
    "a note that starts with a heading puts the attributes under it",
    heading.split("\n")[1].startsWith("{: "),
    heading,
  );

  const fenced = insertAttributes(
    ["```", "code", "", "more", "```", "", "after"].join("\n"),
    attrs,
  );
  const fencedLines = fenced.split("\n");
  const fenceAt = fencedLines.findIndex((line) => line.startsWith("{: "));
  check(
    "a blank line inside a code fence is not a block boundary",
    fenceAt === 5 && fencedLines[4] === "```",
    `line ${fenceAt}: ${fencedLines[fenceAt]}`,
  );
}

/* -------------------- 13c. the index reads the IAL ---------------------- */

section("Block attributes — the index");
{
  const { SiYuanIndex } = indexModule;
  const { ANNOTATION_KEY_ATTR, ATTACHMENT_KEY_ATTR } = blockAttrs;
  const ial =
    `{: id="20260101000000-aaaaaaa" ` +
    `${ANNOTATION_KEY_ATTR}="KEYATTR1" ` +
    `${ATTACHMENT_KEY_ATTR}="ATTACH09"}`;
  const rows = [
    {
      id: "20260101000000-aaaaaaa",
      markdown: "> quote without a link",
      type: "callout",
      root_id: "20260101000000-docdocd",
      ial,
    },
    {
      id: "20260101000000-bbbbbbb",
      markdown: "metadata without a link",
      type: "p",
      root_id: "20260101000000-docdocd",
      ial,
    },
  ];
  const cli = {
    async runJSON() {
      return rows;
    },
  };
  const index = new SiYuanIndex();
  const count = await index.refreshForAttachment(cli, "ATTACH09");
  check(
    "an annotation with no deep link is found by its block attribute",
    index.get("KEYATTR1") === "20260101000000-aaaaaaa",
    index.get("KEYATTR1"),
  );
  check(
    "the PDF is counted from the attribute too",
    count === 1,
    String(count),
  );

  let calls = 0;
  const flaky = {
    async runJSON() {
      calls++;
      if (calls === 1) {
        throw new Error("the whole-workspace scan failed");
      }
      return rows;
    },
  };
  const fallback = new SiYuanIndex();
  const found = await fallback.refreshForAttachment(flaky, "ATTACH09");
  check(
    "the per-PDF fallback reads the attributes too",
    found === 1 && fallback.get("KEYATTR1") === "20260101000000-aaaaaaa",
    `${found} found after ${calls} attempt(s)`,
  );
  check(
    "the index query asks for the attribute column",
    /ial LIKE '%custom-zotero-annotation-key=%'/.test(
      readSrc("modules/siyuan-index.js"),
    ),
  );
}

/* ------------------ 13d. a batch groups by attributes ------------------- */

section("Block attributes — batch grouping");
{
  const { ANNOTATION_KEY_ATTR } = blockAttrs;
  const batch = batchModule.default;
  const rows = [
    {
      id: "b1",
      markdown: "> quote one",
      ial: `{: ${ANNOTATION_KEY_ATTR}="KEY1"}`,
    },
    { id: "b2", markdown: "metadata one", ial: "" },
    {
      id: "b3",
      markdown: "> quote two",
      ial: `{: ${ANNOTATION_KEY_ATTR}="KEY2"}`,
    },
    { id: "b4", markdown: "metadata two", ial: "" },
  ];
  const grouped = batch._groupBatchRows(rows, [{ key: "KEY1" }, { key: "KEY2" }]);
  check(
    "a batch is grouped by the first block's attribute",
    grouped.mapped &&
      grouped.groups[0].join(",") === "b1,b2" &&
      grouped.groups[1].join(",") === "b3,b4",
    JSON.stringify(grouped.groups),
  );

  const anchorRows = [
    { id: "a1", markdown: "> quote one", ial: "" },
    {
      id: "a2",
      markdown: "meta [x](zotero://x?annotation=KEY1&zsi=batch)",
      ial: "",
    },
    { id: "a3", markdown: "> quote two", ial: "" },
    {
      id: "a4",
      markdown: "meta [x](zotero://x?annotation=KEY2&zsi=batch)",
      ial: "",
    },
  ];
  const anchored = batch._groupBatchRows(anchorRows, [
    { key: "KEY1" },
    { key: "KEY2" },
  ]);
  check(
    "the invisible anchor still groups a write without attributes",
    anchored.mapped &&
      anchored.groups[0].join(",") === "a1,a2" &&
      anchored.groups[1].join(",") === "a3,a4",
    JSON.stringify(anchored.groups),
  );

  const oneBlock = batch._withBatchAnchor(
    '> one block\n{: custom-zotero-annotation-key="KEY1"}',
    { zoteroAnnotationLink: "zotero://open/library/items/A?annotation=KEY1" },
  );
  const oneLines = oneBlock.split("\n");
  check(
    "the batch anchor never lands inside the attribute line",
    oneLines[1].startsWith("{: ") && oneLines[2] === "" &&
      oneLines[3].includes("zsi=batch"),
    oneBlock,
  );

  // After a restart the index points at the note's first block, because that
  // is the one with the attributes. Replacing the note must still take only
  // that note's blocks — not the whole batch of the same second.
  const transport = transportModule.default;
  const batchRows = [
    { id: "n1a", markdown: "> quote one", ial: `{: ${ANNOTATION_KEY_ATTR}="KEY1"}` },
    { id: "n1b", markdown: "metadata one", ial: "" },
    { id: "n1c", markdown: "meta [x](zotero://x?annotation=KEY1&zsi=batch)", ial: "" },
    { id: "n2a", markdown: "> quote two", ial: `{: ${ANNOTATION_KEY_ATTR}="KEY2"}` },
    { id: "n2b", markdown: "metadata two", ial: "" },
    { id: "n2c", markdown: "meta [x](zotero://x?annotation=KEY2&zsi=batch)", ial: "" },
  ];
  const second = transport._rowsOfOneBatchNote(batchRows, "n2a");
  check(
    "a note is taken from its first block to the next note's first block",
    second.map((row) => row.id).join(",") === "n2a,n2b,n2c",
    second.map((row) => row.id).join(","),
  );
  // If the next note's attributes did not make it into SiYuan, its first
  // block cannot bound this note — the anchor still can.
  const mixedRows = [
    { id: "m1a", markdown: "> quote one", ial: `{: ${ANNOTATION_KEY_ATTR}="KEY1"}` },
    { id: "m1b", markdown: "metadata one", ial: "" },
    { id: "m1c", markdown: "meta [x](zotero://x?annotation=KEY1&zsi=batch)", ial: "" },
    { id: "m2a", markdown: "> quote two", ial: "" },
    { id: "m2b", markdown: "meta [x](zotero://x?annotation=KEY2&zsi=batch)", ial: "" },
  ];
  const bounded = transport._rowsOfOneBatchNote(mixedRows, "m1a");
  check(
    "the anchor still ends the note when the next one has no attributes",
    bounded.map((row) => row.id).join(",") === "m1a,m1b,m1c",
    bounded.map((row) => row.id).join(","),
  );
  const oldRows = [
    { id: "o1a", markdown: "> quote one", ial: "" },
    { id: "o1b", markdown: "meta [x](zotero://x?annotation=KEY1&zsi=batch)", ial: "" },
    { id: "o2a", markdown: "> quote two", ial: "" },
    { id: "o2b", markdown: "meta [x](zotero://x?annotation=KEY2&zsi=batch)", ial: "" },
  ];
  const oldSecond = transport._rowsOfOneBatchNote(oldRows, "o2b");
  check(
    "a note written before the attributes still ends at its anchor",
    oldSecond.map((row) => row.id).join(",") === "o2a,o2b",
    oldSecond.map((row) => row.id).join(","),
  );

  const fake = {
    getCLI() {
      return {
        async blocksOfSend() {
          return batchRows;
        },
      };
    },
    _rowsOfOneBatchNote: transport._rowsOfOneBatchNote,
  };
  const recovered = await transport._sentBlockRows.call(fake, {
    blockID: "n2a",
    documentID: "20260101000000-docdocd",
    blocks: [],
    markdown: "> quote two",
  });
  check(
    "a stored entry that points at the first block does not take the batch",
    recovered.map((row) => row.id).join(",") === "n2a,n2b,n2c",
    recovered.map((row) => row.id).join(","),
  );
}

/* ---------------- 13e. sections of a literature-note document ----------- */

section("Block attributes — item sections");
{
  const { SECTION_ATTR, withSection } = blockAttrs;
  const item = itemModule.default;

  const marked = withSection("> [!abstract] 摘要\n> body", "abstract", "ITEM1");
  check(
    "a section carries its own marker and item",
    marked.includes(`${SECTION_ATTR}="abstract"`) &&
      marked.includes('custom-zsi-item-key="ITEM1"') &&
      marked.split("\n").pop().startsWith("{: "),
    marked,
  );

  const text = item._itemSectionMarkdown(
    {
      itemKey: "ITEM1",
      title: "A paper",
      metadata: "作者：X",
      abstract: "An abstract",
    },
    ["note one", "note two"],
  );
  check(
    "the document has an info and an abstract section",
    text.includes(`${SECTION_ATTR}="info"`) &&
      text.includes(`${SECTION_ATTR}="abstract"`),
  );
  check(
    "each child note is marked on its own",
    (text.match(new RegExp(`${SECTION_ATTR}="notes"`, "g")) || []).length === 2,
    text,
  );
  check(
    "every section names the item it belongs to",
    (text.match(/custom-zsi-item-key="ITEM1"/g) || []).length === 4,
    text,
  );

  const calls = [];
  const fake = {
    async _httpClient() {
      return {
        async sql(statement) {
          calls.push(statement);
          return [{ id: "20260101000000-aaaaaaa" }];
        },
      };
    },
  };
  const ids = await item._sectionBlockIDs.call(
    fake,
    "20260101000000-docdocd",
    { itemKey: "ITEM1" },
  );
  check(
    "the old sections are found by both markers",
    ids.length === 1 &&
      /custom-zsi-section/.test(calls[0]) &&
      /custom-zsi-item-key="ITEM1"/.test(calls[0]) &&
      /root_id = '20260101000000-docdocd'/.test(calls[0]),
    calls[0],
  );
  check(
    "a document without a key has no sections",
    (await item._sectionBlockIDs.call(fake, "not-an-id", { itemKey: "ITEM1" }))
      .length === 0,
  );
}

/* --------------------- 13f. the code is really wired -------------------- */

section("Block attributes — wiring");
{
  check(
    "a single send writes the attributes in the same append",
    /insertAttributes\(\s*markdown,\s*annotationAttributes\(vars\)/.test(
      readSrc("app/send.js"),
    ),
  );
  check(
    "a batch send writes them too",
    /insertAttributes\(markdown, annotationAttributes\(vars\)\)/.test(
      readSrc("app/send-batch.js"),
    ) &&
      /attributeValue\(row\.ial, ANNOTATION_KEY_ATTR\)/.test(
        readSrc("app/send-batch.js"),
      ),
  );
  check(
    "the item menu offers the sync",
    readSrc("app/item-menu.js").includes('"_syncItemDocument"'),
  );
  check(
    "the item document replaces its old sections",
    /_sectionBlockIDs/.test(readSrc("app/item-send.js")) &&
      /_deleteBlocks\(previous\)/.test(readSrc("app/item-send.js")),
  );
}
