/**
 * Zotero → SiYuan — sending a whole item, not one annotation.
 *
 * The reader is not the only place a user works: the item list is where a
 * paper is selected before it is opened. From there the plugin can put the
 * item's information, its abstract, its child notes or all of its
 * annotations into SiYuan, and it can create the literature-note document
 * itself.
 */

import { getString } from "../utils/locale.js";
import {
  collectMetadata,
  siyuanBlockLink,
} from "../modules/metadata.js";
import {
  abstractMarkdown,
  itemInfoMarkdown,
  noteHtmlToMarkdown,
  notesMarkdown,
} from "../modules/item-note.js";
import { showToast } from "../modules/toast.js";

export default {
  /** The PDF attachments of an item, in library order. */
  async _pdfAttachments(item) {
    if (!item || !item.isRegularItem || !item.isRegularItem()) {
      return [];
    }
    const attachments = [];
    for (const id of item.getAttachments() || []) {
      const attachment = await Zotero.Items.getAsync(id);
      if (!attachment) {
        continue;
      }
      let isPDF = false;
      try {
        isPDF = attachment.isPDFAttachment
          ? attachment.isPDFAttachment()
          : attachment.attachmentContentType === "application/pdf";
      }
      catch (e) {
        isPDF = false;
      }
      if (isPDF) {
        attachments.push(attachment);
      }
    }
    return attachments;
  },

  /** The template variables of an item, without an annotation. */
  async _itemVars(item, pdf = null) {
    return collectMetadata({
      annotation: {},
      parentItem: item,
      attachment: pdf,
      extra: this._now(),
    });
  },

  /** The child notes of an item as Markdown. */
  async _itemNotes(item) {
    const notes = [];
    for (const id of item.getNotes() || []) {
      const note = await Zotero.Items.getAsync(id);
      if (!note) {
        continue;
      }
      let html = "";
      try {
        html = note.getNote() || "";
      }
      catch (e) {
        html = "";
      }
      const markdown = noteHtmlToMarkdown(html);
      if (markdown) {
        notes.push(markdown);
      }
    }
    return notes;
  },

  /**
   * Put item-level Markdown where the settings say notes go.
   *
   * @param {Object} item - the regular item
   * @param {String} markdown
   * @param {Object} [options]
   * @param {Boolean} [options.itemDocument] - always use the item's own
   *   document, whatever the destination preference says
   * @param {Object} [options.vars] - the template variables the caller
   *   already collected; looking them up again would repeat the library reads
   * @returns {Promise<Object|null>} what the write answered
   */
  async _sendItemMarkdown(
    item,
    markdown,
    { itemDocument = false, vars = null } = {},
  ) {
    const text = String(markdown || "").trim();
    if (!text) {
      return null;
    }
    // The same lock the annotation sends use: an item write and a batch
    // must not be in the workspace at once.
    if (this._sending || this._shutDown) {
      if (this._sending) {
        try {
          showToast({
            doc: this._mainDoc(),
            title: getString("zoteroSiYuan-busy", "Sending…"),
            message: getString(
              "zoteroSiYuan-busy-hint",
              "Wait for it to finish.",
            ),
          });
        }
        catch (e) {
          // The menu command still does nothing, silently.
        }
      }
      return null;
    }
    this._sending = true;
    try {
      return await this._writeItemMarkdown(item, text, itemDocument, vars);
    }
    finally {
      this._sending = false;
    }
  },

  /**
   * The write itself — see `_sendItemMarkdown`, which holds the lock.
   *
   * @param {Object} item
   * @param {String} text
   * @param {Boolean} itemDocument
   * @param {Object|null} vars
   * @returns {Promise<Object|null>}
   */
  async _writeItemMarkdown(item, text, itemDocument, vars) {
    let resolved = vars;
    if (!resolved) {
      const pdfs = await this._pdfAttachments(item);
      resolved = await this._itemVars(item, pdfs[0] || null);
    }
    // A fixed document is addressed by its own id; everything else needs
    // the notebook (the daily note, or the document created for the item).
    const kind = this._destinationKind();
    const notebook = itemDocument || kind !== "document"
      ? await this._resolveNotebook()
      : null;
    const destination = itemDocument
      ? await this._resolveItemDocument(notebook, resolved)
      : await this._resolveDestination({ notebook, vars: resolved });
    let written;
    try {
      written = await this._append(
        notebook ? notebook.id : "",
        text,
        null,
        { target: destination },
      );
    }
    catch (e) {
      Zotero.logError(`ZoteroSiYuan: could not send the item: ${e}`);
      this._notifyItemError(e);
      return null;
    }
    this._notifyItem(written || {}, destination);
    return written;
  },

  /** The bubble for an item-level write. */
  _notifyItem(written, destination) {
    const blockID = (written && written.blockID) || "";
    const where =
      (destination && destination.title) ||
      (written && written.documentID) ||
      "SiYuan";
    try {
      showToast({
        title: getString("zoteroSiYuan-item-sent-title", "Sent to SiYuan"),
        message: where,
        link: siyuanBlockLink(blockID),
        linkLabel: getString("zoteroSiYuan-toast-open", "Open in SiYuan"),
        onLink: blockID ? () => this._openInSiYuan(blockID) : null,
        doc: this._mainDoc(),
      });
    }
    catch (e) {
      // The note is in SiYuan; the bubble is optional.
    }
  },

  /** The bubble for a failed item-level write. */
  _notifyItemError(error) {
    try {
      showToast({
        title: getString(
          "zoteroSiYuan-item-failed-title",
          "Could not send the item to SiYuan",
        ),
        message: String((error && error.message) || error),
        timeout: 0,
        doc: this._mainDoc(),
      });
    }
    catch (e) {
      // Logged by the caller.
    }
  },

  /** The item's metadata, as a note of its own. */
  async _sendItemInfo(item) {
    const pdfs = await this._pdfAttachments(item);
    const vars = await this._itemVars(item, pdfs[0] || null);
    return await this._sendItemMarkdown(item, itemInfoMarkdown(vars), { vars });
  },

  /** The item's abstract. */
  async _sendItemAbstract(item) {
    const pdfs = await this._pdfAttachments(item);
    const vars = await this._itemVars(item, pdfs[0] || null);
    const text = abstractMarkdown(vars);
    if (!text) {
      this._notifyItemError(
        new Error(
          getString("zoteroSiYuan-item-no-abstract", "This item has no abstract."),
        ),
      );
      return null;
    }
    return await this._sendItemMarkdown(item, text, { vars });
  },

  /** The item's child notes. */
  async _sendItemNotes(item) {
    const pdfs = await this._pdfAttachments(item);
    const vars = await this._itemVars(item, pdfs[0] || null);
    const notes = await this._itemNotes(item);
    if (!notes.length) {
      this._notifyItemError(
        new Error(
          getString("zoteroSiYuan-item-no-notes", "This item has no notes."),
        ),
      );
      return null;
    }
    return await this._sendItemMarkdown(item, notesMarkdown(vars, notes), {
      vars,
    });
  },

  /**
   * Every annotation of the item, as a normal batch send.
   *
   * That keeps each annotation's own block, marker and index entry — an
   * item-level "all annotations" is the same thing as selecting them in
   * the reader, not a second, simpler format.
   */
  async _sendItemAnnotations(item) {
    const pdfs = await this._pdfAttachments(item);
    const ids = [];
    for (const pdf of pdfs) {
      let annotations = [];
      try {
        annotations = (await pdf.getAnnotations()) || [];
      }
      catch (e) {
        annotations = [];
      }
      for (const entry of annotations) {
        const annotation = typeof entry === "number"
          ? await Zotero.Items.getAsync(entry)
          : entry;
        if (annotation && annotation.key) {
          ids.push(annotation.key);
        }
      }
    }
    if (!ids.length) {
      this._notifyItemError(
        new Error(
          getString(
            "zoteroSiYuan-item-no-annotations",
            "This item has no annotations.",
          ),
        ),
      );
      return null;
    }
    return await this._sendMany(ids, null, this._mainDoc());
  },

  /**
   * Create the item's literature-note document and put its information in.
   *
   * The document is reused when it already exists — the annotations of the
   * item go there as well, and a second document for the same paper would
   * split them.
   */
  async _createItemNoteDocument(item) {
    const pdfs = await this._pdfAttachments(item);
    const vars = await this._itemVars(item, pdfs[0] || null);
    const sections = [
      itemInfoMarkdown(vars),
      abstractMarkdown(vars),
      notesMarkdown(vars, await this._itemNotes(item)),
    ];
    const text = sections.filter(Boolean).join("\n\n");
    return await this._sendItemMarkdown(item, text, {
      itemDocument: true,
      vars,
    });
  },
};
