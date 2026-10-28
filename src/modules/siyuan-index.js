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
 * How a deep link of a group library looks.
 *
 * Zotero needs the group id in the path: the same key in a group library is
 * a different item, and a link without it opens nothing.
 */
const GROUP_LINK_PREFIX = "zotero://open/groups/";

/**
 * A deep link to an annotation, in either library shape.
 * @type {RegExp}
 */
const LINK_PATTERN =
	/zotero:\/\/open\/(?:library|groups\/\d+)\/items\/([A-Za-z0-9]+)/;

/**
 * The SQL `LIKE` that finds a deep link, whichever library it names.
 *
 * A `LIKE` on the personal prefix alone made a note sent from a group
 * library invisible to the index — the marker never came back after a
 * restart, and the note looked unsent.
 */
export const ZOTERO_LINK_LIKE = "'%zotero://open/%/items/%'";

/**
 * How long a scan is trusted, in milliseconds.
 *
 * The workspace is the only place the mapping exists, so it changes behind
 * this plugin's back — the user edits a note, another machine syncs one in.
 * Five minutes is short enough that such a note shows up while the user is
 * still reading, and long enough that opening ten PDFs is still one scan.
 */
export const INDEX_TTL_MS = 300000;

/**
 * The PDF a deep link points at.
 *
 * @param {String} content - the markdown of a block
 * @returns {String} the attachment key, or "" when there is none
 */
export function parseAttachmentKey(content) {
	const match = String(content || "").match(LINK_PATTERN);
	return match ? match[1] : "";
}

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
 * @param {Number} [libraryID] - the group library, 0 or 1 for "My Library"
 * @returns {String}
 */
export function annotationDeepLink(
	attachmentKey,
	annotationKey,
	page,
	libraryID = 0,
) {
	const params = new URLSearchParams();
	params.set("annotation", annotationKey);
	if (page) {
		params.set("page", String(page));
	}
	const group = Number(libraryID);
	const prefix = group > 1
		? `${GROUP_LINK_PREFIX}${group}/items/`
		: ZOTERO_LINK_PREFIX;
	return `${prefix}${attachmentKey}?${params.toString()}`;
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
	/**
	 * @param {Object} [options]
	 * @param {Function} [options.onChange] - told about every change, so the
	 *   local cache can follow the index without the index knowing about it
	 */
	constructor({ onChange = null } = {}) {
		this._onChange = typeof onChange === "function" ? onChange : null;
		// annotation key → SiYuan block id
		this.blocks = new Map();
		// What is known about a sent note beyond its first block: the
		// document it lives in, every block the send produced, and the
		// Markdown that was written. "Replace" and "undo" need that; a
		// scan can only recover a part of it, so it is kept beside the map
		// instead of in it.
		this.details = new Map();
		// attachment key → how many annotations of it are in the index
		this.perAttachment = new Map();
		this.scannedAt = "";
		this.blocksScanned = 0;
		// Whether the workspace has been read at all, and when.
		this.scanned = false;
		this.scannedMs = 0;
		// Which workspace the entries belong to. The notes live in one
		// workspace at a time, so an index of another one is worthless.
		this.scannedKey = "";
		// The scan that is running right now, so a second caller waits for
		// its answer instead of reading the same table again.
		this._scanning = null;
		// Every entry is stamped with the moment it was learned. A scan
		// that started earlier cannot know about an entry that was added
		// while it was running — so those entries have to survive it.
		this._revision = 0;
		this._revisions = new Map();
	}

	get size() {
		return this.blocks.size;
	}

	/**
	 * Tell the listener what changed.
	 *
	 * The index is also the place the local cache learns from, but the
	 * cache is the caller's concern — a change is described here and the
	 * listener decides whether to write a preference.
	 *
	 * @param {Object} change
	 */
	_emit(change) {
		if (!this._onChange) {
			return;
		}
		try {
			this._onChange(change);
		}
		catch (e) {
			Zotero.debug(`ZoteroSiYuan: the index listener failed: ${e}`);
		}
	}

	/**
	 * Fill the index from the local cache.
	 *
	 * Used before the workspace is reachable: without it, a reader that is
	 * opened while SiYuan is closed shows every annotation as unsent. A
	 * later scan replaces these entries — the cache is not authoritative.
	 *
	 * @param {Array<{annotationKey: String, blockID: String, documentID: String}>} entries
	 */
	seed(entries) {
		for (const entry of Array.isArray(entries) ? entries : []) {
			const key = String((entry && entry.annotationKey) || "");
			const blockID = String((entry && entry.blockID) || "");
			if (!key || !blockID || this.blocks.has(key)) {
				continue;
			}
			this.blocks.set(key, blockID);
			this.details.set(key, {
				blockID,
				documentID: String(entry.documentID || ""),
				blocks: [],
				markdown: "",
			});
		}
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
	 * What is known about a sent annotation.
	 *
	 * @param {String} annotationKey
	 * @returns {Object|null} { blockID, documentID, blocks, markdown }
	 */
	getEntry(annotationKey) {
		const key = String(annotationKey || "");
		const blockID = this.get(key);
		if (!blockID) {
			return null;
		}
		const detail = this.details.get(key) || {};
		return {
			blockID,
			documentID: detail.documentID || "",
			blocks: Array.isArray(detail.blocks) ? detail.blocks.slice() : [],
			markdown: detail.markdown || "",
		};
	}

	/**
	 * Remember that an annotation went to a block.
	 * @param {String} annotationKey
	 * @param {String} blockID
	 * @param {Object} [details] - { documentID, blocks, markdown }
	 */
	add(annotationKey, blockID, details = {}) {
		if (annotationKey && blockID) {
			const key = String(annotationKey);
			this.blocks.set(key, String(blockID));
			this._revisions.set(key, ++this._revision);
			this.details.set(key, {
				blockID: String(blockID),
				documentID: String(details.documentID || ""),
				blocks: Array.isArray(details.blocks)
					? details.blocks.map(String)
					: [],
				markdown: String(details.markdown || ""),
			});
			this._emit({
				type: "add",
				key,
				blockID: String(blockID),
				documentID: String(details.documentID || ""),
			});
		}
	}

	/**
	 * Forget an annotation again.
	 * @param {String} annotationKey
	 */
	remove(annotationKey) {
		if (!annotationKey) {
			return;
		}
		const key = String(annotationKey);
		this.blocks.delete(key);
		this.details.delete(key);
		this._revisions.delete(key);
		this._emit({ type: "remove", key });
	}

	/**
	 * Load the blocks of one PDF attachment.
	 *
	 * The index is filled per attachment as a sidebar is drawn — but the
	 * query behind it is a `LIKE '%…%'`, which no index can help with: it
	 * reads the whole table whether it is narrowed to one PDF or not. So
	 * the plugin asks **once** for the whole workspace and answers every
	 * attachment from that answer. Ten PDFs opened in a session used to be
	 * ten scans of the workspace; now they are one.
	 *
	 * A scan that fails falls back to the query for this PDF alone: a
	 * sidebar with its markers is better than no markers at all.
	 *
	 * @param {Object} cli - a SiYuanCLI
	 * @param {String} attachmentKey - the PDF's key
	 * @param {Object} [options] - passed on to `ensureScanned`
	 * @returns {Promise<Number>} how many annotations of it are known
	 */
	async refreshForAttachment(cli, attachmentKey, options = {}) {
		if (!/^[A-Za-z0-9]+$/.test(String(attachmentKey))) {
			throw new Error(`"${attachmentKey}" is not an item key`);
		}
		try {
			await this.ensureScanned(cli, options);
			return this.attachmentCount(attachmentKey);
		}
		catch (e) {
			return await this.queryAttachment(cli, attachmentKey);
		}
	}

	/**
	 * How many annotations of a PDF the index knows.
	 * @param {String} attachmentKey
	 * @returns {Number}
	 */
	attachmentCount(attachmentKey) {
		return this.perAttachment.get(String(attachmentKey)) || 0;
	}

	/**
	 * Read the workspace when it has not been read recently.
	 *
	 * @param {Object} cli - a SiYuanCLI
	 * @param {Object} [options]
	 * @param {Boolean} [options.force] - scan even when the last one is recent
	 * @param {String} [options.key] - which workspace this is; a different
	 *   one has a different index, so a recent scan of another one must not
	 *   be reused
	 * @returns {Promise<Boolean>} whether a scan was made
	 */
	async ensureScanned(cli, { force = false, key = "" } = {}) {
		const age = Date.now() - this.scannedMs;
		const sameWorkspace = !key || !this.scannedKey || this.scannedKey === key;
		if (!force && sameWorkspace && this.scanned && age < INDEX_TTL_MS) {
			return false;
		}
		// One scan at a time: a restored session with eight tabs would
		// otherwise start eight scans of the same workspace at once, and
		// every one of them would read the whole table.
		if (this._scanning) {
			return await this._scanning;
		}
		this._scanning = (async () => {
			// A scan that fails must not count as one: the next caller tries
			// again instead of trusting an empty answer for five minutes.
			this.scanned = false;
			if (key && this.scannedKey && key !== this.scannedKey) {
				// Nothing known about the old workspace is true of this one.
				this.blocks = new Map();
				this.details = new Map();
				this.perAttachment = new Map();
				this._revisions.clear();
			}
			await this.refresh(cli);
			this.scanned = true;
			this.scannedMs = Date.now();
			this.scannedKey = key || this.scannedKey || "";
			return true;
		})();
		try {
			return await this._scanning;
		}
		finally {
			this._scanning = null;
		}
	}

	/**
	 * Read the blocks of one PDF, on its own.
	 *
	 * The fallback for a workspace that could not be scanned as a whole —
	 * and the only path that costs a query per PDF.
	 *
	 * @param {Object} cli - a SiYuanCLI
	 * @param {String} attachmentKey - the PDF's key
	 * @returns {Promise<Number>} how many blocks were found
	 */
	async queryAttachment(cli, attachmentKey) {
		// Everything that is added from now on is newer than the query
		// below can be, so it has to survive it.
		const revision = this._revision;
		const rows = await cli.runJSON([
			"sql",
			"SELECT id, markdown, type, root_id FROM blocks " +
				// The key alone: the link of a group library has a different
				// prefix, and narrowing on the personal one hid those notes.
				`WHERE markdown LIKE '%${attachmentKey}%' ` +
				"ORDER BY created DESC, CASE WHEN type = 'p' THEN 1 ELSE 0 END ASC",
		]);
		let found = 0;
		const seen = new Set();
		for (const row of rows || []) {
			// `markdown` may mention the key in the note's own text.
			if (parseAttachmentKey(row.markdown) !== String(attachmentKey)) {
				continue;
			}
			const key = parseAnnotationKey(row.markdown);
			if (!key || seen.has(key)) {
				continue;
			}
			// The query is ordered by creation date, so the first row of a
			// key is its newest block.
			seen.add(key);
			found++;
			// An entry that was added while the query was running is newer
			// than anything the query could have seen.
			if ((this._revisions.get(key) || 0) > revision) {
				continue;
			}
			this.blocks.set(key, row.id);
			this.details.set(key, {
				blockID: row.id,
				documentID: row.root_id || "",
				blocks: [],
				markdown: row.markdown || "",
			});
			this._emit({
				type: "add",
				key,
				blockID: row.id,
				documentID: row.root_id || "",
			});
		}
		this.perAttachment.set(String(attachmentKey), found);
		return found;
	}

	/**
	 * Rebuild the index from the workspace.
	 *
	 * @param {Object} cli - a SiYuanCLI
	 * @returns {Promise<Number>} how many annotations are known
	 */
	async refresh(cli) {
		// Everything that is added from now on is newer than the query
		// below can be, so it has to survive it.
		const revision = this._revision;
		// What was known before the scan — including entries seeded from
		// the local cache. Anything here that the workspace does not have
		// any more was deleted in SiYuan, and the caller has to hear about
		// it so the marker can go away.
		const before = new Map(this.blocks);
		const rows = await cli.runJSON([
			"sql",
			// The link lives in the *markdown* column: the plain-text
			// `content` column has it stripped, and SiYuan rewrites a
			// non-http link into <span data-href="…">.
			"SELECT id, markdown, type, root_id FROM blocks " +
				`WHERE markdown LIKE ${ZOTERO_LINK_LIKE} ` +
				// Newest first, so a re-sent annotation points at its latest
				// block; and a callout before the paragraph inside it, so
				// the link lands on the whole quote.
				"ORDER BY created DESC, CASE WHEN type = 'p' THEN 1 ELSE 0 END ASC",
		]);
		// Build the new index first: a failing query must not throw away
		// what is already known.
		const found = new Map();
		const foundDetails = new Map();
		const perAttachment = new Map();
		for (const row of rows || []) {
			const key = parseAnnotationKey(row.markdown);
			if (key && !found.has(key)) {
				found.set(key, row.id);
				foundDetails.set(key, {
					blockID: row.id,
					documentID: row.root_id || "",
					blocks: [],
					markdown: row.markdown || "",
				});
				// Counted once per annotation: a note is usually more than
				// one block, and a PDF with twenty notes is not forty.
				const attachment = parseAttachmentKey(row.markdown);
				if (attachment) {
					perAttachment.set(
						attachment,
						(perAttachment.get(attachment) || 0) + 1,
					);
				}
			}
		}
		// An annotation that was sent while the query was running is not in
		// its result — that query cannot know about it. Its block is the
		// newest one there is, so it has to win over the query's answer.
		for (const [key, blockID] of this.blocks) {
			if ((this._revisions.get(key) || 0) > revision) {
				found.set(key, blockID);
				foundDetails.set(
					key,
					this.details.get(key) || {
						blockID,
						documentID: "",
						blocks: [],
						markdown: "",
					},
				);
			}
		}
		this.blocks = found;
		this.details = foundDetails;
		this.perAttachment = perAttachment;
		// Keep the stamps in step with the index, so it cannot grow forever.
		for (const key of [...this._revisions.keys()]) {
			if (!this.blocks.has(key)) {
				this._revisions.delete(key);
			}
		}
		this.blocksScanned = Array.isArray(rows) ? rows.length : 0;
		this.scannedAt = new Date().toISOString();
		// Keys the cache knew and the workspace no longer has. A note the
		// user deleted in SiYuan is not "unsent" — it is gone, and the
		// reader should stop pointing at it.
		const removed = [];
		for (const [key, blockID] of before) {
			if (!found.has(key)) {
				removed.push({ key, blockID });
			}
		}
		this._emit({
			type: "snapshot",
			blocks: this.blocks,
			details: this.details,
			removed,
		});
		return this.blocks.size;
	}
}