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

/**
 * Read a preference that is really a switch.
 *
 * A `pref()` default is a string, but the same preference can also be set
 * to a boolean — by a checkbox in a pane, or by hand in the config editor.
 * `String(value) === "1"` silently says "off" for a real `true`, so every
 * truthy spelling is accepted here.
 *
 * @param {String} key
 * @param {Boolean} [fallback]
 * @returns {Boolean}
 */
export function prefFlag(key, fallback = false) {
  const value = getPref(key, fallback ? "1" : "0");
  return (
    value === true ||
    value === 1 ||
    value === "1" ||
    value === "true"
  );
}

export function clearPref(key) {
  return Zotero.Prefs.clear(`${PREFS_PREFIX}.${key}`, true);
}
