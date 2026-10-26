/**
 * Zotero → SiYuan — the self test's plumbing: logging, timing, the report.
 */

import { tempFilePath } from "../../utils/paths.js";
import { VERSION } from "../../version.js";

const REPORT_FILE = "zotero-siyuan-selftest.json";

/** Marks the test block so it can be found (and removed) afterwards. */
export const SELFTEST_MARKER = "ZoteroSiYuanSelfTest";

export function log(message) {
	try {
		Zotero.debug(`ZoteroSiYuan: ${message}`);
	}
	catch (e) {
		// ignore
	}
}

/** Sleep, preferring the main window's timer (the sandbox may have none). */
export function sleep(ms) {
	return new Promise((resolve) => {
		try {
			const win = Zotero.getMainWindow();
			if (win && win.setTimeout) {
				win.setTimeout(resolve, ms);
				return;
			}
		}
		catch (e) {
			// fall through
		}
		setTimeout(resolve, ms);
	});
}

export async function writeReport(report) {
	const path = tempFilePath(REPORT_FILE);
	try {
		await Zotero.File.putContentsAsync(path, JSON.stringify(report, null, 2));
	}
	catch (e) {
		log(`could not write the self-test report: ${e}`);
	}
	return path;
}

/**
 * A PDF attachment from the user's library.
 *
 * Using a real attachment means the bibliographic metadata in the generated
 * Markdown is real too — the self test then covers the whole formatter, not
 * a stripped-down version of it.
 *
 * @returns {Promise<Number>} the attachment's item id, 0 when there is none
 */

/**
 * The version of the plugin that is really installed.
 *
 * It is written into the code on every build. The addon manager keeps the
 * version of the *manifest* in its own cache, and that cache can be a
 * version behind — the script itself is read fresh. So the version that
 * comes with the code is the one that counts.
 *
 * @returns {String}
 */
export function pluginVersion() {
	return String(VERSION || "");
}
