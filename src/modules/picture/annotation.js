/**
 * Zotero → SiYuan — where the picture of an area selection lives.
 *
 * A "框选" annotation — the box that was dragged over a part of the page —
 * has no text at all: what the user selected is kept as a **picture**.
 * Zotero stores it in its cache, and the reader hands the same picture over
 * as a data URL. Both places are found here; what is done with the picture
 * is in `assets.js`.
 */

/** The annotation types that carry a picture instead of text. */
const PICTURE_TYPES = ["image", "ink"];

/**
 * Is this an annotation whose content is a picture?
 *
 * The reader's model calls the field `type`, the item calls it
 * `annotationType` — both are accepted, so the check works whichever
 * model it is handed.
 *
 * @param {Object} annotation - the reader's annotation model
 * @returns {Boolean}
 */
export function isPictureAnnotation(annotation) {
	if (!annotation) {
		return false;
	}
	const type = String(
		annotation.type || annotation.annotationType || "",
	).toLowerCase();
	return PICTURE_TYPES.includes(type);
}

/**
 * Where Zotero keeps the picture of an annotation.
 *
 * Zotero's own way is tried first, and then the same folder is worked out
 * by hand — one of the two always works, and neither of them may be taken
 * for granted.
 *
 * @param {Number} libraryID - the library the annotation belongs to
 * @param {String} key - the annotation's key
 * @returns {String} the path, or "" when it cannot be worked out
 */
export function cacheImagePath(libraryID, key) {
	if (!key) {
		return "";
	}
	try {
		const path = Zotero.Annotations.getCacheImagePath({
			libraryID,
			key,
		});
		if (path) {
			return path;
		}
	}
	catch (e) {
		// Fall through to the way it is done by hand.
	}
	try {
		const cache = Zotero.DataDirectory.getSubdirectory("cache");
		const library = Zotero.Libraries.get(libraryID);
		const folder =
			library && library.libraryType === "group"
				? PathUtils.join(cache, "groups", String(library.id))
				: PathUtils.join(cache, "library");
		return PathUtils.join(folder, `${key}.png`);
	}
	catch (e) {
		return "";
	}
}

/**
 * The picture of an annotation, as a file on disk.
 *
 * Zotero keeps the cropped picture of an image or ink annotation in its
 * cache — `<data>/cache/library/<key>.png` — and that file is the
 * canonical copy: it can be handed to the workspace byte for byte.
 *
 * @param {Object} item - the Zotero annotation item
 * @returns {Promise<String>} the path, or "" when there is no picture
 */
export async function annotationImagePath(item) {
	if (!item || !item.key) {
		return "";
	}
	const path = cacheImagePath(item.libraryID, item.key);
	if (!path) {
		return "";
	}
	try {
		// `IOUtils.exists` answers with a promise — a promise is always
		// truthy, so it has to be awaited or every path counts as there.
		return (await IOUtils.exists(path)) ? path : "";
	}
	catch (e) {
		return "";
	}
}

/**
 * The picture of an annotation, found by its key alone.
 *
 * Most annotations live in "My Library", and their picture is in a folder
 * that can be named without looking the item up at all — which matters,
 * because a lookup can fail while the picture is right there.
 *
 * @param {String} key - the annotation's key
 * @param {Number} libraryID - the library to look in
 * @returns {Promise<String>} the path, or "" when there is no picture
 */
export async function findPicture(key, libraryID) {
	const path = cacheImagePath(libraryID, key);
	if (!path) {
		return "";
	}
	try {
		return (await IOUtils.exists(path)) ? path : "";
	}
	catch (e) {
		return "";
	}
}

/**
 * The picture of an annotation, as a data URL.
 *
 * The reader hands the picture over that way — it is what the sidebar
 * draws. It is the fallback for the case where the cache file is not
 * there (a picture that came in with a sync, for instance).
 *
 * @param {Object} annotation - the reader's annotation model
 * @returns {String} the data URL, or ""
 */
export function annotationImageDataURL(annotation) {
	const image = annotation && annotation.image;
	return typeof image === "string" && image.startsWith("data:") ? image : "";
}
