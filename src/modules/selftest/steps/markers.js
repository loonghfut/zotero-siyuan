/**
 * Zotero → SiYuan — the steps that only need a document they build themselves:/n * markers, the link back, the icon, the protocol handler.
 *
 * Each function is one step of the self test. It takes the run's context and
 * answers with the detail the report shows; whether the step passed is
 * decided by `step()` in `../index.js`.
 */

import {
	findHandlerExecutable,
	protocolHandlerCommand,
	suppressProtocolWarning,
} from "../../siyuan-launcher.js";


export async function checkSentAnnotationRendersTheLinkBack(ctx) {
	const { addon, win, annotation, attachmentID, real, doc } = ctx;

	const sentDoc = win.document.implementation.createHTMLDocument(
		"zotero-siyuan-selftest-sent",
	);
	// Put a known annotation into the index, the way a real send
	// would, and see whether the reader offers a way back.
	addon._index.add("SELFTESTSENT", "20260101000000-abcdefg");
	addon._onRenderSidebarAnnotationHeader({
		doc: sentDoc,
		params: {
			type: "SidebarAnnotationHeader",
			annotation: {
				...annotation,
				id: "SELFTESTSENT",
				tags: [],
			},
		},
		reader: { itemID: attachmentID },
		append(node) {
			sentDoc.body.appendChild(node);
		},
	});
	const link = sentDoc.body.querySelector(".zotero-siyuan-sent-link");
	addon._index.remove("SELFTESTSENT");
	return {
		rendered: !!link,
		href: link ? link.getAttribute("href") : "",
		title: link ? link.getAttribute("aria-label") : "",
		hasIcon: !!(link && link.querySelector("svg")),
	};
}

export async function checkMarkerAppearsWithoutReopeningThePDF(ctx) {
	const { addon, win, annotation } = ctx;

	const doc = win.document.implementation.createHTMLDocument(
		"zotero-siyuan-selftest-instant",
	);
	const button = doc.createElement("button");
	button.setAttribute("data-zsi-annotation", "SELFKEY1");
	doc.body.appendChild(button);
	addon._index.add("SELFKEY1", "20260101000000-abcdefg");
	const added = addon._updateRenderedMarkers(doc);
	const link = doc.body.querySelector(".zotero-siyuan-sent-link");
	const again = addon._updateRenderedMarkers(doc);
	addon._index.remove("SELFKEY1");
	return {
		added,
		again,
		rendered: !!link,
		href: link ? link.getAttribute("href") : "",
	};
}

export async function checkMarkerNeverAppearsTwice(ctx) {
	const { addon, win, annotation, attachmentID, button } = ctx;

	const doc = win.document.implementation.createHTMLDocument(
		"zotero-siyuan-selftest-double",
	);
	const key = "SELFKEY2";
	addon._index.add(key, "20260101000000-abcdefg");

	// The reader's sidebar puts everything a plugin appends into a
	// box of its own, wipes that box on every render, and gives
	// every single append() call a box of its own inside it. That
	// is what the reader really does — see its custom-sections
	// component — and it is why the button and the marker have to
	// be appended together.
	const box = doc.createElement("div");
	box.className = "custom-sections";
	doc.body.appendChild(box);
	const render = () => {
		box.replaceChildren();
		addon._onRenderSidebarAnnotationHeader({
			doc,
			params: {
				type: "SidebarAnnotationHeader",
				annotation: { ...annotation, id: key, tags: [] },
			},
			reader: { itemID: attachmentID },
			append(...nodes) {
				const section = doc.createElement("div");
				section.className = "section";
				section.append(...nodes);
				box.appendChild(section);
			},
		});
	};
	const count = () =>
		doc.body.querySelectorAll(".zotero-siyuan-sent-link").length;

	render();
	const afterFirst = count();

	// The hand-made marker, as it appears right after a send.
	addon._updateRenderedMarkers(doc);
	const afterManual = count();

	// The reader re-renders the header.
	render();
	const afterRerender = count();

	// And once more, to be sure it settles.
	render();
	const afterThird = count();

	// The reader must not put the button and the marker into two
	// different boxes — that is what made the sidebar show two
	// markers in the first place.
	const boxes = box.children.length;

	addon._index.remove(key);
	return {
		afterFirst,
		afterManual,
		afterRerender,
		afterThird,
		boxes,
	};
}

export async function checkBatchSendShowsTheMarkersRightAway(ctx) {
	const { addon, win, annotation, attachmentID } = ctx;

	const doc = win.document.implementation.createHTMLDocument(
		"zotero-siyuan-selftest-batch",
	);
	const key = "SELFKEY3";
	const reader = { itemID: attachmentID };

	const box = doc.createElement("div");
	box.className = "custom-sections";
	doc.body.appendChild(box);
	const render = () => {
		box.replaceChildren();
		addon._onRenderSidebarAnnotationHeader({
			doc,
			params: {
				type: "SidebarAnnotationHeader",
				annotation: { ...annotation, id: key, tags: [] },
			},
			reader,
			append(...nodes) {
				const section = doc.createElement("div");
				section.className = "section";
				section.append(...nodes);
				box.appendChild(section);
			},
		});
	};

	// The annotation is not in the index yet, so the reader has no
	// marker to show.
	render();
	const before = doc.body.querySelectorAll(".zotero-siyuan-sent-link")
		.length;

	// The context menu has to find the reader's document on its
	// own — the event does not carry it.
	const items = [];
	addon._onCreateAnnotationContextMenu({
		reader,
		params: { ids: [key] },
		append(item) {
			items.push(item);
		},
	});
	const known = !!addon._readerDoc(reader);

	// The send puts the annotation into the index, and then the
	// marker has to be on screen without reloading the PDF.
	addon._index.add(key, "20260101000000-batchg");
	addon._updateRenderedMarkers(doc);
	const afterSend = doc.body.querySelectorAll(
		".zotero-siyuan-sent-link",
	).length;

	// And the reader's own render must not add a second one.
	render();
	const afterRerender = doc.body.querySelectorAll(
		".zotero-siyuan-sent-link",
	).length;

	addon._index.remove(key);
	return {
		before,
		afterSend,
		afterRerender,
		known,
		menuItems: items.length,
	};
}

export async function checkMarkerOpensTheBlockWhenClicked(ctx) {
	const { addon, win } = ctx;

	const doc = win.document.implementation.createHTMLDocument(
		"zotero-siyuan-selftest-click",
	);
	addon._ensureDelegation(doc);
	const link = addon._createSentLink(doc, "20260101000000-abcdefg");
	doc.body.appendChild(link);

	let opened = "";
	const original = addon._openInSiYuan.bind(addon);
	addon._openInSiYuan = (id) => {
		opened = id;
	};
	const event = doc.createEvent("MouseEvents");
	event.initEvent("click", true, true);
	link.dispatchEvent(event);
	addon._openInSiYuan = original;
	return { opened };
}

export async function checkSiYuanAppCanBeOpenedWithoutAPrompt(ctx) {
	// no state of its own

	const executable = await findHandlerExecutable();
	return {
		fromRegistry: protocolHandlerCommand(),
		executable,
		found: !!executable,
		warningSuppressed: suppressProtocolWarning(),
	};
}

export async function checkSiYuanIconIsInlineSVG(ctx) {
	const { addon, win } = ctx;

	const doc = win.document.implementation.createHTMLDocument(
		"zotero-siyuan-selftest-icon",
	);
	const link = addon._createSentLink(doc, "20260101000000-abcdefg");
	const svg = link.querySelector("svg");
	const polygons = svg ? svg.querySelectorAll("polygon") : [];
	return {
		rendered: !!svg,
		namespace: svg ? svg.namespaceURI : "",
		shapes: polygons.length,
		viewBox: svg ? svg.getAttribute("viewBox") : "",
		fills: [...polygons].map((p) => p.getAttribute("fill")),
	};
}
