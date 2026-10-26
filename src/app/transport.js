/**
 * Zotero → SiYuan — talking to SiYuan: the CLI, the HTTP API, the notebook.
 */

import { getPref } from "../utils/prefs.js";
import { NOTEBOOK_CACHE_MS, WORKSPACE_CACHE_MS } from "./constants.js";
import { SiYuanHTTP } from "../modules/siyuan-http.js";
import { SiYuanCLI } from "../modules/siyuan.js";
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

  /**
   * Append to today's daily note, preferring the CLI.
   *
   * @param {String} notebookID
   * @param {String} markdown
   * @param {Object} [hooks] - what the self test watches this write with
   * @param {Object} [options]
   * @param {Boolean} [options.collectBlocks] - also list the sibling blocks
   *   of the write. Only the self test needs them, and only to delete them
   *   again — for a real send they would cost one process more.
   * @returns {Promise<{transport: String, documentID: String, blockID: String}>}
   */
  async _append(notebookID, markdown, hooks = null, options = {}) {
    // The self test watches a send of its own, so it decides what the write
    // really does — a dry run, or a write it cleans up itself. A real send
    // carries no hooks and goes straight through.
    if (hooks && hooks.append) {
      return await hooks.append(notebookID, markdown);
    }
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
        return {
          transport: "the SiYuan HTTP API",
          documentID: written.documentID || "",
          blockID: written.blockID || "",
          blocks: written.blockID ? [written.blockID] : [],
          // The HTTP API names the block it made, but not its siblings.
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
