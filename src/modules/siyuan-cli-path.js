/**
 * Zotero → SiYuan — where SiYuan puts its command line.
 *
 * This is a list of paths, and nothing else: whether one of them can be
 * launched is decided by `siyuan-process.js`, which is the only caller.
 * Kept apart because the list is long, platform-dependent, and the one
 * thing most likely to need another entry.
 */

/**
 * The names the CLI goes by inside `resources/kernel/`.
 *
 * SiYuan 3.7+ ships the CLI as `SiYuan-Kernel` (`SiYuan-Kernel.exe` on
 * Windows) — **not** as `siyuan`. The `siyuan` name is only a convenience:
 * the Windows installer creates it as a hard link, and on macOS/Linux the
 * user is told to create it as a symlink. An install that never had either
 * is perfectly normal, so both names are tried.
 */
const KERNEL_NAMES = ["SiYuan-Kernel", "siyuan"];

/**
 * Every path the CLI is worth looking for at.
 *
 * None of these is guaranteed: the user may have unpacked SiYuan anywhere,
 * which is what the preference is for. They are the layouts that are true
 * when nothing was customised.
 *
 * @param {Object} [platform]
 * @param {String} [platform.home] - the user's home directory
 * @param {String} [platform.localAppData] - `%LOCALAPPDATA%`
 * @param {String} [platform.roamingAppData] - `%APPDATA%`
 * @param {String} [platform.programFiles] - `%ProgramFiles%`
 * @param {Boolean} [platform.isWin]
 * @param {Boolean} [platform.isMac]
 * @returns {String[]}
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
  const addKernel = (kernelDir) => {
    for (const name of KERNEL_NAMES) {
      candidates.push(`${kernelDir}${isWin ? `${name}.exe` : name}`);
    }
  };

  if (isWin) {
    const localBases = [];
    if (localAppData) {
      localBases.push(localAppData);
    }
    if (home) {
      localBases.push(`${home}\\AppData\\Local`);
    }
    for (const base of localBases) {
      addKernel(`${base}\\Programs\\SiYuan\\resources\\kernel\\`);
      addKernel(`${base}\\SiYuan\\resources\\kernel\\`);
      // The Microsoft Store edition registers `siyuan.exe` as an app
      // execution alias that starts the kernel CLI, not the desktop app.
      candidates.push(`${base}\\Microsoft\\WindowsApps\\siyuan.exe`);
    }
    if (roamingAppData) {
      addKernel(`${roamingAppData}\\SiYuan\\resources\\kernel\\`);
    }
    for (const base of [
      programFiles,
      "C:\\Program Files",
      "C:\\Program Files (x86)",
    ]) {
      if (base) {
        addKernel(`${base}\\SiYuan\\resources\\kernel\\`);
      }
    }
  }
  else if (isMac) {
    for (const base of ["/Applications", home ? `${home}/Applications` : ""]) {
      if (base) {
        addKernel(`${base}/SiYuan.app/Contents/Resources/kernel/`);
      }
    }
    // The setup the SiYuan README describes: a `siyuan` symlink in a bin
    // directory. Zotero is started from Finder, so its PATH is the launchd
    // default (/usr/bin:/bin:/usr/sbin:/sbin) — `Subprocess.pathSearch()`
    // alone would never see /usr/local/bin or /opt/homebrew/bin.
    for (const dir of [
      "/usr/local/bin",
      "/opt/homebrew/bin",
      home ? `${home}/.local/bin` : "",
    ]) {
      if (dir) {
        candidates.push(`${dir}/siyuan`);
      }
    }
  }
  else {
    // The deb/rpm packages install to /opt/SiYuan; the tar.gz and older
    // builds land wherever the user unpacked them.
    for (const dir of [
      "/opt/SiYuan",
      "/opt/siyuan",
      "/usr/lib/siyuan",
      "/usr/lib/SiYuan",
      "/usr/share/siyuan",
    ]) {
      addKernel(`${dir}/resources/kernel/`);
    }
    if (home) {
      addKernel(`${home}/.local/share/siyuan/kernel/`);
    }
    // `/usr/bin/siyuan` is deliberately not a candidate (nor `/snap/bin`):
    // the packages put the *Electron app* there, and starting it with
    // `--version` would launch the GUI instead of printing an answer.
    for (const dir of [
      "/usr/local/bin",
      home ? `${home}/.local/bin` : "",
      home ? `${home}/bin` : "",
    ]) {
      if (dir) {
        candidates.push(`${dir}/siyuan`);
      }
    }
  }

  return candidates;
}
