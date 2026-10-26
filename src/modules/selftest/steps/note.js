/**
 * Zotero → SiYuan — the steps that look at what a note is made of: the picture of
 * an area selection, the context menu, the notification bubble.
 *
 * Each function is one step of the self test. It takes the run's context and
 * answers with the detail the report shows; whether the step passed is
 * decided by `step()` in `../index.js`.
 */

import { showToast } from "../../toast.js";
import { waitForMainWindow } from "../fixtures.js";
import { sleep } from "../report.js";


export async function checkAreaSelectionBringsItsPicture(ctx) {
	const { addon, annotation, attachmentID, report, notePictures, real } = ctx;

	const probe = await addon.probePictures();
	report.pictures = probe;
	if (!probe.annotations.length) {
		// Nothing to test — that is not a failure.
		return {
			skipped: "the library has no area selection",
			cacheDir: probe.cacheDir,
		};
	}
	const first = probe.annotations[0];
	const picture = {
		key: first.key,
		type: first.type,
		path: first.path,
		cached: first.exists,
	};
	if (!first.exists) {
		// The picture is not where Zotero says it is. The note can
		// still be written, but the selection would be lost — so
		// this is worth saying out loud.
		throw new Error(
			`the picture of ${first.key} is not at ${first.path || "(no path)"}`,
		);
	}
	// The whole chain, with a real annotation.
	const model = {
		id: first.key,
		type: first.type,
		text: "",
		comment: "",
		pageLabel: "",
		authorName: "",
		position: null,
		tags: [],
	};
	const markdown = await addon._buildContent(model, {
		itemID: attachmentID,
	});
	notePictures(markdown);
	picture.markdown = markdown;
	// Every step of the chain — this is where a failure says what
	// went wrong.
	picture.trace = addon._lastPictureTrace || null;
	picture.linked = /!\[[^\]]*\]\(assets\/[^)]+\)/.test(markdown);
	if (!picture.linked) {
		const trace = picture.trace || {};
		throw new Error(
			"the note does not carry the picture — no Markdown link to it" +
				(trace.error ? ` (${trace.error})` : "") +
				` [picture=${trace.isPicture}, key=${trace.key}, ` +
				`cache=${trace.cached}, path=${trace.cachePath || "none"}, ` +
				`workspace=${trace.workspace || "none"}, ` +
				`exported=${trace.exported || "none"}]`,
		);
	}

	// The picture is compressed before it is sent. A picture of a
	// megabyte that goes out uncompressed means the compression
	// does not work — and the workspace fills up.
	const trace = picture.trace || {};
	picture.compressed = !!trace.compressed;
	picture.originalSize = trace.originalSize || 0;
	picture.sentSize = trace.sentSize || 0;
	picture.saved = picture.originalSize - picture.sentSize;
	const compressionWanted =
		String(addon.getPref("imageCompress", "1")) !== "0";
	if (
		compressionWanted &&
		!picture.compressed &&
		picture.originalSize > 100000
	) {
		throw new Error(
			`the picture was not compressed — ${picture.originalSize} bytes went out as they were`,
		);
	}
	return picture;
}

export async function checkAnnotationContextMenuOffersABatchSend(ctx) {
	const { addon, attachmentID } = ctx;

	const items = [];
	addon._onCreateAnnotationContextMenu({
		reader: { itemID: attachmentID },
		params: { ids: ["AAAA1111", "BBBB2222"] },
		append(item) {
			items.push(item);
		},
	});
	return {
		count: items.length,
		label: items[0] ? items[0].label : "",
		hasCommand: !!(items[0] && items[0].onCommand),
	};
}

export async function checkNotificationBubbleAppears(ctx) {
	// no state of its own

	// The bubble lives in the main window, which may not exist yet
	// right after startup.
	await waitForMainWindow();
	const diag = {
		getMainWindow: (() => {
			try {
				return !!Zotero.getMainWindow();
			}
			catch (e) {
				return `error: ${e.message}`;
			}
		})(),
		anyWindow: (() => {
			try {
				return !!Services.wm.getMostRecentWindow(null);
			}
			catch (e) {
				return `error: ${e.message}`;
			}
		})(),
		mainWindowCount: (() => {
			try {
				return Services.wm.getEnumerator("navigator:browser")
					.hasMoreElements();
			}
			catch (e) {
				return `error: ${e.message}`;
			}
		})(),
	};
	const toast = showToast({
		title: "Zotero to SiYuan",
		message: "self test",
		timeout: 50,
	});
	if (!toast) {
		throw new Error(
			`the bubble could not be shown: ${JSON.stringify(diag)}`,
		);
	}
	const element = toast.element;
	const attached = !!element.parentNode;
	toast.close();
	await sleep(400);
	return { ...diag, attached, removed: !element.parentNode };
}
