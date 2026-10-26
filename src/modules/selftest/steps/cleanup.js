/**
 * Zotero → SiYuan — taking back what the self test wrote.
 *
 * A self test that leaves its traces in the user's daily note is not a self
 * test. Deleting them, though, must never cost the user a note: a block is
 * only removed when this run can prove it created it. `blocksExact` is that
 * proof — it is set when the document was read before the write as well, so
 * the list is "what appeared while this write ran" instead of "what carries
 * the same timestamp", and a note written by the user in the same second is
 * not in it.
 *
 * The deletion is verified afterwards. `block delete` answers "success" for
 * a block that is already gone too, so a command that failed cannot be told
 * from one that worked by its answer alone — only by asking the workspace.
 */

import { clearLegacyTags } from "../../siyuan-index.js";
import { log } from "../report.js";

/**
 * @param {Object} ctx - the run's context
 * @returns {Promise<Object>} what the report shows
 */
export async function cleanUpAfterTheSelfTest(ctx) {
	const { cli, captured, real } = ctx;

	const blocks = captured.blocksExact
		? (captured.blocks && captured.blocks.length
			? captured.blocks
			: [captured.blockID]).filter(Boolean)
		: (captured.blockID ? [captured.blockID] : []);
	if (!captured.blocksExact && captured.blockID) {
		// The transport could not say which blocks were new (the HTTP API
		// names one block, not its siblings), so only that one is taken
		// back. Anything else could be a note the user wrote at the same
		// moment.
		log(
			"the note's blocks could not be attributed to the test — only its first block is removed",
		);
	}

	const removed = [];
	const failures = [];
	for (const block of blocks) {
		try {
			await cli.deleteBlock(block);
			removed.push(block);
		}
		catch (e) {
			failures.push(`${block}: ${e.message}`);
		}
	}
	// An annotation that was tagged by an older version of the plugin keeps
	// the tag until it is taken off; that tag is not a trace of this run.
	if (real && real.item) {
		await clearLegacyTags(real.item);
	}

	if (failures.length) {
		throw new Error(
			`could not remove the test block(s): ${failures.join("; ")}`,
		);
	}

	let leftovers = [];
	if (removed.length) {
		try {
			leftovers = await cli.findExistingBlocks(removed);
		}
		catch (e) {
			// The query itself failed: the deletes were reported as fine,
			// and there is nothing more this step can check.
			log(`could not confirm the test blocks are gone: ${e}`);
		}
	}
	if (leftovers.length) {
		throw new Error(
			`the test block(s) are still in the daily note: ${leftovers.join(", ")}`,
		);
	}

	return { removedBlocks: removed, attributed: !!captured.blocksExact };
}
