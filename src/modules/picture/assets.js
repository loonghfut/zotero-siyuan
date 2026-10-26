/**
 * Zotero → SiYuan — a picture on its way into the workspace, and the way
 * back out again.
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

import {
	bytesOfDataURL,
	compressImage,
	compressionPays,
	detectImageType,
	extensionOf,
	JPEG,
} from "./bytes.js";

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
 * The pictures that may be taken back.
 *
 * A picture that was in the folder before is not ours, and a picture that
 * a note refers to belongs to that note — neither of them may go. What is
 * left showed up on its own and is referred to by nobody: litter.
 *
 * The decision is kept here, apart from the file system, so it can be
 * tried out without a workspace.
 *
 * @param {Set<String>} before - the pictures the folder held before
 * @param {Set<String>} after - the pictures it holds now
 * @param {Set<String>} referenced - the pictures a note refers to
 * @returns {String[]} the names that may go
 */
export function strayPictureNames(before, after, referenced) {
	const names = [];
	if (!before || !after || !referenced) {
		// Without the reading from before it cannot be told what is new,
		// and without the reading of the notes it cannot be told what
		// belongs to a note. Nothing is taken back then.
		return names;
	}
	for (const name of after) {
		if (!before.has(name) && !referenced.has(name)) {
			names.push(name);
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

/**
 * The compressed form of a picture that was compressed before.
 *
 * Sending the same selection again — the user clicked twice, or sent it in
 * a batch after sending it once — used to decode and re-encode the whole
 * screenshot, which is the most expensive step of a send by far. The bytes
 * do not change between two sends, so the answer is kept.
 *
 * The cache is keyed by the bytes themselves (a hash of them, plus their
 * length and the quality), never by the annotation: a picture that Zotero
 * re-cropped has different bytes and must not hit the entry of the old one.
 */
const MEMO = new Map();
const MEMO_MAX_ENTRIES = 12;
const MEMO_MAX_BYTES = 32 * 1024 * 1024;
let memoBytes = 0;

/**
 * A short fingerprint of the bytes and the quality.
 *
 * Two independent accumulators, one forwards and one walking backwards in
 * strides: a collision would hand the user the wrong picture, so the key
 * is more than a single 32-bit hash.
 *
 * @param {Uint8Array} bytes
 * @param {Number} quality
 * @returns {String}
 */
function memoKey(bytes, quality) {
	let forward = 0x811c9dc5;
	for (let i = 0; i < bytes.length; i++) {
		forward ^= bytes[i];
		forward = Math.imul(forward, 0x01000193);
	}
	let backward = 0x9e3779b9;
	for (let i = bytes.length - 1; i >= 0; i -= 7) {
		backward ^= bytes[i];
		backward = Math.imul(backward, 0x85ebca6b);
	}
	return (
		`${bytes.length}:` +
		`${(forward >>> 0).toString(36)}:` +
		`${(backward >>> 0).toString(36)}:` +
		`${quality}`
	);
}

/**
 * File a compressed picture, forgetting the oldest ones when it grows.
 *
 * @param {String} key
 * @param {Object} value - { bytes, type, width, height, way }
 */
function remember(key, value) {
	if (MEMO.has(key)) {
		return;
	}
	MEMO.set(key, value);
	memoBytes += value.bytes.length;
	while (MEMO.size > MEMO_MAX_ENTRIES || memoBytes > MEMO_MAX_BYTES) {
		const oldest = MEMO.keys().next();
		if (oldest.done) {
			break;
		}
		const dropped = MEMO.get(oldest.value);
		MEMO.delete(oldest.value);
		memoBytes -= (dropped && dropped.bytes.length) || 0;
	}
}

/**
 * How many pictures are remembered — the self test reports it.
 * @returns {Number}
 */
export function memoizedPictures() {
	return MEMO.size;
}

/** Forget every remembered picture — a shutdown keeps nothing alive. */
export function forgetPictures() {
	MEMO.clear();
	memoBytes = 0;
}

/**
 * Put a picture into the workspace's assets.
 *
 * The picture is compressed first: a screenshot of a page is several
 * times as big as it needs to be, and the note only needs the picture,
 * not the megabytes behind it. The original is kept when the compressed
 * one is not smaller.
 *
 * @param {String} workspaceDir - the SiYuan workspace
 * @param {Object} source - { path } or { dataURL }
 * @param {String} name - the file name, without the extension
 * @param {Object} options
 * @param {Boolean} options.compress - false to send the picture as it is
 * @param {Number} options.quality - the JPEG quality, 0…1
 * @param {Function} options.compressor - the compression itself, for tests
 * @param {Boolean} options.memo - use the remembered answer even when a
 *   compressor of one's own is given (for the checks)
 * @returns {Promise<Object>} { asset, file, compressed, size } — the path
 *   the Markdown refers to (`assets/zotero-siyuan-ABCD1234.jpg`) and where
 *   the file really is
 */
export async function exportPicture(workspaceDir, source, name, options = {}) {
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

	let bytes = null;
	if (source.path) {
		// A byte-for-byte copy — the picture must not be touched. The
		// plugin sandbox has IOUtils but not the older OS.* helpers.
		// `IOUtils.write` takes the path itself; there is no
		// `IOUtils.newFile`.
		bytes = await IOUtils.read(source.path);
	}
	else if (source.dataURL) {
		bytes = bytesOfDataURL(source.dataURL);
	}
	if (!bytes || !bytes.length) {
		return { asset: "", file: "" };
	}

	// Compress it — but only when that makes it smaller.
	const originalSize = bytes.length;
	// What the picture really is decides the file name. A JPEG copied into
	// a `.png` file is a picture some renderers refuse to show.
	let type = detectImageType(bytes) || "image/png";
	let way = "";
	let remembered = false;
	const quality = options.quality === undefined ? 0.82 : options.quality;
	// A test brings its own compressor; its answer belongs to that test and
	// must not be filed under the real picture's bytes — unless the test
	// asks for the cache, which is the only way to look at it without a
	// canvas.
	const shared = options.compressor === undefined || options.memo === true;
	const compressor = options.compress === false
		? null
		: options.compressor || compressImage;
	if (compressor) {
		const key = shared ? memoKey(bytes, Number(quality) || 0.82) : "";
		const known = key ? MEMO.get(key) : null;
		if (known) {
			remembered = true;
			way = known.way || "";
			if (compressionPays(bytes.length, known.bytes.length)) {
				bytes = known.bytes;
				type = known.type || JPEG;
			}
		}
		else {
			const smaller = await compressor(bytes, { quality });
			if (smaller && smaller.bytes && smaller.bytes.length) {
				if (key) {
					remember(key, smaller);
				}
				if (compressionPays(bytes.length, smaller.bytes.length)) {
					bytes = smaller.bytes;
					type = smaller.type || JPEG;
					way = smaller.way || "";
				}
			}
		}
	}

	const fileName = `${name}.${extensionOf(type)}`;
	const target = PathUtils.join(dir, fileName);
	await IOUtils.write(target, bytes);

	return {
		asset: `assets/${fileName}`,
		file: target,
		type,
		compressed: type === JPEG,
		size: bytes.length,
		originalSize,
		way,
		// Whether the answer came out of the cache — the trace says it.
		memoized: remembered,
	};
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
