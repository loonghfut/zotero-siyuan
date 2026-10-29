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

/**
 * The message files of the plugin, in every locale directory.
 *
 * The scaffold copies the whole `locale/<locale>/` tree into the package,
 * so a locale that is shipped here is one the plugin really has.
 */
const FTL_FILES = ["zoteroSiYuan-addon.ftl", "zoteroSiYuan-preferences.ftl"];

const NAMESPACE = "zoteroSiYuan";

/** The locale every plugin ships, and the one every string falls back to. */
const FALLBACK_LOCALE = "en-US";

/**
 * The bundles, in the order they are asked: the language Zotero runs in
 * first, the fallback language second.
 *
 * A bundle is only put in here when its files really exist — otherwise the
 * second one answers, and a message that is missing in the translation
 * falls back to English instead of disappearing.
 */
const bundles = [];

/**
 * The locale Zotero runs in.
 * @returns {String}
 */
function appLocale() {
	try {
		return (Zotero && Zotero.locale) || FALLBACK_LOCALE;
	}
	catch (e) {
		return FALLBACK_LOCALE;
	}
}

/**
 * The file path of a message file, when it has one.
 *
 * An unpacked install is a `file:` URI and can be asked about directly. An
 * install inside the XPI is a `jar:` URI, which is not a file at all — there
 * is nothing to check there, and "" says so.
 *
 * @param {String} locale
 * @param {String} file
 * @returns {String} the path, or "" when it cannot be checked
 */
function localeFilePath(locale, file) {
	try {
		const uri = Services.io.newURI(
			`${_globalThis.rootURI}locale/${locale}/${file}`,
		);
		return uri.QueryInterface(Components.interfaces.nsIFileURL).file.path;
	}
	catch (e) {
		return "";
	}
}

/**
 * Does the plugin ship this locale?
 *
 * `IOUtils.exists()` answers with a **promise**, and a promise is always
 * truthy — a check written as `files.every((f) => IOUtils.exists(f))` is
 * therefore always true. It is awaited here. A path that cannot be
 * checked counts as present: guessing "absent" would take the user's
 * language away from them.
 *
 * @param {String} locale
 * @returns {Promise<Boolean>}
 */
async function localeExists(locale) {
	for (const file of FTL_FILES) {
		const path = localeFilePath(locale, file);
		if (!path) {
			return true;
		}
		try {
			if (!(await IOUtils.exists(path))) {
				return false;
			}
		}
		catch (e) {
			return true;
		}
	}
	return true;
}

/**
 * Open the Fluent files of one locale.
 * @param {String} locale
 * @returns {Object} the bundle, or null
 */
function openBundle(locale) {
	try {
		return new Localization(
			FTL_FILES.map((file) => `${_globalThis.rootURI}locale/${locale}/${file}`),
			true,
		);
	}
	catch (e) {
		Zotero.debug(
			`ZoteroSiYuan: could not open the ${locale} Fluent file: ${e}`,
		);
		return null;
	}
}

/**
 * Open the message bundles.
 *
 * Asynchronous because deciding *which* locales to open means looking at
 * the files that were really packaged — see `localeExists`. Startup awaits
 * it before anything can draw a button with a label in it.
 *
 * @returns {Promise<void>}
 */
export async function initLocale() {
	bundles.length = 0;

	const wanted = appLocale();
	const locales = wanted === FALLBACK_LOCALE
		? [FALLBACK_LOCALE]
		: [wanted, FALLBACK_LOCALE];

	for (const locale of locales) {
		// Only ask for a locale the plugin really ships — otherwise the
		// fallback answers everything and the language is simply English.
		if (locale !== FALLBACK_LOCALE && !(await localeExists(locale))) {
			Zotero.debug(
				`ZoteroSiYuan: the interface is ${wanted}, which the plugin does not ship — using ${FALLBACK_LOCALE}`,
			);
			continue;
		}
		const bundle = openBundle(locale);
		if (bundle) {
			bundles.push(bundle);
		}
	}
}

export function getString(id, fallback) {
	for (const bundle of bundles) {
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
				const value = bundle.formatValueSync(candidate);
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

/**
 * Fill the `%s` placeholders of a message, in order.
 *
 * Fluent has placeables of its own, but the plugin's messages are plain
 * text with `%s` — including the ones the preferences pane resolves itself
 * — so the substitution lives here instead of in every caller.
 *
 * @param {String} message
 * @param {...*} values
 * @returns {String}
 */
export function fill(message, ...values) {
	let text = String(message);
	for (const value of values) {
		text = text.replace("%s", String(value));
	}
	return text;
}
