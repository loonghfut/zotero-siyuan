/**
 * Zotero → SiYuan — the static checks for The reader's sidebar contract.
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

/* --------------------- 12. the reader's sidebar contract ------------------ */

section("Reader sidebar contract");
{
  // The reader puts every append() call into a box of its own, so the
  // button and the marker have to be appended together — otherwise they end
  // up in two boxes, neither of them can see the other, and the sidebar
  // shows two markers.
  const source = allSource;
  const renderHandler = source.match(
    /_onRenderSidebarAnnotationHeader\(event\)\s*\{([\s\S]*?)\r?\n  \},?\r?\n/,
  );
  const body = renderHandler ? renderHandler[1] : "";
  const appendCalls = (body.match(/event\.append\(/g) || []).length;
  check(
    "the button and the marker are appended in one call",
    appendCalls === 1 && body.includes("event.append(...nodes)"),
    `${appendCalls} append() calls`,
  );
  check(
    "the marker is only removed when it was put in by hand",
    source.includes('querySelectorAll("[data-zsi-manual]")') &&
      source.includes("data-zsi-manual"),
  );
  const dropBody = (source.match(
    /_dropManualLinks\(doc, annotationKey\)\s*\{([\s\S]*?)\n  \},/,
  ) || ["", ""])[1];
  check(
    "the hand-made markers are filed, not searched for",
    // A sidebar renders one header per annotation. Looking for the
    // hand-made marker with a document-wide query, once per header, is the
    // cost that makes a PDF with hundreds of annotations slow to open — so
    // the markers are filed by annotation, and the one scan happens when the
    // document is first seen.
    /_manualLinksOf\(doc\)\s*\{[\s\S]*?this\._manualLinks\.get\(doc\)/.test(
      source,
    ) &&
      dropBody.includes("this._manualLinksOf(doc)") &&
      // The guard (`doc.querySelectorAll` as a truthiness test) is fine —
      // a query with a selector is what must not be there.
      !dropBody.includes('querySelectorAll("'),
  );
  check(
    "the lookup for an existing marker covers the whole document",
    // The reader puts every append() call into a box of its own, so the
    // marker and the button may sit in different boxes.
    /doc\.querySelectorAll\("\.zotero-siyuan-sent-link"\)/.test(source),
  );
  check(
    "the context menu does not use an undefined document",
    // `doc` has to come from the reader, not from the event.
    source.includes("const doc = this._readerDoc(reader);"),
  );
  check(
    "the reader's document is remembered while the sidebar renders",
    source.includes("this._readerDocs.set(event.reader, doc)"),
  );
  check(
    "a reader that was drawn before the plugin gets the button",
    source.includes("_patchReaderSidebars") && source.includes("_annotationKeyOf"),
  );
  check(
    "only the box of an annotation is patched, not the toolbar's",
    // The reader has boxes of its own — the toolbar, for one. Only the
    // preview of an annotation carries its key.
    /_annotationKeyOf\(box\)\s*\{[\s\S]*?closest\("\.preview"\)/.test(source),
  );
  check(
    "the button is built in one place, for both ways in",
    source.includes("_createButton(doc, annotation, event.reader)") &&
      source.includes(
        "_createButton(doc, await this._annotationFromItem(item), reader)",
      ),
  );

  /* --- one send at a time, and the buttons say so ---------------------- */

  check(
    "every button of a reader is disabled while a send runs",
    // A second click during a send would write the same note twice, so it
    // is not the clicked button alone that is taken away.
    /_setReaderBusy\(doc, busy\)\s*\{[\s\S]*?this\._busyDocs\.add\(doc\)[\s\S]*?querySelectorAll\(/.test(
      source,
    ) &&
      source.includes("this._setReaderBusy(doc, true)") &&
      source.includes("this._setReaderBusy(doc, false)") &&
      source.includes("this._setReaderBusy(target, true)") &&
      source.includes("this._setReaderBusy(target, false)"),
  );
  check(
    "a header drawn during a send arrives disabled",
    // The reader can redraw a header while a send runs; a button that
    // appears ready and then refuses is worse than one that looks busy.
    source.includes("if (this._busyDocs && this._busyDocs.has(doc))") &&
      source.includes("button.disabled = true;"),
  );

  /* --- a batch is one process at a time, but not silent ---------------- */

  check(
    "a batch says how far it is",
    /_sendMany\(ids, reader, doc\)\s*\{[\s\S]*?_batchProgress\(0, total\)/.test(
      source,
    ) &&
      source.includes("progress.update(") &&
      // The same bubble carries the answer at the end instead of a second
      // one appearing next to it.
      source.includes("progress.update(done)"),
  );
  check(
    "a batch looks the PDF and its parent up once",
    // Two library reads per note for a batch of fifty is ninety-eight reads
    // that all answer the same thing.
    /async _getAttachment\(reader\)\s*\{[\s\S]*?const memo = this\._batchMemo[\s\S]*?memo\.attachments\.set/
      .test(source) &&
      /const memo = this\._batchMemo;[\s\S]*?this\._loadItem\(pdf\.parentItemID\)/.test(
        source,
      ) &&
      source.includes("this._batchMemo = null"),
  );
}
