/**
 * SiYuan kernel HTTP API — the fallback transport.
 *
 * The CLI is the primary transport, but a plugin must not depend on being
 * able to spawn a process. This client talks to the local SiYuan kernel
 * directly, which is also how the CLI itself works.
 *
 * Endpoints used:
 *
 *   POST /api/notebook/lsNotebooks
 *   POST /api/block/appendDailyNoteBlock
 *
 * The API token lives in the workspace's own configuration file
 * (`<workspace>/conf/conf.json` → `api.token`), so it is read at runtime
 * rather than configured by hand.
 */

import { homeDir, localAppDataDir, roamingAppDataDir } from "../utils/paths.js";
import { responseText } from "../utils/http.js";

const WORKSPACE_LIST_FILES = [
  "workspace.json",
];

/**
 * How many workspaces may be tried with their own token.
 *
 * Every wrong token is a failed authentication as far as the kernel is
 * concerned, and it rate-limits those — so a handful is the limit, not a
 * sweep through every workspace the user ever opened.
 */
const MAX_AUTH_ATTEMPTS = 3;

/**
 * What a block id looks like: `YYYYMMDDHHMMSS-xxxxxxx`.
 */
const BLOCK_ID = /^\d{14}-[0-9a-z]{7}$/i;

/** A string that is a block id, or "". */
function blockIDOf(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return BLOCK_ID.test(text) ? text : "";
}

/**
 * Read the block and document ids out of an append answer.
 *
 * The kernel answers `appendDailyNoteBlock` with an array of transactions;
 * `appendBlock` answers with `{ id }`. Both shapes — and a few plausible
 * neighbours — are searched, because the shape is the kernel's to change
 * and a wrong guess would turn every "open in SiYuan" link into
 * `siyuan://blocks/[object Object]`.
 *
 * @param {*} data - the `data` field of the kernel's answer
 * @returns {{blockID: String, documentID: String}}
 */
export function extractAppendResult(data) {
  let blockID = "";
  let documentID = "";

  const visit = (node, depth) => {
    if (!node || depth > 4 || (blockID && documentID)) {
      return;
    }
    if (typeof node === "string") {
      if (!blockID) {
        blockID = blockIDOf(node);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item, depth + 1);
      }
      return;
    }
    if (typeof node !== "object") {
      return;
    }
    if (!blockID) {
      for (const key of ["id", "blockID", "blockId"]) {
        const id = blockIDOf(node[key]);
        if (id) {
          blockID = id;
          break;
        }
      }
    }
    if (!documentID) {
      for (const key of ["parentID", "parentId", "rootID", "rootId", "documentID"]) {
        const id = blockIDOf(node[key]);
        if (id) {
          documentID = id;
          break;
        }
      }
    }
    for (const key of ["doOperations", "data", "transactions", "result"]) {
      if (node[key] !== undefined) {
        visit(node[key], depth + 1);
      }
    }
  };

  visit(data, 0);
  return { blockID, documentID };
}

export class SiYuanHTTP {
  constructor(options) {
    this.host = options.host || "127.0.0.1";
    this.port = options.port || 6806;
    this.token = options.token || "";
    this.workspaceDir = options.workspaceDir || "";
  }

  get baseURL() {
    return `http://${this.host}:${this.port}`;
  }

  async request(endpoint, payload) {
    if (!this.token) {
      throw new Error("No SiYuan API token found.");
    }
    const response = await Zotero.HTTP.request("POST", this.baseURL + endpoint, {
      body: JSON.stringify(payload || {}),
      headers: {
        Authorization: `Token ${this.token}`,
        "Content-Type": "application/json",
      },
      timeout: 8000,
    });
    // Zotero.HTTP.request resolves with the XMLHttpRequest itself, so the
    // body is `responseText` — there is no `response.text()`.
    const text = await responseText(response);
    let result;
    try {
      result = JSON.parse(text);
    }
    catch (e) {
      throw new Error(
        `SiYuan returned a non-JSON response from ${endpoint}: ${text.slice(0, 200)}`,
      );
    }
    if (result.code !== 0) {
      const reason = result.data && result.data.reason ? ` (${result.data.reason})` : "";
      const error = new Error(`SiYuan ${endpoint} failed${reason}: ${result.msg}`);
      // The kernel answered — it looked at the request and said no. That is
      // a definite "nothing was written", unlike a request that never got
      // an answer.
      error.refused = true;
      throw error;
    }
    return result.data;
  }

  async listNotebooks() {
    const data = await this.request("/api/notebook/lsNotebooks", {});
    return (data && data.notebooks) || [];
  }

  /**
   * Run a SQL query against the workspace.
   *
   * The CLI can do the same (`siyuan sql`), and it is the first choice —
   * but a machine where the CLI cannot be spawned still has a kernel that
   * answers this endpoint, and without it every PDF would lose its
   * "already sent" markers after a restart.
   *
   * @param {String} statement - a read-only SELECT
   * @returns {Promise<Object[]>} the rows
   */
  async sql(statement) {
    const data = await this.request("/api/query/sql", {
      stmt: String(statement || ""),
    });
    return Array.isArray(data) ? data : [];
  }

  /**
   * Append a Markdown block to today's daily note, creating it if needed.
   *
   * The kernel answers with an **array of transactions**, not with a block
   * id:
   *
   *   [{ "doOperations": [{ "id": "20260101000000-bbbbbbb",
   *                         "parentID": "20260101000000-ccccccc", … }] }]
   *
   * Taking that array as the id would put `[object Object]` into every
   * `siyuan://blocks/…` link, so the id is read out of it — and an answer
   * of any other shape is searched too, because the kernel changes and a
   * wrong guess must not become a broken link.
   *
   * @returns {Promise<{blockID: String, documentID: String}>}
   */
  async appendDailyNote(notebookID, markdown) {
    let data;
    try {
      data = await this.request("/api/block/appendDailyNoteBlock", {
        notebook: notebookID,
        dataType: "markdown",
        data: markdown,
      });
    }
    catch (e) {
      if (e && e.refused) {
        // The kernel said no: nothing was written.
        throw e;
      }
      // A timeout or a dropped connection: the request may well have been
      // processed before the answer was lost. Saying so is what keeps the
      // caller from sending the same note a second time.
      const error = new Error(e && e.message ? e.message : String(e));
      error.writeState = "unknown";
      error.written = true;
      throw error;
    }
    return extractAppendResult(data);
  }

  /**
   * Append Markdown to a document.
   *
   * The endpoint is the same operation the CLI's `block append` uses; its
   * answer is an array of transactions, so the id is read out of it.
   *
   * @param {String} parentID - the document (or block) to append to
   * @param {String} markdown
   * @returns {Promise<{blockID: String, documentID: String}>}
   */
  async appendBlock(parentID, markdown) {
    let data;
    try {
      data = await this.request("/api/block/appendBlock", {
        parentID,
        dataType: "markdown",
        data: markdown,
      });
    }
    catch (e) {
      if (e && e.refused) {
        throw e;
      }
      const error = new Error(e && e.message ? e.message : String(e));
      error.writeState = "unknown";
      error.written = true;
      throw error;
    }
    return extractAppendResult(data);
  }

  /**
   * Create a document with Markdown.
   *
   * The legacy `createDocWithMd` endpoint is refused by a notebook that
   * uses structured titles (`legacyPathUnsupported`). The CLI path handles
   * that; this fallback is only reached when the CLI cannot run at all.
   *
   * @param {String} notebookID
   * @param {String} parentPath - e.g. "/"
   * @param {String} title
   * @param {String} [markdown]
   * @returns {Promise<String>} the document id
   */
  async createDocument(notebookID, parentPath, title, markdown = "") {
    const parent = String(parentPath || "/").trim() || "/";
    const path = `${parent.replace(/\/+$/, "")}/${title}`;
    const data = await this.request("/api/filetree/createDocWithMd", {
      notebook: notebookID,
      path,
      markdown: String(markdown || ""),
    });
    const id = typeof data === "string"
      ? data.trim()
      : data && (data.id || data.ID) || "";
    if (!blockIDOf(id)) {
      throw new Error(
        `SiYuan did not answer with a document id: ${JSON.stringify(data).slice(0, 200)}`,
      );
    }
    return blockIDOf(id);
  }

  /**
   * Set custom attributes on a block or document.
   *
   * @param {String} id
   * @param {Object} attrs - name → value
   * @returns {Promise<void>}
   */
  async setBlockAttrs(id, attrs) {
    await this.request("/api/attr/setBlockAttrs", {
      id,
      attrs: attrs || {},
    });
  }

  /**
   * Delete one block.
   *
   * @param {String} id
   * @returns {Promise<void>}
   */
  async deleteBlock(id) {
    await this.request("/api/block/deleteBlock", { id });
  }

  /**
   * Resolve the notebook that should receive the daily note.
   * @param {string} wanted - notebook name or id; empty = first usable one
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
    for (const notebook of notebooks) {
      if (!notebook.closed) {
        return notebook;
      }
    }
    return notebooks[0];
  }

  /**
   * Find a workspace whose API token actually works.
   *
   * The configured workspace is tried first — it is the one the user chose.
   * Trying a *wrong* token against a running kernel counts as a failed
   * authentication, and SiYuan's kernel rate-limits those ("too many
   * authentication failures"), which would lock out the workspace that does
   * work. So the number of attempts is capped.
   *
   * @param {string} workspacePref - the configured workspace directory
   * @returns {Promise<SiYuanHTTP>}
   */
  static async discover(workspacePref) {
    const candidates = [];

    if (workspacePref) {
      candidates.push(workspacePref);
    }
    for (const dir of await SiYuanHTTP.workspaceList()) {
      if (!candidates.includes(dir)) {
        candidates.push(dir);
      }
    }
    for (const dir of SiYuanHTTP.defaultWorkspaceDirs()) {
      if (!candidates.includes(dir)) {
        candidates.push(dir);
      }
    }

    const errors = [];
    let attempts = 0;
    for (const dir of candidates) {
      let conf;
      try {
        conf = await SiYuanHTTP.readWorkspaceConf(dir);
      }
      catch (e) {
        // no configuration there — not a candidate
        continue;
      }
      if (!conf || !conf.api || !conf.api.token) {
        continue;
      }

      if (++attempts > MAX_AUTH_ATTEMPTS) {
        errors.push(
          `stopped after ${MAX_AUTH_ATTEMPTS} authentication attempts ` +
            "(the kernel limits the failed ones)",
        );
        break;
      }

      const client = new SiYuanHTTP({
        host: "127.0.0.1",
        port: conf.api.port || 6806,
        token: conf.api.token,
        workspaceDir: dir,
      });
      try {
        // Verify the token really belongs to a running kernel.
        await client.listNotebooks();
        return client;
      }
      catch (e) {
        errors.push(`${dir}: ${SiYuanHTTP.explain(e)}`);
      }
    }

    throw new Error(
      "Could not reach a SiYuan kernel over HTTP. " +
        (errors.length ? "Tried:\n  " + errors.join("\n  ") : "No workspace with an API token was found."),
    );
  }

  /**
   * Make a failure readable.
   *
   * The kernel answers "too many authentication failures" with a 429 whose
   * body is in Chinese — worth translating, because it looks like the plugin
   * simply cannot connect.
   */
  static explain(error) {
    const text = error && error.message ? error.message : String(error);
    if (/\b429\b/.test(text)) {
      return (
        "the kernel is rate-limiting authentication attempts (too many failed " +
        "ones) — wait a moment and try again" +
        (text.includes(":") ? ` [${text.split(":").pop().trim()}]` : "")
      );
    }
    return text;
  }

  static async readWorkspaceConf(dir) {
    const path = PathUtils.join(dir, "conf", "conf.json");
    const text = await Zotero.File.getContentsAsync(path);
    return JSON.parse(text);
  }

  /** The workspaces SiYuan's app knows about (its "recent workspaces" list). */
  static async workspaceList() {
    const dirs = [];
    for (const appDir of SiYuanHTTP.appConfigDirs()) {
      for (const name of WORKSPACE_LIST_FILES) {
        try {
          const path = PathUtils.join(appDir, name);
          const text = await Zotero.File.getContentsAsync(path);
          const list = JSON.parse(text);
          for (const entry of list) {
            const dir = typeof entry === "string" ? entry : entry.path;
            if (dir) {
              dirs.push(dir);
            }
          }
        }
        catch (e) {
          // not there, or not readable — try the next location
        }
      }
    }
    return dirs;
  }

  static appConfigDirs() {
    const dirs = [];
    const home = homeDir();
    if (home) {
      dirs.push(PathUtils.join(home, ".config", "siyuan"));
      dirs.push(PathUtils.join(home, "Library", "Application Support", "siyuan"));
      dirs.push(PathUtils.join(home, "AppData", "Roaming", "siyuan"));
    }
    const roaming = roamingAppDataDir();
    if (roaming) {
      dirs.push(PathUtils.join(roaming, "siyuan"));
    }
    const local = localAppDataDir();
    if (local) {
      dirs.push(PathUtils.join(local, "siyuan"));
    }
    return dirs;
  }

  static defaultWorkspaceDirs() {
    const dirs = [];
    const home = homeDir();
    if (home) {
      dirs.push(PathUtils.join(home, "SiYuan"));
      dirs.push(PathUtils.join(home, "Documents", "SiYuan"));
    }
    return dirs;
  }
}
