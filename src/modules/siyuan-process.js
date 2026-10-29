/**
 * Zotero → SiYuan — running the `siyuan` binary and reading its answer.
 *
 * Everything here is about a process: finding the executable, spawning it with
 * a timeout, and turning whatever it printed into something the caller can
 * use. Knowing *what* to ask SiYuan belongs to `siyuan.js`, which extends this.
 */

import { fill, getString } from "../utils/locale.js";
import {
  firstOf,
  homeDir,
  localAppDataDir,
  roamingAppDataDir,
  tempFilePath,
} from "../utils/paths.js";
import { buildCandidatePaths } from "./siyuan-cli-path.js";
import { autoWorkspace } from "./siyuan-workspace.js";

// The search paths are asked about from outside (diagnostics, the checks),
// so they stay reachable from the module the rest of the plugin imports.
export { buildCandidatePaths } from "./siyuan-cli-path.js";

const COMMAND_TIMEOUT = 30000;

/**
 * Mark a failure that happened *after* a write command had started.
 *
 * The command may or may not have written something — a timeout kills the
 * process, a broken stdout leaves us without an answer. Neither says "it
 * did not work", so the caller must not retry it and must not take back
 * the picture the note may already refer to.
 *
 * @param {Error} error
 * @returns {Error} the same error
 */
export function markWriteUnknown(error) {
  if (error && typeof error === "object") {
    error.writeState = "unknown";
    // The older flag, kept because `appendBlock` already sets it for the
    // same reason ("the answer was not usable, but it may have written").
    error.written = true;
  }
  return error;
}

/**
 * Did this failure leave the write in an unknown state?
 *
 * @param {Error} error
 * @returns {Boolean}
 */
export function isWriteUnknown(error) {
  if (!error) {
    return false;
  }
  if (error.writeState) {
    return error.writeState === "unknown";
  }
  return !!error.written || !!error.timedOut;
}

export class SiYuanProcess {
  constructor(options = {}) {
    this.executable = options.executable || ""; // explicit path, "" = auto-detect
    this.workspace = options.workspace || ""; // "" = whatever the CLI defaults to
  }

  /* ----------------------------------------------------------- process */

  /**
   * Run the siyuan CLI.
   *
   * @param {string[]} args
   * @param {Object} [options]
   * @param {Boolean} [options.mutating] - the command writes to the
   *   workspace. When it had started but its answer could not be read, the
   *   write may still have happened: that is recorded on the error
   *   (`writeState: "unknown"`) instead of being retried.
   * @returns {Promise<{code: number, output: string}>}
   */

  async run(args, { mutating = false } = {}) {
    const command = await this.resolveExecutable();
    const argv = args.slice();

    // A SiYuan install does not have to sit where the CLI would look by
    // itself — on macOS the CLI's own default is `~/SiYuan`, while the app
    // puts its workspace in `~/Library/Application Support/SiYuan`. So the
    // workspace is named explicitly whenever it is known; `workspaceFor()`
    // never throws: when it cannot tell, the CLI's default is still tried.
    const workspace = await this.workspaceFor(args);
    if (workspace) {
      argv.push("-w", workspace);
    }

    Zotero.debug(`ZoteroSiYuan: running ${command} ${argv.join(" ")}`);

    // First choice: Gecko's Subprocess module. It reports the exit code and
    // can merge stderr into stdout, which is what tells us why a command
    // failed.
    let proc = null;
    try {
      const { Subprocess } = ChromeUtils.importESModule(
        "resource://gre/modules/Subprocess.sys.mjs",
      );
      // stderr: "stdout" merges the error output into stdout, so a failing
      // command still tells us what went wrong.
      proc = await Subprocess.call({
        command,
        arguments: argv,
        stderr: "stdout",
      });
    }
    catch (e) {
      // `errorCode` means the executable itself could not be launched:
      // nothing ran, so a second attempt cannot write anything twice.
      if (e && e.errorCode) {
        throw new Error(
          fill(
            getString(
              "zoteroSiYuan-error-cli-spawn",
              "Could not run the SiYuan CLI at “%s”: %s",
            ),
            command,
            e.message,
          ),
        );
      }
      // The Subprocess module is not reachable from this scope — fall back
      // to Zotero's own helper, which the client itself uses.
      return await this.runThroughZotero(command, argv, mutating, e);
    }

    // From here on the process exists: if reading its answer fails, the
    // command may already have done its work. Running it again would write
    // a second note — so the failure is reported as "unknown" instead.
    try {
      const { out, exitCode } = await this.readProcess(proc);
      return { code: exitCode, output: out };
    }
    catch (e) {
      if (mutating) {
        markWriteUnknown(e);
      }
      throw e;
    }
  }

  /**
   * The workspace a command should name with `-w`.
   *
   * A configured one always wins. Without one, the CLI is asked which
   * workspace SiYuan is set up with — see `siyuan-workspace.js` for why
   * its own default is not good enough. Empty means "let the CLI decide".
   *
   * @param {String[]} args - the command, so `workspace …` is not asked
   *   about itself
   * @returns {Promise<String>}
   */

  async workspaceFor(args) {
    return this.workspace || (await autoWorkspace(this, args));
  }

  /**
   * Run the CLI through Zotero's own subprocess helper.
   *
   * Only reached when the plugin's own import of the Subprocess module
   * failed — which says nothing about whether the command could run, so a
   * failure here is marked the same way as any other started-but-unread
   * command.
   *
   * @param {String} command
   * @param {String[]} argv
   * @param {Boolean} mutating
   * @param {Error} firstError
   * @returns {Promise<{code: number, output: string}>}
   */

  async runThroughZotero(command, argv, mutating, firstError) {
    try {
      const merged = await Zotero.Utilities.Internal.subprocess(command, argv);
      return { code: merged ? 0 : 1, output: String(merged || "") };
    }
    catch (e2) {
      const error = new Error(
        fill(
          getString(
            "zoteroSiYuan-error-cli-spawn-twice",
            "Could not run the SiYuan CLI at “%s”: %s (first attempt: %s)",
          ),
          command,
          e2.message,
          firstError && firstError.message ? firstError.message : firstError,
        ),
      );
      if (mutating) {
        markWriteUnknown(error);
      }
      throw error;
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
          fill(
            getString(
              "zoteroSiYuan-error-cli-timeout",
              "The siyuan CLI did not answer within %s ms.",
            ),
            COMMAND_TIMEOUT,
          ),
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

  async runJSON(args, options = {}) {
    const result = await this.run(args.concat(["--format", "json"]), options);
    const output = (result.output || "").trim();

    if (result.code !== 0) {
      throw new Error(this.describeFailure(output, args, result.code));
    }
    if (!output) {
      throw new Error(
        fill(
          getString(
            "zoteroSiYuan-error-cli-no-output",
            "The siyuan CLI returned no output for: siyuan %s",
          ),
          args.join(" "),
        ),
      );
    }
    try {
      return JSON.parse(output);
    }
    catch (e) {
      throw new Error(
        fill(
          getString(
            "zoteroSiYuan-error-cli-bad-output",
            "Could not parse the siyuan CLI output: %s",
          ),
          output.slice(0, 300),
        ),
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

  async runRaw(args, options = {}) {
    const result = await this.run(args, options);
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
        fill(
          getString(
            "zoteroSiYuan-error-cli-no-output",
            "The siyuan CLI returned no output for: siyuan %s",
          ),
          args.join(" "),
        ),
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
      message = fill(
        getString("zoteroSiYuan-error-cli-exit-code", "exit code %s"),
        code,
      );
    }
    return fill(
      getString(
        "zoteroSiYuan-error-cli-command-failed",
        "siyuan %s failed: %s",
      ),
      args.join(" "),
      message,
    );
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
   * Does this answer come from the SiYuan CLI?
   *
   * `--version` on the kernel prints “SiYuan-Kernel version 3.8.8”. Asking
   * that the answer names SiYuan keeps a path that starts the *desktop app*
   * instead — on Linux `/usr/bin/siyuan` is the Electron app — from being
   * taken for the CLI just because it launched.
   *
   * @param {String} text
   * @returns {Boolean}
   */

  looksLikeCLI(text) {
    return /siyuan/i.test(String(text || ""));
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
      const text = out.trim();
      if (this.looksLikeCLI(text)) {
        return { ok: true, output: text, exitCode, error: "" };
      }
      attempts.push(
        `Subprocess.call: “${text.slice(0, 80)}” is not the SiYuan CLI`,
      );
      // The file ran and answered: trying it a second way cannot turn it
      // into the CLI, and on Linux the wrong file is the desktop app,
      // which would only be started a second time.
      return { ok: false, output: text, exitCode, error: attempts.join(" | ") };
    }
    catch (e) {
      attempts.push(
        `Subprocess.call: ${e && e.message ? e.message : String(e)}`,
      );
      // The file started but never answered — the desktop app does that
      // when it is asked for `--version`. Another attempt would only start
      // a second window.
      if (e && e.timedOut) {
        return { ok: false, output: "", exitCode: -1, error: attempts.join(" | ") };
      }
    }

    // Zotero's own helper uses the same module, but it is imported in the
    // client's scope — so it works even when the plugin's own import of the
    // module does not.
    try {
      const out = await Zotero.Utilities.Internal.subprocess(path, [
        "--version",
      ]);
      const text = String(out || "").trim();
      if (this.looksLikeCLI(text)) {
        return { ok: true, output: text, exitCode: 0, error: "" };
      }
      attempts.push(
        `Zotero.Utilities.Internal.subprocess: “${text.slice(0, 80)}” ` +
          "is not the SiYuan CLI",
      );
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
      // The deb/rpm packages install the *desktop app* as /usr/bin/siyuan.
      // Starting it would open the window (and lock the workspace) instead
      // of answering, so a PATH hit there is not the CLI we are after.
      const notTheCLI = new Set(["/usr/bin/siyuan", "/usr/bin/SiYuan"]);
      for (const name of Zotero.isWin
        ? ["siyuan", "siyuan.exe", "SiYuan-Kernel.exe"]
        : ["siyuan", "SiYuan-Kernel"]) {
        try {
          const found = await Subprocess.pathSearch(name);
          if (found && !notTheCLI.has(found)) {
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
      getString(
        "zoteroSiYuan-error-cli-not-found",
        "Could not find the SiYuan CLI. SiYuan 3.7 or later ships it as " +
          "“SiYuan-Kernel” (SiYuan-Kernel.exe on Windows) in the installation's " +
          "resources/kernel folder — on macOS for example " +
          "/Applications/SiYuan.app/Contents/Resources/kernel/SiYuan-Kernel. " +
          "Leave the CLI path empty to find it automatically, or set the full " +
          "path to that file.",
      ) +
        (failures.length
          ? "\n" +
            getString("zoteroSiYuan-error-tried", "Tried:") +
            "\n  " +
            failures.join("\n  ")
          : ""),
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

  tempPath() {
    const name = `zotero-siyuan-${Date.now()}-${Math.floor(
      Math.random() * 100000,
    )}.md`;
    return tempFilePath(name);
  }

  /**
   * The top-level blocks of a document that were created at a given second.
   *
   * Used after `block append`: the command names the first block it made,
   * and its id carries the creation second — every top-level block written
   * by that one append was created then.
   *
   * @param {String} documentID
   * @param {String} created - a SiYuan timestamp
   * @returns {Promise<String[]>}
   */
}
