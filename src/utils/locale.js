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
 * Does the plugin ship this locale?
 * @param {String} locale
 * @returns {Boolean}
 */
function localeExists(locale) {
	try {
		return FTL_FILES.every((file) =>
			IOUtils.exists(`${_globalThis.rootURI}locale/${locale}/${file}`),
		);
	}
	catch (e) {
		return false;
	}
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

export function initLocale() {
	bundles.length = 0;

	const wanted = appLocale();
	const locales = wanted === FALLBACK_LOCALE
		? [FALLBACK_LOCALE]
		: [wanted, FALLBACK_LOCALE];

	for (const locale of locales) {
		// Only ask for a locale the plugin really ships — otherwise the
		// fallback answers everything and the language is simply English.
		if (locale !== FALLBACK_LOCALE && !localeExists(locale)) {
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
