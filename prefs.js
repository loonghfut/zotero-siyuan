// Default preferences for Zotero → SiYuan.
//
// These live on the root branch (not under `extensions.zotero.`), so they must
// be read with the `global` flag: Zotero.Prefs.get('extensions.zotero-siyuan.cliPath', true)

// Path to the SiYuan command line interface. Empty means "look it up on PATH
// and in the usual install locations". On Windows that is
// %LOCALAPPDATA%\Programs\SiYuan\resources\kernel\siyuan.exe
pref('extensions.zotero-siyuan.cliPath', '');

// SiYuan workspace directory. Empty means "use whichever workspace the siyuan
// CLI currently uses" (see `siyuan workspace info`).
pref('extensions.zotero-siyuan.workspace', '');

// Name or id of the notebook that holds the daily note. Empty means "the
// first notebook in the workspace".
pref('extensions.zotero-siyuan.notebook', '');
