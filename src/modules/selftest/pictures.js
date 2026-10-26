/**
 * Zotero → SiYuan — the pictures a self test writes, and how to take them back.
 *
 * A "框选" annotation brings its picture along, and the picture is written into
 * the workspace *before* the note that refers to it. A dry run writes no note,
 * so that picture would be litter — and a render that fails half way leaves one
 * behind that no note names. Everything the test wrote has to go again, and
 * only what the test wrote.
 *
 * The bookkeeping is a small object of its own so the run can hand it to the
 * steps without giving them the whole run.
 *
 * @param {Object} addon - the plugin instance, for the workspace's path
 */

import { pictureAssetNames, strayPictureNames } from "../siyuan-image.js";
import { log } from "./report.js";
export function createPictureBookkeeping(addon) {
// The pictures this test caused to be written into the workspace.
//
// A "框选" annotation brings its picture along, and the picture goes
// into the workspace *before* the note is written — the note has to
// refer to a file that is really there. A dry run writes no note, so
// the picture it left behind would be litter. They are collected here
// and taken back at the end.
const exportedPictures = new Set();

function notePictures(markdown) {
	for (const name of pictureAssetNames(markdown)) {
		exportedPictures.add(name);
	}
}

/**
 * The pictures the workspace already had.
 *
 * The self test writes pictures of its own — and they have to go
 * again. What the Markdown mentions is not always enough: a render
 * that fails half way leaves a picture behind that no note refers
 * to. So the folder is looked at before and after, and whatever
 * appeared in between goes.
 *
 * @returns {Promise<Set<String>|null>} the names, or null when the
 *   folder could not be read — then the caller knows it must not
 *   treat the difference of two readings as "everything is new"
 */
async function picturesInWorkspace() {
	const names = new Set();
	try {
		const workspace = await addon._resolveWorkspaceDir();
		if (!workspace) {
			return null;
		}
		const dir = PathUtils.join(workspace, "data", "assets");
		for (const child of await IOUtils.getChildren(dir)) {
			const name = String(child.name || "");
			if (name.startsWith("zotero-siyuan-")) {
				names.add(name);
			}
		}
	}
	catch (e) {
		// No folder, no permission — nothing to tell.
		return null;
	}
	return names;
}

/**
 * The pictures the kernel knows about.
 *
 * A picture that a real note refers to is registered in the assets
 * table. A picture the self test left behind is not — nobody ever
 * linked it. This is what tells the two apart, so a note that is
 * sent while the self test runs does not lose its picture.
 *
 * @returns {Promise<Set<String>|null>} the names, or null when the
 *   kernel could not be asked
 */
async function registeredPictures() {
	const names = new Set();
	try {
		const cli = addon.getCLI();
		const rows = await cli.runJSON([
			"sql",
			"SELECT path FROM assets WHERE path LIKE '%zotero-siyuan-%'",
		]);
		for (const row of rows || []) {
			const path = String(row.path || "");
			const name = path.split("/").pop();
			if (name) {
				names.add(name);
			}
		}
	}
	catch (e) {
		return null;
	}
	return names;
}

/**
 * Take one picture out of the workspace's assets folder.
 *
 * @param {String} name - the file name, without any path
 * @returns {Promise<Boolean>} whether a file was really removed
 */
async function removePictureNamed(name) {
	const workspace = await addon._resolveWorkspaceDir();
	if (!workspace) {
		return false;
	}
	// The name is a plain file name, so it may go into the path as a
	// component — PathUtils.join refuses components that carry a
	// separator of their own.
	const path = PathUtils.join(workspace, "data", "assets", name);
	if (!(await IOUtils.exists(path))) {
		return false;
	}
	await IOUtils.remove(path, { ignoreAbsent: true });
	return true;
}

/**
 * The pictures that showed up while the self test ran and that no
 * note refers to.
 *
 * The picture is written into the assets folder before the note
 * that mentions it — the note has to point at a file that is really
 * there. When the send fails in between, the file stays and the
 * Markdown never names it, so it would survive the cleanup by name.
 * The difference between the folder before and after the run finds
 * those.
 *
 * @param {Set<String>|null} before - the pictures the workspace had
 *   when the self test started
 * @param {Set<String>} named - the pictures the Markdown named
 * @returns {Promise<String[]>} the names that were removed
 */
async function removeStrayPictures(before, named) {
	if (!before) {
		// The folder could not be read at the start — without that
		// reading it is impossible to tell what is stray.
		return [];
	}
	const after = await picturesInWorkspace();
	if (!after) {
		return [];
	}
	// A picture that a real note refers to is known to the kernel.
	// A note sent while the self test runs must keep its picture.
	const registered = await registeredPictures();
	if (!registered) {
		log("the kernel did not answer — the stray pictures stay");
		return [];
	}
	const referenced = new Set([...registered, ...named]);
	const removed = [];
	for (const name of strayPictureNames(before, after, referenced)) {
		try {
			if (await removePictureNamed(name)) {
				removed.push(name);
			}
		}
		catch (e) {
			log(`could not take back the stray picture ${name}: ${e}`);
		}
	}
	return removed;
}

async function removeExportedPictures() {
	if (!exportedPictures.size) {
		return [];
	}
	const workspace = await addon._resolveWorkspaceDir();
	if (!workspace) {
		return [];
	}
	const removed = [];
	for (const name of exportedPictures) {
		try {
			const path = PathUtils.join(workspace, "data", "assets", name);
			if (await IOUtils.exists(path)) {
				await IOUtils.remove(path, { ignoreAbsent: true });
				removed.push(name);
			}
		}
		catch (e) {
			log(`could not take back the picture ${name}: ${e}`);
		}
	}
	exportedPictures.clear();
	return removed;
}

  return {
    exportedPictures,
    notePictures,
    picturesInWorkspace,
    removeStrayPictures,
    removeExportedPictures,
  };
}
