/**
 * Zotero → SiYuan — the attributes a written block carries.
 *
 * A Zotero deep link in the Markdown used to be the only thing the index
 * could find a sent annotation by. That made the index depend on the
 * template: a template that never wrote `{{zoteroAnnotationLink}}` produced
 * a note that was invisible to the next scan.
 *
 * Every note now carries custom attributes as well. SiYuan's Markdown
 * parser keeps a block IAL (`{: custom-x="y"}`), so the attributes are
 * written in the same `block append` that writes the note — no second
 * process, no HTTP call. The index can read them back out of the `ial`
 * column, and the user can query or filter by them inside SiYuan.
 */

/** The annotation this block came from. */
export const ANNOTATION_KEY_ATTR = "custom-zotero-annotation-key";

/** The Zotero item the annotation belongs to. */
export const ITEM_KEY_ATTR = "custom-zotero-item-key";

/** The PDF attachment the annotation lives on. */
export const ATTACHMENT_KEY_ATTR = "custom-zotero-attachment-key";

/** The annotation's colour, as the hex value Zotero stores. */
export const COLOR_ATTR = "custom-zotero-color";

/** The page the annotation is on. */
export const PAGE_ATTR = "custom-zotero-page";

/** The annotation's own tags. */
export const TAGS_ATTR = "custom-zotero-tags";

/** When the annotation was last changed in Zotero. */
export const MODIFIED_ATTR = "custom-zotero-modified";

/** Which part of a literature note a block belongs to. */
export const SECTION_ATTR = "custom-zsi-section";

/** The item a literature-note section belongs to. */
export const SECTION_ITEM_ATTR = "custom-zsi-item-key";

/**
 * Make a value safe to sit between the quotes of an IAL.
 *
 * SiYuan does not read a backslash as an escape here: a quote inside the
 * value ends the attribute, and the rest of the line is silently lost. The
 * values this module writes are keys, colours, page numbers and tags —
 * dropping the quote (and a backslash, which would look like an escape) is
 * better than writing an IAL that the parser truncates.
 *
 * @param {*} value
 * @returns {String}
 */
export function attributeValueText(value) {
	return String(value == null ? "" : value)
		.replace(/["\\]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * One block IAL line for a set of attributes.
 *
 * Empty values are left out: an attribute with no value would only make the
 * note look as if it knew something it does not.
 *
 * @param {Object} attrs - name → value
 * @returns {String} the IAL line, or "" when nothing is left
 */
export function attributeLine(attrs) {
	const pairs = [];
	for (const [name, value] of Object.entries(attrs || {})) {
		if (!/^[A-Za-z0-9_-]+$/.test(name)) {
			continue;
		}
		const text = attributeValueText(value);
		if (text) {
			pairs.push(`${name}="${text}"`);
		}
	}
	return pairs.length ? `{: ${pairs.join(" ")}}` : "";
}

/**
 * Read every attribute out of an IAL string.
 *
 * SiYuan stores the block's IAL as `{: id="…" updated="…" custom-x="…"}`.
 * Values are taken as they are between quotes — that is the same rule the
 * parser applies, so a value written by `attributeLine` comes back intact.
 *
 * @param {String} ial
 * @returns {Object} name → value
 */
export function parseAttributes(ial) {
	const attrs = {};
	const text = String(ial || "");
	const pattern = /([A-Za-z0-9_-]+)="([^"]*)"/g;
	let match;
	while ((match = pattern.exec(text))) {
		attrs[match[1]] = match[2];
	}
	return attrs;
}

/**
 * One attribute out of an IAL string.
 *
 * @param {String} ial
 * @param {String} name
 * @returns {String}
 */
export function attributeValue(ial, name) {
	return parseAttributes(ial)[String(name || "")] || "";
}

/**
 * The attributes of an annotation note, from the template variables.
 *
 * @param {Object} vars - from `collectMetadata`
 * @returns {Object} name → value
 */
export function annotationAttributes(vars = {}) {
	return {
		[ANNOTATION_KEY_ATTR]: vars.annotationId || "",
		[ITEM_KEY_ATTR]: vars.itemKey || "",
		[ATTACHMENT_KEY_ATTR]: vars.attachmentKey || "",
		[COLOR_ATTR]: vars.annotationColor || "",
		[PAGE_ATTR]: vars.pageNumber ? String(vars.pageNumber) : "",
		[TAGS_ATTR]: vars.annotationTags || "",
		[MODIFIED_ATTR]: vars.annotationModified || "",
	};
}

/**
 * The annotation facts the index reads back from an IAL.
 *
 * @param {String} ial
 * @returns {{annotationKey: String, itemKey: String, attachmentKey: String}}
 */
export function annotationAttributesFromIAL(ial) {
	const attrs = parseAttributes(ial);
	return {
		annotationKey: attrs[ANNOTATION_KEY_ATTR] || "",
		itemKey: attrs[ITEM_KEY_ATTR] || "",
		attachmentKey: attrs[ATTACHMENT_KEY_ATTR] || "",
	};
}

/**
 * Put an IAL line after the first block of a note.
 *
 * `block append` answers with the first block it created — that is the block
 * the "open in SiYuan" link and the index point at, so that is the block the
 * attributes have to describe. The first block ends at the first blank line
 * outside a fenced code block; a callout's own blank line is written as
 * `>`, so it does not count.
 *
 * A note with no blank line is one block: the line goes at its end. A note
 * that starts with a heading gets the line directly under the heading,
 * because SiYuan treats the heading as a block of its own even when the next
 * line follows without a blank one.
 *
 * @param {String} markdown
 * @param {String} line - an IAL line from `attributeLine`
 * @returns {String}
 */
export function insertAfterFirstBlock(markdown, line) {
	const text = String(markdown == null ? "" : markdown);
	const attrs = String(line || "").trim();
	if (!attrs) {
		return text;
	}
	const lines = text.split("\n");
	let first = 0;
	while (first < lines.length && !lines[first].trim()) {
		first++;
	}
	if (first >= lines.length) {
		return attrs;
	}
	// A heading is a block on its own, even without a blank line after it.
	if (/^#{1,6}\s/.test(lines[first])) {
		lines.splice(first + 1, 0, attrs);
		return lines.join("\n");
	}
	let fence = "";
	for (let i = first; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		const fenceMatch = trimmed.match(/^(```+|~~~+)/);
		if (fenceMatch) {
			if (!fence) {
				fence = fenceMatch[1][0];
			}
			else if (fenceMatch[1][0] === fence) {
				fence = "";
			}
			continue;
		}
		if (fence) {
			continue;
		}
		if (trimmed === "") {
			lines.splice(i, 0, attrs);
			return lines.join("\n");
		}
	}
	return `${text.replace(/\s+$/, "")}\n${attrs}`;
}

/**
 * Put the annotation attributes into a rendered note.
 *
 * @param {String} markdown
 * @param {Object} attrs - from `annotationAttributes`
 * @returns {String}
 */
export function insertAttributes(markdown, attrs) {
	const line = attributeLine(attrs);
	return line ? insertAfterFirstBlock(markdown, line) : String(markdown || "");
}

/**
 * The attributes of one section of a literature-note document.
 *
 * @param {String} section - "info" | "abstract" | "notes"
 * @param {String} itemKey
 * @returns {Object}
 */
export function sectionAttributes(section, itemKey = "") {
	return {
		[SECTION_ATTR]: section || "",
		[SECTION_ITEM_ATTR]: itemKey || "",
	};
}

/**
 * Mark a section block with the item it belongs to.
 *
 * Each section is a callout, so the IAL line goes directly under it. The
 * sync reads these blocks back by attribute and replaces exactly them —
 * never the user's own blocks, and never the annotation notes.
 *
 * @param {String} markdown - one section (one callout)
 * @param {String} section
 * @param {String} itemKey
 * @returns {String}
 */
export function withSection(markdown, section, itemKey = "") {
	const text = String(markdown || "").replace(/\s+$/, "");
	if (!text) {
		return "";
	}
	const line = attributeLine(sectionAttributes(section, itemKey));
	return line ? `${text}\n${line}` : text;
}
