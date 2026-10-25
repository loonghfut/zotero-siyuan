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
 *   siyuan dailynote append --notebook <id> --file <path> -w <workspace> --format json
 */

import { tempFilePath, firstOf, homeDir, localAppDataDir, roamingAppDataDir } from "../utils/paths.js";

/** How long a single CLI invocation may take before it is killed. */
const COMMAND_TIMEOUT = 30000;

/**
 * A SiYuan timestamp: local time as `YYYYMMDDHHMMSS`.
 *
 * The kernel stores block creation times in exactly this format, which is
 * what makes it possible to find the block a command has just created.
 *
 * @param {Date} date
 * @returns {String}
 */
export function siyuanTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * The directories the siyuan CLI may live in, most likely first.
 *
 * Kept pure so it can be tested without a running Zotero. On Windows the
 * important detail is that desktop apps install into %LOCALAPPDATA%
 * (`AppData\Local`), while `Services.dirsvc.get("AppData")` is the *Roaming*
 * directory (`AppData\Roaming`) — using the wrong one yields paths that do
 * not exist.
 */
export function buildCandidatePaths({
  home = "",
  localAppData = "",
  roamingAppData = "",
  programFiles = "",
  isWin = false,
  isMac = false,
} = {}) {
  const candidates = [];

  if (isWin) {
    const localBases = [];
    if (localAppData) {
      localBases.push(localAppData);
    }
    if (home) {
      localBases.push(`${home}\\AppData\\Local`);
    }
    for (const base of localBases) {
      candidates.push(
        `${base}\\Programs\\SiYuan\\resources\\kernel\\siyuan.exe`,
      );
      candidates.push(`${base}\\SiYuan\\resources\\kernel\\siyuan.exe`);
    }
    if (roamingAppData) {
      candidates.push(
        `${roamingAppData}\\SiYuan\\resources\\kernel\\siyuan.exe`,
      );
    }
    for (const base of [
      programFiles,
      "C:\\Program Files",
      "C:\\Program Files (x86)",
    ]) {
      if (base) {
        candidates.push(`${base}\\SiYuan\\resources\\kernel\\siyuan.exe`);
      }
    }
  }
  else if (isMac) {
    candidates.push(
      "/Applications/SiYuan.app/Contents/Resources/kernel/siyuan",
    );
    if (home) {
      candidates.push(
        `${home}/Applications/SiYuan.app/Contents/Resources/kernel/siyuan`,
      );
    }
  }
  else {
    candidates.push(
      "/usr/lib/siyuan/resources/kernel/siyuan",
      "/opt/siyuan/resources/kernel/siyuan",
    );
    if (home) {
      candidates.push(`${home}/.local/share/siyuan/kernel/siyuan`);
    }
  }

  return candidates;
}

export class SiYuanCLI {
  constructor(options) {
    this.executable = options.executable || ""; // explicit path, "" = auto-detect
    this.workspace = options.workspace || ""; // "" = whatever the CLI defaults to
  }

  /* ----------------------------------------------------------- process */

  /**
   * Run the siyuan CLI.
   * @param {string[]} args
   * @returns {Promise<{code: number, output: string}>}
   */
  async run(args) {
    const command = await this.resolveExecutable();
    const argv = args.slice();

    if (this.workspace) {
      argv.push("-w", this.workspace);
    }

    Zotero.debug(`ZoteroSiYuan: running ${command} ${argv.join(" ")}`);

    // First choice: Gecko's Subprocess module. It reports the exit code and
    // can merge stderr into stdout, which is what tells us why a command
    // failed.
    try {
      const { Subprocess } = ChromeUtils.importESModule(
        "resource://gre/modules/Subprocess.sys.mjs",
      );
      // stderr: "stdout" merges the error output into stdout, so a failing
      // command still tells us what went wrong.
      const proc = await Subprocess.call({
        command,
        arguments: argv,
        stderr: "stdout",
      });
      const { out, exitCode } = await this.readProcess(proc);
      return { code: exitCode, output: out };
    }
    catch (e) {
      if (e && e.timedOut) {
        // The command was started but never finished — retrying it through
        // the fallback would only hang again.
        throw e;
      }
      if (e && e.errorCode) {
        throw new Error(
          `Could not run the SiYuan CLI at "${command}": ${e.message}`,
        );
      }
      // The Subprocess module is not reachable from this scope — fall back to
      // Zotero's own helper, which the client itself uses (stdout only).
      try {
        const merged = await Zotero.Utilities.Internal.subprocess(command, argv);
        return { code: merged ? 0 : 1, output: String(merged || "") };
      }
      catch (e2) {
        throw new Error(
          `Could not run the SiYuan CLI at "${command}": ${e2.message} ` +
            `(first attempt: ${e && e.message ? e.message : e})`,
        );
      }
    }
  }

  /**
   * Read a running process to the end, with a timeout.
   *
   * A CLI that hangs (a locked workspace, a kernel that never answers) must
   * not freeze the reader's click handler, so the whole read+wait is raced
   * against a deadline.
   *
   * @param {Object} proc - a Gecko Subprocess handle
   * @returns {Promise<{out: String, exitCode: Number}>}
   */
  async readProcess(proc) {
    const work = (async () => {
      let out = "";
      let chunk;
      while ((chunk = await proc.stdout.readString())) {
        out += chunk;
      }
      // `proc.wait()` resolves with an *object* — `{ exitCode }` — not with
      // the number itself. Taking it as a number would make every command
      // look like it had failed.
      const waited = await proc.wait();
      const exitCode =
        typeof waited === "number"
          ? waited
          : waited && typeof waited.exitCode === "number"
            ? waited.exitCode
            : -1;
      return { out, exitCode };
    })();

    let timer = null;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try {
          proc.kill();
        }
        catch (e) {
          // already gone
        }
        const error = new Error(
          `the siyuan CLI did not answer within ${COMMAND_TIMEOUT} ms`,
        );
        error.timedOut = true;
        reject(error);
      }, COMMAND_TIMEOUT);
    });

    try {
      return await Promise.race([work, guard]);
    }
    finally {
      clearTimeout(timer);
    }
  }

  /**
   * Run the CLI and parse its JSON output.
   * @throws {Error} when the command fails
   */
  async runJSON(args) {
    const result = await this.run(args.concat(["--format", "json"]));
    const output = (result.output || "").trim();

    if (result.code !== 0) {
      throw new Error(this.describeFailure(output, args, result.code));
    }
    if (!output) {
      throw new Error(
        `The siyuan CLI returned no output for: siyuan ${args.join(" ")}`,
      );
    }
    try {
      return JSON.parse(output);
    }
    catch (e) {
      throw new Error(
        `Could not parse the siyuan CLI output: ${output.slice(0, 300)}`,
      );
    }
  }

  /**
   * Run the CLI and return its raw answer.
   *
   * Some commands do not answer with JSON even when asked to — `dailynote
   * append` answers with the id of the block it created — so they must not
   * go through `runJSON()`.
   *
   * @throws {Error} when the command fails
   */
  async runRaw(args) {
    const result = await this.run(args);
    if (result.code !== 0) {
      throw new Error(
        this.describeFailure(result.output, args, result.code),
      );
    }
    const output = (result.output || "").trim();
    if (!output) {
      // The fallback transport cannot tell a silent success from a failure,
      // so an empty answer is treated as a failure.
      throw new Error(
        `The siyuan CLI returned no output for: siyuan ${args.join(" ")}`,
      );
    }
    return output;
  }

  describeFailure(output, args, code) {
    const text = (output || "").trim();
    // The CLI prints "Error: …" first, then the usage block.
    const lines = text.split("\n");
    let message = "";
    for (const line of lines) {
      if (/^Error:/.test(line)) {
        message = line.replace(/^Error:\s*/, "");
        break;
      }
    }
    if (!message) {
      message = lines
        .filter((l) => l && !/^\s{2,}/.test(l))
        .slice(0, 2)
        .join(" ");
    }
    if (!message) {
      message = `exit code ${code}`;
    }
    return `siyuan ${args.join(" ")} failed: ${message}`;
  }

  /* -------------------------------------------------------- executable */

  /**
   * Windows uses backslashes; Gecko's executable check does not accept
   * forward slashes, so a path typed as "C:/Users/…" is rejected as
   * "not an executable" even though the file is there.
   */
  normalizePath(path) {
    return Zotero.isWin ? path.replace(/\//g, "\\") : path;
  }

  /**
   * Can this file actually be launched?
   *
   * Deliberately does not pre-check with IOUtils/PathUtils: Firefox's
   * Subprocess already validates the file, and its verdict is the one that
   * matters. So ask it directly — and keep the reason, because "could not
   * find the CLI" without saying why is useless.
   *
   * @param {String} path
   * @returns {Promise<{ok: Boolean, output: String, error: String}>}
   */
  async tryRun(path) {
    const attempts = [];

    try {
      const { Subprocess } = ChromeUtils.importESModule(
        "resource://gre/modules/Subprocess.sys.mjs",
      );
      const proc = await Subprocess.call({
        command: path,
        arguments: ["--version"],
        stderr: "stdout",
      });
      const { out, exitCode } = await this.readProcess(proc);
      return { ok: true, output: out.trim(), exitCode, error: "" };
    }
    catch (e) {
      attempts.push(
        `Subprocess.call: ${e && e.message ? e.message : String(e)}`,
      );
    }

    // Zotero's own helper uses the same module, but it is imported in the
    // client's scope — so it works even when the plugin's own import of the
    // module does not.
    try {
      const out = await Zotero.Utilities.Internal.subprocess(path, [
        "--version",
      ]);
      const text = String(out || "").trim();
      if (text) {
        return { ok: true, output: text, exitCode: 0, error: "" };
      }
      attempts.push("Zotero.Utilities.Internal.subprocess: no output");
    }
    catch (e) {
      attempts.push(
        `Zotero.Utilities.Internal.subprocess: ${
          e && e.message ? e.message : String(e)
        }`,
      );
    }

    return { ok: false, output: "", exitCode: -1, error: attempts.join(" | ") };
  }

  /** Locate the siyuan CLI. */
  async resolveExecutable() {
    // Already found and verified — do not spawn `siyuan --version` again.
    if (this._resolved && this.executable) {
      return this.executable;
    }

    if (this.executable) {
      const normalized = this.normalizePath(this.executable);
      const result = await this.tryRun(normalized);
      if (result.ok) {
        this.executable = normalized;
        this._resolved = true;
        return normalized;
      }
      Zotero.debug(
        `ZoteroSiYuan: the configured path "${this.executable}" cannot be launched (${result.error}); falling back to auto-detection`,
      );
      this.executable = "";
    }

    // On PATH? Subprocess.pathSearch resolves the name and validates it.
    try {
      const { Subprocess } = ChromeUtils.importESModule(
        "resource://gre/modules/Subprocess.sys.mjs",
      );
      for (const name of ["siyuan", "siyuan.exe"]) {
        try {
          const found = await Subprocess.pathSearch(name);
          if (found) {
            this.executable = found;
            this._resolved = true;
            return found;
          }
        }
        catch (e) {
          // not on PATH under this name — try the next
        }
      }
    }
    catch (e) {
      Zotero.debug(
        `ZoteroSiYuan: the Subprocess module is not reachable here (${e.message})`,
      );
    }

    // Common install locations.
    const failures = [];
    for (const candidate of this.candidatePaths()) {
      const result = await this.tryRun(candidate);
      if (result.ok) {
        this.executable = candidate;
        this._resolved = true;
        return candidate;
      }
      failures.push(`${candidate} — ${result.error}`);
    }

    throw new Error(
      "Could not find the siyuan CLI. It ships with SiYuan 3.7+ " +
        "(Windows: %LOCALAPPDATA%\\Programs\\SiYuan\\resources\\kernel\\siyuan.exe). " +
        "Leave the CLI path empty to auto-detect it, or set the full path to siyuan.exe." +
        (failures.length ? "\nTried:\n  " + failures.join("\n  ") : ""),
    );
  }

  candidatePaths() {
    // Each base is looked up in several independent ways, because no single
    // source is available in every scope a plugin may run in.
    const home = homeDir();
    // "AppData" is the *Roaming* directory; desktop apps install into
    // %LOCALAPPDATA%. Getting this wrong points at a directory that does
    // not exist, so probe both, and derive the local one from Home as well.
    const localAppData = localAppDataDir();
    const roamingAppData = roamingAppDataDir();
    const programFiles = firstOf(
      () => Services.env.get("ProgramFiles"),
      () => Services.env.get("ProgramW6432"),
    );

    return buildCandidatePaths({
      home,
      localAppData,
      roamingAppData,
      programFiles,
      isWin: Zotero.isWin,
      isMac: Zotero.isMac,
    });
  }

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
   * Append Markdown to today's daily note, creating it if needed.
   *
   * Note the answer format: `siyuan dailynote append` prints the id of the
   * block it created — a bare string, *not* JSON, even with
   * `--format json`. So this must not go through `runJSON()`: parsing the
   * block id as JSON fails, and the caller would believe the write failed
   * although the block is already in the note.
   *
   * @param {string} notebookID
   * @param {string} markdown
   * @returns {Promise<string>} the id of the block that was appended
   */
  async appendToDailyNote(notebookID, markdown) {
    // The content goes through a temporary file: it contains newlines and
    // Markdown punctuation that would be awkward as a command line argument.
    const path = this.tempPath();
    await Zotero.File.putContentsAsync(path, markdown);
    try {
      return await this.runRaw([
        "dailynote",
        "append",
        "--notebook",
        notebookID,
        "--file",
        path,
      ]);
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

  tempPath() {
    const name = `zotero-siyuan-${Date.now()}-${Math.floor(
      Math.random() * 100000,
    )}.md`;
    return tempFilePath(name);
  }

  /**
   * The top-level blocks that were created after a given moment.
   *
   * `dailynote append` answers with the id of the *daily note document*,
   * not of the blocks it created — so the blocks themselves are looked up in
   * the workspace's own database. A template usually produces several
   * (a callout, a comment, a metadata paragraph), and all of them are
   * returned.
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
      `AND created >= '${since}' ORDER BY created ASC`;
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
    return await this.runRaw(["block", "delete", "--id", blockID]);
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
