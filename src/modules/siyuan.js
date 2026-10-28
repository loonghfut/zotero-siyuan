/**
 * SiYuan command line client.
 *
 * Talks to SiYuan through its own CLI (SiYuan 3.7+ ships `siyuan` next to
 * the kernel; on Windows that is
 * `…\SiYuan\resources\kernel\siyuan.exe`).
 *
 * The CLI works directly on the workspace, so no API token, host or port is
 * needed, and it resolves the daily-note path from SiYuan's own settings.
 *
 * Commands used:
 *
 *   siyuan workspace list   --format json
 *   siyuan workspace info   --format json
 *   siyuan notebook list    -w <workspace> --format json
 *   siyuan dailynote create --notebook <id> -w <workspace>
 *   siyuan block append     --parent <document id> --file <path> -w <workspace> --format json
 *
 * The two write commands behave very differently, and the difference
 * matters:
 *
 *   - `dailynote append` answers with the id of the **daily note document**
 *     (a bare string, even with `--format json`);
 *   - `block append` answers with JSON `{ "id": "<block id>" }` — the exact
 *     block it created.
 *
 * So a send creates the daily note first and then appends to it: the block
 * id then needs no guessing. `dailynote append` is kept as the fallback for
 * a CLI that does not know `block append`.
 */

import { tempFilePath, firstOf, homeDir, localAppDataDir, roamingAppDataDir } from "../utils/paths.js";

/** How long a single CLI invocation may take before it is killed. */

import { SiYuanProcess } from "./siyuan-process.js";
import documents from "./siyuan-documents.js";
import { isBlockID, siyuanTimestamp } from "./siyuan-sql.js";

// The search paths are asked about from outside (diagnostics, the checks), so
// they stay reachable from the module the rest of the plugin imports.
export { buildCandidatePaths } from "./siyuan-process.js";
// The ids and timestamps are made here and read elsewhere; keeping the
// export on this module means callers do not have to know where they moved.
export { isBlockID, siyuanTimestamp } from "./siyuan-sql.js";

export function blockCreatedAt(blockID) {
  const text = String(blockID == null ? "" : blockID).trim();
  return /^\d{14}-/.test(text) ? text.slice(0, 14) : "";
}

export class SiYuanCLI extends SiYuanProcess {
  /* --------------------------------------------------------- commands */

  async listWorkspaces() {
    const data = await this.runJSON(["workspace", "list"]);
    return Array.isArray(data) ? data : [];
  }

  async currentWorkspace() {
    const data = await this.runJSON(["workspace", "info"]);
    return (data && data.path) || "";
  }

  async listNotebooks() {
    const data = await this.runJSON(["notebook", "list"]);
    return Array.isArray(data) ? data : [];
  }

  /**
   * Resolve the notebook that should receive the daily note.
   * @param {string} wanted - notebook name or id from the preferences; empty = first usable one
   */

  async resolveNotebook(wanted) {
    const notebooks = await this.listNotebooks();
    if (!notebooks.length) {
      throw new Error("The selected SiYuan workspace has no notebooks.");
    }
    if (wanted) {
      const lower = String(wanted).trim().toLowerCase();
      for (const notebook of notebooks) {
        if (
          notebook.id === wanted ||
          String(notebook.name).trim().toLowerCase() === lower
        ) {
          return notebook;
        }
      }
      throw new Error(
        `No SiYuan notebook named "${wanted}". Available: ` +
          notebooks.map((n) => n.name).join(", "),
      );
    }
    for (const candidate of notebooks) {
      if (!candidate.closed) {
        return candidate;
      }
    }
    return notebooks[0];
  }


  /**
   * Today's daily note, created when it does not exist yet.
   *
   * The command is idempotent — it answers with the id of the document of
   * today either way — so it is safe to run before every send.
   *
   * @param {string} notebookID
   * @returns {Promise<string>} the id of the daily note document
   */

  async createDailyNote(notebookID) {
    if (!notebookID) {
      throw new Error("No SiYuan notebook was given.");
    }
    const output = await this.runRaw([
      "dailynote",
      "create",
      "--notebook",
      notebookID,
    ]);
    const documentID = String(output || "").trim();
    if (!isBlockID(documentID)) {
      throw new Error(
        `The siyuan CLI did not answer with a document id: ${documentID.slice(0, 200)}`,
      );
    }
    return documentID;
  }

  /**
   * Append Markdown to a document and return the id of the block it made.
   *
   * `block append` is the only command that says which block it created:
   * its JSON answer is `{ "id": "20260101000000-abcdefg" }`. For a
   * multi-block Markdown the id is the first block of it — the one a
   * "open in SiYuan" link should point at.
   *
   * @param {string} parentID - the document (or block) to append to
   * @param {string} markdown
   * @returns {Promise<string>} the id of the new block
   */

  async appendBlock(parentID, markdown) {
    if (!isBlockID(parentID)) {
      throw new Error(`"${parentID}" is not a block id`);
    }
    const path = this.tempPath();
    await Zotero.File.putContentsAsync(path, markdown);
    try {
      const result = await this.run(
        [
          "block",
          "append",
          "--parent",
          parentID,
          "--file",
          path,
          "--format",
          "json",
        ],
        // A write: if the process hangs or its answer cannot be read, it
        // may still have appended something.
        { mutating: true },
      );
      if (result.code !== 0) {
        // The command refused — nothing was written, so a fallback is safe.
        throw new Error(
          this.describeFailure(
            result.output,
            ["block", "append"],
            result.code,
          ),
        );
      }
      const output = String(result.output || "").trim();
      let data = null;
      try {
        data = JSON.parse(output);
      }
      catch (e) {
        // The command may well have written the block; the answer is just
        // not the shape expected. Falling back here would write it twice,
        // so this is reported instead.
        const error = new Error(
          `siyuan block append answered with something other than JSON: ${output.slice(0, 200)}`,
        );
        error.written = true;
        throw error;
      }
      const id = data && typeof data.id === "string" ? data.id.trim() : "";
      if (!isBlockID(id)) {
        const error = new Error(
          "siyuan block append did not answer with a block id: " +
            JSON.stringify(data).slice(0, 200),
        );
        error.written = true;
        throw error;
      }
      return id;
    }
    finally {
      try {
        await IOUtils.remove(path, { ignoreAbsent: true });
      }
      catch (e) {
        // ignore
      }
    }
  }

  /**
   * Replace the content of an existing block.
   *
   * A sync used to write the new block and delete the old one. Updating in
   * place keeps the block id — so a link, a backlink or the plugin's own
   * index still leads to the note — and there is no moment where two copies
   * exist.
   *
   * The command does not say whether the block kept its id, so the caller
   * checks afterwards. A failure is reported like an append's: a refused
   * update wrote nothing, an unanswered one may have written.
   *
   * @param {String} blockID
   * @param {String} markdown
   * @returns {Promise<void>}
   */

  async updateBlock(blockID, markdown) {
    if (!isBlockID(blockID)) {
      throw new Error(`"${blockID}" is not a block id`);
    }
    const path = this.tempPath();
    await Zotero.File.putContentsAsync(path, markdown);
    try {
      const result = await this.run(
        [
          "block",
          "update",
          "--id",
          blockID,
          "--file",
          path,
          "--format",
          "json",
        ],
        { mutating: true },
      );
      if (result.code !== 0) {
        throw new Error(
          this.describeFailure(result.output, ["block", "update"], result.code),
        );
      }
    }
    finally {
      try {
        await IOUtils.remove(path, { ignoreAbsent: true });
      }
      catch (e) {
        // ignore
      }
    }
  }

  /**
   * Today's daily note, created when it does not exist yet — and remembered.
   *
   * `dailynote create` is idempotent and answers with the id of today's
   * document, but it is a process per call: without this, every send would
   * start one, and so would the next send a second later. The document of a
   * day does not move, so it is kept per notebook and per day.
   *
   * @param {string} notebookID
   * @returns {Promise<string>} the id of the daily note document
   */

  async dailyNoteDocument(notebookID) {
    const key = this.dailyNoteKey(notebookID);
    if (this._dailyNote && this._dailyNote.key === key) {
      return this._dailyNote.documentID;
    }
    const documentID = await this.createDailyNote(notebookID);
    this._dailyNote = { key, documentID };
    return documentID;
  }

  /**
   * What the remembered daily note belongs to: the workspace, the notebook,
   * and the local date — a note is "today's" until midnight.
   *
   * @param {string} notebookID
   * @returns {string}
   */

  dailyNoteKey(notebookID) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const day =
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    return `${this.workspace}|${notebookID}|${day}`;
  }

  /**
   * Append Markdown to today's daily note, creating it if needed.
   *
   * Answers with the ids of what was written, so the caller can link to the
   * note and clean up after a test:
   *
   *   { documentID, blockID, blocks, blocksExact }
   *
   * The preferred way is `dailynote create` + `block append`, because
   * `block append` says exactly which block it created. The older
   * `dailynote append` only answers with the *document* id, so on that path
   * the blocks have to be looked up by timestamp — which is ambiguous for
   * two writes in the same second, and is why it is only the fallback.
   *
   * A send needs one thing from all of this: the block id. The list of the
   * other blocks written at the same moment is only used by the self test,
   * which has to take them all back — so it costs a process only when it is
   * asked for. `blocksExact` says whether that list is trustworthy: it is
   * only true when the document was read before the write as well, so the
   * list is "what appeared while this write ran" rather than "what carries
   * the same timestamp" — the second kind includes notes other writers made
   * at the same moment.
   *
   * @param {string} notebookID
   * @param {string} markdown
   * @param {Object} [options]
   * @param {Boolean} [options.collectBlocks] - also list the sibling blocks
   * @returns {Promise<{documentID: String, blockID: String,
   *   blocks: String[], blocksExact: Boolean}>}
   */

  async appendToDailyNote(notebookID, markdown, { collectBlocks = false } = {}) {
    const since = siyuanTimestamp();
    try {
      // Was the document remembered from an earlier send? Then a failure
      // below may mean it is gone (deleted in SiYuan, or the day turned
      // over) — and recreating it is worth one attempt.
      const remembered =
        !!this._dailyNote && this._dailyNote.key === this.dailyNoteKey(notebookID);
      let documentID = await this.dailyNoteDocument(notebookID);
      // The caller that deletes what was written needs to know which
      // blocks are *new*. A timestamp alone cannot say that: a note
      // written by the user in the same second carries the same one. So
      // the document is read before the write as well, and only the
      // difference counts.
      let before = collectBlocks
        ? await this.findBlocksSince(documentID, since).catch(() => null)
        : null;
      let blockID = "";
      try {
        blockID = await this.appendBlock(documentID, markdown);
      }
      catch (e) {
        if (
          !remembered ||
          (e && (e.timedOut || e.written || e.writeState === "unknown"))
        ) {
          throw e;
        }
        // The remembered note is not there any more. `appendBlock` says
        // when it may have written, so reaching this point means it wrote
        // nothing — creating the note again cannot double anything.
        this._dailyNote = null;
        documentID = await this.dailyNoteDocument(notebookID);
        // The snapshot belongs to the *old* document; the new one needs its
        // own, or every block of it would look like it was just written.
        if (collectBlocks) {
          before = await this.findBlocksSince(documentID, since)
            .catch(() => null);
        }
        blockID = await this.appendBlock(documentID, markdown);
      }
      // Every top-level block of the same append shares its creation
      // second. They are collected for the self test, which has to take
      // them all back again; the link itself points at the first one.
      const rows = collectBlocks
        ? await this.newBlockRowsSince(documentID, since, before)
        : [];
      const blocks = rows.map((row) => row.id);
      return {
        documentID,
        blockID,
        blocks: blocks.length ? blocks : [blockID],
        blockRows: rows,
        // True when the list above is "everything that appeared while this
        // write ran", not "everything with the same timestamp".
        blocksExact: collectBlocks ? !!before : false,
      };
    }
    catch (e) {
      if (e && (e.timedOut || e.written || e.writeState === "unknown")) {
        // Either the command hung, or it may already have written — a
        // fallback would then append the same note twice.
        throw e;
      }
      // Whatever was remembered is of no use now.
      this._dailyNote = null;
      Zotero.debug(
        `ZoteroSiYuan: "block append" is not available (${e.message}); ` +
          "falling back to \"dailynote append\"",
      );
    }

    // The fallback: one command, but it only answers with the document id.
    // A caller that has to delete its own blocks needs the document before
    // the write, so the daily note is resolved first in that case only.
    let knownDocumentID = "";
    let before = null;
    if (collectBlocks) {
      try {
        knownDocumentID = await this.dailyNoteDocument(notebookID);
        before = await this.findBlocksSince(knownDocumentID, since);
      }
      catch (e) {
        knownDocumentID = "";
        before = null;
      }
    }
    const path = this.tempPath();
    await Zotero.File.putContentsAsync(path, markdown);
    let documentID = "";
    try {
      documentID = String(
        await this.runRaw(
          [
            "dailynote",
            "append",
            "--notebook",
            notebookID,
            "--file",
            path,
          ],
          // A write, like `block append` above.
          { mutating: true },
        ),
      ).trim();
    }
    finally {
      try {
        await IOUtils.remove(path, { ignoreAbsent: true });
      }
      catch (e) {
        // ignore
      }
    }

    // Only a snapshot of the *same* document can be trusted.
    const comparable = !!before && knownDocumentID === documentID;
    const rows = documentID
      ? await this.newBlockRowsSince(
        documentID,
        since,
        comparable ? before : null,
      )
      : [];
    const blocks = rows.map((row) => row.id);
    return {
      documentID,
      blockID: blocks[0] || "",
      blocks,
      blockRows: rows,
      blocksExact: comparable,
    };
  }

  /**
   * The blocks that appeared in a document while a write ran.
   *
   * @param {String} documentID
   * @param {String} since - a SiYuan timestamp, taken before the write
   * @param {String[]|null} before - the blocks that already existed then;
   *   null when no snapshot could be taken
   * @returns {Promise<String[]>} oldest first
   */

  async newBlocksSince(documentID, since, before) {
    let after = [];
    try {
      after = await this.findBlocksSince(documentID, since);
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
    return after.filter((id) => !known.has(id));
  }

  /**
   * Which of these blocks still exist.
   *
   * The self test deletes what it wrote and then asks this — a delete that
   * did not take must not be reported as a clean run.
   *
   * @param {String[]} blockIDs
   * @returns {Promise<String[]>} the ones that are still there
   */

  async findExistingBlocks(blockIDs) {
    const ids = (blockIDs || []).filter((id) => isBlockID(id));
    if (!ids.length) {
      return [];
    }
    const list = ids.map((id) => `'${id}'`).join(", ");
    const rows = await this.runJSON([
      "sql",
      `SELECT id FROM blocks WHERE id IN (${list})`,
    ]);
    if (!Array.isArray(rows)) {
      return [];
    }
    return rows.map((row) => row.id).filter(Boolean);
  }

  /**
   * The top-level blocks that were created after a given moment.
   *
   * Only used to tell what a write left behind. On its own it cannot
   * separate two writes in the same second — that is why `newBlocksSince`
   * compares two of these answers.
   *
   * @param {String} documentID - the daily note document
   * @param {String} since - a SiYuan timestamp
   * @returns {Promise<String[]>} the block ids, oldest first
   */

  async findBlocksSince(documentID, since) {
    if (!/^[0-9A-Za-z-]+$/.test(String(documentID))) {
      throw new Error(`"${documentID}" is not a block id`);
    }
    if (!/^[0-9]{14}$/.test(String(since))) {
      throw new Error(`"${since}" is not a SiYuan timestamp`);
    }
    const statement =
      "SELECT id, type, created FROM blocks " +
      `WHERE root_id = '${documentID}' AND parent_id = '${documentID}' ` +
      `AND created >= '${since}' ORDER BY sort ASC`;
    const rows = await this.runJSON(["sql", statement]);
    if (!Array.isArray(rows)) {
      return [];
    }
    return rows.map((row) => row.id).filter(Boolean);
  }

  /** Delete a block from the workspace. */
  async deleteBlock(blockID) {
    if (!/^[0-9A-Za-z-]+$/.test(String(blockID))) {
      throw new Error(`"${blockID}" is not a block id`);
    }
    // A write as well: a delete that timed out may already have happened.
    return await this.runRaw(["block", "delete", "--id", blockID], {
      mutating: true,
    });
  }

  /**
   * Check that the CLI works and report what it sees.
   */

  async diagnose() {
    const report = {
      ok: false,
      executable: "",
      workspace: "",
      notebooks: [],
      error: "",
    };
    try {
      report.executable = await this.resolveExecutable();
      report.workspace = this.workspace || (await this.currentWorkspace());
      report.notebooks = await this.listNotebooks();
      report.ok = true;
    }
    catch (e) {
      report.error = e.message;
    }
    return report;
  }
}

// The document operations live in their own file; a caller still sees one
// client with all of its commands.
Object.assign(SiYuanCLI.prototype, documents);
