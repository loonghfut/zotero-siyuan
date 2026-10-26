/**
 * Zotero → SiYuan — the picture of an area selection.
 *
 * A "框选" annotation has no text: what the user selected is kept as a
 * picture, and the note has to carry it, or the selection is lost. The
 * work is split by concern, and this file is the one the rest of the
 * plugin imports — moving a function between the parts below is not a
 * change to any caller.
 *
 *   annotation.js — where Zotero keeps the picture of an annotation
 *   bytes.js      — what the picture is: its type, and the compression
 *   assets.js     — putting it into the workspace, and taking it back
 */

export {
	annotationImageDataURL,
	annotationImagePath,
	cacheImagePath,
	findPicture,
	isPictureAnnotation,
} from "./picture/annotation.js";

export {
	base64Of,
	bytesOfDataURL,
	compressImage,
	compressionPays,
	detectImageType,
	extensionOf,
	JPEG,
} from "./picture/bytes.js";

export {
	assetsDir,
	exportPicture,
	forgetPictures,
	memoizedPictures,
	pictureAssetNames,
	pictureFile,
	pictureMarkdown,
	pictureName,
	removePicture,
	strayPictureNames,
} from "./picture/assets.js";
