/**
 * Zotero → SiYuan — how a sent block is wrapped and what it carries.
 *
 * A Zotero deep link in the Markdown used to be the only thing the index
 * could find a sent annotation by. That made the index depend on the
 * template: a template that never wrote `{{zoteroAnnotationLink}}` produced
 * a note that was invisible to the next scan.
 *
 * Every send is now one **super block** (`{{{row … }}}`), and the
 * annotation's custom attributes are written on that container as a block
 * IAL (`{: custom-x="y"}`) after the closing marker. One send is therefore
 * one block: the index points at it, the reader link opens it, and a
 * replacement deletes it — there is no "which of these blocks belongs to
 * that note" question left to answer.
 *
 * The wrapper and the IAL go in the same `block append` that writes the
 * note — no second process, no HTTP call, no `attr set`.
 */

/** The annotation this block came from. */
export const ANNOTATION_KEY_ATTR = "custom-zotero-annotation-key";

/** The Zotero item the annotation belongs to. */
export const ITEM_KEY_ATTR = "custom-zotero-item-key";

/** The PDF attachment the annotation lives on. */
export const ATTACHMENT_KEY_ATTR = "custom-zotero-attachment-key";

/**
 * The Zotero library an item belongs to.
 *
 * Zotero keys are unique inside a library, not across libraries: a group
 * library and "My Library" can both hold `ABCD1234`. Every attribute that
 * identifies an item therefore has to be read together with this one.
 */
export const LIBRARY_ID_ATTR = "custom-zotero-library-id";

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

/**
 * The template a block was rendered with, as a short fingerprint.
 *
 * A literature-note sync skips an annotation whose text has not changed —
 * but when the template changes, every note has to be rendered again, and
 * the annotation's own timestamp cannot say that. The fingerprint can.
 */
export const TEMPLATE_ATTR = "custom-zsi-template";

/** The sections an item-level send can write on its own. */
export const ITEM_SECTION_INFO = "info";
export const ITEM_SECTION_ABSTRACT = "abstract";
export const ITEM_SECTION_NOTES = "notes";
export const ITEM_SECTION_ANNOTATIONS = "annotations";

/** The one container a literature-note sync writes. */
export const ITEM_SECTION_DOCUMENT = "item";

/** A child note that became a document of its own, under the item's document. */
export const ITEM_SECTION_NOTE_DOCUMENT = "note-document";

/**
 * The item a literature-note block belongs to.
 *
 * Kept as its own attribute name (not `custom-zotero-item-key`) because
 * that one is already the stamp of the item's document and the attribute of
 * every annotation note.
 */
export const SECTION_ITEM_ATTR = "custom-zsi-item-key";

/**
 * The Zotero note a "note document" came from.
 *
 * The item key says which literature note the sub-document belongs to, but a
 * note can be renamed or edited — its key is what stays. It is written on the
 * sub-document and on the block inside it, so a later sync finds both again.
 */
export const NOTE_KEY_ATTR = "custom-zotero-note-key";

/** The super-block fence SiYuan's Markdown parser understands. */
export const SUPER_BLOCK_OPEN = "{{{row";
export const SUPER_BLOCK_CLOSE = "}}}";

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
		[LIBRARY_ID_ATTR]: vars.libraryID ? String(vars.libraryID) : "",
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
 * @returns {{annotationKey: String, itemKey: String, attachmentKey: String,
 *   libraryID: Number}}
 */
export function annotationAttributesFromIAL(ial) {
	const attrs = parseAttributes(ial);
	return {
		annotationKey: attrs[ANNOTATION_KEY_ATTR] || "",
		itemKey: attrs[ITEM_KEY_ATTR] || "",
		attachmentKey: attrs[ATTACHMENT_KEY_ATTR] || "",
		libraryID: Number(attrs[LIBRARY_ID_ATTR]) || 0,
	};
}

/**
 * Wrap a rendered note in one super block.
 *
 * `block append` answers with the first block it created, and the index and
 * the "open in SiYuan" link point at that block. Wrapping the whole note
 * makes "the first block" and "the note" the same thing, so nothing has to
 * guess where the note ends.
 *
 * Nested super blocks are legal, so a template that already contains one is
 * not a special case — it simply becomes a child of this one.
 *
 * @param {String} markdown
 * @returns {String} the wrapped Markdown, or "" when there is nothing to wrap
 */
export function wrapSuperBlock(markdown) {
	const text = String(markdown == null ? "" : markdown)
		.replace(/^\s+/, "")
		.replace(/\s+$/, "");
	if (!text) {
		return "";
	}
	return `${SUPER_BLOCK_OPEN}\n\n${text}\n\n${SUPER_BLOCK_CLOSE}`;
}

/**
 * Wrap a rendered note and put its attributes on the container.
 *
 * The IAL has to follow the closing marker: SiYuan attaches an attribute
 * line to the last closed block, which is the super block. Writing it after
 * the last *child* instead would mark that child, not the note.
 *
 * @param {String} markdown
 * @param {Object} [attrs] - from `annotationAttributes`, `itemDocumentAttributes`
 * @returns {String}
 */
export function markBlock(markdown, attrs) {
	const wrapped = wrapSuperBlock(markdown);
	if (!wrapped) {
		return "";
	}
	const line = attributeLine(attrs);
	return line ? `${wrapped}\n${line}` : wrapped;
}

/**
 * The attributes of one section an item-level send writes on its own.
 *
 * These blocks are *not* marked with `custom-zsi-item-key`: that attribute
 * belongs to the literature-note container, so a solo section can be found
 * by its own name without being one of the sync's blocks. A sync takes
 * them over (`_soloItemSectionBlocks`) — they describe the same item, and
 * two copies of the details in one document is not what a sync should
 * leave behind.
 *
 * @param {String} section - `info`, `abstract`, `notes`, …
 * @param {String} itemKey
 * @param {Number} [libraryID]
 * @returns {Object}
 */
export function itemSectionAttributes(section, itemKey = "", libraryID = 0) {
	return {
		[SECTION_ATTR]: section || "",
		[ITEM_KEY_ATTR]: itemKey || "",
		[LIBRARY_ID_ATTR]: libraryID ? String(libraryID) : "",
	};
}

/**
 * The attributes of the block one item-document sync writes.
 *
 * The whole sync — information, abstract and child notes — is one super
 * block, so a second sync replaces it as a unit: one block to find, one
 * block to delete, and the user's own text and the annotation notes are
 * never part of it.
 *
 * @param {String} itemKey
 * @param {Number} [libraryID]
 * @returns {Object}
 */
export function itemDocumentAttributes(itemKey = "", libraryID = 0) {
	return {
		[SECTION_ATTR]: ITEM_SECTION_DOCUMENT,
		[SECTION_ITEM_ATTR]: itemKey || "",
		[LIBRARY_ID_ATTR]: libraryID ? String(libraryID) : "",
	};
}

/**
 * The attributes of one child note written as a document of its own.
 *
 * These are written on the **document** *and* on the one super block inside
 * it: the document is found by its own IAL, the block is what a changed note
 * rewrites in place. `custom-zotero-note-key` is the note's Zotero key — the
 * one thing about it that does not change when its title does.
 *
 * `custom-zotero-item-key` is deliberately **not** among them: that
 * attribute identifies the literature-note document itself, and a sub-note
 * carrying it would be mistaken for its parent by `_findItemDocument`.
 *
 * @param {String} itemKey - the literature item
 * @param {Number} libraryID
 * @param {String} noteKey - the Zotero note
 * @param {String} [modified] - the note's `dateModified`
 * @param {String} [template] - the notes template's fingerprint
 * @returns {Object}
 */
export function noteDocumentAttributes(
	itemKey = "",
	libraryID = 0,
	noteKey = "",
	modified = "",
	template = "",
) {
	return {
		[SECTION_ATTR]: ITEM_SECTION_NOTE_DOCUMENT,
		[SECTION_ITEM_ATTR]: itemKey || "",
		[LIBRARY_ID_ATTR]: libraryID ? String(libraryID) : "",
		[NOTE_KEY_ATTR]: noteKey || "",
		[MODIFIED_ATTR]: modified || "",
		[TEMPLATE_ATTR]: template || "",
	};
}
