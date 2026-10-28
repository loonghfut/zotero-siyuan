/**
 * Zotero → SiYuan — the literature note: its sections, its annotations,
 * and the block a sync rewrites in place.
 *
 * The checks here are the ones a build cannot make: that a note's links,
 * pictures, tables and code survive the conversion to Markdown, that a
 * second sync updates instead of duplicating, and that an unchanged
 * annotation is left alone.
 *
 * Part of `node tools/validate.mjs`: this file runs when it is imported,
 * and the entry point prints the summary.
 */

import { check, readSrc, section } from "./harness.mjs";

const { htmlToMarkdown, noteHtml, itemNote, sectionsModule, templateModule } =
  await (async () => {
    const noteHtml = await import(
      new URL("../../src/modules/note-html.js", import.meta.url).href
    );
    const itemNote = await import(
      new URL("../../src/modules/item-note.js", import.meta.url).href
    );
    const sectionsModule = await import(
      new URL("../../src/app/item-sections.js", import.meta.url).href
    );
    const templateModule = await import(
      new URL("../../src/modules/template.js", import.meta.url).href
    );
    return {
      htmlToMarkdown: noteHtml.htmlToMarkdown,
      noteHtml,
      itemNote,
      sectionsModule,
      templateModule,
    };
  })();

/* ----------------------- 14a. a note arrives in full ------------------- */

section("Literature note — a child note as Markdown");
{
  const html =
    "<h2>Results</h2>" +
    '<p>See <a href="https://example.com/paper">the paper</a> and ' +
    "<strong>this</strong>.</p>" +
    '<p><img src="zotero://attachment/ABCD/" alt="figure 1"></p>';
  const text = htmlToMarkdown(html);
  check(
    "a heading, a link, emphasis and a picture all survive",
    text.includes("## Results") &&
      text.includes("[the paper](https://example.com/paper)") &&
      text.includes("**this**") &&
      text.includes("![figure 1](zotero://attachment/ABCD/)"),
    text,
  );

  const table = htmlToMarkdown(
    "<table><tr><th>作者</th><th>年份</th></tr>" +
      "<tr><td>张三</td><td>2024</td></tr></table>",
  );
  check(
    "a table becomes a Markdown table with a header rule",
    table.split("\n")[0] === "| 作者 | 年份 |" &&
      /^\| --- \| --- \|$/.test(table.split("\n")[1]) &&
      table.includes("| 张三 | 2024 |"),
    table,
  );

  const code = htmlToMarkdown(
    '<pre><code class="language-js">if (a) { b(); }</code></pre>',
  );
  check(
    "a code block keeps its language and its content",
    code === "```js\nif (a) { b(); }\n```",
    code,
  );

  const inline = htmlToMarkdown("<p>Use <code>a `b` c</code> here.</p>");
  check(
    "inline code is fenced against the backticks inside it",
    inline.includes("``a `b` c``"),
    inline,
  );

  const list = htmlToMarkdown(
    "<ul><li>one</li><li>two<ul><li>two a</li></ul></li></ul>",
  );
  check(
    "a nested list keeps its shape",
    list === "- one\n- two\n  - two a",
    list,
  );

  const quote = htmlToMarkdown(
    "<blockquote><p>first</p><p>second</p></blockquote>",
  );
  check(
    "a quote keeps its paragraphs",
    quote === "> first\n>\n> second",
    quote,
  );

  const script = htmlToMarkdown("<script>alert(1)</script><p>after</p>");
  check("a script is not part of the note", script === "after", script);

  const grouped = htmlToMarkdown(
    '<div data-schema-version="9"><h2>Results</h2>' +
      "<table><tr><th>a</th></tr><tr><td>1</td></tr></table>" +
      "<pre><code>x = 1</code></pre></div>",
  );
  check(
    "a grouping div does not flatten the blocks inside it",
    grouped.includes("## Results") &&
      grouped.includes("| a |") &&
      /```\s*\nx = 1\n```/.test(grouped),
    grouped,
  );

  const entities = htmlToMarkdown("<p>2 &times; 3 &amp; 4 &mdash; 6</p>");
  check(
    "named and numeric entities are decoded",
    entities === "2 × 3 & 4 — 6" && noteHtml.decodeEntities("&#x1f600;") === "😀",
    entities,
  );
}

/* -------------------- 14b. the three section templates ------------------ */

section("Literature note — the section templates");
{
  const { itemInfoMarkdown, abstractMarkdown, notesMarkdown } = itemNote;
  const vars = {
    title: "A paper",
    metadata: "作者：张三",
    abstract: "An abstract",
  };

  const info = itemInfoMarkdown(vars);
  check(
    "the built-in information section is the old shape",
    info.split("\n")[0] === "> [!note] Item details: A paper" &&
      info.includes("> 作者：张三"),
    info,
  );
  check(
    "an item with nothing to say writes no section",
    itemInfoMarkdown({}) === "",
  );

  const custom = itemInfoMarkdown(
    vars,
    "## {{title}}\n\n{{#if metadataCallout}}{{metadataCallout}}{{/if}}",
  );
  check(
    "a custom information template is rendered with the item's values",
    custom === "## A paper\n\n> 作者：张三",
    custom,
  );

  const abstract = abstractMarkdown(vars);
  check(
    "the abstract keeps its callout",
    abstract.split("\n")[0] === "> [!abstract] Abstract" &&
      abstract.includes("> An abstract"),
    abstract,
  );

  const notes = notesMarkdown(vars, ["one", "two"]);
  check(
    "each note is its own callout",
    (notes.match(/\[!note\]/g) || []).length === 2,
    notes,
  );

  const numbered = notesMarkdown(vars, ["one", "two"], "{{noteNumber}}. {{note}}");
  check(
    "the notes template is rendered once per note, with its number",
    numbered === "1. one\n\n2. two",
    numbered,
  );

  const bodyless = notesMarkdown(
    vars,
    ["第一段正文"],
    "> [!note] {{itemNotesLabel}}\n",
  );
  check(
    "a template that never names its body renders only what it says",
    bodyless === "> [!note] Notes",
    bodyless,
  );
  check(
    "the missing body variable is what the pane reports",
    itemNote.missingBodyVariable("notes", "> [!note] {{itemNotesLabel}}\n") ===
      "noteCallout" &&
      itemNote.missingBodyVariable(
        "notes",
        "> [!note] {{itemNotesLabel}}\n{{#if noteCallout}}{{noteCallout}}{{/if}}",
      ) === "" &&
      itemNote.missingBodyVariable("info", "{{metadataCallout}}") === "" &&
      itemNote.missingBodyVariable("note", "anything") === "",
    [
      itemNote.missingBodyVariable("notes", "> [!note] {{itemNotesLabel}}"),
      itemNote.missingBodyVariable("info", "{{metadataCallout}}"),
    ].join(" / "),
  );
  check(
    "the pane checks a template against its own section",
    /checkTemplate\(template, this\._templateSlot\)/.test(
      readSrc("../addon/content/preferences-template.js"),
    ) &&
      /missingBodyVariable\(slot, template\)/.test(
        readSrc("app/preferences-api.js"),
      ),
  );
  check(
    "the preview knows the per-note variables",
    /noteVars\(/.test(readSrc("app/preferences-api.js")) &&
      /export function noteVars/.test(readSrc("modules/item-note.js")),
  );

  check(
    "the section variables are on the template cheat sheet",
    ["itemInfoLabel", "metadataCallout", "noteCallout", "noteNumber"].every(
      (name) =>
        templateModule.TEMPLATE_VARIABLES.some((entry) => entry.name === name),
    ),
  );
}

/* ------------------------ 14c. updating in place ----------------------- */

section("Literature note — one block, updated in place");
{
  const sections = sectionsModule.default;
  const calls = [];

  const make = (overrides = {}) => ({
    _updateBlock: async () => true,
    _blockRow: async () => ({ id: "20260101000000-aaaaaaa", ial: "" }),
    _setBlockAttrs: async () => true,
    ...overrides,
  });

  const kept = await sections._replaceItemSection.call(
    make(),
    "20260101000000-aaaaaaa",
    "content",
    { "custom-zsi-section": "info" },
  );
  check(
    "an accepted update keeps the block",
    kept.updated === true && kept.gone === false,
    JSON.stringify(kept),
  );

  const gone = await sections._replaceItemSection.call(
    make({ _blockRow: async () => null }),
    "20260101000000-aaaaaaa",
    "content",
    {},
  );
  check(
    "an update that consumed the block says so",
    gone.updated === false && gone.gone === true,
    JSON.stringify(gone),
  );

  const refused = await sections._replaceItemSection.call(
    make({ _updateBlock: async () => false }),
    "20260101000000-aaaaaaa",
    "content",
    {},
  );
  check(
    "a refused update falls back to the old path",
    refused.updated === false && refused.gone === false,
    JSON.stringify(refused),
  );

  const stamped = make({
    _blockRow: async () => ({ id: "b", ial: '{: id="b"}' }),
    _setBlockAttrs: async (id, attrs) => {
      calls.push({ id, attrs });
      return true;
    },
  });
  await sections._replaceItemSection.call(
    stamped,
    "20260101000000-aaaaaaa",
    "content",
    { "custom-zsi-item-key": "ITEM1" },
  );
  check(
    "attributes lost by the parser are written back",
    calls.length === 1 && calls[0].attrs["custom-zsi-item-key"] === "ITEM1",
    JSON.stringify(calls),
  );

  check(
    "the write path updates before it appends",
    /previous\.length === 1/.test(readSrc("app/item-send.js")) &&
      /_replaceItemSection\(/.test(readSrc("app/item-send.js")) &&
      /_updateBlock\(/.test(readSrc("app/item-sections.js")),
  );
  check(
    "a sync takes over the sections sent one by one",
    /_soloItemSectionBlocks\(/.test(readSrc("app/item-send.js")) &&
      /ITEM_SECTION_INFO/.test(readSrc("app/item-sections.js")) &&
      /ITEM_SECTION_NOTES/.test(readSrc("app/item-sections.js")),
  );

  const soloCalls = [];
  const solo = await sections._soloItemSectionBlocks.call(
    {
      async _httpClient() {
        return {
          async sql(statement) {
            soloCalls.push(statement);
            return [{ id: "20260101000000-solo" }];
          },
        };
      },
    },
    "20260101000000-docdocd",
    { "custom-zsi-item-key": "ITEM1" },
  );
  check(
    "the solo sections are found by the item key and their name",
    solo.length === 1 &&
      /custom-zotero-item-key="ITEM1"/.test(soloCalls[0]) &&
      /custom-zsi-section="info"/.test(soloCalls[0]) &&
      /custom-zsi-section="notes"/.test(soloCalls[0]) &&
      !/custom-zsi-section="annotations"/.test(soloCalls[0]),
    soloCalls[0] || "no query",
  );
  check(
    "the CLI has a block update command",
    /"block",\s*"update"/.test(readSrc("modules/siyuan.js")),
  );
  check(
    "the HTTP API has an update endpoint",
    /\/api\/block\/updateBlock/.test(readSrc("modules/siyuan-http.js")),
  );
}

/* ---------------------- 14d. annotations, incrementally ---------------- */

section("Literature note — annotations, incrementally");
{
  const { default: annotations } = await import(
    new URL("../../src/app/item-annotations.js", import.meta.url).href
  );
  const { templateFingerprint } = templateModule;
  const documentID = "20260101000000-docdocd";
  const stamp = templateFingerprint("TPL");

  const before = new Map([
    ["KEEP", { id: "b1", modified: "2026-01-01 00:00:00", template: stamp }],
    ["EDIT", { id: "b2", modified: "2026-01-01 00:00:00", template: stamp }],
    ["GONE", { id: "b3", modified: "2026-01-01 00:00:00", template: stamp }],
  ]);
  const after = new Map(before);
  after.set("NEW", { id: "b4", modified: "2026-03-03 00:00:00", template: stamp });

  const deleted = [];
  const remembered = [];
  const updates = [];
  let listings = 0;
  let appended = "";
  const fake = {
    // The real methods (the summary, the index bookkeeping) are mixed in;
    // only the parts that talk to SiYuan are replaced.
    ...annotations,
    _index: {
      add: (key, blockID) => remembered.push(`${key}:${blockID}`),
    },
    getTemplateFor: () => "TPL",
    _annotationSectionBlocks: async () => {
      listings++;
      return listings === 1 ? before : after;
    },
    _itemAnnotationItems: async () => [
      { item: { key: "KEEP", dateModified: "2026-01-01 00:00:00" }, pdf: {} },
      { item: { key: "EDIT", dateModified: "2026-02-02 00:00:00" }, pdf: {} },
      { item: { key: "NEW", dateModified: "2026-03-03 00:00:00" }, pdf: {} },
    ],
    _annotationFromItem: async (item) => ({ id: item.key }),
    _buildVars: async (annotation) => ({
      annotationId: annotation.id,
      annotationModified: "x",
      itemKey: "ITEM1",
    }),
    _buildContent: async () => "> [!quote] 摘录",
    _replaceItemSection: async (blockID) => {
      updates.push(blockID);
      return { updated: true, gone: false };
    },
    _append: async (notebook, markdown) => {
      appended = markdown;
      return { blockID: "b4", documentID };
    },
    _deleteBlocks: async (ids) => {
      deleted.push(...ids);
      return true;
    },
  };

  const result = await annotations._syncItemAnnotations.call(fake, {
    documentID,
    notebook: { id: "nb" },
    item: {},
    pdfs: [{}],
  });

  check(
    "an unchanged annotation is not written again",
    !updates.includes("b1"),
    updates.join(",") || "nothing updated",
  );
  check(
    "a changed annotation is updated in place",
    updates.join(",") === "b2",
    updates.join(","),
  );
  check(
    "a new annotation is appended",
    appended.includes("[!quote]") && result.added === 1,
    String(result.added),
  );
  check(
    "an annotation that is gone takes its block with it",
    deleted.join(",") === "b3" && result.removed === 1,
    deleted.join(","),
  );
  check(
    "the index learns where the updated and new notes are",
    remembered.join(",") === "NEW:b4,EDIT:b2",
    remembered.join(",") || "nothing remembered",
  );
  check(
    "the summary counts what happened",
    /Annotations: 1 added, 1 updated, 1 removed/.test(result.summary),
    result.summary,
  );

  check(
    "the sync only touches the blocks it wrote itself",
    /SECTION_ATTR/.test(readSrc("app/item-annotations.js")) &&
      /ITEM_SECTION_ANNOTATIONS/.test(readSrc("app/item-annotations.js")),
  );
  check(
    "a changed template re-renders the notes",
    /TEMPLATE_ATTR/.test(readSrc("app/item-annotations.js")) &&
      /templateFingerprint/.test(readSrc("app/item-annotations.js")),
  );
  check(
    "the literature-note sync brings the annotations along",
    /_syncItemAnnotations\(/.test(readSrc("app/item-send.js")),
  );
  check(
    "the annotations preference exists",
    /pref\("itemSyncAnnotations"/.test(
      readSrc("../addon/prefs.js"),
    ),
  );
}
