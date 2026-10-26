/**
 * Zotero → SiYuan — metadata collection.
 *
 * Turns an annotation — and the item it belongs to — into the flat set of
 * values the send template is rendered with. Every value is a plain string,
 * so the template engine stays trivial.
 */

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

/** Prefix every line with "> " so the text becomes a callout body. */
export function toCalloutBody(text) {
	return String(text == null ? "" : text)
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

/** A link that opens the item in Zotero. */
export function itemLink(itemKey) {
	return itemKey ? `zotero://select/library/items/${itemKey}` : "";
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
	return `zotero://open/library/items/${attachmentKey}?${params.toString()}`;
}

/** A link that opens a block in the SiYuan desktop app. */
export function siyuanBlockLink(blockID) {
	return blockID ? `siyuan://blocks/${blockID}` : "";
}

/** Tag names, whether they arrive as strings or as objects. */
function tagNames(tags) {
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
		lines.push(`作者：${vars.authors}`);
	}
	if (vars.year) {
		lines.push(`年份：${vars.year}`);
	}
	if (vars.publication) {
		lines.push(`出处：${vars.publication}`);
	}
	if (vars.page) {
		lines.push(`页码：${vars.page}`);
	}
	if (vars.annotator) {
		lines.push(`批注人：${vars.annotator}`);
	}
	if (vars.itemKey) {
		lines.push(
			`来源：[${vars.titleInline}](${vars.zoteroAnnotationLink})`,
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
 * @param {Object} options.extra - { date, time, timestamp }
 * @returns {Object} the variables
 */
export function collectMetadata({
	annotation = {},
	parentItem = null,
	attachment = null,
	annotationKey = "",
	extra = {},
}) {
	const quote = String(annotation.text || "").trim();
	const comment = String(annotation.comment || "").trim();
	const title = field(parentItem, "title");
	const itemKey = parentItem ? parentItem.key || "" : "";
	const attachmentKey = attachment ? attachment.key || "" : "";
	const page = annotation.pageLabel || "";
	const annotator = annotation.authorName || "";
	const authors = getCreatorList(parentItem);

	const vars = {
		// --- the annotation -------------------------------------------
		quote,
		quoteCallout: toCalloutBody(quote),
		quoteInline: escapeInline(quote),
		comment,
		commentCallout: toCalloutBody(comment),
		commentInline: escapeInline(comment),
		page,
		pageNumber: pageNumberOf(annotation),
		annotator,
		annotatorDate: annotation.dateModified || "",
		annotationType: annotation.type || "",
		annotationId: annotationKey || annotation.id || "",
		annotationTags: tagNames(annotation.tags).join(", "),

		// --- the item --------------------------------------------------
		title,
		titleInline: escapeInline(title),
		authors,
		author: authors ? authors.split("、")[0] : "",
		year: getYear(parentItem),
		publication: field(parentItem, "publicationTitle"),
		volume: field(parentItem, "volume"),
		issue: field(parentItem, "issue"),
		pages: field(parentItem, "pages"),
		doi: field(parentItem, "DOI"),
		isbn: field(parentItem, "ISBN"),
		url: field(parentItem, "url"),
		abstract: field(parentItem, "abstractNote"),
		itemType: itemTypeName(parentItem),
		tags: parentItem ? tagNames(parentItem.getTags()).join(", ") : "",
		itemKey,
		attachmentKey,

		// --- when ------------------------------------------------------
		date: extra.date || "",
		time: extra.time || "",
		timestamp: extra.timestamp || "",
	};

	vars.zoteroLink = itemLink(itemKey);
	vars.zoteroAnnotationLink = annotationLink({
		attachmentKey,
		annotationKey,
		page: vars.pageNumber,
		fallback: vars.zoteroLink,
	});
	vars.metadata = buildMetadataBlock(vars);

	return vars;
}
