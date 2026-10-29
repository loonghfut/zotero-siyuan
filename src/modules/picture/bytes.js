/**
 * Zotero → SiYuan — what a picture is made of: its bytes, its type, and the
 * compression that makes a screenshot small enough to travel.
 *
 * Nothing here touches a file: the bytes come in, the bytes go out.
 */

import { getString } from "../../utils/locale.js";

/** The way a compressed picture is encoded. */
export const JPEG = "image/jpeg";

/** The file extension of a picture type. */
const EXTENSIONS = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"image/gif": "gif",
	"image/bmp": "bmp",
};

/**
 * The file extension of a picture type.
 * @param {String} type - a MIME type
 * @returns {String} the extension, `png` when the type is unknown
 */
export function extensionOf(type) {
	return EXTENSIONS[type] || "png";
}

/**
 * The bytes of a data URL.
 * @param {String} dataURL
 * @returns {Uint8Array}
 */
export function bytesOfDataURL(dataURL) {
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
 * The bytes of a picture as a base64 string.
 *
 * The string is built in pieces: `String.fromCharCode(...bytes)` on a
 * picture of a megabyte would blow the stack.
 *
 * @param {Uint8Array} bytes
 * @returns {String}
 */
export function base64Of(bytes) {
	const data = bytes && bytes.length ? bytes : new Uint8Array(0);
	let binary = "";
	const step = 0x8000;
	for (let i = 0; i < data.length; i += step) {
		binary += String.fromCharCode.apply(
			null,
			data.subarray(i, Math.min(i + step, data.length)),
		);
	}
	return btoa(binary);
}

/**
 * What kind of picture these bytes are.
 *
 * The answer decides the file name: writing JPEG bytes into a `.png` file
 * makes some renderers refuse the picture, and SiYuan shows what the
 * extension promises. The bytes are what is known, so they are read — a
 * data URL that says `image/jpeg` is believed as well, but never trusted
 * alone.
 *
 * @param {Uint8Array} bytes
 * @returns {String} a MIME type, or "" when it is not a known picture
 */
export function detectImageType(bytes) {
	if (!bytes || bytes.length < 4) {
		return "";
	}
	if (
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47
	) {
		return "image/png";
	}
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return JPEG;
	}
	if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return "image/webp";
	}
	if (
		bytes[0] === 0x47 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x38
	) {
		return "image/gif";
	}
	if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
		return "image/bmp";
	}
	return "";
}

/**
 * Zotero's main window — the one with a document in it.
 *
 * @returns {Object|null}
 */
function mainWindow() {
	try {
		if (typeof Zotero === "undefined" || !Zotero.getMainWindow) {
			return null;
		}
		return Zotero.getMainWindow();
	}
	catch (e) {
		return null;
	}
}

/**
 * The ways a picture can be compressed.
 *
 * Both do the same three things — decode the picture, draw it on a
 * canvas, read the canvas back — but they need different parts of the
 * platform. The first one needs no window at all; the second one works
 * with the window of Zotero.
 */
const STRATEGIES = [
	{
		name: "offscreen",
		available() {
			return (
				typeof Blob === "function" &&
				typeof createImageBitmap === "function" &&
				typeof OffscreenCanvas === "function"
			);
		},
		async decode(bytes, type) {
			const blob = new Blob([bytes], { type: type || "image/png" });
			return await createImageBitmap(blob);
		},
		makeCanvas(width, height) {
			return new OffscreenCanvas(width, height);
		},
		async encode(canvas, quality) {
			const blob = await canvas.convertToBlob({ type: JPEG, quality });
			return new Uint8Array(await blob.arrayBuffer());
		},
		close(picture) {
			if (picture && typeof picture.close === "function") {
				picture.close();
			}
		},
	},
	{
		name: "window",
		available() {
			const win = mainWindow();
			return !!(win && win.document && win.Image);
		},
		async decode(bytes, type) {
			const win = mainWindow();
			const picture = new win.Image();
			// A data URL needs no permission to be read — a file URL would.
			const url = `data:${type || "image/png"};base64,${base64Of(bytes)}`;
			await new Promise((resolve, reject) => {
				picture.onload = () => resolve();
				picture.onerror = () =>
					reject(
						new Error(
							getString(
								"zoteroSiYuan-error-picture-decode",
								"The picture could not be decoded.",
							),
						),
					);
				picture.src = url;
			});
			return picture;
		},
		makeCanvas(width, height) {
			const win = mainWindow();
			const canvas = win.document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			return canvas;
		},
		async encode(canvas, quality) {
			return bytesOfDataURL(canvas.toDataURL(JPEG, quality));
		},
		close() {
			// The window's picture needs nothing.
		},
	},
];

/**
 * Compress a picture.
 *
 * The picture of a "框选" annotation is a screenshot of the page: it
 * carries an alpha channel that is completely opaque, and with four
 * bytes per pixel it is several times as big as it needs to be. A JPEG
 * of the same picture is a fraction of the size — and the text in it
 * stays readable.
 *
 * Nothing is thrown when it does not work: a picture that cannot be
 * compressed is sent as it is. A note is better than no note.
 *
 * @param {Uint8Array} bytes - the picture
 * @param {Object} options
 * @param {Number} options.quality - the JPEG quality, 0…1
 * @returns {Promise<Object|null>} { bytes, type, width, height, way } —
 *   or null when the picture could not be compressed
 */
export async function compressImage(bytes, { quality = 0.82 } = {}) {
	if (!bytes || !bytes.length) {
		return null;
	}
	const q = Math.min(1, Math.max(0.05, Number(quality) || 0.82));
	const inputType = detectImageType(bytes) || "image/png";
	for (const strategy of STRATEGIES) {
		try {
			if (!strategy.available()) {
				continue;
			}
			const picture = await strategy.decode(bytes, inputType);
			const width = picture.width || picture.naturalWidth || 0;
			const height = picture.height || picture.naturalHeight || 0;
			if (!width || !height) {
				strategy.close(picture);
				continue;
			}
			const canvas = strategy.makeCanvas(width, height);
			const context = canvas.getContext("2d");
			// JPEG has no transparent colour, and the transparent parts of
			// the picture would turn black. The page behind the selection
			// is white — so white is what goes there.
			context.fillStyle = "#ffffff";
			context.fillRect(0, 0, width, height);
			context.drawImage(picture, 0, 0, width, height);
			const out = await strategy.encode(canvas, q);
			strategy.close(picture);
			if (!out || !out.length) {
				continue;
			}
			return {
				bytes: out,
				type: JPEG,
				width,
				height,
				// Which way it was done — the report says it.
				way: strategy.name,
			};
		}
		catch (e) {
			// The next way is tried.
		}
	}
	return null;
}

/**
 * Is the compressed picture worth using?
 *
 * A picture that is already small — or a format that came out bigger
 * than it went in — is left alone. The picture that is sent is always
 * the smaller of the two.
 *
 * @param {Number} originalSize
 * @param {Number} compressedSize
 * @returns {Boolean}
 */
export function compressionPays(originalSize, compressedSize) {
	return (
		Number.isFinite(originalSize) &&
		Number.isFinite(compressedSize) &&
		compressedSize > 0 &&
		compressedSize < originalSize
	);
}
