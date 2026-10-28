/**
 * Zotero → SiYuan — resolving Zotero items: annotation, parent, attachment, key.
 */

import { annotationImagePath } from "../modules/siyuan-image.js";

export default {
  /** The reader's annotation model, built from a Zotero annotation item. */
  async _annotationFromItem(item) {
    let position = null;
    try {
      position = item.annotationPosition
        ? JSON.parse(item.annotationPosition)
        : null;
    }
    catch (e) {
      position = null;
    }
    // The picture of a "框选" annotation. It is looked up here, while the
    // item is at hand: the item knows which library it belongs to, and
    // that is what the cache path is built from.
    let imagePath = "";
    try {
      imagePath = (await annotationImagePath(item)) || "";
    }
    catch (e) {
      imagePath = "";
    }
    return {
      id: item.key,
      type: item.annotationType || "highlight",
      color: item.annotationColor || "",
      text: item.annotationText || "",
      comment: item.annotationComment || "",
      pageLabel: item.annotationPageLabel || "",
      authorName: item.annotationAuthorName || "",
      // The reader's own annotation model has no date, but the item it was
      // built from does — and a batch send has the item in hand right here.
      dateModified: item.dateModified || "",
      position,
      tags: (item.getTags() || []).map((t) => ({ name: t.tag })),
      imagePath,
    };
  },

  /** The Zotero item behind the reader's annotation model. */
  async _getAnnotationItem(annotation) {
    const id = annotation && annotation.id;
    if (!id) {
      return null;
    }
    try {
      if (/^\d+$/.test(String(id))) {
        return await Zotero.Items.getAsync(Number(id));
      }
      const key = String(id);
      const item = await Zotero.Items.getByLibraryAndKeyAsync(
        Zotero.Libraries.userLibraryID,
        key,
      );
      if (item) {
        return item;
      }
      // The annotation may live in a group library — looking it up in
      // "My Library" alone would miss it, and with it the picture.
      for (const library of this._groupLibraries()) {
        try {
          const found = await Zotero.Items.getByLibraryAndKeyAsync(
            library.libraryID,
            key,
          );
          if (found) {
            return found;
          }
        }
        catch (e) {
          // The library may not be loaded — try the next one.
        }
      }
      return null;
    }
    catch (e) {
      return null;
    }
  },

  /**
   * A reader-shaped object for an annotation that has no reader.
   *
   * Automatic sends, retries and item-level sends work from the annotation
   * item alone. `_buildVars` only needs the attachment, and an annotation's
   * parent *is* its attachment — so a small object is enough to let the
   * whole rendering path run unchanged.
   *
   * @param {Object} annotation
   * @returns {Promise<{itemID: Number}|null>}
   */
  async _readerForAnnotation(annotation) {
    const item = await this._getAnnotationItem(annotation);
    if (!item || !item.parentItemID) {
      return null;
    }
    return { itemID: item.parentItemID };
  },

  /**
   * Read the annotation items of a batch in the background.
   *
   * `_getAnnotationItem` is one library read per annotation, and a batch of
   * fifty notes did them one after another — every note waited for the one
   * before it. Here they are read a few at a time while the batch is
   * already writing, and the loop takes each answer when it arrives.
   *
   * @param {String[]} ids - annotation keys, or numeric item ids
   * @param {Number} [limit] - how many reads run at once
   * @returns {{get: (id: String) => Promise<Object|null>}}
   */
  _prefetchAnnotationItems(ids, limit = 4) {
    const byID = new Map();
    const queue = [];
    for (const id of ids || []) {
      const key = String(id);
      if (byID.has(key)) {
        continue;
      }
      let settle = null;
      const promise = new Promise((resolve) => {
        settle = resolve;
      });
      byID.set(key, promise);
      queue.push({ id: key, settle });
    }
    const read = async () => {
      while (queue.length) {
        const job = queue.shift();
        let item = null;
        try {
          item = await this._getAnnotationItem({ id: job.id });
        }
        catch (e) {
          item = null;
        }
        job.settle(item);
      }
    };
    for (let i = 0; i < Math.min(limit, queue.length); i++) {
      read();
    }
    return {
      get: (id) => byID.get(String(id)) || Promise.resolve(null),
    };
  },

  /** The group libraries, when Zotero knows about any. */
  _groupLibraries() {
    try {
      return (Zotero.Libraries.getAll() || []).filter(
        (library) =>
          library.libraryID !== Zotero.Libraries.userLibraryID,
      );
    }
    catch (e) {
      return [];
    }
  },

  /**
   * The regular item a PDF belongs to — the one with the bibliographic data.
   *
   * @param {Object} reader - the reader tab
   * @param {Object} [hooks] - what the self test watches this with
   * @param {Object} [attachment] - the PDF item, when it is already at hand
   * @returns {Promise<Object|null>}
   */
  async _getParentItem(reader, hooks = null, attachment = null) {
    try {
      if (hooks && hooks.stage) {
        hooks.stage("reading the parent item");
      }
      // The attachment is the same object the caller already asked for —
      // loading it a second time would be a second trip for one answer.
      // It is also enough on its own: a reader is only needed to find it.
      const pdf = attachment ||
        ((reader && reader.itemID) ? await this._getAttachment(reader) : null);
      if (!pdf || !pdf.parentItemID) {
        return null;
      }
      // A batch sends many annotations of one PDF: the parent is the same
      // item every time, so it is loaded once for the whole batch.
      const memo = this._batchMemo;
      if (memo) {
        if (!memo.parents.has(pdf.parentItemID)) {
          // The promise is filed, not its answer: the second annotation
          // waits for the same read instead of starting another one.
          memo.parents.set(
            pdf.parentItemID,
            this._loadItem(pdf.parentItemID),
          );
        }
        const memoized = await memo.parents.get(pdf.parentItemID);
        if (hooks && hooks.stage) {
          hooks.stage("parent item read");
        }
        return memoized || null;
      }
      const parent = await Zotero.Items.getAsync(pdf.parentItemID);
      if (hooks && hooks.stage) {
        hooks.stage("parent item read");
      }
      return parent;
    }
    catch (e) {
      Zotero.debug(`ZoteroSiYuan: could not resolve the parent item: ${e}`);
      return null;
    }
  },

  /**
   * The PDF attachment the reader is showing, if any.
   *
   * Inside a batch the item is loaded once and handed to every annotation:
   * a batch of fifty notes would otherwise read the same PDF fifty times.
   */
  async _getAttachment(reader) {
    const itemID = reader && reader.itemID;
    if (!itemID) {
      return null;
    }
    const memo = this._batchMemo;
    if (memo) {
      if (!memo.attachments.has(itemID)) {
        memo.attachments.set(itemID, this._loadItem(itemID));
      }
      return await memo.attachments.get(itemID);
    }
    return await this._loadItem(itemID);
  },

  /** Load one item, or null when it cannot be loaded. */
  async _loadItem(itemID) {
    try {
      return await Zotero.Items.getAsync(itemID);
    }
    catch (e) {
      return null;
    }
  },

  /**
   * The annotation's key.
   *
   * Zotero's protocol handler wants the *key* (`getByLibraryAndKey`), while
   * the reader may hand out the numeric item id — so both are accepted.
   */
  async _resolveAnnotationKey(annotation) {
    const id = annotation && annotation.id;
    if (!id) {
      return "";
    }
    const text = String(id);
    if (!/^\d+$/.test(text)) {
      return text;
    }
    try {
      const item = await Zotero.Items.getAsync(Number(text));
      return item && item.key ? item.key : "";
    }
    catch (e) {
      return "";
    }
  },

  /** The date and time, as the template wants them. */
  _now() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
      now.getDate(),
    )}`;
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    return {
      date,
      time,
      timestamp: `${date} ${time}:${pad(now.getSeconds())}`,

    };
  }

};
