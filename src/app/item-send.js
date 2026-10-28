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
import { withSection } from "../modules/block-attrs.js";
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
import { isBlockID } from "../modules/siyuan.js";
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
   * The three sections of a literature-note document.
   *
   * Each child note is its own callout, so `withSection` marks exactly one
   * block per section. The attributes are what a later sync uses to find and
   * replace those blocks — without touching the user's own text or the
   * annotation notes.
   *
   * @param {Object} vars
   * @param {String[]} notes - Markdown of each child note
   * @returns {String}
   */
  _itemSectionMarkdown(vars, notes = []) {
    const itemKey = String(vars.itemKey || vars.attachmentKey || "");
    const sections = [];
    const info = itemInfoMarkdown(vars);
    if (info) {
      sections.push(withSection(info, "info", itemKey));
    }
    const abstract = abstractMarkdown(vars);
    if (abstract) {
      sections.push(withSection(abstract, "abstract", itemKey));
    }
    for (const note of Array.isArray(notes) ? notes : []) {
      const text = notesMarkdown(vars, [note]);
      if (text) {
        sections.push(withSection(text, "notes", itemKey));
      }
    }
    return sections.join("\n\n");
  },

  /**
   * The blocks a previous sync left in the item's document.
   *
   * The section attributes are the whole record: nothing is kept in Zotero,
   * so a sync after a restart — or on another machine — finds the same
   * blocks. The item key scopes the query: a document that accidentally
   * holds two papers' sections does not lose the other one's.
   *
   * @param {String} documentID
   * @param {Object} vars
   * @returns {Promise<String[]>}
   */
  async _sectionBlockIDs(documentID, vars) {
    if (!isBlockID(documentID)) {
      return [];
    }
    const itemKey = String(vars.itemKey || vars.attachmentKey || "")
      .replace(/[^A-Za-z0-9]/g, "");
    if (!itemKey) {
      return [];
    }
    const statement =
      "SELECT id FROM blocks " +
      `WHERE root_id = '${documentID}' AND type != 'd' ` +
      "AND ial LIKE '%custom-zsi-section=%' " +
      `AND ial LIKE '%custom-zsi-item-key="${itemKey}"%' ` +
      "ORDER BY sort ASC";
    try {
      const http = await this._httpClient();
      const rows = await http.sql(statement);
      return (rows || []).map((row) => row && row.id).filter(Boolean);
    }
    catch (e) {
      Zotero.debug(
        `ZoteroSiYuan: could not list the item document's sections over HTTP (${e.message}); trying the CLI`,
      );
    }
    try {
      const rows = await this.getCLI().runJSON(["sql", statement]);
      return (rows || []).map((row) => row && row.id).filter(Boolean);
    }
    catch (e) {
      Zotero.debug(
        `ZoteroSiYuan: could not list the item document's sections: ${e.message}`,
      );
      return [];
    }
  },

  /**
   * Write the item's literature-note document, replacing a previous sync.
   *
   * The document is reused, and the information / abstract / notes blocks
   * are replaced instead of appended. The new sections go in **first**: a
   * failed write must not leave the document with no details at all. Only
   * blocks carrying both section markers are deleted, so the user's own
   * text and the annotation notes stay where they are.
   *
   * @param {Object} item
   * @returns {Promise<Object|null>}
   */
  async _createItemNoteDocument(item) {
    const pdfs = await this._pdfAttachments(item);
    const vars = await this._itemVars(item, pdfs[0] || null);
    const notes = await this._itemNotes(item);
    const text = this._itemSectionMarkdown(vars, notes);
    if (!text) {
      this._notifyItemError(
        new Error(
          getString(
            "zoteroSiYuan-item-no-content",
            "This item has nothing to put in its document.",
          ),
        ),
      );
      return null;
    }
    // The document has to be known before the write: its old sections are
    // read first, and they are only removed once the new ones are in.
    const notebook = await this._resolveNotebook();
    const destination = await this._resolveItemDocument(notebook, vars);
    const previous = await this._sectionBlockIDs(destination.documentID, vars);
    const written = await this._sendItemMarkdown(item, text, {
      itemDocument: true,
      vars,
    });
    if (written && previous.length) {
      const deleted = await this._deleteBlocks(previous);
      if (!deleted) {
        Zotero.logError(
          "ZoteroSiYuan: the old sections of the item document could not be " +
            "deleted — the next sync will still find them by their attributes.",
        );
      }
    }
    return written;
  },

  /**
   * The item menu's "sync this item": information, abstract and notes, in
   * the item's own document, replacing the sections the last sync wrote.
   *
   * @param {Object} item
   * @returns {Promise<Object|null>}
   */
  async _syncItemDocument(item) {
    return await this._createItemNoteDocument(item);
  },
};
