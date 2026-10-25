/**
 * Zotero → SiYuan — the index of what has been sent.
 *
 * The mapping "this annotation went to that SiYuan block" is not stored in
 * the Zotero library: a tag would show up in the tag selector, travel to
 * the Zotero server and be visible to everybody who shares the library, and
 * it would still not be a link.
 *
 * Instead **SiYuan is the only place the mapping exists**. Every block the
 * plugin writes carries a Zotero deep link in its metadata, so the mapping
 * can be read back out of the workspace itself:
 *
 *   SELECT id, content FROM blocks WHERE content LIKE '%zotero://open/…%'
 *
 * The plugin scans that once at startup and keeps the result in memory.
 * Sending an annotation adds to the index right away, so the marker shows
 * up immediately.
 */

/** The deep link the plugin writes into the SiYuan block. */
export const ZOTERO_LINK_PREFIX = "zotero://open/library/items/";

/**
 * The annotation key inside a Zotero deep link.
 *
 * SiYuan rewrites `[text](zotero://open/library/items/KEY?annotation=ID&page=3)`
 * into `<span data-href="…">`, and escapes the `&` as `&` — so the key
 * has to be read out of the middle, not off the end.
 *
 * @param {String} content - the markdown of a block
 * @returns {String} the annotation key, or "" when there is none
 */
export function parseAnnotationKey(content) {
	const text = String(content || "");
	const at = text.indexOf("annotation=");
	if (at === -1) {
		return "";
	}
	const match = text.slice(at + "annotation=".length).match(/^[A-Za-z0-9]+/);
	return match ? match[0] : "";
}

/**
 * The deep link back to an annotation.
 *
 * @param {String} attachmentKey
 * @param {String} annotationKey
 * @param {Number} page
 * @returns {String}
 */
export function annotationDeepLink(attachmentKey, annotationKey, page) {
	const params = new URLSearchParams();
	params.set("annotation", annotationKey);
	if (page) {
		params.set("page", String(page));
	}
	return `${ZOTERO_LINK_PREFIX}${attachmentKey}?${params.toString()}`;
}

/**
 * Remove the tags an earlier version of the plugin left behind.
 *
 * The plugin used to mark a sent annotation with a `siyuan:<block id>` tag.
 * That polluted the tag selector and did not survive as a link, so the
 * mapping now lives in the workspace instead — but the old tags should not
 * stay in the library.
 *
 * @param {Object} annotation - a Zotero annotation item
 * @returns {Promise<Boolean>} whether anything was removed
 */
export async function clearLegacyTags(annotation) {
	if (!annotation) {
		return false;
	}
	let changed = false;
	for (const tag of annotation.getTags() || []) {
		const name = typeof tag === "string" ? tag : tag.tag || tag.name || "";
		if (name.startsWith("siyuan:")) {
			annotation.removeTag(name);
			changed = true;
		}
	}
	if (changed) {
		await annotation.saveTx();
	}
	return changed;
}

/**
 * The index of the annotations that have been sent.
 */
export class SiYuanIndex {
	constructor() {
		// annotation key → SiYuan block id
		this.blocks = new Map();
		this.scannedAt = "";
		this.blocksScanned = 0;
	}

	get size() {
		return this.blocks.size;
	}

	/**
	 * The SiYuan block an annotation went to, or "".
	 * @param {String} annotationKey
	 * @returns {String}
	 */
	get(annotationKey) {
		if (!annotationKey) {
			return "";
		}
		return this.blocks.get(String(annotationKey)) || "";
	}

	/**
	 * Remember that an annotation went to a block.
	 * @param {String} annotationKey
	 * @param {String} blockID
	 */
	add(annotationKey, blockID) {
		if (annotationKey && blockID) {
			this.blocks.set(String(annotationKey), String(blockID));
		}
	}

	/**
	 * Load the blocks of one PDF attachment.
	 *
	 * Scanning the whole workspace is slow once there are thousands of sent
	 * annotations, and a sidebar only ever needs its own PDF's — so the
	 * index is filled per attachment.
	 *
	 * @param {Object} cli - a SiYuanCLI
	 * @param {String} attachmentKey - the PDF's key
	 * @returns {Promise<Number>} how many blocks were found
	 */
	async refreshForAttachment(cli, attachmentKey) {
		if (!/^[A-Za-z0-9]+$/.test(String(attachmentKey))) {
			throw new Error(`"${attachmentKey}" is not an item key`);
		}
		const rows = await cli.runJSON([
			"sql",
			"SELECT id, markdown, type FROM blocks " +
				`WHERE markdown LIKE '%${ZOTERO_LINK_PREFIX}${attachmentKey}%' ` +
				"ORDER BY created DESC, CASE WHEN type = 'p' THEN 1 ELSE 0 END ASC",
		]);
		let added = 0;
		for (const row of rows || []) {
			const key = parseAnnotationKey(row.markdown);
			if (key && !this.blocks.has(key)) {
				this.blocks.set(key, row.id);
				added++;
			}
		}
		return added;
	}

	/**
	 * Rebuild the index from the workspace.
	 *
	 * @param {Object} cli - a SiYuanCLI
	 * @returns {Promise<Number>} how many annotations are known
	 */
	async refresh(cli) {
		const rows = await cli.runJSON([
			"sql",
			// The link lives in the *markdown* column: the plain-text
			// `content` column has it stripped, and SiYuan rewrites a
			// non-http link into <span data-href="…">.
			"SELECT id, markdown, type FROM blocks " +
				`WHERE markdown LIKE '%${ZOTERO_LINK_PREFIX}%' ` +
				// Newest first, so a re-sent annotation points at its latest
				// block; and a callout before the paragraph inside it, so
				// the link lands on the whole quote.
				"ORDER BY created DESC, CASE WHEN type = 'p' THEN 1 ELSE 0 END ASC",
		]);
		// Build the new index first: a failing query must not throw away
		// what is already known.
		const found = new Map();
		for (const row of rows || []) {
			const key = parseAnnotationKey(row.markdown);
			if (key && !found.has(key)) {
				found.set(key, row.id);
			}
		}
		this.blocks = found;
		this.blocksScanned = Array.isArray(rows) ? rows.length : 0;
		this.scannedAt = new Date().toISOString();
		return this.blocks.size;
	}
}