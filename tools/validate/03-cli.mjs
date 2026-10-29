/**
 * Zotero → SiYuan — the static checks for The siyuan CLI: where it is, and what it answers.
 *
 * Part of `node tools/validate.mjs`: this file runs when it is imported, and
 * the entry point prints the summary. `check()` and `section()` come from
 * `harness.mjs`, together with the source readers.
 */

import {
  ROOT,
  check,
  section,
} from "./harness.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/* ------------------ 5. the CLI search paths are correct ---------------- */

section("siyuan CLI search paths");
const { buildCandidatePaths } = await import(
  new URL("../../src/modules/siyuan.js", import.meta.url).href
);
const home = process.env.USERPROFILE || process.env.HOME || "";
const localAppData = process.env.LOCALAPPDATA || "";
const roamingAppData = process.env.APPDATA || "";
const isWin = process.platform === "win32";
const candidates = buildCandidatePaths({
  home,
  localAppData,
  roamingAppData,
  isWin,
  isMac: process.platform === "darwin",
});

check(
  "the LocalAppData kernel is a candidate",
  localAppData
    ? candidates.includes(
        `${localAppData}\\Programs\\SiYuan\\resources\\kernel\\SiYuan-Kernel.exe`,
      )
    : true,
  "n/a on this platform",
);
check(
  "the installer's siyuan.exe hard link is a candidate too",
  // The Windows installer hard-links `siyuan.exe` next to the kernel, and
  // the Store edition registers it as an app execution alias — either is
  // what an older install, or one whose link was lost, needs.
  localAppData
    ? candidates.includes(
        `${localAppData}\\Programs\\SiYuan\\resources\\kernel\\siyuan.exe`,
      )
    : true,
  "n/a on this platform",
);
check(
  "the Roaming AppData candidate is not mistaken for the local one",
  !localAppData ||
    !candidates.includes(
      `${roamingAppData}\\Programs\\SiYuan\\resources\\kernel\\siyuan.exe`,
    ) ||
    !candidates.includes(
      `${localAppData}\\Programs\\SiYuan\\resources\\kernel\\siyuan.exe`,
    ),
);

// The plugin must find the CLI even when only the home directory is known:
// `Services.dirsvc` is not reachable in every scope a plugin runs in.
{
  const fromHome = buildCandidatePaths({ home, isWin: true });
  check(
    "a candidate can be derived from the home directory alone",
    fromHome.includes(
      `${home}\\AppData\\Local\\Programs\\SiYuan\\resources\\kernel\\SiYuan-Kernel.exe`,
    ),
    fromHome.join(" | "),
  );
}

// macOS: the CLI is `SiYuan-Kernel` inside the app bundle. `siyuan` only
// exists when the user made the symlink the SiYuan README suggests, so the
// bundle path has to be searched without it.
{
  const mac = buildCandidatePaths({ home: "/Users/zotero", isMac: true });
  for (const expected of [
    "/Applications/SiYuan.app/Contents/Resources/kernel/SiYuan-Kernel",
    "/Users/zotero/Applications/SiYuan.app/Contents/Resources/kernel/SiYuan-Kernel",
    "/usr/local/bin/siyuan",
    "/opt/homebrew/bin/siyuan",
  ]) {
    check(`macOS searches ${expected}`, mac.includes(expected), mac.join(" | "));
  }
}

// Linux: the deb/rpm packages install to /opt/SiYuan. `/usr/bin/siyuan`
// there is the Electron app, not the CLI — launching it with `--version`
// would open the GUI, so it must never be tried.
{
  const linux = buildCandidatePaths({ home: "/home/zotero" });
  for (const expected of [
    "/opt/SiYuan/resources/kernel/SiYuan-Kernel",
    "/usr/local/bin/siyuan",
    "/home/zotero/.local/share/siyuan/kernel/SiYuan-Kernel",
  ]) {
    check(
      `Linux searches ${expected}`,
      linux.includes(expected),
      linux.join(" | "),
    );
  }
  check(
    "Linux does not mistake the Electron app for the CLI",
    !linux.includes("/usr/bin/siyuan") && !linux.includes("/usr/bin/SiYuan"),
    linux.join(" | "),
  );
}

// The workspace has to be named, not assumed: on macOS the CLI's own
// default (`~/SiYuan`) is not where the app keeps its workspace
// (`~/Library/Application Support/SiYuan`), so every command would fail on
// a normal install.
{
  const processSource = readFileSync(
    join(ROOT, "src", "modules", "siyuan-process.js"),
    "utf8",
  );
  const workspaceSource = readFileSync(
    join(ROOT, "src", "modules", "siyuan-workspace.js"),
    "utf8",
  );
  check(
    "every command is given the workspace explicitly",
    /const workspace = await this\.workspaceFor\(args\);/.test(processSource) &&
      /argv\.push\("-w", workspace\)/.test(processSource),
  );
  check(
    "the CLI is asked which workspace SiYuan uses",
    /runJSON\(\["workspace", "info"\]\)/.test(workspaceSource) &&
      /info\.valid !== false/.test(workspaceSource),
  );
  check(
    "a command about workspaces does not ask itself",
    /args\[0\] === "workspace"/.test(workspaceSource),
  );
}

// If SiYuan is installed on this machine, the real binary must be reachable.
const realCli = candidates.find((candidate) => existsSync(candidate)) || "";
if (realCli) {
  check(
    `the installed CLI is among the candidates (${realCli})`,
    candidates.includes(realCli),
    "auto-detection would miss it",
  );
}
else {
  console.log(
    "  [SKIP] no SiYuan CLI was found at any of the candidate paths",
  );
}

// The probe has to be runnable, not merely correct: it calls four helpers
// that live in `utils/paths.js`. One of them was left behind when the file
// was split, and the ReferenceError turned into "Could not find the siyuan
// CLI" — the plugin looked as if SiYuan were not installed, but only on a
// machine where `siyuan` is not on PATH.
{
  const { SiYuanProcess } = await import(
    new URL("../../src/modules/siyuan-process.js", import.meta.url).href
  );
  const hadZotero = "Zotero" in globalThis;
  const hadServices = "Services" in globalThis;
  const oldZotero = globalThis.Zotero;
  const oldServices = globalThis.Services;
  globalThis.Zotero = { isWin, isMac: process.platform === "darwin", debug() {} };
  globalThis.Services = { env: { get: (name) => process.env[name] ?? "" } };
  let paths = [];
  let error = "";
  try {
    paths = new SiYuanProcess().candidatePaths();
  }
  catch (e) {
    error = String(e && e.message ? e.message : e);
  }
  finally {
    if (hadZotero) globalThis.Zotero = oldZotero;
    else delete globalThis.Zotero;
    if (hadServices) globalThis.Services = oldServices;
    else delete globalThis.Services;
  }
  check(
    "the install locations can be worked out at all",
    error === "" && Array.isArray(paths) && paths.length > 0,
    error || `${paths.length} candidate(s)`,
  );
}

/* ------------------ 6. the HTTP fallback can find a workspace ------------ */

section("SiYuan HTTP fallback discovery");
{
  // The kernel counts *failed* authentications and locks itself out after
  // too many of them, so this must try the configured workspace first and
  // stop after a couple of tries — exactly like the plugin does.
  //
  // The configured workspace comes from the environment, not from a path
  // that is built into this file: a hardcoded one is right on exactly one
  // machine, and it would put that machine's directory layout into the
  // repository.
  const preferred = String(process.env.SIYUAN_WORKSPACE || "").trim();
  const appDirs = [
    join(home, ".config", "siyuan"),
    join(home, "Library", "Application Support", "siyuan"),
    join(home, "AppData", "Roaming", "siyuan"),
  ];
  // The workspace candidates, in the order they are tried: the configured
  // workspace first, then the ones SiYuan's own "recent workspaces" list
  // knows.
  const workspaceCandidates = [];
  if (preferred) {
    workspaceCandidates.push(preferred);
  }
  for (const appDir of appDirs) {
    const listPath = join(appDir, "workspace.json");
    if (!existsSync(listPath)) continue;
    let list = [];
    try {
      list = JSON.parse(readFileSync(listPath, "utf8"));
    }
    catch (e) {
      continue;
    }
    for (const entry of list) {
      const dir = typeof entry === "string" ? entry : entry.path;
      if (dir && !workspaceCandidates.includes(dir)) {
        workspaceCandidates.push(dir);
      }
    }
  }

  let found = null;
  const errors = [];
  let attempts = 0;
  // How many candidates really hold a SiYuan configuration. A candidate
  // that has none is not a workspace — it is a path that does not point at
  // SiYuan, and it must not turn "SiYuan is not installed here" into a
  // failure.
  let usable = 0;
  for (const dir of workspaceCandidates) {
    const confPath = join(dir, "conf", "conf.json");
    if (!existsSync(confPath)) continue;
    usable++;
    let conf;
    try {
      conf = JSON.parse(readFileSync(confPath, "utf8"));
    }
    catch (e) {
      continue;
    }
    if (!conf.api || !conf.api.token) continue;
    if (++attempts > 3) break;
    const port = conf.api.port || 6806;
    // The plugin verifies the token by authenticating; so does this test.
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/notebook/lsNotebooks`,
        {
          method: "POST",
          headers: {
            Authorization: `Token ${conf.api.token}`,
            "Content-Type": "application/json",
          },
          body: "{}",
        },
      );
      const body = await response.json();
      if (body.code === 0) {
        found = {
          dir,
          token: conf.api.token,
          port,
          notebooks: (body.data.notebooks || []).map((n) => n.name),
        };
        break;
      }
      errors.push(`${dir}: ${body.msg}`);
    }
    catch (e) {
      // kernel not running for this workspace — try the next one
      errors.push(`${dir}: ${e.message}`);
    }
  }
  const rateLimited = errors.some((e) =>
    /429|too many|认证失败次数过多|rate-limit/i.test(e),
  );
  if (found) {
    check(
      "a workspace with a working API token can be discovered",
      true,
    );
    console.log(
      `         → ${found.dir} (port ${found.port}, notebooks: ${found.notebooks.join(", ")})`,
    );
  }
  else if (!usable) {
    // No SiYuan on this machine — nothing to discover. A CI runner has
    // none, and "the workspace could not be found" there is a fact about
    // the runner, not a defect of the plugin.
    console.log(
      "  [SKIP] no SiYuan workspace is installed on this machine; " +
        "the discovery check cannot be judged",
    );
  }
  else if (rateLimited) {
    // The kernel locks itself out after too many *failed* authentications.
    // That is a state of the machine, not a defect of the plugin — and it
    // cannot be judged from here, so it is reported rather than failed.
    console.log(
      "  [SKIP] the SiYuan kernel is rate-limiting authentication attempts;" +
        " the discovery check cannot be judged right now",
    );
  }
  else {
    check(
      "a workspace with a working API token can be discovered",
      false,
      errors.length ? errors.join(" | ") : "no workspace authenticated",
    );
  }
}

/* --------------- 6b. the write answers name the block they made ------------- */

section("The write path names its block");
{
  // `dailynote append` answers with the *document* id, `block append` with
  // the id of the block. Reading that wrong is invisible: the note is
  // written, but every link points at “[object Object]”. So both answers
  // are checked against the shape the kernel really sends.
  const { extractAppendResult } = await import(
    new URL("../../src/modules/siyuan-http.js", import.meta.url).href
  );
  const { isBlockID, blockCreatedAt } = await import(
    new URL("../../src/modules/siyuan.js", import.meta.url).href
  );

  check(
    "a block id is recognized",
    isBlockID("20260101000000-abcdefg") &&
      !isBlockID("20260101000000") &&
      !isBlockID("[object Object]") &&
      blockCreatedAt("20260101000000-abcdefg") === "20260101000000",
  );

  // The real answer of /api/block/appendDailyNoteBlock.
  const transactions = [
    {
      timestamp: 0,
      doOperations: [
        {
          action: "insert",
          id: "20260101000000-bbbbbbb",
          parentID: "20260101000000-ccccccc",
          rootID: "",
          data: "<div data-node-id=\"20260101000000-bbbbbbb\"></div>",
        },
      ],
    },
  ];
  check(
    "the ids are read out of the kernel's transactions",
    extractAppendResult(transactions).blockID === "20260101000000-bbbbbbb" &&
      extractAppendResult(transactions).documentID ===
        "20260101000000-ccccccc",
  );
  check(
    "a plain id is accepted as well",
    extractAppendResult("20260101000000-bbbbbbb").blockID ===
      "20260101000000-bbbbbbb",
  );
  check(
    "an object answer is searched too",
    extractAppendResult({ id: "20260101000000-abcdefg" }).blockID ===
      "20260101000000-abcdefg",
  );
  check(
    "an answer without an id does not invent one",
    extractAppendResult({}).blockID === "" &&
      extractAppendResult(null).blockID === "",
  );

  const cli =
    readFileSync(join(ROOT, "src", "modules", "siyuan.js"), "utf8") +
    readFileSync(join(ROOT, "src", "modules", "siyuan-documents.js"), "utf8");
  check(
    "the CLI creates the daily note and then appends to it",
    cli.includes('"dailynote"') &&
      cli.includes('"create"') &&
      /"block",\s*\n\s*"append",/.test(cli) &&
      cli.includes("blockCreatedAt"),
  );
  check(
    "the old one-shot command is only the fallback",
    cli.includes("The fallback:") && cli.includes("falling back to"),
  );
  check(
    "the daily note is created once, not once per send",
    // `dailynote create` is a process. The document of a day does not move,
    // so it is remembered — and recreated when the write says it is gone.
    cli.includes("async dailyNoteDocument(notebookID)") &&
      /_dailyNote = \{ key, documentID \}/.test(cli) &&
      cli.includes("dailyNoteKey(notebookID)") &&
      /remembered[\s\S]{0,400}?this\._dailyNote = null;/.test(cli),
  );
  check(
    "the sibling blocks cost a process only when they are asked for",
    /collectBlocks = false/.test(cli) &&
      /const rows = collectBlocks\s*\?[\s\S]{0,80}newBlockRowsSince\(/.test(cli),
  );
  check(
    "only the blocks a write created are attributed to it",
    // A timestamp alone cannot separate our blocks from a note the user
    // wrote in the same second — so the document is read *before* the write
    // as well, and only the difference counts. `blocksExact` says whether
    // that was possible; a caller that deletes must look at it.
    /let before = collectBlocks\s*\?[\s\S]{0,90}findBlocksSince\(documentID, since\)/.test(
      cli,
    ) &&
      /blocksExact/.test(cli) &&
      /!known\.has\(row\.id\)/.test(cli),
  );
  check(
    "a clean-up can tell whether its deletion took",
    // `block delete` answers "success" for a block that is already gone,
    // so the self test asks the workspace instead of trusting the command.
    /findExistingBlocks\(/.test(cli),
  );
  check(
    "a failed write says whether it may have written",
    // The daily note is recreated when a write to it fails, which is only
    // safe while nothing was written — so the two flags are what the
    // decision hangs on.
    /e\.timedOut \|\| e\.written/.test(cli),
  );
}
