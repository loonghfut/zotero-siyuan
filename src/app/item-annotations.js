/**
 * Zotero → SiYuan — the annotations of a literature note.
 *
 * A literature note is worth having because the annotations are in it. The
 * sync writes them as ordinary annotation notes — one super block each,
 * carrying the annotation key — so the reader's "sent" markers, the index
 * and "open in SiYuan" all keep working.
 *
 * It is **incremental**: an annotation whose text and template fingerprint
 * did not change is not rendered again, a changed one is updated in place,
 * a new one is appended, and the notes of annotations that are gone are
 * deleted. A sync after adding one highlight therefore costs one write,
 * not a delete-and-rewrite of the whole document.
 */

import { getString } from "../utils/locale.js";
import {
  ANNOTATION_KEY_ATTR,
  ITEM_SECTION_ANNOTATIONS,
  MODIFIED_ATTR,
  SECTION_ATTR,
  TEMPLATE_ATTR,
  annotationAttributes,
  attributeValue,
  markBlock,
  parseAttributes,
} from "../modules/block-attrs.js";
import { isBlockID } from "../modules/siyuan.js";
import { templateFingerprint } from "../modules/template.js";

export default {
	/**
	 * The annotation items of every PDF of an item, in page order.
	 *
	 * @param {Object[]} pdfs
	 * @returns {Promise<Array<{item: Object, pdf: Object}>>}
	 */
	async _itemAnnotationItems(pdfs) {
		const entries = [];
		for (const pdf of pdfs || []) {
			let list = [];
			try {
				list = (await pdf.getAnnotations()) || [];
			}
			catch (e) {
				list = [];
			}
			// `getAnnotations` answers with ids or with items, depending on
			// the Zotero version; the ids are read in one go.
			const ids = list.filter((entry) => typeof entry === "number");
			const loaded = ids.length ? await this._loadItems(ids) : [];
			const byID = new Map();
			for (const item of loaded) {
				if (item && item.id !== undefined) {
					byID.set(item.id, item);
				}
			}
			const items = list
				.map((entry) => (typeof entry === "number" ? byID.get(entry) : entry))
				.filter(Boolean);
			items.sort(
				(a, b) => this._annotationPage(a) - this._annotationPage(b),
			);
			for (const item of items) {
				if (item.key) {
					entries.push({ item, pdf });
				}
			}
		}
		return entries;
	},

	/**
	 * The annotation blocks a previous sync wrote into a document.
	 *
	 * Only blocks carrying the sync's section are returned: an annotation
	 * the user sent into the document by hand is theirs, and a later sync
	 * must not delete it just because the annotation left the library.
	 *
	 * @param {String} documentID
	 * @returns {Promise<Map<String, Object>>} key → { id, modified, template }
	 */
	async _annotationSectionBlocks(documentID) {
		const found = new Map();
		if (!isBlockID(documentID)) {
			return found;
		}
		const statement =
			"SELECT id, ial FROM blocks " +
			`WHERE root_id = '${documentID}' AND ial LIKE '%${SECTION_ATTR}="${ITEM_SECTION_ANNOTATIONS}"%' ` +
			"ORDER BY sort ASC";
		let rows = [];
		try {
			const http = await this._httpClient();
			rows = await http.sql(statement);
		}
		catch (e) {
			try {
				rows = await this.getCLI().runJSON(["sql", statement]);
			}
			catch (error) {
				Zotero.debug(
					`ZoteroSiYuan: could not list the literature note's annotations: ${error.message}`,
				);
				return found;
			}
		}
		for (const row of rows || []) {
			if (!row || !row.id) {
				continue;
			}
			const attrs = parseAttributes(row.ial);
			const key = attrs[ANNOTATION_KEY_ATTR] || "";
			if (!key) {
				continue;
			}
			found.set(key, {
				id: row.id,
				modified: attrs[MODIFIED_ATTR] || "",
				template: attrs[TEMPLATE_ATTR] || "",
			});
		}
		return found;
	},

	/**
	 * Bring the annotations of an item into its literature note.
	 *
	 * @param {Object} options
	 * @param {String} options.documentID
	 * @param {Object} options.notebook
	 * @param {Object[]} options.pdfs
	 * @returns {Promise<{added: Number, updated: Number, removed: Number, failed: Number, summary: String}>}
	 */
	async _syncItemAnnotations({ documentID, notebook, pdfs }) {
		const result = { added: 0, updated: 0, removed: 0, failed: 0, summary: "" };
		if (!isBlockID(documentID)) {
			return result;
		}
		const template = this.getTemplateFor("item");
		const stamp = templateFingerprint(template);
		const existing = await this._annotationSectionBlocks(documentID);
		const entries = await this._itemAnnotationItems(pdfs);

		const appended = [];
		const updated = [];
		const stale = [];
		const seen = new Set();
		// Pictures built before the write; a write that never happens has to
		// take them back, exactly like a batch.
		this._batchPictures = [];
		try {
			for (const entry of entries) {
				const key = entry.item.key;
				seen.add(key);
				const previous = existing.get(key);
				if (
					previous &&
					previous.modified &&
					previous.modified === String(entry.item.dateModified || "") &&
					previous.template === stamp
				) {
					continue;
				}
				try {
					const annotation = await this._annotationFromItem(entry.item);
					const vars = await this._buildVars(annotation, null, null, {
						attachment: entry.pdf,
						template,
					});
					const body = await this._buildContent(annotation, null, null, {
						vars,
						template,
					});
					if (!String(body || "").trim()) {
						continue;
					}
					const attrs = {
						...annotationAttributes(vars),
						[SECTION_ATTR]: ITEM_SECTION_ANNOTATIONS,
						[TEMPLATE_ATTR]: stamp,
					};
					const job = {
						key,
						attrs,
						markdown: markBlock(body, attrs),
					};
					if (previous) {
						const attempt = await this._replaceItemSection(
							previous.id,
							job.markdown,
							attrs,
						);
						if (attempt.updated) {
							updated.push({ ...job, blockID: previous.id });
							continue;
						}
						if (!attempt.gone) {
							// The old block could not be updated; the new note is
							// written first and the old one deleted afterwards.
							stale.push(previous.id);
						}
					}
					appended.push(job);
				}
				catch (e) {
					result.failed++;
					Zotero.logError(
						`ZoteroSiYuan: the annotation ${key} could not be written: ${e}`,
					);
				}
			}

			if (appended.length) {
				const joined = appended.map((job) => job.markdown).join("\n\n");
				let written = null;
				try {
					written = await this._append(
						notebook ? notebook.id : "",
						joined,
						null,
						{
							target: { kind: "item", documentID },
							// The rows say exactly which block belongs to which
							// note, without a second query.
							collectBlocks: true,
						},
					);
				}
				catch (e) {
					result.failed += appended.length;
					Zotero.logError(
						`ZoteroSiYuan: the annotations of the literature note could not be written: ${e}`,
					);
					appended.length = 0;
				}
				// The write answered with the blocks it made; their attributes
				// say which annotation each one is. They are not needed for the
				// note itself — only so the reader's markers appear now.
				const known = new Map();
				for (const row of (written && written.blockRows) || []) {
					const key = attributeValue(row && row.ial, ANNOTATION_KEY_ATTR);
					if (key && row.id) {
						known.set(key, row.id);
					}
				}
				if (appended.some((job) => !known.has(job.key))) {
					// SiYuan's query index catches up a moment after a write, so
					// the rows above can be missing on a first sync.
					await new Promise((resolve) => setTimeout(resolve, 1200));
					const after = await this._annotationSectionBlocks(documentID);
					for (const [key, row] of after) {
						if (!known.has(key)) {
							known.set(key, row.id);
						}
					}
				}
				for (const job of appended) {
					// The write did not fail — the block is in SiYuan. A block
					// whose id could not be learned yet is found by the next
					// sync and by the index scan, so it is not a failure.
					result.added++;
					const blockID = known.get(job.key);
					if (blockID) {
						this._rememberAnnotation(
							job.key,
							blockID,
							documentID,
							job.markdown,
						);
					}
				}
			}
			for (const job of updated) {
				result.updated++;
				this._rememberAnnotation(job.key, job.blockID, documentID, job.markdown);
			}

			// Only after the new notes are safely in SiYuan is anything taken
			// back: the annotations that are gone, and the old blocks of the
			// ones that had to be appended.
			const removedBlocks = [];
			for (const [key, row] of existing) {
				if (!seen.has(key)) {
					removedBlocks.push(row.id);
				}
			}
			removedBlocks.push(...stale);
			if (removedBlocks.length) {
				const deleted = await this._deleteBlocks(removedBlocks);
				if (deleted) {
					result.removed = removedBlocks.length;
				}
				else {
					result.failed += removedBlocks.length;
				}
			}
		}
		finally {
			this._batchPictures = null;
			// Every picture here belongs to a note that is in SiYuan now;
			// none of them is waiting to be taken back.
			this._pendingPicture = null;
		}
		if (result.added || result.updated || result.removed || result.failed) {
			result.summary = this._annotationSummary(result);
		}
		return result;
	},

	/** Remember where one annotation's note is, so its marker is right. */
	_rememberAnnotation(key, blockID, documentID, markdown) {
		if (!key || !blockID) {
			return;
		}
		this._index.add(key, blockID, {
			documentID,
			blocks: [blockID],
			markdown,
		});
	},

	/** One line for the bubble: what the sync did to the annotations. */
	_annotationSummary({ added, updated, removed, failed }) {
		const parts = [];
		if (added) {
			parts.push(
				getString(
					"zoteroSiYuan-item-annotations-added",
					"%d added",
				).replace("%d", String(added)),
			);
		}
		if (updated) {
			parts.push(
				getString(
					"zoteroSiYuan-item-annotations-updated",
					"%d updated",
				).replace("%d", String(updated)),
			);
		}
		if (removed) {
			parts.push(
				getString(
					"zoteroSiYuan-item-annotations-removed",
					"%d removed",
				).replace("%d", String(removed)),
			);
		}
		if (failed) {
			parts.push(
				getString(
					"zoteroSiYuan-item-annotations-failed",
					"%d failed",
				).replace("%d", String(failed)),
			);
		}
		return getString("zoteroSiYuan-item-annotations-label", "Annotations") +
			": " + parts.join(", ");
	},
};
