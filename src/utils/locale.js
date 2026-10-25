/**
 * Fluent helpers.
 *
 * The reader UI has its own Fluent bundles and never sees the plugin's
 * sources, so strings are resolved here in the plugin scope and written to
 * the reader DOM as plain attributes.
 *
 * The scaffold prefixes every message id with the namespace
 * (`zoteroSiYuan-…`) and renames the FTL files to `zoteroSiYuan-*.ftl`.
 */

const FTL_FILES = ["zoteroSiYuan-addon.ftl", "zoteroSiYuan-preferences.ftl"];
const NAMESPACE = "zoteroSiYuan";

let l10n = null;

export function initLocale() {
  try {
    l10n = new Localization(
      FTL_FILES.map((file) => `${_globalThis.rootURI}locale/en-US/${file}`),
      true,
    );
  }
  catch (e) {
    Zotero.debug(`ZoteroSiYuan: could not open the Fluent file: ${e}`);
    l10n = null;
  }
}

export function getString(id, fallback) {
  if (l10n) {
    // The message ids in the FTL file are written without the namespace
    // (`button-label`), while the code asks for them with it
    // (`zoteroSiYuan-button-label`) — so both forms are tried.
    for (const candidate of [
      id,
      id.startsWith(`${NAMESPACE}-`) ? id.slice(NAMESPACE.length + 1) : "",
    ]) {
      if (!candidate) {
        continue;
      }
      try {
        const value = l10n.formatValueSync(candidate);
        if (value) {
          return value;
        }
      }
      catch (e) {
        // try the next form
      }
    }
  }
  return fallback || id;
}
