/**
 * Zotero → SiYuan — the pictures inside an item's child notes.
 *
 * A note does not hold its pictures: Zotero gives each one an attachment of
 * its own and the note only names it by key. SiYuan cannot read that name,
 * so the bytes have to be put into the workspace first — by the same road
 * the picture of a "框选" annotation takes: compressed, written under
 * `data/assets`, and referred to as `assets/…`.
 *
 * The writing is kept out of `item-send.js` so that file stays about the
 * note, and out of `content.js` so the annotation path keeps its own
 * bookkeeping. What is shared with it is the pipeline itself — the
 * compression preferences, `exportPicture`, and the rule that a picture the
 * note never came to refer to is taken back.
 */

import { noteImageRefs } from "../modules/note-images.js";
import { exportPicture } from "../modules/siyuan-image.js";
import { isWriteUnknown } from "../modules/siyuan-process.js";

/*
 * A short, stable name for a picture kept in the note itself.
 *
 * The picture has no key, so its own content is the name: a second sync of
 * the same note writes over the same file instead of leaving the old copy
 * behind.
 *
 * @param {String} text
 * @returns {String}
 */
function digest(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(36)}-${text.length.toString(36)}`;
}

/**
 * The file name a note's picture gets in the workspace.
 *
 * It is stable on purpose: a sync rewrites the whole notes section, and a
 * name with a timestamp in it would put a fresh copy of every picture into
 * the workspace on every sync. The same picture — the same attachment, or
 * the same bytes — keeps its file, and the note keeps its address.
 *
 * @param {Object} ref - from `noteImageRefs`
 * @returns {String}
 */
export function notePictureName(ref) {
  const key = String((ref && ref.key) || "").replace(/[^\w-]/g, "");
  if (key) {
    return `zotero-siyuan-note-${key}`;
  }
  return `zotero-siyuan-note-${digest(String((ref && ref.dataURL) || ""))}`;
}

export default {
  /**
   * Run a note send with the pictures it builds held onto.
   *
   * The pictures go into the workspace before the note does, so a write
   * that never happens would leave them there. A picture is only kept when
   * the write came back with something to show for it — and when the write
   * may have reached SiYuan but the answer was lost, the note may already
   * refer to the picture, so it stays.
   *
   * The list is this send's own: the annotations a literature note carries
   * are synced while the write is in flight, and that sync keeps its
   * pictures in the same field. Handing the cleanup this list — rather than
   * whatever the field holds by then — is what keeps a failure from taking
   * back the wrong picture, or leaving one behind.
   *
   * @param {Function} work - builds the notes and writes them
   * @returns {Promise<*>} whatever the work returned
   */
  async _withItemPictures(work) {
    const outer = Array.isArray(this._batchPictures)
      ? this._batchPictures
      : null;
    const mine = [];
    this._batchPictures = mine;
    let keep = false;
    try {
      const result = await work();
      keep = !!result;
      return result;
    }
    catch (e) {
      keep = isWriteUnknown(e);
      throw e;
    }
    finally {
      if (keep) {
        // Every picture here belongs to a note that is in SiYuan now.
        this._pendingPicture = null;
      }
      else if (mine.length) {
        this._batchPictures = mine;
        await this._dropPictures();
      }
      this._batchPictures = outer;
    }
  },

  /**
   * Put the pictures of a note into the workspace.
   *
   * A picture that cannot be found or placed is left out of the answer; the
   * note is still written without it. Losing a picture must never cost the
   * user the note around it.
   *
   * @param {String} html - the note as Zotero stores it
   * @param {Number} libraryID - the library the note lives in
   * @returns {Promise<Map<String,String>>} reference id → `assets/…`
   */
  async _noteImageAssets(html, libraryID) {
    const assets = new Map();
    const refs = noteImageRefs(html);
    if (!refs.length) {
      return assets;
    }
    const workspace = await this._resolveWorkspaceDir();
    if (!workspace) {
      Zotero.debug(
        "ZoteroSiYuan: the SiYuan workspace is unknown — the pictures of a note cannot be placed",
      );
      return assets;
    }
    // The same settings the "框选" pictures are sent with — one answer for
    // both, read in one place (`content.js`). A picture that came from a
    // page is compressed, and the note keeps what is left.
    const { compress, quality } = this._pictureSettings();
    for (const ref of refs) {
      try {
        const source = await this._noteImageSource(ref, libraryID);
        if (!source) {
          Zotero.debug(
            `ZoteroSiYuan: the picture of a note could not be found: ${ref.id}`,
          );
          continue;
        }
        const picture = await exportPicture(
          workspace,
          source,
          notePictureName(ref),
          { compress, quality },
        );
        if (!picture.asset) {
          continue;
        }
        assets.set(ref.id, picture.asset);
        // Where the picture went, so a write that never happens can take
        // it back — the same record the annotation path keeps.
        this._pendingPicture = { asset: picture.asset, file: picture.file };
        if (Array.isArray(this._batchPictures)) {
          this._batchPictures.push(this._pendingPicture);
        }
      }
      catch (e) {
        Zotero.logError(
          `ZoteroSiYuan: a picture of a note could not be placed: ${e}`,
        );
      }
    }
    return assets;
  },

  /**
   * Where the bytes of one picture of a note are.
   *
   * Zotero 7 gives every picture an attachment of its own, and the note
   * names that attachment by key. Zotero 6 wrote the picture into the
   * note's HTML as a data URL. Both are answered here.
   *
   * @param {Object} ref - from `noteImageRefs`
   * @param {Number} libraryID - the library the note lives in
   * @returns {Promise<Object|null>} `{ path }` or `{ dataURL }`
   */
  async _noteImageSource(ref, libraryID) {
    if (!ref) {
      return null;
    }
    if (ref.dataURL) {
      return { dataURL: ref.dataURL };
    }
    if (!ref.key) {
      return null;
    }
    const library = Number(libraryID) || Zotero.Libraries.userLibraryID;
    let item = null;
    try {
      // The asynchronous lookup is the one that works on a cold library
      // cache; the synchronous one is the fallback for an older build.
      item = typeof Zotero.Items.getByLibraryAndKeyAsync === "function"
        ? await Zotero.Items.getByLibraryAndKeyAsync(library, ref.key)
        : Zotero.Items.getByLibraryAndKey(library, ref.key);
    }
    catch (e) {
      item = null;
    }
    if (!item || typeof item.getFilePathAsync !== "function") {
      return null;
    }
    try {
      // Only a string is a path: `false` means the file is missing, and
      // anything else is not something `IOUtils.read` could open.
      const path = await item.getFilePathAsync();
      return typeof path === "string" && path ? { path } : null;
    }
    catch (e) {
      return null;
    }
  },
};
