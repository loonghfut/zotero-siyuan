/**
 * Preference helpers.
 *
 * The scaffold rewrites `addon/prefs.js` so every key is prefixed with
 * `config.prefsPrefix`; the same prefix is used when reading them back.
 */

const PREFS_PREFIX = "extensions.zotero.zoteroSiYuan";

export function getPref(key, fallback) {
  const value = Zotero.Prefs.get(`${PREFS_PREFIX}.${key}`, true);
  return value === undefined || value === null || value === "" ? fallback : value;
}

export function setPref(key, value) {
  return Zotero.Prefs.set(`${PREFS_PREFIX}.${key}`, value, true);
}

export function clearPref(key) {
  return Zotero.Prefs.clear(`${PREFS_PREFIX}.${key}`, true);
}
