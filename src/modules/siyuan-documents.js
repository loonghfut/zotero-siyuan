/**
 * Zotero → SiYuan — documents, their attributes, and what a write produced.
 *
 * These are the operations a send needs beyond the daily note: find a
 * document by title or by a custom attribute, create the one an item owns,
 * append to a named document, and read back the blocks a write made. They
 * are mixed into `SiYuanCLI`, so a caller still uses one client.
 */

import { fill, getString } from "../utils/locale.js";
import {
  documentIDOf,
  isBlockID,
  siyuanTimestamp,
  sqlID,
  sqlString,
} from "./siyuan-sql.js";

export default {
  /**
   * A document by its title.
   *
   * The title is what the user can see and type; the id is what the write
   * commands need. The newest match wins when the same title exists twice.
   *
   * @param {String} title
   * @returns {Promise<String>} the document id, or ""
   */
  async findDocumentByTitle(title) {
    const wanted = String(title || "").trim();
    if (!wanted) {
      return "";
    }
    const rows = await this.runJSON([
      "sql",
      "SELECT id FROM blocks " +
        `WHERE type = 'd' AND content = '${sqlString(wanted)}' ` +
        "ORDER BY updated DESC LIMIT 1",
    ]);
    const row = Array.isArray(rows) ? rows[0] : null;
    return row && isBlockID(row.id) ? row.id : "";
  },

  /**
   * The document that carries a custom attribute.
   *
   * This is how a per-item document is found again: the document is
   * created once and stamped with `custom-zotero-item-key`, so a later
   * send finds it without keeping state in the Zotero library.
   *
   * @param {String} name - a custom attribute name
   * @param {String} value
   * @returns {Promise<String>} the document id, or ""
   */
  async findDocumentByAttribute(name, value) {
    const key = String(name || "").trim();
    const wanted = String(value || "").trim();
    if (!/^[A-Za-z0-9_-]+$/.test(key) || !wanted) {
      return "";
    }
    const rows = await this.runJSON([
      "sql",
      "SELECT id FROM blocks " +
        `WHERE type = 'd' AND ial LIKE '%${sqlString(key)}="${sqlString(wanted)}"%' ` +
        "ORDER BY updated DESC LIMIT 1",
    ]);
    const row = Array.isArray(rows) ? rows[0] : null;
    return row && isBlockID(row.id) ? row.id : "";
  },

  /**
   * The document that carries **every** one of the attributes.
   *
   * An item key alone is not enough: Zotero keys are unique inside a
   * library, not across libraries, so the library id has to be part of the
   * question. A document stamped by an older version has no library id —
   * the caller falls back to `findDocumentByAttribute` for those.
   *
   * @param {Object} attrs - name → value
   * @returns {Promise<String>} the document id, or ""
   */
  async findDocumentByAttributes(attrs = {}) {
    const pairs = [];
    for (const [name, value] of Object.entries(attrs || {})) {
      const key = String(name || "").trim();
      const wanted = String(value == null ? "" : value).trim();
      if (!/^[A-Za-z0-9_-]+$/.test(key) || !wanted) {
        continue;
      }
      pairs.push(
        `ial LIKE '%${sqlString(key)}="${sqlString(wanted)}"%'`,
      );
    }
    if (!pairs.length) {
      return "";
    }
    const rows = await this.runJSON([
      "sql",
      "SELECT id FROM blocks " +
        `WHERE type = 'd' AND ${pairs.join(" AND ")} ` +
        "ORDER BY updated DESC LIMIT 1",
    ]);
    const row = Array.isArray(rows) ? rows[0] : null;
    return row && isBlockID(row.id) ? row.id : "";
  },

  /**
   * Create a document.
   *
   * `document create` answers with the new document id (a bare string, not
   * JSON) and creates the document with the given Markdown.
   *
   * @param {String} notebookID
   * @param {String} title
   * @param {Object} [options]
   * @param {String} [options.path] - parent document path, "/" by default
   * @param {String} [options.markdown]
   * @returns {Promise<String>} the document id
   */
  async createDocument(notebookID, title, { path = "/", markdown = "" } = {}) {
    if (!notebookID) {
      throw new Error(
        getString(
          "zoteroSiYuan-error-no-notebook-given",
          "No SiYuan notebook was given.",
        ),
      );
    }
    const name = String(title || "").trim();
    if (!name) {
      throw new Error(
        getString(
          "zoteroSiYuan-error-document-needs-title",
          "A document needs a title.",
        ),
      );
    }
    const args = [
      "document",
      "create",
      "--notebook",
      notebookID,
      "--title",
      name,
    ];
    // Passing "/" explicitly is rejected as "block not found" by the CLI,
    // while leaving the flag out means the same thing: the notebook root.
    const parent = String(path || "/").trim();
    if (parent && parent !== "/") {
      args.push("--path", parent);
    }
    if (String(markdown || "")) {
      args.push("--markdown", String(markdown));
    }
    const output = await this.runRaw(args, { mutating: true });
    const id = documentIDOf(output);
    if (id) {
      return id;
    }
    // The command may have created the document and answered with
    // something we could not read. Looking it up by title is safer than
    // creating a second one.
    const found = await this.findDocumentByTitle(name);
    if (found) {
      return found;
    }
    throw new Error(
      fill(
        getString(
          "zoteroSiYuan-error-cli-no-doc-id",
          "The siyuan CLI did not answer with a document id: %s",
        ),
        String(output).slice(0, 200),
      ),
    );
  },

  /**
   * Set custom attributes on a block or document.
   *
   * @param {String} blockID
   * @param {Object} attrs - name → value
   * @returns {Promise<void>}
   */
  async setBlockAttrs(blockID, attrs) {
    const id = sqlID(blockID);
    const args = ["attr", "set", "--id", id];
    for (const [name, value] of Object.entries(attrs || {})) {
      if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        continue;
      }
      args.push("--attr", `${name}=${value == null ? "" : value}`);
    }
    if (args.length <= 4) {
      return;
    }
    await this.runRaw(args, { mutating: true });
  },

  /** The rows of some blocks, for reading back what a send wrote. */
  async blockRows(blockIDs) {
    const ids = (blockIDs || [])
      .map((id) => String(id || "").trim())
      .filter((id) => isBlockID(id));
    if (!ids.length) {
      return [];
    }
    const list = ids.map((id) => `'${id}'`).join(", ");
    const rows = await this.runJSON([
      "sql",
      `SELECT id, markdown, type, root_id, ial FROM blocks WHERE id IN (${list})`,
    ]);
    return Array.isArray(rows) ? rows : [];
  },

  /**
   * The top-level blocks a send produced.
   *
   * A single append writes several blocks in the same second, so the first
   * block's timestamp identifies all of them. They are ordered by `sort`,
   * which is the order they appear in the document.
   *
   * @param {String} blockID - one block of the send
   * @param {String} [documentID] - the document it belongs to
   * @returns {Promise<Object[]>} rows with id, markdown and type
   */
  async blocksOfSend(blockID, documentID = "") {
    const id = sqlID(blockID);
    const doc = documentID && isBlockID(documentID) ? documentID : "";
    const where = doc
      ? `parent_id = '${sqlID(doc)}' AND created = ` +
        `(SELECT created FROM blocks WHERE id = '${id}')`
      : `parent_id = (SELECT root_id FROM blocks WHERE id = '${id}') AND created = ` +
        `(SELECT created FROM blocks WHERE id = '${id}')`;
    const rows = await this.runJSON([
      "sql",
      "SELECT id, markdown, type, root_id, ial FROM blocks " +
        `WHERE ${where} ORDER BY sort ASC`,
    ]);
    return Array.isArray(rows) ? rows : [];
  },

  /**
   * The top-level blocks of a document created since a moment.
   *
   * Ordered by `sort` (the document order), not by id: a batch writes
   * many blocks in the same second, and their ids do not say which came
   * first.
   *
   * @param {String} documentID
   * @param {String} since - a SiYuan timestamp
   * @returns {Promise<Object[]>} rows with id, markdown, type and created
   */
  async findBlockRowsSince(documentID, since) {
    const root = sqlID(documentID);
    if (!/^[0-9]{14}$/.test(String(since))) {
      throw new Error(
        fill(
          getString(
            "zoteroSiYuan-error-invalid-timestamp",
            "“%s” is not a SiYuan timestamp",
          ),
          since,
        ),
      );
    }
    const rows = await this.runJSON([
      "sql",
      "SELECT id, markdown, type, created, root_id, ial FROM blocks " +
        `WHERE root_id = '${root}' AND parent_id = '${root}' ` +
        `AND created >= '${since}' ORDER BY sort ASC`,
    ]);
    return Array.isArray(rows) ? rows : [];
  },

  /** Rows that appeared while a write ran, not the ones that were there before. */
  async newBlockRowsSince(documentID, since, before) {
    let after = [];
    try {
      after = await this.findBlockRowsSince(documentID, since);
    }
    catch (e) {
      Zotero.debug(
        `ZoteroSiYuan: could not list the blocks of the new note: ${e.message}`,
      );
      return [];
    }
    if (!before) {
      return after;
    }
    const known = new Set(before);
    return after.filter((row) => !known.has(row.id));
  },

  /**
   * Append Markdown to a document (not the daily note).
   *
   * @param {String} documentID
   * @param {String} markdown
   * @param {Object} [options]
   * @param {Boolean} [options.collectBlocks]
   * @returns {Promise<{documentID, blockID, blocks, blockRows, blocksExact}>}
   */
  async appendToDocument(documentID, markdown, { collectBlocks = false } = {}) {
    const root = sqlID(documentID);
    const since = siyuanTimestamp();
    const before = collectBlocks
      ? await this.findBlocksSince(root, since).catch(() => null)
      : null;
    const blockID = await this.appendBlock(root, markdown);
    const rows = collectBlocks
      ? await this.newBlockRowsSince(root, since, before)
      : [];
    return {
      documentID: root,
      blockID,
      blocks: rows.length ? rows.map((row) => row.id) : [blockID],
      blockRows: rows,
      blocksExact: !!before,
    };
  },

  /** Delete several blocks; one process per block, because the CLI does that. */
  async deleteBlocks(blockIDs) {
    for (const id of blockIDs || []) {
      if (isBlockID(id)) {
        await this.deleteBlock(id);
      }
    }
  },

  /**
   * Remove a document.
   *
   * A document is not a block: `block delete` refuses it. The document has a
   * command of its own, and it moves the document to SiYuan's trash — the
   * user can still get it back.
   *
   * @param {String} documentID
   * @returns {Promise<void>}
   */
  async deleteDocument(documentID) {
    const id = sqlID(documentID);
    await this.runRaw(["document", "remove", "--id", id], { mutating: true });
  },

  /**
   * Give a document a new title.
   *
   * Used when a child note's first line changed: the sub-document keeps its
   * id (and everything that links to it), only the name follows the note.
   *
   * @param {String} documentID
   * @param {String} title
   * @returns {Promise<void>}
   */
  async renameDocument(documentID, title) {
    const id = sqlID(documentID);
    const name = String(title || "").trim();
    if (!name) {
      return;
    }
    await this.runRaw(
      ["document", "rename", "--id", id, "--title", name],
      { mutating: true },
    );
  },
};
