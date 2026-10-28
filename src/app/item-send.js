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
import { prefFlag } from "../utils/prefs.js";
import {
  ITEM_SECTION_DOCUMENT,
  SECTION_ATTR,
  itemDocumentAttributes,
  itemSectionAttributes,
  markBlock,
} from "../modules/block-attrs.js";
import {
  collectMetadata,
} from "../modules/metadata.js";
import { noteHtmlToMarkdown } from "../modules/item-note.js";
import { rewriteNoteImages } from "../modules/note-images.js";
import { showToast } from "../modules/toast.js";

export default {
  /** Is this item a PDF attachment? */
  _isPDFAttachment(attachment) {
    if (!attachment) {
      return false;
    }
    try {
      return attachment.isPDFAttachment
        ? attachment.isPDFAttachment()
        : attachment.attachmentContentType === "application/pdf";
    }
    catch (e) {
      return false;
    }
  },

  /**
   * The PDF attachments of an item, in library order.
   *
   * A standalone PDF — one that was dropped into the library without a
   * parent item — is its own target, so it answers with itself instead of
   * an empty list.
   */
  async _pdfAttachments(item) {
    if (!item) {
      return [];
    }
    if (this._isPDFAttachment(item)) {
      return [item];
    }
    if (!item.isRegularItem || !item.isRegularItem()) {
      return [];
    }
    const ids = item.getAttachments() || [];
    if (!ids.length) {
      return [];
    }
    // One read for the whole list; `_loadItems` keeps the library order.
    const attachments = await this._loadItems(ids);
    return attachments.filter((attachment) =>
      this._isPDFAttachment(attachment)
    );
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

  /**
   * The child notes of an item as Markdown.
   *
   * `getNotes` throws on a note item — a note cannot have child notes — so
   * it is only asked of the item the user selected.
   *
   * The pictures of a note are attachments of their own, which a Markdown
   * reader cannot open. They go into the workspace first, and the note is
   * converted with their new addresses in place — see `item-pictures.js`.
   *
   * @param {Object} item - a regular item
   * @returns {Promise<String[]>}
   */
  async _itemNotes(item) {
    let ids = [];
    try {
      ids = (item && item.getNotes && item.getNotes()) || [];
    }
    catch (e) {
      // A note or attachment was handed in: it has no child notes.
      ids = [];
    }
    if (!ids.length) {
      return [];
    }
    const notes = await this._loadItems(ids);
    const collected = [];
    for (const note of notes) {
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
      const assets = await this._noteImageAssets(
        html,
        Number(note.libraryID) || 0,
      );
      const markdown = noteHtmlToMarkdown(rewriteNoteImages(html, assets));
      if (markdown) {
        collected.push(markdown);
      }
    }
    return collected;
  },

  /**
   * Put item-level Markdown where the settings say notes go.
   *
   * The whole write — resolving the destination, reading the block it
   * replaces, writing, and removing that block — happens under the same
   * lock. Reading the old block outside the lock was how two syncs could
   * both keep a copy.
   *
   * @param {Object} item - the regular item
   * @param {String} markdown
   * @param {Object} [options]
   * @param {Boolean} [options.itemDocument] - always use the item's own
   *   document, whatever the destination preference says
   * @param {Object} [options.vars] - the template variables the caller
   *   already collected; looking them up again would repeat the library reads
   * @param {String} [options.section] - which item-level section this is
   *   (`info`, `abstract`, `notes`); the old block of the same section in
   *   the target document is replaced, so sending twice does not duplicate
   * @param {Object} [options.attrs] - block attributes for the super block
   *   this write becomes; the item sync uses them to find itself again
   * @returns {Promise<Object|null>} what the write answered
   */
  async _sendItemMarkdown(
    item,
    markdown,
    {
      itemDocument = false,
      vars = null,
      section = "",
      attrs = null,
      quiet = false,
      followUp = null,
    } = {},
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
      // The follow-up — a literature note's annotations — is part of the
      // same job: another send must not slip in between the two halves, or
      // two writers would build pictures and blocks in the same workspace
      // at once. Folding it into one promise also means a shutdown waits
      // for both halves.
      const job = (async () => {
        const written = await this._writeItemMarkdown(
          item,
          text,
          itemDocument,
          vars,
          { section, attrs, quiet },
        );
        if (written && typeof followUp === "function") {
          await followUp(written);
        }
        return written;
      })();
      // A shutdown waits for the writes it can see. An item send used to
      // be invisible to it.
      return await (
        typeof this._trackInflight === "function"
          ? this._trackInflight(job)
          : job
      );
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
   * @param {Object} [options]
   * @param {String} [options.section]
   * @param {Object|null} [options.attrs]
   * @returns {Promise<Object|null>}
   */
  async _writeItemMarkdown(
    item,
    text,
    itemDocument,
    vars,
    { section = "", attrs: providedAttrs = null, quiet = false } = {},
  ) {
    let destination = null;
    let resolved = vars;
    let previous = [];
    try {
      if (!resolved) {
        const pdfs = await this._pdfAttachments(item);
        resolved = await this._itemVars(item, pdfs[0] || null);
      }
      const itemKey = String(resolved.itemKey || resolved.attachmentKey || "");
      const libraryID = Number(resolved.libraryID) || 0;
      // Every item-level write is one super block. The section attributes
      // are what makes a second send replace the first one instead of
      // appending another copy.
      const attrs = providedAttrs ||
        (section && itemKey
          ? itemSectionAttributes(section, itemKey, libraryID)
          : {});
      const content = markBlock(text, attrs);
      // A fixed document is addressed by its own id; everything else needs
      // the notebook (the daily note, or the document created for the item).
      const kind = this._destinationKind();
      const notebook = itemDocument || kind !== "document"
        ? await this._resolveNotebook()
        : null;
      destination = itemDocument
        ? await this._resolveItemDocument(notebook, resolved)
        : await this._resolveDestination({ notebook, vars: resolved });
      // The old block can only be read when the document is known. For a
      // daily note the CLI resolves (and, if needed, creates) today's note;
      // without the CLI there is nothing to scope the search to, and the
      // write is simply appended once.
      const documentID = destination.documentID ||
        (attrs[SECTION_ATTR] && destination.kind === "daily"
          ? await this._dailyDocumentID(notebook)
          : "");
      previous = attrs[SECTION_ATTR] && documentID
        ? await this._sectionBlockIDs(documentID, attrs)
        : [];
      // The sync owns the whole literature note: blocks the user sent
      // section by section (details, abstract, notes) describe the same
      // item and would sit beside the sync's copy as duplicates. They are
      // replaced too — the annotations are not, and neither is the user's
      // own text without a section attribute.
      if (
        attrs[SECTION_ATTR] === ITEM_SECTION_DOCUMENT && documentID &&
        typeof this._soloItemSectionBlocks === "function"
      ) {
        previous.push(
          ...(await this._soloItemSectionBlocks(documentID, attrs)),
        );
      }

      // One block is exactly what a section is, so it can be rewritten in
      // place — the block id survives, and with it every link to the note
      // and the plugin's own record of where it is. More than one block
      // means a document written by an older version: there is no single
      // block to update, so the append-and-delete path below is used.
      if (previous.length === 1) {
        const attempt = await this._replaceItemSection(
          previous[0],
          content,
          attrs,
        );
        if (attempt.updated) {
          const kept = {
            transport: "the block was updated in place",
            blockID: previous[0],
            documentID: documentID || destination.documentID || "",
            blocks: [previous[0]],
            destination,
            updated: true,
          };
          if (!quiet) {
            this._notifyItem(kept, destination);
          }
          return kept;
        }
        if (attempt.gone) {
          // The update consumed the block. There is nothing left to delete,
          // and the content still has to be written.
          previous = [];
        }
      }

      const written = await this._append(
        notebook ? notebook.id : "",
        content,
        null,
        { target: destination },
      );

      // Only after the new block is safely in SiYuan is the old one taken
      // back. Without a block id there is no proof that the write landed,
      // so the old block stays and the user is told.
      if (previous.length) {
        if (!written || !written.blockID) {
          this._notifyItemWarning(
            getString(
              "zoteroSiYuan-item-old-kept",
              "The new note was written, but SiYuan did not confirm which " +
                "block, so the old one was kept.",
            ),
            written,
          );
          return written;
        }
        const deleted = await this._deleteBlocks(previous);
        if (!deleted) {
          Zotero.logError(
            "ZoteroSiYuan: the old item block could not be deleted — both " +
              "versions are in SiYuan now.",
          );
          this._notifyItemWarning(
            getString(
              "zoteroSiYuan-item-delete-failed",
              "The new note was written, but the old one could not be " +
                "removed. Both are in SiYuan now.",
            ),
            written,
          );
          return written;
        }
      }
      if (written) {
        // The caller may have more to say about this write — the literature
        // note adds the annotations after this block is in — so the
        // destination travels with the answer instead of being re-resolved.
        written.destination = destination;
      }
      if (!quiet) {
        this._notifyItem(written || {}, destination);
      }
      return written;
    }
    catch (e) {
      Zotero.logError(`ZoteroSiYuan: could not send the item: ${e}`);
      // A cached document id that no longer exists must not be reused for
      // the rest of the session.
      if (
        destination && destination.kind === "item" &&
        typeof this._forgetItemDocument === "function"
      ) {
        this._forgetItemDocument(destination.documentID);
      }
      this._notifyItemError(e, item);
      return null;
    }
  },

  /**
   * The document of today's daily note, when the CLI can name it.
   *
   * `dailyNoteDocument` is idempotent — it creates the note when it does
   * not exist, exactly as the append would. Without the CLI there is no
   * document id to scope a replacement to, so the caller appends once.
   *
   * @param {Object|null} notebook
   * @returns {Promise<String>}
   */
  async _dailyDocumentID(notebook) {
    if (!notebook || !notebook.id) {
      return "";
    }
    try {
      const cli = this.getCLI();
      if (typeof cli.dailyNoteDocument !== "function") {
        return "";
      }
      return await cli.dailyNoteDocument(notebook.id);
    }
    catch (e) {
      Zotero.debug(
        `ZoteroSiYuan: could not resolve today's daily note (${e.message})`,
      );
      return "";
    }
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
      // A PDF's annotations are normally in page order already; sorting
      // keeps that true for the ones that are not.
      annotations = annotations.slice().sort(
        (a, b) => this._annotationPage(a) - this._annotationPage(b),
      );
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
      this._notifyItemInfo(
        getString(
          "zoteroSiYuan-item-no-annotations",
          "This item has no annotations.",
        ),
      );
      return null;
    }
    const result = await this._sendMany(ids, null, this._mainDoc());
    // The batch was started from the item list, not from a reader. Any
    // reader showing one of these PDFs still has to draw the new markers
    // now, not at its next redraw.
    for (const pdf of pdfs) {
      this._refreshMarkerOf(pdf.id);
    }
    return result;
  },

  /** The page of an annotation item, for ordering a batch. */
  _annotationPage(annotation) {
    try {
      const position = annotation && annotation.annotationPosition
        ? JSON.parse(annotation.annotationPosition)
        : null;
      return position && typeof position.pageIndex === "number"
        ? position.pageIndex
        : 0;
    }
    catch (e) {
      return 0;
    }
  },

  /**
   * Write the item's literature-note document, replacing a previous sync.
   *
   * The details — information, abstract, notes — are one super block
   * carrying the item key, so a later sync finds and rewrites exactly that
   * block and the user's own text is never part of it.
   *
   * The annotations then follow, incrementally: only the ones that are new,
   * edited or rendered with a changed template are written. They are
   * ordinary annotation blocks, so the reader's markers and the index keep
   * working; they are marked with the sync's section so a later sync only
   * touches what it wrote itself.
   *
   * `_sendItemMarkdown` holds the lock for the whole read/write/delete
   * sequence, so two syncs cannot both keep a copy.
   *
   * @param {Object} item
   * @returns {Promise<Object|null>}
   */
  async _createItemNoteDocument(item) {
    const pdfs = await this._pdfAttachments(item);
    const vars = await this._itemVars(item, pdfs[0] || null);
    const itemKey = String(vars.itemKey || vars.attachmentKey || "");
    const libraryID = Number(vars.libraryID) || 0;
    // The notes may bring pictures with them; the whole sync is one unit,
    // so the pictures are held until both halves have written.
    const written = await this._withItemPictures(async () => {
      const notes = await this._itemNotes(item);
      const text = this._itemSectionMarkdown(vars, notes);
      if (!text) {
        this._notifyItemInfo(
          getString(
            "zoteroSiYuan-item-no-content",
            "This item has nothing to put in its document.",
          ),
        );
        return null;
      }
      // The bubble is shown once, at the end: the annotations belong to the
      // same answer, and two bubbles for one command read as two commands.
      // The annotations are written by the follow-up, while the send lock is
      // still held — the two halves of the sync are one unit.
      return await this._sendItemMarkdown(item, text, {
        itemDocument: true,
        vars,
        attrs: itemDocumentAttributes(itemKey, libraryID),
        quiet: true,
        followUp: async (result) => {
          const destination = result.destination || {
            kind: "item",
            documentID: result.documentID || "",
            title: String(vars.title || ""),
          };
          const documentID = destination.documentID || result.documentID || "";
          if (!documentID || !prefFlag("itemSyncAnnotations", true)) {
            return;
          }
          try {
            const notebook = await this._resolveNotebook();
            const synced = await this._syncItemAnnotations({
              documentID,
              notebook,
              pdfs,
            });
            if (synced && synced.summary) {
              result.annotationSummary = synced.summary;
            }
          }
          catch (e) {
            Zotero.logError(
              `ZoteroSiYuan: the annotations could not be synced: ${e}`,
            );
            result.annotationWarning = getString(
              "zoteroSiYuan-item-annotations-sync-failed",
              "The annotations could not be synced; the details are in SiYuan.",
            );
          }
        },
      });
    });
    if (!written) {
      return null;
    }
    this._notifyItem(
      written,
      written.destination || {
        kind: "item",
        documentID: written.documentID || "",
        title: String(vars.title || ""),
      },
    );
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
