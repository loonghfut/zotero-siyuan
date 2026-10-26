/**
 * Zotero → SiYuan — what the self test needs from the library: a PDF, an
 * annotation, and a main window that is really there.
 */

import { log, sleep } from "./report.js";
import { toastTarget } from "../toast.js";


export async function findPDFAttachment() {
	try {
		const rows = await Zotero.DB.queryAsync(
			"SELECT itemID FROM itemAttachments " +
			"WHERE contentType = 'application/pdf' " +
			"AND itemID NOT IN (SELECT itemID FROM deletedItems) " +
			"ORDER BY itemID DESC LIMIT 1",
		);
		if (rows && rows.length) {
			return rows[0].itemID;
		}
	}
	catch (e) {
		log(`could not query the database for a PDF: ${e}`);
	}

	try {
		const ids = await Zotero.Items.getAll(
			Zotero.Libraries.userLibraryID,
			false,
			true,
		);
		for (const id of ids) {
			const item = await Zotero.Items.getAsync(id);
			if (item && item.isPDFAttachment && item.isPDFAttachment()) {
				return id;
			}
		}
	}
	catch (e) {
		log(`could not look for a PDF attachment: ${e}`);
	}

	return 0;
}

/**
 * A real annotation of the library, as the reader would hand it over.
 *
 * The self test needs a real one when it writes for real: only a real
 * annotation can be tagged, and only a real annotation proves that the tag
 * lands on the right item.
 *
 * @param {Number} attachmentID
 * @returns {Promise<Object|null>}
 */
export async function findRealAnnotation() {
	try {
		const rows = await Zotero.DB.queryAsync(
			"SELECT itemID FROM itemAnnotations " +
				"WHERE itemID NOT IN (SELECT itemID FROM deletedItems) " +
				"ORDER BY itemID DESC LIMIT 10",
		);
		for (const row of rows || []) {
			const item = await Zotero.Items.getAsync(row.itemID);
			if (!item || !item.parentItemID) {
				continue;
			}
			const attachment = await Zotero.Items.getAsync(item.parentItemID);
			if (!attachment) {
				continue;
			}
			let position = null;
			try {
				position = item.annotationPosition
					? JSON.parse(item.annotationPosition)
					: null;
			}
			catch (e) {
				position = null;
			}
			return {
				item,
				attachmentID: item.parentItemID,
				annotation: {
					id: item.key,
					type: item.annotationType || "highlight",
					text: item.annotationText || "",
					comment: item.annotationComment || "",
					pageLabel: item.annotationPageLabel || "",
					authorName: item.annotationAuthorName || "",
					position,
					tags: (item.getTags() || []).map((t) => ({ name: t.tag })),
				},
			};
		}
	}
	catch (e) {
		log(`could not find a real annotation: ${e}`);
	}
	return null;
}

/** The main window, once it exists. */
export async function waitForMainWindow(timeout = 15000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		try {
			if (toastTarget()) {
				return true;
			}
		}
		catch (e) {
			// not there yet
		}
		await sleep(200);
	}
	return false;
}

/**
 * The preferences pane, really opened and really used.
 *
 * The pane lives in Zotero's own preferences window, so the only honest
 * test is to open that window, click a variable and see whether the
 * template changed. It is part of the deep self test only — the window
 * would pop up on every start otherwise.
 *
 * @param {Object} addon - the plugin instance
 * @returns {Promise<Object>}
 */
