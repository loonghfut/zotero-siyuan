/**
 * Zotero → SiYuan — which workspace the CLI commands should work on.
 *
 * The CLI can be told with `-w`, and it needs to be: its own default is not
 * the workspace the app uses on every platform. On macOS the CLI falls back
 * to `~/SiYuan`, while the app puts its workspace in
 * `~/Library/Application Support/SiYuan`, so relying on that default makes
 * every command fail on a perfectly normal install.
 *
 * `workspace info` reads the same `workspace.json` the app writes, so its
 * answer is the workspace the user really has.
 */

/**
 * How long the answer is trusted, in milliseconds.
 *
 * SiYuan keeps one workspace open at a time and the user can switch it
 * while Zotero runs, so the answer is asked for again — but not before
 * every single command of a batch.
 */
const AUTO_WORKSPACE_MS = 30000;

/**
 * The workspace a command should name with `-w`.
 *
 * Empty means "whatever the CLI defaults to".
 *
 * @param {Object} cli - a `SiYuanProcess` (it needs `runJSON` and a debug log)
 * @param {String[]} args - the command, so `workspace …` is not asked about itself
 * @returns {Promise<String>}
 */
export async function autoWorkspace(cli, args) {
  // `workspace info` and `workspace list` are the commands that *answer*
  // about workspaces; asking them to name one would be circular.
  if (args && args[0] === "workspace") {
    return "";
  }
  const now = Date.now();
  if (
    cli._autoWorkspace !== undefined &&
    now - (cli._autoWorkspaceAt || 0) < AUTO_WORKSPACE_MS
  ) {
    return cli._autoWorkspace;
  }
  cli._autoWorkspaceAt = now;
  cli._autoWorkspace = "";
  try {
    const info = await cli.runJSON(["workspace", "info"]);
    // Only a workspace SiYuan itself calls valid is passed on: an entry
    // left behind by a workspace on a disconnected drive is worse than
    // letting the CLI report its own default.
    if (info && info.path && info.valid !== false) {
      cli._autoWorkspace = info.path;
    }
  }
  catch (e) {
    Zotero.debug(
      `ZoteroSiYuan: could not ask the CLI for its workspace (${e.message}); ` +
        "letting the CLI use its own default",
    );
  }
  return cli._autoWorkspace;
}
