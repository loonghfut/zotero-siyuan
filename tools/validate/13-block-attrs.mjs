/**
 * Zotero → SiYuan — how a sent note is wrapped and what it carries.
 *
 * The index used to depend on the template writing a Zotero link. These
 * checks guard the second way in — the block IAL on a super block — and the
 * idempotent block a literature-note sync writes.
 *
 * Part of `node tools/validate.mjs`: this file runs when it is imported, and
 * the entry point prints the summary.
 */

import { check, readSrc, section } from "./harness.mjs";

const {
  blockAttrs,
  indexModule,
  batchModule,
  itemModule,
  sectionsModule,
  transportModule,
} =
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
    const sectionsModule = await import(
      new URL("../../src/app/item-sections.js", import.meta.url).href
    );
    const transportModule = await import(
      new URL("../../src/app/transport.js", import.meta.url).href
    );
    return {
      blockAttrs,
      indexModule,
      batchModule,
      itemModule,
      sectionsModule,
      transportModule,
    };
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

/* ------------------- 13b. wrapping and where the IAL goes ---------------- */

section("Block attributes — the super block");
{
  const {
    ANNOTATION_KEY_ATTR,
    SUPER_BLOCK_CLOSE,
    SUPER_BLOCK_OPEN,
    annotationAttributes,
    markBlock,
    parseAttributes,
    wrapSuperBlock,
  } = blockAttrs;
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
  const marked = markBlock(note, attrs);
  const lines = marked.split("\n");
  check(
    "the note is one super block",
    lines[0] === SUPER_BLOCK_OPEN && lines.includes(SUPER_BLOCK_CLOSE),
    lines.slice(0, 2).join(" / "),
  );
  check(
    "the attributes follow the closing marker",
    lines[lines.length - 2] === SUPER_BLOCK_CLOSE &&
      lines[lines.length - 1].startsWith("{: "),
    lines.slice(-2).join(" / "),
  );
  check(
    "the attributes are on the container, not on a callout",
    parseAttributes(lines[lines.length - 1])[ANNOTATION_KEY_ATTR] ===
      "ABCD1234",
    lines[lines.length - 1],
  );
  check(
    "the note itself is unchanged inside the wrapper",
    marked.includes("> [!quote] 摘录 · Title") &&
      marked.includes("> [!note] 批注"),
  );

  const single = markBlock("> only one block", attrs);
  check(
    "a one-block note is wrapped too",
    single.startsWith(`${SUPER_BLOCK_OPEN}\n\n> only one block\n\n`) &&
      single.split("\n").pop().startsWith("{: "),
    single,
  );

  const heading = markBlock("## Heading\ntext", attrs);
  check(
    "a heading stays inside the wrapper",
    heading.includes("## Heading\ntext\n\n}}}"),
    heading,
  );

  const nested = markBlock(
    "{{{row\n\n> a nested block\n\n}}}",
    attrs,
  );
  check(
    "a template that already has a super block is nested, not broken",
    nested.startsWith(`${SUPER_BLOCK_OPEN}\n\n{{{row`) &&
      nested.split("\n").pop().startsWith("{: "),
    nested,
  );

  check(
    "empty content produces no block",
    wrapSuperBlock("   \n\n") === "" && markBlock("", attrs) === "",
  );
  check(
    "a write without attributes is still one super block",
    markBlock("> plain", {}).split("\n").pop() === SUPER_BLOCK_CLOSE,
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
      type: "s",
      root_id: "20260101000000-docdocd",
      ial,
    },
    {
      id: "20260101000000-bbbbbbb",
      markdown: "metadata without a link",
      type: "s",
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
  // One super block per note, which is exactly one row per note.
  const rows = [
    {
      id: "b1",
      markdown: "> quote one",
      ial: `{: ${ANNOTATION_KEY_ATTR}="KEY1"}`,
    },
    {
      id: "b2",
      markdown: "> quote two",
      ial: `{: ${ANNOTATION_KEY_ATTR}="KEY2"}`,
    },
  ];
  const grouped = batch._groupBatchRows(rows, [{ key: "KEY1" }, { key: "KEY2" }]);
  check(
    "a batch maps each super block to its own annotation",
    grouped.mapped &&
      grouped.groups[0].join(",") === "b1" &&
      grouped.groups[1].join(",") === "b2",
    JSON.stringify(grouped.groups),
  );

  // A row the write cannot account for must not be guessed at: an old
  // implementation put it under the previous note, and "replace" then
  // deleted a neighbour.
  const partial = [
    {
      id: "p1",
      markdown: "> quote one",
      ial: `{: ${ANNOTATION_KEY_ATTR}="KEY1"}`,
    },
    { id: "p2", markdown: "a block without an attribute", ial: "" },
    {
      id: "p3",
      markdown: "> quote two",
      ial: `{: ${ANNOTATION_KEY_ATTR}="KEY2"}`,
    },
  ];
  const partialGroups = batch._groupBatchRows(partial, [
    { key: "KEY1" },
    { key: "KEY2" },
  ]);
  check(
    "a row without an attribute is not attributed to a neighbour",
    partialGroups.mapped === false,
    JSON.stringify(partialGroups),
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

  // After a restart the index points at the note's super block. Replacing
  // that note must take only it — not the other notes of the same second.
  const transport = transportModule.default;
  const superRows = [
    {
      id: "s1",
      markdown: "> quote one",
      ial: `{: ${ANNOTATION_KEY_ATTR}="KEY1"}`,
    },
    {
      id: "s2",
      markdown: "> quote two",
      ial: `{: ${ANNOTATION_KEY_ATTR}="KEY2"}`,
    },
  ];
  const fakeBatch = {
    getCLI() {
      return {
        async blocksOfSend() {
          return superRows;
        },
      };
    },
    _rowsOfOneBatchNote: transport._rowsOfOneBatchNote,
  };
  const recovered = await transport._sentBlockRows.call(fakeBatch, {
    blockID: "s2",
    documentID: "20260101000000-docdocd",
    blocks: [],
    markdown: "> quote two",
  });
  check(
    "a stored entry takes its own super block, not the whole batch",
    recovered.map((row) => row.id).join(",") === "s2",
    recovered.map((row) => row.id).join(","),
  );

  // A single send after a restart: a user block written in the same second
  // must not come along, because the note is not that block.
  const withUserRow = [
    { id: "u1", markdown: "a user paragraph", ial: "" },
    {
      id: "s1",
      markdown: "> quote one",
      ial: `{: ${ANNOTATION_KEY_ATTR}="KEY1"}`,
    },
  ];
  const fakeSingle = {
    getCLI() {
      return {
        async blocksOfSend() {
          return withUserRow;
        },
      };
    },
    _rowsOfOneBatchNote: transport._rowsOfOneBatchNote,
  };
  const single = await transport._sentBlockRows.call(fakeSingle, {
    blockID: "s1",
    documentID: "20260101000000-docdocd",
    blocks: [],
    markdown: "> quote one",
  });
  check(
    "a user block from the same second is not part of the note",
    single.map((row) => row.id).join(",") === "s1",
    single.map((row) => row.id).join(","),
  );

  // Notes written before the super block still carry the invisible anchor;
  // they keep working the old way.
  const oldRows = [
    { id: "o1a", markdown: "> quote one", ial: "" },
    { id: "o1b", markdown: "meta [x](zotero://x?annotation=KEY1&zsi=batch)", ial: "" },
    { id: "o2a", markdown: "> quote two", ial: "" },
    { id: "o2b", markdown: "meta [x](zotero://x?annotation=KEY2&zsi=batch)", ial: "" },
  ];
  const oldSecond = transport._rowsOfOneBatchNote(oldRows, "o2b");
  check(
    "a note written before the super block still ends at its anchor",
    oldSecond.map((row) => row.id).join(",") === "o2a,o2b",
    oldSecond.map((row) => row.id).join(","),
  );
  const fakeOld = {
    getCLI() {
      return {
        async blocksOfSend() {
          return oldRows;
        },
      };
    },
    _rowsOfOneBatchNote: transport._rowsOfOneBatchNote,
  };
  const oldRecovered = await transport._sentBlockRows.call(fakeOld, {
    blockID: "o2b",
    documentID: "20260101000000-docdocd",
    blocks: [],
    markdown: "",
  });
  check(
    "an old batch is still sliced by its anchor",
    oldRecovered.map((row) => row.id).join(",") === "o2a,o2b",
    oldRecovered.map((row) => row.id).join(","),
  );
}

/* ---------------- 13e. the block a literature-note sync writes ----------- */

section("Block attributes — item sync");
{
  const {
    ITEM_KEY_ATTR,
    LIBRARY_ID_ATTR,
    SECTION_ATTR,
    SECTION_ITEM_ATTR,
    itemDocumentAttributes,
    itemSectionAttributes,
    markBlock,
  } = blockAttrs;
  const item = sectionsModule.default;

  const attrs = itemDocumentAttributes("ITEM1", 7);
  check(
    "the sync block names the item and its kind",
    attrs[SECTION_ATTR] === "item" && attrs[SECTION_ITEM_ATTR] === "ITEM1",
    JSON.stringify(attrs),
  );
  check(
    "the sync block carries the library as well as the key",
    attrs[LIBRARY_ID_ATTR] === "7",
    JSON.stringify(attrs),
  );
  const sync = markBlock("> [!note] 文献信息\n> body", attrs);
  const last = sync.split("\n").pop();
  check(
    "the sync is one marked super block",
    sync.startsWith("{{{row\n\n") &&
      last.includes(`${SECTION_ATTR}="item"`) &&
      last.includes(`${SECTION_ITEM_ATTR}="ITEM1"`) &&
      last.includes(`${LIBRARY_ID_ATTR}="7"`),
    last,
  );

  const infoAttrs = itemSectionAttributes("info", "ITEM1", 7);
  check(
    "an item section uses the ordinary item key, not the sync container key",
    infoAttrs[SECTION_ATTR] === "info" &&
      infoAttrs[ITEM_KEY_ATTR] === "ITEM1" &&
      infoAttrs[SECTION_ITEM_ATTR] === undefined &&
      infoAttrs[LIBRARY_ID_ATTR] === "7",
    JSON.stringify(infoAttrs),
  );

  // The section templates read a preference; an empty one is the built-in
  // shape, and the harness has no Zotero preferences.
  const sections = { ...item, _itemSectionTemplate: () => "" };
  const text = sections._itemSectionMarkdown(
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
    text.includes("[!note]") && text.includes("[!abstract]"),
  );
  check(
    "each child note is its own callout",
    (text.match(/\[!note\]/g) || []).length === 3,
    text,
  );
  check(
    "the sections are not marked one by one any more",
    !text.includes(SECTION_ATTR) && !text.includes(SECTION_ITEM_ATTR),
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
  const ids = await sections._sectionBlockIDs.call(
    fake,
    "20260101000000-docdocd",
    { itemKey: "ITEM1" },
  );
  check(
    "the old sync block is found by the item key",
    ids.length === 1 &&
      new RegExp(`${SECTION_ITEM_ATTR}="ITEM1"`).test(calls[0]) &&
      /root_id = '20260101000000-docdocd'/.test(calls[0]),
    calls[0],
  );
  const infoCalls = [];
  const infoFake = {
    async _httpClient() {
      return {
        async sql(statement) {
          infoCalls.push(statement);
          return [{ id: "20260101000000-bbbbbbb" }];
        },
      };
    },
  };
  const infoIDs = await sections._sectionBlockIDs.call(
    infoFake,
    "20260101000000-docdocd",
    infoAttrs,
  );
  check(
    "an item section is found by its own section and the ordinary item key",
    infoIDs.length === 1 &&
      new RegExp(`${ITEM_KEY_ATTR}="ITEM1"`).test(infoCalls[0]) &&
      new RegExp(`${SECTION_ATTR}="info"`).test(infoCalls[0]) &&
      new RegExp(`${LIBRARY_ID_ATTR}="7"`).test(infoCalls[0]),
    infoCalls[0],
  );
  check(
    "the sync query does not match a separately sent info section",
    new RegExp(`${SECTION_ITEM_ATTR}="ITEM1"`).test(calls[0]) &&
      !new RegExp(`${SECTION_ATTR}="info"`).test(calls[0]),
    calls[0],
  );
  check(
    "a document without a key has no blocks",
    (await sections._sectionBlockIDs.call(fake, "not-an-id", { itemKey: "ITEM1" }))
      .length === 0,
  );
}

/* --------------------- 13f. the code is really wired -------------------- */

section("Block attributes — wiring");
{
  check(
    "a single send wraps the note and marks the container",
    /markBlock\(markdown,\s*annotationAttributes\(vars\)\)/.test(
      readSrc("app/send.js"),
    ),
  );
  check(
    "a batch send wraps every note",
    /markBlock\(markdown,\s*annotationAttributes\(vars\)\)/.test(
      readSrc("app/send-batch.js"),
    ) &&
      /attributeValue\(row && row\.ial, ANNOTATION_KEY_ATTR\)/.test(
        readSrc("app/send-batch.js"),
      ),
  );
  check(
    "an item-level write is wrapped",
    /const content = markBlock\(text, attrs/.test(readSrc("app/item-send.js")),
  );
  check(
    "the item sync marks its block with the item key",
    /itemDocumentAttributes\(itemKey(?:,\s*[^)]*)?\)/.test(
      readSrc("app/item-send.js"),
    ),
  );
  check(
    "every item-level action writes its own section",
    [
      /section:\s*ITEM_SECTION_INFO/.test(readSrc("app/item-actions.js")),
      /section:\s*ITEM_SECTION_ABSTRACT/.test(readSrc("app/item-actions.js")),
      /section:\s*ITEM_SECTION_NOTES/.test(readSrc("app/item-actions.js")),
    ].every(Boolean),
  );
  check(
    "the section commands are registered on the addon",
    /itemActions/.test(readSrc("index.js")),
  );
  check(
    "the item menu offers the sync",
    readSrc("app/item-menu.js").includes('"_syncItemDocument"'),
  );
  check(
    "the item document replaces its old block",
    /_sectionBlockIDs/.test(readSrc("app/item-send.js")) &&
      /_deleteBlocks\(previous\)/.test(readSrc("app/item-send.js")),
  );
  check(
    "the old anchor is no longer written",
    !readSrc("app/send-batch.js").includes("_withBatchAnchor"),
  );
}
