/**
 * Zotero → SiYuan — the picture of an area selection.
 *
 * A "框选" annotation — the box that was dragged over a part of the page —
 * has no text at all: what the user selected is kept as a **picture**.
 * Zotero stores it in its cache, and the note has to carry the picture
 * itself, or the selection is simply lost.
 *
 * The picture goes into the SiYuan workspace's `data/assets` folder, and
 * the Markdown refers to it the way SiYuan does it:
 *
 *     ![框选](assets/zotero-siyuan-ABCD1234-20261026130000.png)
 *
 * The kernel picks that up on its own: it registers the file in its own
 * asset list and links it to the block that refers to it. (Verified with
 * `siyuan dailynote append` — no separate upload step is needed.)
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

/**
 * The bytes of a data URL.
 * @param {String} dataURL
 * @returns {Uint8Array}
 */
function bytesOfDataURL(dataURL) {
	const comma = dataURL.indexOf(",");
	const base64 = comma === -1 ? "" : dataURL.slice(comma + 1);
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

/**
 * The folder of the workspace's assets.
 * @param {String} workspaceDir
 * @returns {String}
 */
export function assetsDir(workspaceDir) {
	return PathUtils.join(workspaceDir, "data", "assets");
}

/**
 * Where a picture really is on disk.
 *
 * The parts are appended one by one: `PathUtils.join` goes through
 * nsIFile, and nsIFile does not take a component that holds a
 * separator — "assets/name.png" is not a name.
 *
 * @param {String} workspaceDir - the SiYuan workspace
 * @param {String} assetPath - e.g. `assets/zotero-siyuan-ABCD1234.png`
 * @returns {String} the absolute path
 */
export function pictureFile(workspaceDir, assetPath) {
	const parts = String(assetPath || "")
		.split(/[\\/]/)
		.filter(Boolean);
	if (!parts.length) {
		return "";
	}
	return PathUtils.join(assetsDir(workspaceDir), parts[parts.length - 1]);
}

/**
 * Put a picture into the workspace's assets.
 *
 * @param {String} workspaceDir - the SiYuan workspace
 * @param {Object} source - { path } or { dataURL }
 * @param {String} name - the file name, without the extension
 * @returns {Promise<Object>} { asset, file } — the path the Markdown
 *   refers to (`assets/zotero-siyuan-ABCD1234.png`) and where the file
 *   really is
 */
export async function exportPicture(workspaceDir, source, name) {
	if (!workspaceDir || !source) {
		return { asset: "", file: "" };
	}
	const dir = assetsDir(workspaceDir);
	// Said out loud rather than left to the default: the assets folder
	// usually exists already, and this must not be an error.
	await IOUtils.makeDirectory(dir, {
		createAncestors: true,
		ignoreExisting: true,
	});
	const fileName = `${name}.png`;
	const target = PathUtils.join(dir, fileName);

	if (source.path) {
		// A byte-for-byte copy — the picture must not be touched. The
		// plugin sandbox has IOUtils but not the older OS.* helpers.
		// `IOUtils.write` takes the path itself; there is no
		// `IOUtils.newFile`.
		const bytes = await IOUtils.read(source.path);
		await IOUtils.write(target, bytes);
	}
	else if (source.dataURL) {
		await IOUtils.write(target, bytesOfDataURL(source.dataURL));
	}
	else {
		return { asset: "", file: "" };
	}
	return { asset: `assets/${fileName}`, file: target };
}

/**
 * The Markdown that shows a picture.
 *
 * @param {String} assetPath - e.g. `assets/zotero-siyuan-ABCD1234.png`
 * @param {String} alt - the text a screen reader gets
 * @returns {String}
 */
export function pictureMarkdown(assetPath, alt) {
	if (!assetPath) {
		return "";
	}
	return `![${alt || ""}](${assetPath})`;
}

/**
 * Take a picture back out of the workspace.
 *
 * A send that never happens — a dry run, a failed write — must not leave
 * the picture behind: the workspace belongs to the user, and a pile of
 * pictures nobody refers to is litter.
 *
 * @param {String} path - the absolute path of the file
 */
export async function removePicture(path) {
	if (!path) {
		return;
	}
	try {
		await IOUtils.remove(path, { ignoreAbsent: true });
	}
	catch (e) {
		// The file is gone, or it is not ours to remove. Either way there
		// is nothing left to do.
	}
}

/**
 * The pictures a piece of Markdown refers to.
 *
 * The names are the file names inside the workspace's assets folder — the
 * self test uses this to take back the pictures it caused to be written.
 *
 * @param {String} markdown
 * @returns {String[]}
 */
export function pictureAssetNames(markdown) {
	const names = [];
	const text = String(markdown || "");
	for (const match of text.matchAll(/!\[[^\]]*\]\(assets\/([^)\s]+)\)/g)) {
		if (!names.includes(match[1])) {
			names.push(match[1]);
		}
	}
	return names;
}

/**
 * A file name for a picture that is unique but still readable.
 *
 * @param {String} annotationKey - the annotation's key
 * @returns {String}
 */
export function pictureName(annotationKey) {
	const stamp = new Date()
		.toISOString()
		.replace(/[-:T]/g, "")
		.slice(0, 14);
	const key = String(annotationKey || "annotation").replace(/[^\w-]/g, "");
	return `zotero-siyuan-${key}-${stamp}`;
}
