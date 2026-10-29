/**
 * Zotero → SiYuan — a child note written as a document of its own.
 *
 * The checks are about the part a build cannot see: that the sub-document
 * carries the attributes a later sync finds it by, that an unchanged note is
 * left alone, that a changed one is rewritten in place, and that a note that
 * disappeared takes its document with it.
 *
 * Part of `node tools/validate.mjs`: this file runs when it is imported, and
 * the entry point prints the summary.
 */

import { check, readSrc, section } from "./harness.mjs";

const { default: noteDocs } = await import(
  new URL("../../src/app/item-note-docs.js", import.meta.url).href
);
const { noteDocumentAttributes } = await import(
  new URL("../../src/modules/block-attrs.js", import.meta.url).href
);
const { DEFAULT_NOTES_TEMPLATE } = await import(
  new URL("../../src/modules/item-note.js", import.meta.url).href
);
const { templateFingerprint } = await import(
  new URL("../../src/modules/template.js", import.meta.url).href
);

/* ---------------------- 16a. what a note document carries -------------- */

section("Note documents — the attributes");
{
  const attrs = noteDocumentAttributes(
    "ITEM1",
    2,
    "NOTE1",
    "2026-01-01 10:00:00",
    "fingerprint",
  );
  check(
    "the document names the note, the item and the library",
    attrs["custom-zsi-section"] === "note-document" &&
      attrs["custom-zsi-item-key"] === "ITEM1" &&
      attrs["custom-zotero-note-key"] === "NOTE1" &&
      attrs["custom-zotero-library-id"] === "2",
    JSON.stringify(attrs),
  );
  check(
    "the timestamp and the template are part of the record",
    attrs["custom-zotero-modified"] === "2026-01-01 10:00:00" &&
      attrs["custom-zsi-template"] === "fingerprint",
    JSON.stringify(attrs),
  );
  check(
    "a note document is not the item document",
    !("custom-zotero-item-key" in attrs),
    JSON.stringify(attrs),
  );
}

/* ------------------------- 16b. naming a note document ----------------- */

section("Note documents — the title");
{
  check(
    "a heading becomes the name without its hashes",
    noteDocs._noteTitle("## Results and discussion\n\nText") ===
      "Results and discussion",
  );
  check(
    "a link keeps its text, not its address",
    noteDocs._noteTitle("[The paper](https://example.com/a)")
      === "The paper",
  );
  check(
    "a note with no text falls back to the section label",
    noteDocs._noteDocumentTitle({ markdown: "" }, 1) === "Notes 2",
  );
  const titles = noteDocs._noteDocumentTitles([
    { markdown: "# Same" },
    { markdown: "# Same" },
  ]);
  check(
    "two notes with one name get two document names",
    titles[0] === "Same" && titles[1] === "Same (2)",
    titles.join(" / "),
  );
}

/* -------------------- 16c. creating and updating them ------------------ */

section("Note documents — the sync");
{
  const stamp = templateFingerprint(DEFAULT_NOTES_TEMPLATE);

  const make = (overrides = {}) => ({
    ...noteDocs,
    _itemSectionTemplate: () => "",
    _noteDocuments: async () => new Map(),
    _createNoteDocument: async () => "20260101000000-note001",
    _stampNoteDocument: async () => true,
    _noteDocumentBlocks: async () => [],
    _replaceItemSection: async () => ({ updated: false, gone: false }),
    _append: async () => ({ blockID: "b" }),
    _deleteBlocks: async () => true,
    _renameNoteDocument: async () => true,
    _deleteDocuments: async (ids) => ids.length,
    ...overrides,
  });

  {
    const calls = [];
    const fake = make({
      _createNoteDocument: async (notebook, parentID, title, markdown) => {
        calls.push({ notebook, parentID, title, markdown });
        return "20260101000000-note001";
      },
    });
    const result = await noteDocs._syncItemNoteDocuments.call(fake, {
      itemDocumentID: "20260101000000-docdocd",
      notebook: { id: "nb" },
      entries: [{ key: "NOTE1", modified: "2026-01-01", markdown: "## Results\n\nText" }],
      vars: { title: "A paper" },
      itemKey: "ITEM1",
      libraryID: 1,
    });
    check(
      "a new note becomes a document under the item's document",
      calls.length === 1 &&
        calls[0].notebook.id === "nb" &&
        calls[0].parentID === "20260101000000-docdocd" &&
        calls[0].title === "Results",
      JSON.stringify(calls),
    );
    check(
      "the document carries the attributes and the rendered note",
      calls.length === 1 &&
        /custom-zotero-note-key="NOTE1"/.test(calls[0].markdown) &&
        /custom-zsi-section="note-document"/.test(calls[0].markdown),
      calls[0] && calls[0].markdown,
    );
    check("the summary counts the new document", result.added === 1, result.summary);
  }

  {
    const updates = [];
    const fake = make({
      _noteDocuments: async () =>
        new Map([
          ["NOTE1", {
            id: "20260101000000-oldnote",
            title: "Results",
            modified: "2026-01-01",
            template: stamp,
          }],
        ]),
      _noteDocumentBlocks: async () => ["20260101000000-block01"],
      _replaceItemSection: async (blockID) => {
        updates.push(blockID);
        return { updated: true, gone: false };
      },
    });
    const result = await noteDocs._syncItemNoteDocuments.call(fake, {
      itemDocumentID: "20260101000000-docdocd",
      notebook: { id: "nb" },
      entries: [{ key: "NOTE1", modified: "2026-01-01", markdown: "## Results" }],
      vars: {},
      itemKey: "ITEM1",
      libraryID: 1,
    });
    check(
      "an unchanged note is not written again",
      updates.length === 0 && result.updated === 0,
      updates.join(",") || "nothing updated",
    );

    const changed = await noteDocs._syncItemNoteDocuments.call(fake, {
      itemDocumentID: "20260101000000-docdocd",
      notebook: { id: "nb" },
      entries: [{ key: "NOTE1", modified: "2026-05-05", markdown: "## Results" }],
      vars: {},
      itemKey: "ITEM1",
      libraryID: 1,
    });
    check(
      "a changed note is rewritten in place",
      updates.join(",") === "20260101000000-block01" && changed.updated === 1,
      updates.join(",") || "nothing updated",
    );
  }

  {
    const deleted = [];
    const fake = make({
      _noteDocuments: async () =>
        new Map([
          ["NOTE1", { id: "20260101000000-keepme1", title: "Kept", modified: "x", template: stamp }],
          ["NOTE2", { id: "20260101000000-gone002", title: "Gone", modified: "x", template: stamp }],
        ]),
      _deleteDocuments: async (ids) => {
        deleted.push(...ids);
        return ids.length;
      },
    });
    const result = await noteDocs._syncItemNoteDocuments.call(fake, {
      itemDocumentID: "20260101000000-docdocd",
      notebook: { id: "nb" },
      entries: [{ key: "NOTE1", modified: "x", markdown: "## Kept" }],
      vars: {},
      itemKey: "ITEM1",
      libraryID: 1,
    });
    check(
      "a note that is gone takes its document with it",
      deleted.join(",") === "20260101000000-gone002" && result.removed === 1,
      deleted.join(",") || "nothing removed",
    );

    const emptied = await noteDocs._syncItemNoteDocuments.call(fake, {
      itemDocumentID: "20260101000000-docdocd",
      notebook: { id: "nb" },
      entries: [],
      vars: {},
      itemKey: "ITEM1",
      libraryID: 1,
    });
    check(
      "turning the setting off takes every note document back",
      deleted.includes("20260101000000-keepme1") && emptied.removed === 2,
      `${emptied.removed} removed`,
    );
  }
}

/* --------------------------- 16d. the wiring --------------------------- */

section("Note documents — the setting and the transports");
{
  check(
    "the preference exists and is off by default",
    /pref\("itemNotesAsSubdocs", "0"\)/.test(readSrc("../addon/prefs.js")),
  );
  check(
    "the preferences pane shows the switch",
    /zotero-prefpane-zoteroSiYuan-item-notes-subdocs/.test(
      readSrc("../addon/content/preferences.xhtml"),
    ) &&
      /data-l10n-id="pref-item-notes-subdocs"/.test(
        readSrc("../addon/content/preferences.xhtml"),
      ),
  );
  check(
    "the pane writes the preference",
    /ITEM_NOTES_SUBDOCS_ID/.test(readSrc("../addon/content/preferences.js")) &&
      /_saveItemNotesSubdocs/.test(
        readSrc("../addon/content/preferences-actions.js"),
      ) &&
      /"itemNotesAsSubdocs"/.test(
        readSrc("../addon/content/preferences-actions.js"),
      ),
  );
  check(
    "the item sync asks for the switch",
    /prefFlag\("itemNotesAsSubdocs", false\)/.test(
      readSrc("app/item-send.js"),
    ) &&
      /_syncItemNoteDocuments\(/.test(readSrc("app/item-send.js")),
  );
  check(
    "a document is created under the item's document",
    /path: String\(parentID\)/.test(readSrc("app/note-documents.js")),
  );
  check(
    "the CLI and HTTP can remove and rename a document",
    /"document",\s*"remove",\s*"--id"/.test(readSrc("modules/siyuan-documents.js")) &&
      /"document",\s*"rename",\s*"--id"/.test(
        readSrc("modules/siyuan-documents.js"),
      ) &&
      /\/api\/filetree\/removeDocByID/.test(readSrc("modules/siyuan-http.js")) &&
      /\/api\/filetree\/renameDocByID/.test(readSrc("modules/siyuan-http.js")),
  );
  check(
    "the bubble reports what happened to the notes",
    /noteDocumentSummary/.test(readSrc("app/item-notify.js")),
  );
}
