/**
 * Zotero → SiYuan — writing to a block that is already there.
 *
 * A sync writes the new content first and deletes the old block only when
 * the new one is confirmed. When the old note is a single block, that
 * delete-and-append can be replaced by an in-place update: the block id
 * survives, so every link to it — and the plugin's own record — stays
 * right, and there is no moment where two copies exist.
 *
 * The update is not trusted blindly: the block is read back afterwards,
 * because a parser may replace it instead of rewriting it, and its custom
 * attributes are what the next sync finds it by.
 */

import { isBlockID } from "../modules/siyuan.js";
import { isWriteUnknown } from "../modules/siyuan-process.js";

export default {
  /**
   * Replace the content of a block, keeping its id.
   *
   * The CLI goes first, like every other write. A refusal — the block is
   * gone, the workspace is locked — is not a failure of the *sync*: the
   * caller falls back to appending a new block and deleting the old one.
   * An unanswered write is different: it may have landed, so it is thrown
   * instead of being retried over the other transport.
   *
   * @param {String} blockID
   * @param {String} markdown
   * @returns {Promise<Boolean>} whether a transport accepted the update
   */
  async _updateBlock(blockID, markdown) {
    if (!isBlockID(blockID)) {
      return false;
    }
    try {
      await this.getCLI().updateBlock(blockID, markdown);
      this._lastCLIError = "";
      return true;
    }
    catch (cliError) {
      this._lastCLIError = cliError.message;
      if (isWriteUnknown(cliError)) {
        throw cliError;
      }
      Zotero.debug(
        `ZoteroSiYuan: the CLI could not update ${blockID} (${cliError.message}); trying the HTTP API`,
      );
    }
    try {
      const http = await this._httpClient();
      await http.updateBlock(blockID, markdown);
      return true;
    }
    catch (e) {
      if (isWriteUnknown(e)) {
        throw e;
      }
      Zotero.debug(
        `ZoteroSiYuan: the block ${blockID} could not be updated: ${e.message}`,
      );
      return false;
    }
  },

  /**
   * One block's row, to check whether an update kept it.
   *
   * SiYuan answers a write before its query index has caught up — a block
   * written a second ago can be missing from `SELECT` while it is plainly
   * in the document. So "not found" is asked twice, with a pause, before it
   * is believed: a wrong "gone" would append a second copy of the note.
   *
   * @param {String} blockID
   * @returns {Promise<Object|null|undefined>} the row, null when the block
   *   is gone, undefined when that cannot be found out
   */
  async _blockRow(blockID) {
    if (!isBlockID(blockID)) {
      return null;
    }
    const first = await this._readBlockRow(blockID);
    if (first) {
      return first;
    }
    if (first === undefined) {
      // Neither transport could answer; retrying would not change that.
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return await this._readBlockRow(blockID);
  },

  /**
   * The row behind `_blockRow`, once.
   *
   * @param {String} blockID
   * @returns {Promise<Object|null|undefined>}
   */
  async _readBlockRow(blockID) {
    try {
      const http = await this._httpClient();
      const rows = await http.sql(
        `SELECT id, ial FROM blocks WHERE id = '${blockID}' LIMIT 1`,
      );
      if (Array.isArray(rows)) {
        return rows[0] || null;
      }
    }
    catch (e) {
      // No HTTP client — the CLI below can still answer.
    }
    try {
      const rows = await this.getCLI().blockRows([blockID]);
      return (rows && rows[0]) || null;
    }
    catch (e) {
      return undefined;
    }
  },

  /**
   * Put custom attributes on a block, whichever transport can.
   *
   * An in-place update keeps the block, but a parser that re-created it may
   * not have kept the IAL — the attributes are what the next sync finds the
   * block by, so they are written again when they are missing.
   *
   * @param {String} blockID
   * @param {Object} attrs
   * @returns {Promise<Boolean>}
   */
  async _setBlockAttrs(blockID, attrs) {
    if (!isBlockID(blockID)) {
      return false;
    }
    try {
      await this.getCLI().setBlockAttrs(blockID, attrs);
      return true;
    }
    catch (e) {
      Zotero.debug(
        `ZoteroSiYuan: the CLI could not set the block attributes (${e.message}); trying HTTP`,
      );
    }
    try {
      const http = await this._httpClient();
      await http.setBlockAttrs(blockID, attrs);
      return true;
    }
    catch (e) {
      Zotero.debug(
        `ZoteroSiYuan: the block attributes could not be set: ${e.message}`,
      );
      return false;
    }
  },
};
