/**
 * Zotero → SiYuan — talking to SiYuan: the CLI, the HTTP API, the notebook.
 */

import { getPref } from "../utils/prefs.js";
import { NOTEBOOK_CACHE_MS, WORKSPACE_CACHE_MS } from "./constants.js";
import { SiYuanHTTP } from "../modules/siyuan-http.js";
import {
  SiYuanCLI,
  isBlockID,
  siyuanTimestamp,
} from "../modules/siyuan.js";
import { isWriteUnknown } from "../modules/siyuan-process.js";

export default {
  /* -------------------------------------------------------------- helpers */
  getCLI() {
    // The same client is reused, so the executable is resolved once instead
    // of spawning `siyuan --version` for every single command.
    const executable = getPref("cliPath", "");
    const workspace = getPref("workspace", "");
    const key = `${executable}|${workspace}`;
    if (!this._cli || this._cliKey !== key) {
      this._cli = new SiYuanCLI({ executable, workspace });
      this._cliKey = key;
    }
    return this._cli;
  },

  /**
   * Resolve the notebook, preferring the CLI and falling back to the kernel
   * HTTP API. The CLI is the transport we want, but a plugin that only works
   * when it can spawn a process is a plugin that breaks on some machines.
   */
  async _resolveNotebook() {
    const cli = this.getCLI();
    const wanted = getPref("notebook", "");
    // `getCLI()` settles the key the cache belongs to — a changed CLI path
    // or workspace is a different SiYuan, and its notebooks are different.
    const key = `${this._cliKey || ""}|${wanted}`;
    if (
      this._notebookCache &&
      this._notebookCache.key === key &&
      Date.now() - this._notebookCache.at < NOTEBOOK_CACHE_MS
    ) {
      return this._notebookCache.notebook;
    }
    try {
      const notebook = await cli.resolveNotebook(wanted);
      this._notebookCache = { key, at: Date.now(), notebook };
      return notebook;
    }
    catch (cliError) {
      this._notebookCache = null;
      this._lastNotebookError = cliError.message;
      Zotero.debug(
        `ZoteroSiYuan: the CLI could not resolve the notebook (${cliError.message}); trying the HTTP API`,
      );
      try {
        const http = await this._httpClient();
        const notebook = await http.resolveNotebook(wanted);
        this._notebookCache = { key, at: Date.now(), notebook };
        return notebook;
      }
      catch (httpError) {
        throw new Error(
          `the siyuan CLI failed: ${cliError.message} — ` +
            `the SiYuan HTTP API failed too: ${httpError.message}`,
        );
      }
    }
  },

  /* --------------------------------------------------------------- write */

  /**
   * Append to today's daily note, preferring the CLI.
   *
   * @param {String} notebookID
   * @param {String} markdown
   * @param {Object} [hooks] - what the self test watches this write with
   * @param {Object} [options]
   * @param {Object} [options.target] - a destination from `_resolveDestination`
   * @param {Boolean} [options.collectBlocks] - also list the sibling blocks
   *   of the write. Only the self test and a batch send need them.
   * @returns {Promise<{transport: String, documentID: String, blockID: String, blocks: String[], blockRows: Object[], blocksExact: Boolean}>}
   */
  async _append(notebookID, markdown, hooks = null, options = {}) {
    // The self test watches a send of its own, so it decides what the write
    // really does — a dry run, or a write it cleans up itself. A real send
    // carries no hooks and goes straight through.
    if (hooks && hooks.append) {
      return await hooks.append(notebookID, markdown);
    }
    const target = options.target || null;
    if (target && target.kind !== "daily" && target.documentID) {
      return await this._appendToDocument(target, markdown, options);
    }
    const since = siyuanTimestamp();
    try {
      const written = await this.getCLI().appendToDailyNote(
        notebookID,
        markdown,
        { collectBlocks: !!options.collectBlocks },
      );
      this._lastCLIError = "";
      return {
        transport: "the siyuan CLI",
        documentID: written.documentID || "",
        blockID: written.blockID || "",
        blocks: written.blocks || [],
        blockRows: written.blockRows || [],
        blocksExact: !!written.blocksExact,
      };
    }
    catch (cliError) {
      // Keep the reason: if the HTTP fallback fails too, the user needs to
      // see *both* failures, not just the last one.
      this._lastCLIError = cliError.message;
      // The CLI started but its answer never arrived (a timeout, a broken
      // stdout). It may already have written the note — so the HTTP
      // fallback must not run: that would append the same annotation a
      // second time, and the user would only notice later, if at all.
      if (isWriteUnknown(cliError)) {
        const error = new Error(
          `${cliError.message}\n\n` +
            "The note may already have reached SiYuan, so it was not sent " +
            "again. Check today's daily note before trying it a second time.",
        );
        error.writeState = "unknown";
        error.written = true;
        throw error;
      }
      // The CLI could not write — the cached notebook may be the reason.
      this._notebookCache = null;
      Zotero.debug(
        `ZoteroSiYuan: the CLI could not write (${cliError.message}); trying the HTTP API`,
      );
      try {
        const http = await this._httpClient();
        const written = await http.appendDailyNote(notebookID, markdown);
        const documentID = written.documentID || "";
        // The HTTP API names the block it made, but not its siblings. A
        // batch still needs them to tell which block belongs to which
        // annotation, so they are read back when they are asked for.
        const blockRows = options.collectBlocks && documentID
          ? await this._httpBlockRows(http, documentID, since)
          : [];
        return {
          transport: "the SiYuan HTTP API",
          documentID,
          blockID: written.blockID || "",
          blocks: written.blockID ? [written.blockID] : [],
          blockRows,
          // Read back after the write, not before it: a note the user wrote
          // in the same second would be in this list too.
          blocksExact: false,
        };
      }
      catch (httpError) {
        const combined = new Error(
          `the siyuan CLI failed: ${cliError.message} — ` +
            `the SiYuan HTTP API failed too: ${httpError.message}`,
        );
        // The HTTP request may have reached the kernel before its answer
        // was lost — that is not a "nothing was written" either.
        if (isWriteUnknown(httpError)) {
          combined.writeState = "unknown";
          combined.written = true;
        }
        throw combined;
      }
    }
  },

  /**
   * Append to a document that is not the daily note.
   *
   * Same two transports as the daily note, same contract: a write whose
   * answer never arrived is reported as unknown, and is *not* retried over
   * the other transport — that would put the note in twice.
   *
   * @param {Object} target - { documentID }
   * @param {String} markdown
   * @param {Object} options
   * @returns {Promise<Object>}
   */
  async _appendToDocument(target, markdown, options = {}) {
    const documentID = target && target.documentID;
    if (!isBlockID(documentID)) {
      throw new Error(`"${documentID}" is not a SiYuan document id`);
    }
    try {
      const written = await this.getCLI().appendToDocument(
        documentID,
        markdown,
        { collectBlocks: !!options.collectBlocks },
      );
      this._lastCLIError = "";
      return {
        transport: "the siyuan CLI",
        documentID: written.documentID || documentID,
        blockID: written.blockID || "",
        blocks: written.blocks || [],
        blockRows: written.blockRows || [],
        blocksExact: !!written.blocksExact,
      };
    }
    catch (cliError) {
      this._lastCLIError = cliError.message;
      if (isWriteUnknown(cliError)) {
        const error = new Error(
          `${cliError.message}\n\n` +
            "The note may already have reached SiYuan, so it was not sent " +
            "again. Check the target document before trying it a second time.",
        );
        error.writeState = "unknown";
        error.written = true;
        throw error;
      }
      Zotero.debug(
        `ZoteroSiYuan: the CLI could not append to ${documentID} (${cliError.message}); trying the HTTP API`,
      );
      try {
        const http = await this._httpClient();
        const since = siyuanTimestamp();
        const before = options.collectBlocks
          ? await this._httpBlockIDs(http, documentID)
          : null;
        const written = await http.appendBlock(documentID, markdown);
        const blockID = written.blockID || "";
        const blockRows = options.collectBlocks
          ? await this._httpBlockRows(http, documentID, since, before)
          : [];
        return {
          transport: "the SiYuan HTTP API",
          documentID: written.documentID || documentID,
          blockID,
          blocks: blockID ? [blockID] : [],
          blockRows,
          blocksExact: !!before,
        };
      }
      catch (httpError) {
        const combined = new Error(
          `the siyuan CLI failed: ${cliError.message} — ` +
            `the SiYuan HTTP API failed too: ${httpError.message}`,
        );
        if (isWriteUnknown(httpError)) {
          combined.writeState = "unknown";
          combined.written = true;
        }
        throw combined;
      }
    }
  },

  /**
   * The top-level blocks of a document, over HTTP.
   *
   * @param {Object} http - the HTTP client
   * @param {String} documentID
   * @param {String} [since] - a SiYuan timestamp
   * @param {Set<String>|null} [before] - ids that were there before the write
   * @returns {Promise<Object[]>} rows with id, markdown and type
   */
  async _httpBlockRows(http, documentID, since = "", before = null) {
    if (!isBlockID(documentID)) {
      return [];
    }
    try {
      const rows = await http.sql(
        "SELECT id, markdown, type, root_id FROM blocks " +
          `WHERE root_id = '${documentID}' AND parent_id = '${documentID}' ` +
          (since ? `AND created >= '${since}' ` : "") +
          "ORDER BY sort ASC",
      );
      if (!before) {
        return Array.isArray(rows) ? rows : [];
      }
      return (rows || []).filter((row) => row && !before.has(row.id));
    }
    catch (e) {
      Zotero.debug(
        `ZoteroSiYuan: could not list the blocks of ${documentID} over HTTP: ${e.message}`,
      );
      return [];
    }
  },

  /** The ids of a document's top-level blocks, over HTTP. */
  async _httpBlockIDs(http, documentID) {
    try {
      const rows = await http.sql(
        "SELECT id FROM blocks " +
          `WHERE root_id = '${documentID}' AND parent_id = '${documentID}'`,
      );
      return new Set((rows || []).map((row) => row && row.id).filter(Boolean));
    }
    catch (e) {
      return null;
    }
  },

  /**
   * Does a block still exist?
   *
   * A marker that points at a block the user deleted in SiYuan leads
   * nowhere. The answer decides whether the marker is still worth showing —
   * so a check that cannot reach SiYuan says "unknown" instead of "gone".
   *
   * HTTP is tried first: a marker click should not wait for a process to
   * start when the kernel can answer in milliseconds. The CLI is the
   * fallback for a machine without an API token.
   *
   * @param {String} blockID
   * @returns {Promise<Boolean|null>} true, false, or null when unknown
   */
  async _blockExists(blockID) {
    if (!isBlockID(blockID)) {
      return false;
    }
    try {
      const http = await this._httpClient();
      const rows = await http.sql(
        `SELECT id FROM blocks WHERE id = '${blockID}'`,
      );
      return Array.isArray(rows) ? rows.length > 0 : null;
    }
    catch (e) {
      // No HTTP client — try the CLI below.
    }
    try {
      const rows = await this.getCLI().blockRows([blockID]);
      return rows.length > 0;
    }
    catch (e) {
      return null;
    }
  },

  /**
   * Delete blocks, whichever transport can.
   *
   * "Replace" uses this to take the previous note back before writing the
   * new one. A deletion that does not happen is not fatal for the *write*,
   * but it is reported: the user asked for a replacement, and two notes
   * where one was expected is something they have to know about.
   *
   * @param {String[]} blockIDs
   * @returns {Promise<Boolean>} whether every deletion was accepted
   */
  async _deleteBlocks(blockIDs) {
    const ids = [...new Set((blockIDs || []).filter((id) => isBlockID(id)))];
    if (!ids.length) {
      return true;
    }
    try {
      await this.getCLI().deleteBlocks(ids);
      return true;
    }
    catch (cliError) {
      Zotero.debug(
        `ZoteroSiYuan: the CLI could not delete the old blocks (${cliError.message}); trying the HTTP API`,
      );
    }
    try {
      const http = await this._httpClient();
      for (const id of ids) {
        await http.deleteBlock(id);
      }
      return true;
    }
    catch (e) {
      Zotero.logError(
        `ZoteroSiYuan: the old note could not be deleted: ${e.message}`,
      );
      return false;
    }
  },

  /**
   * The blocks a previous send wrote.
   *
   * The index remembers them when the send happened in this session. After
   * a restart only the anchor block is known, so the siblings are looked up
   * by the creation second the way the index scan does it.
   *
   * @param {Object} entry - an entry from `SiYuanIndex.getEntry`
   * @returns {Promise<Object[]>} rows with id, markdown and type
   */
  async _sentBlockRows(entry) {
    if (!entry || !entry.blockID) {
      return [];
    }
    if (entry.blocks && entry.blocks.length) {
      const rows = await this.getCLI()
        .blockRows(entry.blocks)
        .catch(() => []);
      if (rows.length) {
        return rows;
      }
      return entry.blocks.map((id) => ({ id, markdown: "", type: "" }));
    }
    try {
      const rows = await this.getCLI().blocksOfSend(
        entry.blockID,
        entry.documentID,
      );
      if (rows.length) {
        // A batch writes every note in the same second, so "the blocks of
        // this second" is the whole batch. The note's own anchor says where
        // it begins: walk back to the previous anchor.
        if (String(entry.markdown || "").includes("zsi=batch")) {
          return this._rowsOfOneBatchNote(rows, entry.blockID);
        }
        return rows;
      }
    }
    catch (e) {
      Zotero.debug(
        `ZoteroSiYuan: could not list the blocks of the old note: ${e.message}`,
      );
    }
    return [{ id: entry.blockID, markdown: entry.markdown || "", type: "" }];
  },

  /**
   * The blocks of one note in a batch, from all the blocks of that second.
   *
   * A batch writes all of its notes in one append, so they share a creation
   * second. The anchor that closes a note also marks the end of its
   * neighbour: the blocks from after the previous anchor up to this note's
   * anchor are exactly this note.
   *
   * @param {Object[]} rows - the blocks of the write, in `sort` order
   * @param {String} blockID - the anchor block of this note
   * @returns {Object[]}
   */
  _rowsOfOneBatchNote(rows, blockID) {
    const at = (rows || []).findIndex((row) => row && row.id === blockID);
    if (at === -1) {
      return (rows || []).slice();
    }
    let start = 0;
    for (let i = at - 1; i >= 0; i--) {
      if (String((rows[i] && rows[i].markdown) || "").includes("zsi=batch")) {
        start = i + 1;
        break;
      }
    }
    return rows.slice(start, at + 1);
  },

  /**
   * The SiYuan workspace the notes go into.
   *
   * The workspace holds the assets, so the picture has to be put there
   * before the note is written.
   *
   * @returns {Promise<String>} the directory, or "" when it is unknown
   */
  async _resolveWorkspaceDir() {
    const configured = String(getPref("workspace", "") || "").trim();
    // The cache belongs to one answer: an explicit workspace, or the one
    // the CLI reports. Switching the preference has to invalidate it —
    // otherwise the old folder keeps receiving pictures until a restart.
    const key = configured || "<auto>";
    if (this._workspaceKey !== key) {
      this._workspaceKey = key;
      this._workspaceDir = "";
    }
    if (configured) {
      return configured;
    }
    // The detected workspace is not kept forever: SiYuan lets the user
    // switch it while Zotero runs, and a picture written into the old one
    // sits in a workspace the note does not belong to.
    if (
      this._workspaceDir &&
      Date.now() - (this._workspaceAt || 0) < WORKSPACE_CACHE_MS
    ) {
      return this._workspaceDir;
    }
    try {
      this._workspaceDir = await this.getCLI().currentWorkspace();
    }
    catch (e) {
      // The CLI is not reachable — the HTTP API knows the workspace too.
      try {
        const http = await this._httpClient();
        this._workspaceDir = http ? http.workspaceDir : "";
      }
      catch (e2) {
        this._workspaceDir = "";
      }
    }
    this._workspaceAt = Date.now();
    return this._workspaceDir;
  },

  /**
   * The HTTP fallback client — discovered once and kept.
   *
   * Every discovery authenticates against the kernel, and the kernel
   * counts the failed ones, so it is not done twice per send.
   *
   * @returns {Promise<SiYuanHTTP>}
   */
  async _httpClient() {
    const key = getPref("workspace", "");
    if (!this._http || this._httpKey !== key) {
      this._http = await SiYuanHTTP.discover(key);
      this._httpKey = key;
    }
    return this._http;
  },

};
