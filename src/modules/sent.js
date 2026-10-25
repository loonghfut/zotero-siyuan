/**
 * Zotero → SiYuan — the "already sent" marker.
 *
 * Which SiYuan block an annotation went to is recorded as a tag on the
 * annotation itself: `siyuan:<block id>`.
 *
 * A tag travels with the library — it syncs to the Zotero server — so the
 * marker survives a reinstall and works on another machine, and the user
 * can find every annotation they have ever sent by searching that tag.
 */

/** The prefix of the tag that records where an annotation went. */
export const SIYUAN_TAG_PREFIX = "siyuan:";

/** The tag that records a block. */
export function siyuanTag(blockID) {
	return `${SIYUAN_TAG_PREFIX}${blockID}`;
}

/** The names of a set of tags, whether they are strings or objects. */
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
			return tag.tag || tag.name || "";
		})
		.filter(Boolean);
}

/**
 * The block id recorded in a set of tags, or "" when there is none.
 * @param {Array} tags
 * @returns {String}
 */
export function blockIDFromTags(tags) {
	for (const name of tagNames(tags)) {
		if (name.startsWith(SIYUAN_TAG_PREFIX)) {
			return name.slice(SIYUAN_TAG_PREFIX.length);
		}
	}
	return "";
}

/**
 * Record where an annotation was sent.
 *
 * @param {Object} annotation - the Zotero annotation item
 * @param {String} blockID - the SiYuan block
 * @returns {Promise<Boolean>} whether the annotation now carries the tag
 */
export async function markSent(annotation, blockID) {
	if (!annotation || !blockID) {
		return false;
	}
	const tag = siyuanTag(blockID);
	if (!annotation.hasTag(tag)) {
		annotation.addTag(tag);
		await annotation.saveTx();
	}
	return true;
}

/**
 * Forget where an annotation was sent.
 * @param {Object} annotation - the Zotero annotation item
 * @returns {Promise<Boolean>}
 */
export async function clearSent(annotation) {
	if (!annotation) {
		return false;
	}
	let changed = false;
	for (const name of tagNames(annotation.getTags())) {
		if (name.startsWith(SIYUAN_TAG_PREFIX)) {
			annotation.removeTag(name);
			changed = true;
		}
	}
	if (changed) {
		await annotation.saveTx();
	}
	return changed;
}
