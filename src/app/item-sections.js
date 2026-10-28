/**
 * Zotero → SiYuan — the sections of a literature note.
 *
 * The document an item owns holds three sections written from the item:
 * its information, its abstract and its child notes. They are written as
 * one super block carrying the item key, so a second sync finds and
 * replaces exactly that block.
 *
 * Two attribute families meet here, and they must not be confused:
 *
 * - the sync container (`custom-zsi-item-key`) — the one block a sync owns;
 * - an item-level section sent on its own (`custom-zotero-item-key` plus
 *   `custom-zsi-section`) — written by "send the details/abstract/notes".
 *
 * A sync takes the solo sections over: they describe the same item and
 * would sit beside the sync's copy as duplicates. A block without either
 * family is the user's own text and is never touched.
 */

import { getPref } from "../utils/prefs.js";
import {
  ITEM_KEY_ATTR,
  ITEM_SECTION_ABSTRACT,
  ITEM_SECTION_DOCUMENT,
  ITEM_SECTION_INFO,
  ITEM_SECTION_NOTES,
  LIBRARY_ID_ATTR,
  SECTION_ATTR,
  SECTION_ITEM_ATTR,
} from "../modules/block-attrs.js";
import {
  abstractMarkdown,
  itemInfoMarkdown,
  notesMarkdown,
} from "../modules/item-note.js";
import { isBlockID } from "../modules/siyuan.js";

export default {
  /** One of the three section templates; "" means the built-in shape. */
  _itemSectionTemplate(key) {
    return String(getPref(key, "") || "");
  },

  /**
   * The three sections of a literature-note document.
   *
   * Each child note is its own callout, so the sync writes the same shapes
   * a hand-made literature note uses. The whole result is wrapped in one
   * super block by `_sendItemMarkdown`, and the item key is attached to
   * that container — a later sync finds and replaces the unit without
   * touching the user's own text or the annotation notes.
   *
   * @param {Object} vars
   * @param {String[]} notes - Markdown of each child note
   * @returns {String}
   */
  _itemSectionMarkdown(vars, notes = []) {
    const sections = [];
    const info = itemInfoMarkdown(
      vars,
      this._itemSectionTemplate("itemInfoTemplate"),
    );
    if (info) {
      sections.push(info);
    }
    const abstract = abstractMarkdown(
      vars,
      "",
      this._itemSectionTemplate("itemAbstractTemplate"),
    );
    if (abstract) {
      sections.push(abstract);
    }
    const noteTemplate = this._itemSectionTemplate("itemNotesTemplate");
    for (const note of Array.isArray(notes) ? notes : []) {
      const text = notesMarkdown(vars, [note], noteTemplate);
      if (text) {
        sections.push(text);
      }
    }
    return sections.join("\n\n");
  },

  /**
   * The blocks a previous send of one item section left in a document.
   *
   * The attributes are the whole record: nothing is kept in Zotero, so a
   * sync after a restart — or on another machine — finds the same block.
   *
   * The container query deliberately does not filter by section: every
   * older version wrote its sections separately, and the first sync after
   * an upgrade still has to replace them all.
   *
   * @param {String} documentID
   * @param {Object} vars - attributes, or a legacy `{ itemKey }`
   * @returns {Promise<String[]>}
   */
  async _sectionBlockIDs(documentID, vars = {}) {
    if (!isBlockID(documentID)) {
      return [];
    }
    const hasSectionItem = vars[SECTION_ITEM_ATTR] !== undefined;
    const hasItem = vars[ITEM_KEY_ATTR] !== undefined;
    const itemKeyAttr = hasSectionItem
      ? SECTION_ITEM_ATTR
      : hasItem
        ? ITEM_KEY_ATTR
        : SECTION_ITEM_ATTR;
    const itemKey = String(
      hasSectionItem
        ? vars[SECTION_ITEM_ATTR]
        : hasItem
          ? vars[ITEM_KEY_ATTR]
          : (vars.itemKey || vars.attachmentKey || ""),
    ).replace(/[^A-Za-z0-9]/g, "");
    if (!itemKey) {
      return [];
    }
    const section = String(vars[SECTION_ATTR] || "")
      .replace(/[^A-Za-z0-9_-]/g, "");
    const clauses = [`ial LIKE '%${itemKeyAttr}="${itemKey}"%'`];
    // The container is the one family that keeps compatibility with the
    // per-section blocks older versions wrote; a named section is exact.
    if (section && section !== ITEM_SECTION_DOCUMENT) {
      clauses.push(`ial LIKE '%${SECTION_ATTR}="${section}"%'`);
    }
    const libraryID = String(vars[LIBRARY_ID_ATTR] || "")
      .replace(/[^0-9]/g, "");
    if (libraryID) {
      // Documents written before the library id existed have no such
      // attribute; they still belong to this item.
      clauses.push(
        `(ial LIKE '%${LIBRARY_ID_ATTR}="${libraryID}"%' ` +
          `OR ial NOT LIKE '%${LIBRARY_ID_ATTR}=%')`,
      );
    }
    const statement =
      "SELECT id FROM blocks " +
      `WHERE root_id = '${documentID}' AND type != 'd' ` +
      `AND ${clauses.join(" AND ")} ` +
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
   * The blocks the user sent to one section on its own.
   *
   * "Send the details", "Send the abstract" and "Send the notes" each write
   * a block marked with its section (`info`, `abstract`, `notes`). A sync
   * writes the same three as one document of its own — the solo blocks
   * would sit beside that copy as duplicates, so the sync takes them over.
   * A block without a section attribute is the user's own text and is
   * never touched here.
   *
   * @param {String} documentID
   * @param {Object} containerAttrs - the sync's attributes (item key, library)
   * @returns {Promise<String[]>}
   */
  async _soloItemSectionBlocks(documentID, containerAttrs = {}) {
    if (!isBlockID(documentID)) {
      return [];
    }
    const itemKey = String(
      containerAttrs[SECTION_ITEM_ATTR] || "",
    ).replace(/[^A-Za-z0-9]/g, "");
    if (!itemKey) {
      return [];
    }
    const sections = [
      ITEM_SECTION_INFO,
      ITEM_SECTION_ABSTRACT,
      ITEM_SECTION_NOTES,
    ].map((name) => `${SECTION_ATTR}="${name}"`);
    // The solo sections are stamped with the ordinary item key — the
    // container key is the sync's own mark, and a solo block never has it.
    const statement =
      "SELECT id FROM blocks " +
      `WHERE root_id = '${documentID}' AND type != 'd' ` +
      `AND ial LIKE '%${ITEM_KEY_ATTR}="${itemKey}"%' ` +
      `AND (${sections.map((s) => `ial LIKE '%${s}%'`).join(" OR ")}) ` +
      "ORDER BY sort ASC";
    try {
      const http = await this._httpClient();
      const rows = await http.sql(statement);
      return (rows || []).map((row) => row && row.id).filter(Boolean);
    }
    catch (e) {
      Zotero.debug(
        `ZoteroSiYuan: could not list the solo sections over HTTP (${e.message}); trying the CLI`,
      );
    }
    try {
      const rows = await this.getCLI().runJSON(["sql", statement]);
      return (rows || []).map((row) => row && row.id).filter(Boolean);
    }
    catch (e) {
      Zotero.debug(
        `ZoteroSiYuan: could not list the solo sections: ${e.message}`,
      );
      return [];
    }
  },

  /**
   * Replace the content of one section in place.
   *
   * The block id survives, so a link to the note still leads to it and the
   * index does not have to be rewritten. The result says what happened,
   * because the caller has to choose between "done" and the append-and-
   * delete path:
   *
   * - `updated`: the block is the new content;
   * - `gone`: the update consumed the block, so there is nothing left to
   *   delete and the content still has to be written;
   * - neither: the update was refused, and the old path is used.
   *
   * An update whose answer never arrived is thrown, not reported as
   * refused: it may have landed, and appending would duplicate the note.
   *
   * @param {String} blockID
   * @param {String} content - the wrapped Markdown, attributes included
   * @param {Object} attrs
   * @returns {Promise<{updated: Boolean, gone: Boolean}>}
   */
  async _replaceItemSection(blockID, content, attrs) {
    const updated = await this._updateBlock(blockID, content);
    if (!updated) {
      return { updated: false, gone: false };
    }
    const row = await this._blockRow(blockID);
    if (row === null) {
      // The update replaced the block instead of rewriting it. Its content
      // is gone, so nothing has to be deleted either — but the caller has
      // to write it again.
      return { updated: false, gone: true };
    }
    if (row) {
      // A parser that re-created the block may not have kept the IAL. The
      // attributes are how the next sync finds it, so they are put back.
      const ial = String(row.ial || "");
      const missing = Object.entries(attrs || {}).some(
        ([name, value]) => value && !ial.includes(`${name}="${value}"`),
      );
      if (missing) {
        await this._setBlockAttrs(blockID, attrs);
      }
    }
    return { updated: true, gone: false };
  },
};
