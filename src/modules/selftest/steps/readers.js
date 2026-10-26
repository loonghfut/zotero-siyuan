/**
 * Zotero → SiYuan — the steps that look at the real reader — including the one that
 * clicks a real button in a real sidebar.
 *
 * Each function is one step of the self test. It takes the run's context and
 * answers with the detail the report shows; whether the step passed is
 * decided by `step()` in `../index.js`.
 */

import { sleep } from "../report.js";


export async function checkEveryOpenReaderShowsTheButton(ctx) {
	const { addon, annotation, button } = ctx;

	// A reader that was restored when Zotero started may have drawn
	// its sidebar before this plugin was awake — say what is on
	// screen, and what the plugin can do about it.
	const readers = (Zotero.Reader._readers || []).filter(
		(r) => r && r.itemID,
	);
	const rows = () =>
		readers.map((r) => {
			const known = addon._readerDocs.get(r);
			const d = known || addon._readerDoc(r);
			return {
				itemID: r.itemID,
				known: !!known,
				reachable: !!d,
				boxes: d ? d.querySelectorAll(".custom-sections").length : 0,
				buttons: d
					? d.querySelectorAll(".zotero-siyuan-annotation-button").length
					: 0,
				markers: d
					? d.querySelectorAll(".zotero-siyuan-sent-link").length
					: 0,
			};
		});
	const before = rows();
	await addon._patchReaderSidebars();
	return { readers: readers.length, before, after: rows() };
}

export async function checkReaderThatWasDrawnWithoutThePluginGetsTheButton(ctx) {
	const { addon, win, annotation } = ctx;

	// A reader that was restored when Zotero started draws its
	// sidebar before the plugins are up — the reader's own event
	// never arrives, so the button has to be put in by hand.
	const doc = win.document.implementation.createHTMLDocument(
		"zotero-siyuan-selftest-patch",
	);
	const key = await addon._resolveAnnotationKey(annotation);

	// The reader's own markup: the page label of the annotation
	// sits next to its header, and the header has a box of its own.
	const preview = doc.createElement("div");
	preview.className = "preview";
	const header = doc.createElement("header");
	const page = doc.createElement("div");
	page.id = `page_${key}`;
	const box = doc.createElement("div");
	box.className = "custom-sections";
	header.appendChild(page);
	header.appendChild(box);
	preview.appendChild(header);
	doc.body.appendChild(preview);

	const reader = { itemID: 1, _iframeWindow: { document: doc } };
	const before = doc.querySelectorAll(".zotero-siyuan-annotation-button")
		.length;
	const result = await addon._patchReaderSidebars([reader]);
	const after = doc.querySelectorAll(".zotero-siyuan-annotation-button")
		.length;
	const button = doc.querySelector(".zotero-siyuan-annotation-button");
	// And a second time must not add a second button.
	await addon._patchReaderSidebars([reader]);
	const again = doc.querySelectorAll(".zotero-siyuan-annotation-button")
		.length;

	return {
		before,
		after,
		again,
		patched: result.patched,
		key: button ? button.getAttribute("data-zsi-annotation") : "",
	};
}

export async function checkRealReaderShowsOneMarkerPerAnnotation(ctx) {
	const { addon, annotation, captured, clickAndWatch, cli, real, ui } = ctx;

	// Everything above runs in a synthetic document. Only the real
	// reader can show whether the markers behave.
	//
	// This step clicks a real button in a real sidebar, so it runs
	// only when the user asked for the test (the preferences
	// button) — not on every Zotero start. A test that touches the
	// reader uninvited is a test people learn to hate.
	if (!ui) {
		return { skipped: "not requested" };
	}

	// Any reader that is showing its annotations will do — the
	// reader does not draw them until the PDF is ready, and the
	// section of the sidebar can be folded away.
	let doc = null;
	let reader = null;
	let drawn = 0;
	const deadline = Date.now() + 45000;
	while (Date.now() < deadline && !drawn) {
		for (const r of Zotero.Reader._readers || []) {
			if (!r || !r.itemID) {
				continue;
			}
			const d = addon._readerDoc(r);
			if (!d || !d.querySelectorAll) {
				continue;
			}
			// Only the boxes of the annotations count — the reader
			// has boxes of its own, too.
			const n = [...d.querySelectorAll(".custom-sections")].filter(
				(b) => !!addon._annotationKeyOf(b),
			).length;
			if (n > drawn) {
				doc = d;
				reader = r;
				drawn = n;
			}
		}
		if (!drawn) {
			await sleep(500);
		}
	}
	if (!doc || !drawn) {
		// The reader did not show its annotations — that has nothing
		// to do with this plugin.
		return { drawn: 0, note: "no reader showed its annotations" };
	}
	await sleep(2000);

	// Every annotation header gets a box of the reader's own, and
	// the button and its marker have to share that box — otherwise
	// the sidebar shows the marker twice.
	const buttons = [...doc.querySelectorAll(".zotero-siyuan-annotation-button")];
	const boxes = buttons.map((b) => ({
		key: b.getAttribute("data-zsi-annotation"),
		markers: b.parentNode
			? b.parentNode.querySelectorAll(".zotero-siyuan-sent-link").length
			: 0,
	}));
	const split = boxes.filter((b) => b.markers > 1).length;

	// Count what is on screen before anything is sent.
	const before = doc.querySelectorAll(".zotero-siyuan-sent-link").length;

	// Send one annotation for real, through the reader's own button,
	// and watch the marker appear.
	//
	// This send is the reader's own, so the bookkeeping of the main
	// flow is put back afterwards — otherwise the two sends would
	// mix up each other's results.
	const capturedBefore = { ...captured };
	ctx.resetClick();
	const button = doc.querySelector(".zotero-siyuan-annotation-button");
	const key = button.getAttribute("data-zsi-annotation");
	// What the index knew about this annotation before the test —
	// it may be a block the user sent themselves, and that one must
	// survive the cleanup below.
	const previousBlock = addon._index.get(key);
	clickAndWatch(button);

	// Wait for the send to finish — the plugin says so itself.
	const sendDeadline = Date.now() + 30000;
	while (Date.now() < sendDeadline && addon._sending) {
		await sleep(200);
	}
	await sleep(500);

	const links = [...doc.querySelectorAll(".zotero-siyuan-sent-link")];
	const forKey = links.filter(
		(link) => link.getAttribute("data-zsi-for") === key,
	).length;
	// The marker right next to the button.
	const nextToButton = button.parentNode
		? button.parentNode.querySelectorAll(".zotero-siyuan-sent-link").length
		: 0;

	// What is on screen, key by key.
	const byKey = {};
	for (const link of links) {
		const k = link.getAttribute("data-zsi-for") || "?";
		byKey[k] = byKey[k] || { total: 0, manual: 0, boxes: new Set() };
		byKey[k].total++;
		if (link.getAttribute("data-zsi-manual")) {
			byKey[k].manual++;
		}
		const box = link.closest ? link.closest(".custom-sections") : null;
		byKey[k].boxes.add(
			box
				? [...doc.querySelectorAll(".custom-sections")].indexOf(box)
				: -1,
		);
	}
	const buttonsByKey = {};
	for (const b of doc.querySelectorAll("[data-zsi-annotation]")) {
		const k = b.getAttribute("data-zsi-annotation") || "?";
		buttonsByKey[k] = (buttonsByKey[k] || 0) + 1;
	}
	// Where every box of the reader sits — the same annotation can
	// show up more than once.
	const allBoxes = [...doc.querySelectorAll(".custom-sections")].map(
		(box, i) => {
			const chain = [];
			let node = box;
			for (let d = 0; d < 5 && node; d++) {
				chain.push(node.className || node.id || node.tagName);
				node = node.parentNode;
			}
			return {
				i,
				key: addon._annotationKeyOf(box),
				buttons: box.querySelectorAll(".zotero-siyuan-annotation-button")
					.length,
				chain,
			};
		},
	);
	const detail = {};
	for (const k of Object.keys(byKey)) {
		detail[k] = {
			total: byKey[k].total,
			manual: byKey[k].manual,
			boxes: [...byKey[k].boxes],
			buttons: buttonsByKey[k] || 0,
		};
	}

	// Leave nothing behind — but only what this test wrote itself.
	// A block the user sent for this annotation is not ours to
	// delete, and the index has to point back at it.
	//
	// All of them, not just the first: a template turns one send
	// into a callout, a comment and a metadata paragraph, and the
	// rest of them would stay in the user's daily note. When the
	// transport could not tell which blocks were new, only the one
	// it named is removed: guessing would delete the user's note.
	const ownBlocks = (
		captured.blocksExact && captured.blocks && captured.blocks.length
			? captured.blocks
			: captured.blockID
				? [captured.blockID]
				: []
	).filter(Boolean);
	const removed = [];
	const failures = [];
	for (const block of ownBlocks) {
		try {
			await cli.deleteBlock(block);
			removed.push(block);
		}
		catch (e) {
			failures.push(`${block}: ${e.message}`);
		}
	}
	if (failures.length) {
		throw new Error(
			`could not remove the test block(s): ${failures.join("; ")}`,
		);
	}
	if (removed.length) {
		const leftovers = await cli.findExistingBlocks(removed);
		if (leftovers.length) {
			throw new Error(
				`the test block(s) are still in the daily note: ${leftovers.join(", ")}`,
			);
		}
	}
	if (previousBlock) {
		addon._index.add(key, previousBlock);
	}
	else {
		addon._index.remove(key);
	}

	// The marker on screen still points at the block that was just
	// deleted. Take it away, then let the index put the right one
	// back — a marker to a block that is gone is a dead link the
	// user would click.
	for (const link of doc.querySelectorAll(".zotero-siyuan-sent-link")) {
		if (link.getAttribute("data-zsi-for") === key) {
			link.remove();
		}
	}
	addon._updateRenderedMarkers(doc);

	// Give the main flow its own bookkeeping back.
	Object.assign(captured, capturedBefore);
	ctx.resetClick();

	return {
		reader: reader.itemID,
		buttons: buttons.length,
		split,
		before,
		after: links.length,
		forKey,
		nextToButton,
		manual: doc.querySelectorAll("[data-zsi-manual]").length,
		detail,
		allBoxes,
		blockID: removed[0] || "",
		removedBlocks: removed,
	};
}
