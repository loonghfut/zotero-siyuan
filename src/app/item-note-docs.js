/**
 * Zotero → SiYuan — a child note as a document of its own.
 *
 * A literature note normally holds its child notes in one section. The
 * setting `itemNotesAsSubdocs` asks for the other shape: every Zotero note
 * becomes a SiYuan **document** under the literature note's document, so it
 * has a place of its own in the document tree.
 *
 * The sync is incremental and attribute-driven, like the annotations: each
 * sub-document carries the note's key and the item's key, so a later sync
 * finds the same document instead of creating a second one. A note that
 * changed is rewritten in place (its one super block keeps its id), a note
 * that disappeared takes its document with it, and a note that is new gets a
 * document.
 *
 * The notes are rendered with the same `itemNotesTemplate` the inline
 * section uses, so a template the user tuned remains in charge of what a
 * note looks like.
 *
 * The document operations themselves — finding, creating, renaming and
 * removing — live in `note-documents.js`.
 */

import { getString } from "../utils/locale.js";
import {
  markBlock,
  noteDocumentAttributes,
} from "../modules/block-attrs.js";
import {
  DEFAULT_NOTES_TEMPLATE,
  noteHtmlToMarkdown,
  notesMarkdown,
} from "../modules/item-note.js";
import { rewriteNoteImages } from "../modules/note-images.js";
import { isBlockID } from "../modules/siyuan.js";
import { templateFingerprint } from "../modules/template.js";

export default {
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
    const entries = await this._itemNoteEntries(item);
    return entries
      .map((entry) => entry.markdown)
      .filter((markdown) => String(markdown || "").trim());
  },

  /**
   * The child notes of an item, with what a sub-document needs.
   *
   * The key is what a note keeps when its title changes; the timestamp says
   * whether it has to be rendered again. The Markdown is the same the
   * inline notes section uses.
   *
   * @param {Object} item - a regular item
   * @returns {Promise<Array<{key: String, modified: String,
   *   markdown: String}>>}
   */
  async _itemNoteEntries(item) {
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
      // A note that could not be read is still listed: its key tells the
      // sub-document sync not to take its document back just because the
      // text is missing this time.
      if (String(note.key || "")) {
        collected.push({
          key: String(note.key || ""),
          modified: String(note.dateModified || ""),
          markdown,
        });
      }
    }
    return collected;
  },

  /**
   * Put every child note into a document under the item's document.
   *
   * An empty `entries` list is not "do nothing": it is what a sync with the
   * setting off passes, and it takes back the sub-documents a previous sync
   * made — the notes are written inline again, so the old copies would sit
   * in the tree as duplicates.
   *
   * Only documents carrying **both** the item key and the section are
   * touched, so a document the user made by hand is never deleted or
   * rewritten.
   *
   * @param {Object} options
   * @param {String} options.itemDocumentID - the literature note's document
   * @param {Object} options.notebook
   * @param {Object[]} options.entries - `{ key, modified, markdown }`
   * @param {Object} options.vars - the template variables of the item
   * @param {String} options.itemKey
   * @param {Number} options.libraryID
   * @returns {Promise<{added: Number, updated: Number, removed: Number,
   *   failed: Number, summary: String}>}
   */
  async _syncItemNoteDocuments({
    itemDocumentID,
    notebook,
    entries = [],
    vars = {},
    itemKey = "",
    libraryID = 0,
  } = {}) {
    const result = { added: 0, updated: 0, removed: 0, failed: 0, summary: "" };
    if (!isBlockID(itemDocumentID)) {
      return result;
    }
    const template =
      this._itemSectionTemplate("itemNotesTemplate") || DEFAULT_NOTES_TEMPLATE;
    const stamp = templateFingerprint(template);
    const existing = await this._noteDocuments(itemKey, libraryID);
    const titles = this._noteDocumentTitles(entries);
    const seen = new Set();

    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index] || {};
      const noteKey = String(entry.key || "");
      // A note without a key could never be found again; writing it would
      // only make a duplicate on the next sync.
      if (!noteKey) {
        continue;
      }
      seen.add(noteKey);
      const title = titles[index];
      const body = notesMarkdown(vars, [entry.markdown], template);
      if (!body) {
        continue;
      }
      const attrs = noteDocumentAttributes(
        itemKey,
        libraryID,
        noteKey,
        entry.modified,
        stamp,
      );
      const content = markBlock(body, attrs);
      const previous = existing.get(noteKey);
      try {
        if (!previous) {
          const documentID = await this._createNoteDocument(
            notebook,
            itemDocumentID,
            title,
            content,
          );
          await this._stampNoteDocument(documentID, attrs);
          result.added++;
          continue;
        }
        // Both the note's own timestamp and the template decide whether the
        // rendered text can have changed.
        if (
          previous.modified &&
          previous.modified === String(entry.modified || "") &&
          previous.template === stamp
        ) {
          continue;
        }
        const blocks = await this._noteDocumentBlocks(previous.id, noteKey);
        let updated = false;
        let gone = false;
        if (blocks.length === 1) {
          const attempt = await this._replaceItemSection(
            blocks[0],
            content,
            attrs,
          );
          updated = attempt.updated;
          gone = attempt.gone;
        }
        if (!updated) {
          const written = await this._append(
            notebook ? notebook.id : "",
            content,
            null,
            { target: { kind: "item", documentID: previous.id } },
          );
          if (!written || !written.blockID) {
            result.failed++;
            continue;
          }
          // An update that consumed the block left nothing to delete.
          if (blocks.length && !gone) {
            await this._deleteBlocks(blocks);
          }
        }
        await this._stampNoteDocument(previous.id, attrs);
        // The first line is the document's name; a note whose first line
        // changed should not keep a name that no longer describes it.
        if (title && previous.title && previous.title !== title) {
          await this._renameNoteDocument(previous.id, title);
        }
        result.updated++;
      }
      catch (e) {
        result.failed++;
        Zotero.logError(
          `ZoteroSiYuan: the note ${noteKey} could not be written as a ` +
            `document: ${e}`,
        );
      }
    }

    // Only after the notes that still exist are safely in SiYuan is anything
    // taken back.
    const stale = [];
    for (const [noteKey, document] of existing) {
      if (!seen.has(noteKey)) {
        stale.push(document.id);
      }
    }
    if (stale.length) {
      const removed = await this._deleteDocuments(stale);
      result.removed += removed;
      result.failed += stale.length - removed;
    }
    if (result.added || result.updated || result.removed || result.failed) {
      result.summary = this._noteDocumentSummary(result);
    }
    return result;
  },

  /**
   * The title each note's document should have.
   *
   * Two notes can start with the same line; a document title that appears
   * twice under one parent is confusing, so the second one gets a counter.
   *
   * @param {Object[]} entries
   * @returns {String[]}
   */
  _noteDocumentTitles(entries = []) {
    const used = new Set();
    return (Array.isArray(entries) ? entries : []).map((entry, index) => {
      const title = this._noteDocumentTitle(entry, index);
      let candidate = title;
      let number = 2;
      while (used.has(candidate.toLowerCase())) {
        candidate = `${title.slice(0, 90)} (${number++})`;
      }
      used.add(candidate.toLowerCase());
      return candidate;
    });
  },

  /**
   * The document title of one note: its first line of text.
   *
   * Zotero shows a note by that same line, so the SiYuan document is named
   * the way the user already knows it. The name is made safe for a file
   * name, and a note with no text at all gets the section's label.
   *
   * @param {Object} entry - `{ markdown }`
   * @param {Number} index
   * @returns {String}
   */
  _noteDocumentTitle(entry, index = 0) {
    const title = this._noteTitle(entry && entry.markdown)
      .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);
    if (title) {
      return title;
    }
    return `${getString("zoteroSiYuan-item-notes", "Notes")} ${index + 1}`;
  },

  /**
   * The first readable line of a note.
   *
   * Markdown markers — a heading's hashes, a quote's `>`, a list's bullet,
   * a link's address — are not part of a name.
   *
   * @param {String} markdown
   * @returns {String}
   */
  _noteTitle(markdown) {
    for (const line of String(markdown || "").split("\n")) {
      let text = line.trim();
      if (!text) {
        continue;
      }
      text = text
        .replace(/^#{1,6}\s+/, "")
        .replace(/^>\s?/, "")
        .replace(/^[-*+]\s+/, "")
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[*_`~]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (text) {
        return text;
      }
    }
    return "";
  },

  /**
   * One line for the bubble: what happened to the note documents.
   *
   * @param {Object} counts
   * @returns {String}
   */
  _noteDocumentSummary({ added, updated, removed, failed }) {
    const parts = [];
    if (added) {
      parts.push(
        getString("zoteroSiYuan-item-note-docs-added", "%d added").replace(
          "%d",
          String(added),
        ),
      );
    }
    if (updated) {
      parts.push(
        getString(
          "zoteroSiYuan-item-note-docs-updated",
          "%d updated",
        ).replace("%d", String(updated)),
      );
    }
    if (removed) {
      parts.push(
        getString(
          "zoteroSiYuan-item-note-docs-removed",
          "%d removed",
        ).replace("%d", String(removed)),
      );
    }
    if (failed) {
      parts.push(
        getString(
          "zoteroSiYuan-item-note-docs-failed",
          "%d failed",
        ).replace("%d", String(failed)),
      );
    }
    return (
      getString("zoteroSiYuan-item-notes", "Notes") + ": " + parts.join(", ")
    );
  },
};
