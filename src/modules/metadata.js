/**
 * Zotero → SiYuan — metadata collection.
 *
 * Turns an annotation — and the item it belongs to — into the flat set of
 * values the send template is rendered with. Every value is a plain string,
 * so the template engine stays trivial.
 */

import { getString } from "../utils/locale.js";

/**
 * The label of one metadata line, in the language of the interface.
 *
 * The separator that follows it is part of the interface too: a Chinese
 * label takes the full-width colon, everything else the ASCII one.
 *
 * @param {String} name - the key after `label-`
 * @param {String} fallback
 * @returns {String}
 */
function metaLabel(name, fallback) {
	const label = getString(`zoteroSiYuan-label-${name}`, fallback);
	const separator = /[\u3400-\u9fff]/.test(label) ? "：" : ": ";
	return `${label}${separator}`;
}

/**
 * Escape the characters that would otherwise be interpreted as Markdown
 * structure inside a paragraph.
 *
 * The square brackets matter as much as the rest: the title is put into a
 * Markdown link, and a bracket in the title would end the link's text
 * early — so `[A [weird] (title)]` has to become `[A \[weird\] (title)]`.
 */
export function escapeInline(text) {
	return String(text == null ? "" : text)
		.replace(/\\/g, "\\\\")
		.replace(/([*_`[\]])/g, "\\$1")
		.replace(/^(\s*)([-+>])(\s)/gm, "$1\\$2$3")
		.replace(/^(\s*)(\d+)\.(\s)/gm, "$1$2\\.$3");
}

/**
 * Prefix every line with "> " so the text becomes a callout body.
 *
 * Nothing in, nothing out: an empty text would otherwise become a lone
 * ">", and that is a quote with nothing in it — a line that takes up
 * room in the note without saying anything.
 */
export function toCalloutBody(text) {
	const value = String(text == null ? "" : text);
	if (value.trim() === "") {
		return "";
	}
	return value
		.split("\n")
		.map((line) => (line.trim() ? "> " + line : ">"))
		.join("\n");
}

/** The four-digit year of an item's date field. */
export function getYear(item) {
	if (!item) {
		return "";
	}
	const date = item.getField("date") || "";
	const match = String(date).match(/(\d{4})/);
	return match ? match[1] : "";
}

/** Every creator of an item, joined with "、". */
export function getCreatorList(item) {
	if (!item) {
		return "";
	}
	let creators = null;
	try {
		// CSL JSON gives correctly ordered names and puts CJK names into
		// `literal`, which is what we want for a personal note.
		const csl = Zotero.Utilities.Item.itemToCSLJSON(item);
		if (csl) {
			creators = []
				.concat(csl.author || [])
				.concat(csl.editor || [])
				.concat(csl.translator || []);
		}
	}
	catch (e) {
		creators = null;
	}
	if (!creators || !creators.length) {
		creators = (item.getCreators() || []).map((creator) =>
			creator.fieldMode === 1
				? { literal: creator.name }
				: { given: creator.firstName, family: creator.lastName },
		);
	}
	return creators
		.map((creator) =>
			creator.literal
				? creator.literal
				: [creator.given, creator.family].filter(Boolean).join(" "),
		)
		.filter(Boolean)
		.join("、");
}

/**
 * The library segment of a Zotero deep link.
 *
 * Zotero has one URL shape for "My Library" and another one for a group —
 * `zotero://open/groups/<id>/items/KEY`. Writing the personal one for a
 * group item does not fail loudly: Zotero looks the key up in the user's
 * own library, finds nothing, and the link just does not go anywhere.
 *
 * @param {Number} libraryID
 * @returns {String} "library", or "groups/<id>"
 */
export function libraryPath(libraryID) {
	const id = Number(libraryID) || 0;
	let userLibraryID = 1;
	try {
		userLibraryID = Zotero.Libraries.userLibraryID;
	}
	catch (e) {
		// Not reachable in every scope — 1 is the user library in Zotero.
	}
	return !id || id === userLibraryID ? "library" : `groups/${id}`;
}

/** A link that opens the item in Zotero. */
export function itemLink(itemKey, libraryID = 0) {
	return itemKey
		? `zotero://select/${libraryPath(libraryID)}/items/${itemKey}`
		: "";
}

/**
 * A link that opens the PDF in the reader, scrolled to the annotation.
 *
 * Zotero's protocol handler reads `annotation` — the annotation's *key*, not
 * its numeric id — and `page` (1-based) from the query string, see
 * `chrome/content/zotero/xpcom/fileHandlers.js`.
 */
export function annotationLink({
	attachmentKey,
	annotationKey,
	page,
	libraryID = 0,
	fallback = "",
}) {
	if (!attachmentKey || !annotationKey) {
		return fallback;
	}
	const params = new URLSearchParams();
	params.set("annotation", annotationKey);
	if (page) {
		params.set("page", String(page));
	}
	return (
		`zotero://open/${libraryPath(libraryID)}/items/${attachmentKey}` +
		`?${params.toString()}`
	);
}

/** A link that opens a block in the SiYuan desktop app. */
export function siyuanBlockLink(blockID) {
	return blockID ? `siyuan://blocks/${blockID}` : "";
}

/**
 * A Zotero timestamp, as something a note can show.
 *
 * Zotero stores dates as SQL strings in **UTC** ("2026-10-26 03:12:00"), so
 * showing one as it is would put a time in the note that the user never saw
 * on their clock. It is converted to local time, and to minutes: a note does
 * not need seconds.
 *
 * @param {String} value
 * @returns {String}
 */
function readableStamp(value) {
	const text = String(value || "").trim();
	if (!text) {
		return "";
	}
	try {
		const date = Zotero.Date.sqlToDate(text, true);
		if (!date || Number.isNaN(date.getTime())) {
			return text;
		}
		const pad = (n) => String(n).padStart(2, "0");
		return (
			`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
			` ${pad(date.getHours())}:${pad(date.getMinutes())}`
		);
	}
	catch (e) {
		// Not a date this Zotero can read — the raw value is still better
		// than nothing.
		return text;
	}
}

/** Tag names, whether they arrive as strings or as objects. */function tagNames(tags) {
	if (!tags || !tags.length) {
		return [];
	}
	return tags
		.map((tag) => {
			if (typeof tag === "string") {
				return tag;
			}
			if (!tag) {
				return "";
			}
			return tag.name || tag.tag || "";
		})
		.filter(Boolean);
}

/** The page an annotation is on, as a number. */
function pageNumberOf(annotation) {
	const position = annotation.position;
	if (position && typeof position.pageIndex === "number") {
		return position.pageIndex + 1;
	}
	const match = String(annotation.pageLabel || "").match(/\d+/);
	return match ? Number(match[0]) : 0;
}

function field(item, name) {
	if (!item) {
		return "";
	}
	try {
		return item.getField(name) || "";
	}
	catch (e) {
		return "";
	}
}

function itemTypeName(item) {
	if (!item) {
		return "";
	}
	try {
		return Zotero.ItemTypes.getName(item.itemTypeID) || "";
	}
	catch (e) {
		return "";
	}
}

/**
 * The metadata block the default template appends: one field per line,
 * with the source as a link back to Zotero.
 */
function buildMetadataBlock(vars) {
	const lines = [];
	if (vars.authors) {
		lines.push(metaLabel("author", "作者") + vars.authors);
	}
	if (vars.year) {
		lines.push(metaLabel("year", "年份") + vars.year);
	}
	if (vars.publication) {
		lines.push(metaLabel("publication", "出处") + vars.publication);
	}
	if (vars.page) {
		lines.push(metaLabel("page", "页码") + vars.page);
	}
	if (vars.annotator) {
		lines.push(metaLabel("annotator", "批注人") + vars.annotator);
	}
	if (vars.zoteroAnnotationLink) {
		lines.push(
			metaLabel("source", "来源") +
				`[${vars.titleInline}](${vars.zoteroAnnotationLink})`,
		);
	}
	return lines.join("  \n");
}

/**
 * Collect everything the template can use.
 *
 * @param {Object} options
 * @param {Object} options.annotation - the reader's annotation model
 * @param {Object} options.parentItem - the item the annotation belongs to
 * @param {Object} options.attachment - the PDF attachment, if any
 * @param {String} options.annotationKey - the annotation's key
 * @param {String} options.image - the Markdown of the picture, for an
 *   annotation whose content is a picture (an area selection)
 * @param {Object} options.extra - { date, time, timestamp }
 * @param {String} options.annotationDate - the annotation's last modified
 *   time, when the item behind it had to be asked for it
 * @returns {Object} the variables
 */
export function collectMetadata({
	annotation = {},
	parentItem = null,
	attachment = null,
	annotationKey = "",
	image = "",
	extra = {},
	annotationDate = "",
}) {
	const quote = String(annotation.text || "").trim();
	const comment = String(annotation.comment || "").trim();
	// A PDF that stands on its own — dropped into the library, never
	// attached to an item — has no parent to take a title from. Falling
	// back to the attachment keeps the note identifiable, and it keeps the
	// link the plugin needs to find the note again after a restart.
	const source = parentItem || attachment || null;
	const title = field(source, "title");
	const itemKey = source ? source.key || "" : "";
	const attachmentKey = attachment ? attachment.key || "" : "";
	// Which library the item lives in — a group library needs a different
	// deep link than "My Library", or the link leads nowhere.
	const libraryID = Number(
		(attachment && attachment.libraryID) ||
			(source && source.libraryID) ||
			0,
	);
	const page = annotation.pageLabel || "";
	const annotator = annotation.authorName || "";
	const authors = getCreatorList(parentItem);

	// The picture of an area selection. It has a variable of its own, and
	// the send puts it in even when the template does not mention it — the
	// selection IS the content of a "框选" annotation, so it must not get
	// lost just because the template never heard of it.
	const picture = String(image || "").trim();

	const vars = {
		// --- the annotation -------------------------------------------
		quote,
		// Only the text. The picture is not repeated here: a template that
		// asks for both `{{imageCallout}}` and `{{quoteCallout}}` would
		// show the picture twice.
		quoteCallout: quote ? toCalloutBody(quote) : "",
		quoteInline: escapeInline(quote),
		comment,
		commentCallout: toCalloutBody(comment),
		commentInline: escapeInline(comment),
		page,
		pageNumber: pageNumberOf(annotation),
		annotator,
		// The reader's annotation JSON carries no date at all, so the value
		// comes from the item — see `_buildContent`.
		annotatorDate: readableStamp(annotation.dateModified || annotationDate),
		annotationType: annotation.type || "",
		annotationId: annotationKey || annotation.id || "",
		annotationTags: tagNames(annotation.tags).join(", "),
		// The values below are not template variables; they are what the
		// block attributes are written from. Keeping them here means the
		// reader's model and a Zotero item (automatic sends, retries) both
		// answer the same way.
		annotationColor: String(annotation.color || ""),
		annotationModified: String(annotation.dateModified || annotationDate || ""),

		// --- the picture ----------------------------------------------
		image: picture,
		imageCallout: picture ? toCalloutBody(picture) : "",

		// --- the item --------------------------------------------------
		title,
		titleInline: escapeInline(title),
		authors,
		author: authors ? authors.split("、")[0] : "",
		year: getYear(source),
		publication: field(source, "publicationTitle"),
		volume: field(source, "volume"),
		issue: field(source, "issue"),
		pages: field(source, "pages"),
		doi: field(source, "DOI"),
		isbn: field(source, "ISBN"),
		url: field(source, "url"),
		abstract: field(source, "abstractNote"),
		itemType: itemTypeName(source),
		tags: source ? tagNames(source.getTags()).join(", ") : "",
		itemKey,
		attachmentKey,
		libraryID,

		// --- when ------------------------------------------------------
		date: extra.date || "",
		time: extra.time || "",
		timestamp: extra.timestamp || "",
	};

	vars.zoteroLink = itemLink(itemKey, libraryID);
	vars.zoteroAnnotationLink = annotationLink({
		attachmentKey,
		annotationKey,
		page: vars.pageNumber,
		libraryID,
		fallback: vars.zoteroLink,
	});
	vars.metadata = buildMetadataBlock(vars);

	return vars;
}
