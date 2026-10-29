/**
 * Zotero → SiYuan — the SiYuan documents a child note becomes.
 *
 * The sync (`item-note-docs.js`) decides *which* note needs which document.
 * This file is the other half: finding the documents a previous sync made,
 * reading and rewriting the block inside one, creating a document under the
 * literature note, renaming it, and removing it again.
 *
 * Every operation is written for both transports — the CLI is preferred,
 * the HTTP API is the fallback — because a note sync should not depend on
 * being able to spawn a process.
 */

import { getString } from "../utils/locale.js";
import {
  ITEM_SECTION_NOTE_DOCUMENT,
  LIBRARY_ID_ATTR,
  MODIFIED_ATTR,
  NOTE_KEY_ATTR,
  SECTION_ATTR,
  SECTION_ITEM_ATTR,
  TEMPLATE_ATTR,
  parseAttributes,
} from "../modules/block-attrs.js";
import { isBlockID } from "../modules/siyuan.js";

export default {
  /**
   * The sub-documents a previous sync wrote for one item.
   *
   * @param {String} itemKey
   * @param {Number} libraryID
   * @returns {Promise<Map<String, Object>>} note key → `{ id, title,
   *   modified, template }`
   */
  async _noteDocuments(itemKey, libraryID) {
    const found = new Map();
    const key = String(itemKey || "").replace(/[^A-Za-z0-9]/g, "");
    if (!key) {
      return found;
    }
    const clauses = [
      "type = 'd'",
      `ial LIKE '%${SECTION_ATTR}="${ITEM_SECTION_NOTE_DOCUMENT}"%'`,
      `ial LIKE '%${SECTION_ITEM_ATTR}="${key}"%'`,
    ];
    if (libraryID) {
      // A document written before the library id existed has no such
      // attribute; it still belongs to this item.
      clauses.push(
        `(ial LIKE '%${LIBRARY_ID_ATTR}="${libraryID}"%' ` +
          `OR ial NOT LIKE '%${LIBRARY_ID_ATTR}=%')`,
      );
    }
    const statement =
      "SELECT id, content, ial FROM blocks " +
      `WHERE ${clauses.join(" AND ")} ORDER BY created ASC`;
    const rows = await this._queryNoteRows(statement, "note documents");
    for (const row of rows) {
      if (!row || !row.id) {
        continue;
      }
      const attrs = parseAttributes(row.ial);
      const noteKey = attrs[NOTE_KEY_ATTR] || "";
      if (!noteKey) {
        continue;
      }
      found.set(noteKey, {
        id: row.id,
        title: String(row.content || ""),
        modified: attrs[MODIFIED_ATTR] || "",
        template: attrs[TEMPLATE_ATTR] || "",
      });
    }
    return found;
  },

  /**
   * The blocks one sub-document holds for a note.
   *
   * One block is what the sync writes, so it can be rewritten in place. More
   * than one means the note was appended twice — for instance by an older
   * version — and the append-and-delete path is used.
   *
   * @param {String} documentID
   * @param {String} noteKey
   * @returns {Promise<String[]>}
   */
  async _noteDocumentBlocks(documentID, noteKey) {
    const key = String(noteKey || "").replace(/[^A-Za-z0-9]/g, "");
    if (!isBlockID(documentID) || !key) {
      return [];
    }
    const statement =
      "SELECT id FROM blocks " +
      `WHERE root_id = '${documentID}' AND type != 'd' ` +
      `AND ial LIKE '%${NOTE_KEY_ATTR}="${key}"%' ` +
      "ORDER BY sort ASC";
    const rows = await this._queryNoteRows(statement, "a note document's blocks");
    return (rows || []).map((row) => row && row.id).filter(Boolean);
  },

  /**
   * Run a small query, HTTP first and the CLI second.
   *
   * A sync already talks to both transports; a read should not be the reason
   * a machine without one of them cannot sync.
   *
   * @param {String} statement
   * @param {String} what - for the debug log
   * @returns {Promise<Object[]>}
   */
  async _queryNoteRows(statement, what) {
    try {
      const http = await this._httpClient();
      return (await http.sql(statement)) || [];
    }
    catch (e) {
      Zotero.debug(
        `ZoteroSiYuan: could not list ${what} over HTTP (${e.message}); ` +
          "trying the CLI",
      );
    }
    try {
      return (await this.getCLI().runJSON(["sql", statement])) || [];
    }
    catch (e) {
      Zotero.debug(`ZoteroSiYuan: could not list ${what}: ${e.message}`);
      return [];
    }
  },

  /**
   * Create one note's document under the literature note's document.
   *
   * The CLI takes an internal parent path (`/<document id>`). The HTTP
   * fallback addresses a parent by its human-readable path instead, so that
   * is read first.
   *
   * @param {Object} notebook
   * @param {String} parentID - the literature note's document
   * @param {String} title
   * @param {String} markdown
   * @returns {Promise<String>} the new document id
   */
  async _createNoteDocument(notebook, parentID, title, markdown) {
    if (!notebook || !notebook.id) {
      throw new Error(
        getString(
          "zoteroSiYuan-no-notebook",
          "The SiYuan notebook could not be resolved.",
        ),
      );
    }
    try {
      return await this.getCLI().createDocument(notebook.id, title, {
        // The CLI wants the parent's internal path without a leading
        // slash — `/202601…` is rejected as "block not found".
        path: String(parentID),
        markdown,
      });
    }
    catch (cliError) {
      Zotero.debug(
        `ZoteroSiYuan: the CLI could not create the note document ` +
          `(${cliError.message}); trying the HTTP API`,
      );
      try {
        const http = await this._httpClient();
        const parentPath = await this._noteParentPath(http, parentID);
        return await http.createDocument(
          notebook.id,
          parentPath,
          title,
          markdown,
        );
      }
      catch (httpError) {
        throw new Error(
          getString(
            "zoteroSiYuan-note-document-failed",
            "Could not create the SiYuan document for a note: %s",
          ).replace(
            "%s",
            `the CLI failed: ${cliError.message} — the HTTP API failed too: ` +
              httpError.message,
          ),
        );
      }
    }
  },

  /**
   * The human-readable path of a document, for the HTTP fallback.
   *
   * @param {Object} http - the HTTP client
   * @param {String} documentID
   * @returns {Promise<String>}
   */
  async _noteParentPath(http, documentID) {
    try {
      const rows = await http.sql(
        `SELECT hpath FROM blocks WHERE id = '${documentID}' LIMIT 1`,
      );
      const hpath = rows && rows[0] && rows[0].hpath;
      if (hpath) {
        return String(hpath);
      }
    }
    catch (e) {
      Zotero.debug(
        `ZoteroSiYuan: could not read the parent document's path ` +
          `(${e.message}); creating the note at the notebook root`,
      );
    }
    return "/";
  },

  /**
   * Stamp a note document with the attributes a later sync finds it by.
   *
   * @param {String} documentID
   * @param {Object} attrs
   * @returns {Promise<Boolean>}
   */
  async _stampNoteDocument(documentID, attrs) {
    try {
      await this.getCLI().setBlockAttrs(documentID, attrs);
      return true;
    }
    catch (cliError) {
      Zotero.debug(
        `ZoteroSiYuan: could not stamp the note document with the CLI ` +
          `(${cliError.message}); trying HTTP`,
      );
    }
    try {
      const http = await this._httpClient();
      await http.setBlockAttrs(documentID, attrs);
      return true;
    }
    catch (e) {
      Zotero.debug(
        `ZoteroSiYuan: could not stamp the note document: ${e.message}`,
      );
      return false;
    }
  },

  /**
   * Rename one note document.
   *
   * A failure is not fatal: the id did not change, only the visible name
   * still says what the note used to start with.
   *
   * @param {String} documentID
   * @param {String} title
   * @returns {Promise<Boolean>}
   */
  async _renameNoteDocument(documentID, title) {
    try {
      await this.getCLI().renameDocument(documentID, title);
      return true;
    }
    catch (cliError) {
      Zotero.debug(
        `ZoteroSiYuan: the CLI could not rename the note document ` +
          `(${cliError.message}); trying HTTP`,
      );
    }
    try {
      const http = await this._httpClient();
      await http.renameDocument(documentID, title);
      return true;
    }
    catch (e) {
      Zotero.debug(
        `ZoteroSiYuan: could not rename the note document: ${e.message}`,
      );
      return false;
    }
  },

  /**
   * Remove several documents, one at a time.
   *
   * A document is not a block, so `_deleteBlocks` cannot be used here.
   *
   * @param {String[]} documentIDs
   * @returns {Promise<Number>} how many were removed
   */
  async _deleteDocuments(documentIDs) {
    const ids = [
      ...new Set((documentIDs || []).filter((id) => isBlockID(id))),
    ];
    let removed = 0;
    for (const id of ids) {
      if (await this._deleteDocument(id)) {
        removed++;
      }
    }
    return removed;
  },

  /**
   * Remove one document, whichever transport can.
   *
   * @param {String} documentID
   * @returns {Promise<Boolean>}
   */
  async _deleteDocument(documentID) {
    try {
      await this.getCLI().deleteDocument(documentID);
      return true;
    }
    catch (cliError) {
      Zotero.debug(
        `ZoteroSiYuan: the CLI could not remove the note document ` +
          `(${cliError.message}); trying the HTTP API`,
      );
    }
    try {
      const http = await this._httpClient();
      await http.deleteDocument(documentID);
      return true;
    }
    catch (e) {
      Zotero.logError(
        `ZoteroSiYuan: the note document could not be removed: ${e.message}`,
      );
      return false;
    }
  },
};
