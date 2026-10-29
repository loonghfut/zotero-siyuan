/**
 * Zotero → SiYuan — the pictures inside a child note.
 *
 * A note does not hold its pictures: Zotero keeps each one as an attachment
 * and the note only names it. These checks are about reading that name,
 * pointing it at the copy in the workspace, and taking the copy back when
 * the note that would refer to it never gets written.
 *
 * Part of `node tools/validate.mjs`: this file runs when it is imported,
 * and the entry point prints the summary.
 */

import { check, readSrc, section } from "./harness.mjs";

const { noteImageRefs, rewriteNoteImages } = await import(
  new URL("../../src/modules/note-images.js", import.meta.url).href
);
const { htmlToMarkdown } = await import(
  new URL("../../src/modules/note-html.js", import.meta.url).href
);
const { default: pictures, notePictureName } = await import(
  new URL("../../src/app/item-pictures.js", import.meta.url).href
);

/* ---------------------- 15a. reading a note's pictures ----------------- */

section("Note pictures — what a note refers to");
{
  const stored =
    '<p>Text</p><img alt="" width="759" height="431" ' +
    'data-attachment-key="GZRNT3UA" ' +
    'data-annotation="%7B%22pageLabel%22%3A%22828%22%7D">';
  const refs = noteImageRefs(stored);
  check(
    "Zotero 7 names a picture by its attachment",
    refs.length === 1 &&
      refs[0].key === "GZRNT3UA" &&
      refs[0].id === "key:GZRNT3UA" &&
      refs[0].dataURL === "",
    JSON.stringify(refs),
  );

  const repeated = noteImageRefs(
    stored +
      '<p>Again</p><img data-attachment-key="GZRNT3UA">' +
      '<img data-attachment-key="OTHER123">',
  );
  check(
    "the same picture twice is one upload",
    repeated.length === 2,
    JSON.stringify(repeated),
  );

  const data = "data:image/png;base64,iVBORw0KGgo=";
  const old = noteImageRefs(`<p><img src="${data}"></p>`);
  check(
    "a picture written into the HTML is found by its bytes",
    old.length === 1 &&
      old[0].key === "" &&
      old[0].dataURL === data &&
      old[0].id === `data:${data}`,
    JSON.stringify(old),
  );

  const linked = noteImageRefs('<img src="zotero://attachment/ABCD2345/">');
  check(
    "an attachment named in the src is found too",
    linked.length === 1 && linked[0].key === "ABCD2345",
    JSON.stringify(linked),
  );

  check(
    "a picture SiYuan can load itself is left alone",
    noteImageRefs('<img src="https://example.com/a.png">').length === 0 &&
      noteImageRefs('<img src="https://example.com/a.png">').length === 0,
  );
}

/* --------------------- 15b. pointing a note elsewhere ------------------ */

section("Note pictures — the address in the workspace");
{
  const asset = "assets/zotero-siyuan-note-GZRNT3UA.png";
  const assets = new Map([["key:GZRNT3UA", asset]]);

  const rewritten = rewriteNoteImages(
    '<p><img alt="figure 1" width="759" data-attachment-key="GZRNT3UA"></p>',
    assets,
  );
  check(
    "the picture is pointed at the workspace and keeps its alt text",
    rewritten.includes(`src="${asset}"`) && rewritten.includes('alt="figure 1"'),
    rewritten,
  );
  check(
    "the tag stays well-formed when the new address is added",
    /<img\b[^>]*\sdata-attachment-key="GZRNT3UA"\s+src="/.test(rewritten) &&
      !/"src="|'src="/.test(rewritten),
    rewritten,
  );
  check(
    "the note becomes Markdown that shows the picture",
    htmlToMarkdown(rewritten) === `![figure 1](${asset})`,
    htmlToMarkdown(rewritten),
  );

  const oldSrc = rewriteNoteImages(
    '<img src="data:image/png;base64,AAA" data-attachment-key="GZRNT3UA">',
    assets,
  );
  check(
    "an address that was already there is replaced, not doubled",
    (oldSrc.match(/\bsrc=/g) || []).length === 1 &&
      oldSrc.includes(`src="${asset}"`),
    oldSrc,
  );

  const untouched = rewriteNoteImages(
    '<img src="https://example.com/a.png">' +
      '<img data-attachment-key="MISSING1">',
    assets,
  );
  check(
    "a picture with no copy is left as it was",
    untouched.includes("https://example.com/a.png") &&
      untouched.includes('data-attachment-key="MISSING1"') &&
      !untouched.includes("MISSING1\" src="),
    untouched,
  );

  check(
    "no uploads, no rewriting",
    rewriteNoteImages('<img data-attachment-key="GZRNT3UA">', new Map()) ===
      '<img data-attachment-key="GZRNT3UA">',
  );
}

/* ------------------------ 15c. the file in assets ---------------------- */

section("Note pictures — one file per picture");
{
  const key = notePictureName({ key: "GZRNT3UA", dataURL: "" });
  check(
    "a picture keeps the same file across two syncs",
    key === notePictureName({ key: "GZRNT3UA", dataURL: "" }) &&
      key === "zotero-siyuan-note-GZRNT3UA" &&
      !/\d{14}/.test(key),
    key,
  );
  check(
    "two pictures get two files",
    notePictureName({ key: "AAAA1111" }) !== notePictureName({ key: "BBBB2222" }),
  );
  const inNote = notePictureName({ key: "", dataURL: "data:image/png;base64,AAA" });
  check(
    "a picture from the HTML is named after its bytes",
    inNote.startsWith("zotero-siyuan-note-") &&
      inNote ===
        notePictureName({ key: "", dataURL: "data:image/png;base64,AAA" }) &&
      inNote !==
        notePictureName({ key: "", dataURL: "data:image/png;base64,BBB" }),
    inNote,
  );
}

/* ------------------------- 15d. where the bytes are -------------------- */

section("Note pictures — finding the bytes");
{
  const saved = globalThis.Zotero;
  const asked = [];
  globalThis.Zotero = {
    debug() {},
    logError() {},
    Libraries: { userLibraryID: 1 },
    Items: {
      async getByLibraryAndKeyAsync(libraryID, key) {
        asked.push(`${libraryID}:${key}`);
        if (key === "GZRNT3UA") {
          return { getFilePathAsync: async () => "/zotero/storage/GZRNT3UA/image.png" };
        }
        if (key === "TEXT1212") {
          return { getFilePathAsync: async () => ({}) };
        }
        return null;
      },
    },
  };
  try {
    const fromAttachment = await pictures._noteImageSource(
      { key: "GZRNT3UA", dataURL: "" },
      3,
    );
    check(
      "an attachment is looked up in the note's own library",
      fromAttachment && fromAttachment.path === "/zotero/storage/GZRNT3UA/image.png" &&
        asked[0] === "3:GZRNT3UA",
      JSON.stringify({ fromAttachment, asked }),
    );

    const fromHTML = await pictures._noteImageSource(
      { key: "", dataURL: "data:image/png;base64,AAA" },
      1,
    );
    check(
      "a picture in the HTML needs no lookup",
      fromHTML && fromHTML.dataURL === "data:image/png;base64,AAA",
      JSON.stringify(fromHTML),
    );

    const missing = await pictures._noteImageSource({ key: "NOPE9999" }, 1);
    check("a picture that is gone answers nothing", missing === null);

    const unreadable = await pictures._noteImageSource({ key: "TEXT1212" }, 1);
    check(
      "an attachment that has no file answers nothing",
      unreadable === null,
    );
  }
  finally {
    if (saved === undefined) {
      delete globalThis.Zotero;
    }
    else {
      globalThis.Zotero = saved;
    }
  }
}

/* ---------------------- 15e. a write that never happens ---------------- */

section("Note pictures — taken back with the write");
{
  const make = (overrides = {}) => ({
    _pendingPicture: { asset: "assets/a.png", file: "/tmp/a.png" },
    _batchPictures: null,
    dropped: 0,
    async _dropPictures() {
      this.dropped++;
      this._batchPictures = null;
      this._pendingPicture = null;
    },
    ...overrides,
  });

  const kept = make();
  const keptResult = await pictures._withItemPictures.call(kept, async () => ({ blockID: "b" }));
  check(
    "a note that was written keeps its pictures",
    kept.dropped === 0 && kept._pendingPicture === null &&
      kept._batchPictures === null && keptResult.blockID === "b",
    JSON.stringify(keptResult),
  );

  const nothing = make();
  const nothingResult = await pictures._withItemPictures.call(
    nothing,
    async () => {
      nothing._batchPictures.push({ asset: "assets/a.png", file: "/tmp/a.png" });
      return null;
    },
  );
  check(
    "a send that wrote nothing takes its pictures back",
    nothingResult === null && nothing.dropped === 1,
    String(nothing.dropped),
  );

  const failed = make();
  let threw = null;
  try {
    await pictures._withItemPictures.call(failed, async () => {
      failed._batchPictures.push({ asset: "assets/a.png", file: "/tmp/a.png" });
      throw new Error("the kernel is not running");
    });
  }
  catch (e) {
    threw = e;
  }
  check(
    "a failed write takes its pictures back and the error survives",
    failed.dropped === 1 && threw && /kernel/.test(threw.message),
    `${failed.dropped} / ${threw && threw.message}`,
  );

  const unknown = make();
  try {
    await pictures._withItemPictures.call(unknown, async () => {
      unknown._batchPictures.push({ asset: "assets/a.png", file: "/tmp/a.png" });
      throw Object.assign(new Error("no answer"), { writeState: "unknown" });
    });
  }
  catch (e) {
    // The note may already be there — the picture must stay with it.
  }
  check(
    "a write that may have happened keeps its pictures",
    unknown.dropped === 0,
    String(unknown.dropped),
  );
}

/* ------------------------- 15f. the send path -------------------------- */

section("Note pictures — wired into the send");
{
  check(
    "a note is converted with its pictures pointed elsewhere",
    /_noteImageAssets\(/.test(readSrc("app/item-note-docs.js")) &&
      /rewriteNoteImages\(html, assets\)/.test(readSrc("app/item-note-docs.js")),
  );
  check(
    "the pictures go through the same pipeline as a 框选",
    /exportPicture\(/.test(readSrc("app/item-pictures.js")),
  );
  const content = readSrc("app/content.js");
  check(
    "one place decides how a picture is compressed",
    /_pictureSettings\(\)\s*\{/.test(content) &&
      /prefFlag\("imageCompress", true\)/.test(content) &&
      /getPref\("imageQuality", "82"\)/.test(content),
  );
  check(
    "both kinds of picture are sent with those settings",
    /this\._pictureSettings\(\)/.test(content) &&
      /this\._pictureSettings\(\)/.test(readSrc("app/item-pictures.js")) &&
      !/imageCompress|imageQuality/.test(readSrc("app/item-pictures.js")),
  );
  check(
    "both note sends hold on to their pictures",
    /_withItemPictures\(/.test(readSrc("app/item-actions.js")) &&
      (readSrc("app/item-send.js").match(/_withItemPictures\(/g) || []).length >= 1,
  );
  check(
    "a picture is remembered for the cleanup",
    /this\._pendingPicture = \{ asset: picture\.asset, file: picture\.file \}/.test(
      readSrc("app/item-pictures.js"),
    ) &&
      /this\._batchPictures\.push\(this\._pendingPicture\)/.test(
        readSrc("app/item-pictures.js"),
      ),
  );
}
