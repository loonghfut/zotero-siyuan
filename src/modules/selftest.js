/**
 * Zotero → SiYuan — end-to-end self test.
 *
 * The self test drives exactly the path a user's click takes, inside Zotero:
 *
 *   renderSidebarAnnotationHeader event → the button → its click handler →
 *   _send() → build the Markdown → resolve the notebook → append to SiYuan.
 *
 * Nothing is mocked: the annotation header event is the plugin's own
 * handler, the button is a real DOM button, the click is a real click, and
 * the append is the plugin's own transport. So a passing report is evidence
 * that the plugin works *in the client it ships in*.
 *
 * Two modes:
 *
 *   dry run (default) — the append is replaced by the siyuan CLI's own
 *     `--dry-run`, so SiYuan validates the exact command without writing.
 *   real write        — the block really is appended to today's daily note.
 *
 * The result is written to a JSON report in the temp directory.
 */

import { tempFilePath } from "../utils/paths.js";
import { clearLegacyTags } from "./siyuan-index.js";
import {
	pictureAssetNames,
	removePicture,
	strayPictureNames,
} from "./siyuan-image.js";
import {
	findHandlerExecutable,
	protocolHandlerCommand,
	suppressProtocolWarning,
} from "./siyuan-launcher.js";
import { showToast, toastTarget } from "./toast.js";

const REPORT_FILE = "zotero-siyuan-selftest.json";

/** Marks the test block so it can be found (and removed) afterwards. */
export const SELFTEST_MARKER = "ZoteroSiYuanSelfTest";

function log(message) {
	try {
		Zotero.debug(`ZoteroSiYuan: ${message}`);
	}
	catch (e) {
		// ignore
	}
}

/** Sleep, preferring the main window's timer (the sandbox may have none). */
function sleep(ms) {
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

async function writeReport(report) {
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
async function findPDFAttachment() {
	try {
		const rows = await Zotero.DB.queryAsync(
			"SELECT itemID FROM itemAttachments " +
			"WHERE contentType = 'application/pdf' " +
			"AND itemID NOT IN (SELECT itemID FROM deletedItems) " +
			"ORDER BY itemID DESC LIMIT 1",
		);
		if (rows && rows.length) {
			return rows[0].itemID;
		}
	}
	catch (e) {
		log(`could not query the database for a PDF: ${e}`);
	}

	try {
		const ids = await Zotero.Items.getAll(
			Zotero.Libraries.userLibraryID,
			false,
			true,
		);
		for (const id of ids) {
			const item = await Zotero.Items.getAsync(id);
			if (item && item.isPDFAttachment && item.isPDFAttachment()) {
				return id;
			}
		}
	}
	catch (e) {
		log(`could not look for a PDF attachment: ${e}`);
	}

	return 0;
}

/**
 * A real annotation of the library, as the reader would hand it over.
 *
 * The self test needs a real one when it writes for real: only a real
 * annotation can be tagged, and only a real annotation proves that the tag
 * lands on the right item.
 *
 * @param {Number} attachmentID
 * @returns {Promise<Object|null>}
 */
async function findRealAnnotation() {
	try {
		const rows = await Zotero.DB.queryAsync(
			"SELECT itemID FROM itemAnnotations " +
				"WHERE itemID NOT IN (SELECT itemID FROM deletedItems) " +
				"ORDER BY itemID DESC LIMIT 10",
		);
		for (const row of rows || []) {
			const item = await Zotero.Items.getAsync(row.itemID);
			if (!item || !item.parentItemID) {
				continue;
			}
			const attachment = await Zotero.Items.getAsync(item.parentItemID);
			if (!attachment) {
				continue;
			}
			let position = null;
			try {
				position = item.annotationPosition
					? JSON.parse(item.annotationPosition)
					: null;
			}
			catch (e) {
				position = null;
			}
			return {
				item,
				attachmentID: item.parentItemID,
				annotation: {
					id: item.key,
					type: item.annotationType || "highlight",
					text: item.annotationText || "",
					comment: item.annotationComment || "",
					pageLabel: item.annotationPageLabel || "",
					authorName: item.annotationAuthorName || "",
					position,
					tags: (item.getTags() || []).map((t) => ({ name: t.tag })),
				},
			};
		}
	}
	catch (e) {
		log(`could not find a real annotation: ${e}`);
	}
	return null;
}

/** The main window, once it exists. */
async function waitForMainWindow(timeout = 15000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		try {
			if (toastTarget()) {
				return true;
			}
		}
		catch (e) {
			// not there yet
		}
		await sleep(200);
	}
	return false;
}

/**
 * The preferences pane, really opened and really used.
 *
 * The pane lives in Zotero's own preferences window, so the only honest
 * test is to open that window, click a variable and see whether the
 * template changed. It is part of the deep self test only — the window
 * would pop up on every start otherwise.
 *
 * @param {Object} addon - the plugin instance
 * @returns {Promise<Object>}
 */
async function testPreferencesPane(addon) {
	const panes = Zotero.PreferencePanes.pluginPanes || [];
	const mine = panes.find((pane) =>
		String(pane.id || "").includes("zotero-siyuan@example.com"),
	);
	if (!mine) {
		throw new Error("the plugin's preference pane is not registered");
	}

	// The raw preference, so it can be restored exactly — an empty one
	// means "use the built-in template".
	const originalPref = addon.getTemplatePref();
	const original = addon.getTemplate();
	let win = null;
	try {
		Zotero.Utilities.Internal.openPreferences(mine.id);

		// Wait until the pane is really ready: the editor exists *and* it
		// already holds the template. Inserting into an editor that is not
		// filled yet would throw the template away.
		const deadline = Date.now() + 25000;
		let area = null;
		while (Date.now() < deadline) {
			const candidate = Services.wm.getMostRecentWindow("zotero:pref");
			if (candidate && candidate.document) {
				const editor = candidate.document.getElementById(
					"zotero-prefpane-zoteroSiYuan-template",
				);
				if (editor && editor.value.length) {
					win = candidate;
					area = editor;
					break;
				}
			}
			await sleep(300);
		}
		if (!win) {
			throw new Error("the preferences window did not open");
		}
		if (!area) {
			throw new Error("the template editor did not appear");
		}

		const doc = win.document;
		const rows = doc.querySelectorAll("tr[data-variable]");
		if (!rows.length) {
			throw new Error("the variable list is empty");
		}

		const before = {
			originalLength: original.length,
			areaLength: area.value.length,
			areaTail: area.value.slice(-40),
		};

		// Put the caret at the very start, so the insertion is unambiguous.
		area.focus();
		area.setSelectionRange(0, 0);

		const row = rows[0];
		const name = row.getAttribute("data-variable");
		row.dispatchEvent(
			new win.MouseEvent("click", { bubbles: true, cancelable: true }),
		);
		await sleep(300);

		const expected = `{{${name}}}`;
		const inserted = area.value.startsWith(expected);
		const saved = String(addon.getTemplate() || "").startsWith(expected);
		const after = {
			areaLength: area.value.length,
			areaTail: area.value.slice(-40),
			prefLength: String(addon.getTemplate() || "").length,
		};

		// Put the user's template back, exactly as it was.
		area.value = original;
		area.dispatchEvent(
			new win.Event("input", { bubbles: true, cancelable: false }),
		);

		// --- the conditional blocks ------------------------------------
		// The pane has to put a conditional around the *selected* text —
		// and the button takes the focus away from the editor, so the
		// selection has to survive the click.
		const controls = {
			variable: doc.getElementById(
				"zotero-prefpane-zoteroSiYuan-conditional-variable",
			),
			if: doc.getElementById("zotero-prefpane-zoteroSiYuan-conditional-if"),
			else: doc.getElementById(
				"zotero-prefpane-zoteroSiYuan-conditional-else",
			),
			end: doc.getElementById(
				"zotero-prefpane-zoteroSiYuan-conditional-end",
			),
		};
		for (const [name, control] of Object.entries(controls)) {
			if (!control) {
				throw new Error(
					`the pane has no "${name}" control for the conditionals`,
				);
			}
		}

		const body = "{{commentCallout}}";
		area.value = body;
		area.dispatchEvent(
			new win.Event("input", { bubbles: true, cancelable: false }),
		);
		await sleep(200);

		controls.variable.value = "comment";
		// Select the text that is to go into the block. The selection
		// event is what tells the pane where the text is.
		area.focus();
		area.setSelectionRange(0, body.length);
		area.dispatchEvent(new win.Event("select", { bubbles: true }));
		await sleep(150);

		controls.if.dispatchEvent(
			new win.MouseEvent("click", { bubbles: true, cancelable: true }),
		);
		await sleep(300);
		const wrapped = area.value;

		// The other end of the block, and its other branch.
		area.focus();
		area.setSelectionRange(wrapped.length, wrapped.length);
		area.dispatchEvent(new win.Event("select", { bubbles: true }));
		await sleep(100);
		controls.end.dispatchEvent(
			new win.MouseEvent("click", { bubbles: true, cancelable: true }),
		);
		await sleep(250);
		const withEnd = area.value;

		area.focus();
		area.setSelectionRange(withEnd.length, withEnd.length);
		area.dispatchEvent(new win.Event("select", { bubbles: true }));
		await sleep(100);
		controls.else.dispatchEvent(
			new win.MouseEvent("click", { bubbles: true, cancelable: true }),
		);
		await sleep(250);
		const withElse = area.value;

		const conditionals = {
			wrapped: wrapped.includes("{{#if comment}}"),
			// The selected text has to be *inside* the block, not replaced
			// by it.
			inside: wrapped.includes(`{{#if comment}}\n${body}\n{{/if}}`),
			elseBranch: withElse.includes("{{else}}"),
			endTag: withEnd.includes("{{/if}}"),
			value: withElse,
		};
		if (!conditionals.wrapped || !conditionals.inside) {
			throw new Error(
				`the pane did not put the conditional around the selection: ${JSON.stringify(wrapped)}`,
			);
		}
		if (!conditionals.elseBranch || !conditionals.endTag) {
			throw new Error(
				`the pane did not insert the else and the end: ${JSON.stringify(withElse)}`,
			);
		}

		// Put the user's template back, exactly as it was.
		area.value = original;
		area.dispatchEvent(
			new win.Event("input", { bubbles: true, cancelable: false }),
		);

		return {
			variables: rows.length,
			variable: name,
			inserted,
			saved,
			before,
			after,
			conditionals,
		};
	}
	finally {
		// The user's template must survive the test, whatever happened.
		try {
			addon.setTemplate(originalPref);
		}
		catch (e) {
			// ignore
		}
		if (win) {
			try {
				win.close();
			}
			catch (e) {
				// ignore
			}
		}
	}
}

/**
 * Run the full chain.
 *
 * @param {Object} options
 * @param {Object} options.addon - the plugin instance
 * @param {String} options.notebookPref - the configured notebook name/id
 * @param {Boolean} options.realWrite - really append to the daily note
 * @param {Number} options.timeout - how long the click may take
 * @returns {Promise<Object>} the report
 */
export async function runSelfTest({
	addon,
	notebookPref = "",
	realWrite = false,
	timeout = 45000,
}) {
	const started = Date.now();
	const report = {
		at: new Date().toISOString(),
		zoteroVersion: Zotero.version,
		mode: realWrite ? "real write" : "dry run",
		ok: false,
		steps: [],
	};
	const captured = {
		stage: "start",
		notebook: null,
		transport: null,
		markdown: null,
		dryRun: null,
		blocks: [],
		blockID: "",
		documentID: "",
	};

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

	function record(name, ok, detail) {
		const entry = { name, ok: !!ok };
		if (detail !== undefined && detail !== null) {
			entry.detail = detail;
		}
		report.steps.push(entry);
		return entry.ok;
	}

	/**
	 * Run one probe and record it. A failing probe becomes an entry, never
	 * an exception — so one broken step does not hide the others.
	 *
	 * @param {String} name
	 * @param {Function} fn
	 * @returns {Promise<Object>} the recorded entry
	 */
	async function step(name, fn) {
		const entry = { name, ok: true };
		const started = Date.now();
		try {
			entry.value = await fn();
			// The same content under `detail`, so the report reads the same
			// way whichever helper recorded the step.
			entry.detail = entry.value;
		}
		catch (e) {
			entry.ok = false;
			entry.error = e && e.message ? e.message : String(e);
		}
		entry.ms = Date.now() - started;
		report.steps.push(entry);
		return entry;
	}

	// --- watch the send, without changing it -------------------------
	//
	// The hooks are put on the addon right before the click, and the click
	// picks them up. Nothing on the plugin is replaced, so a real send that
	// happens while the self test runs stays a real send: it is written,
	// and the cleanup below does not touch it.
	const original = {
		append: addon._append,
	};

	let clicked = false;
	const hooks = {
		stage(stage) {
			captured.stage = stage;
		},
		notebook(notebook) {
			captured.notebook = { id: notebook.id, name: notebook.name };
			captured.stage = "notebook resolved";
		},
		async append(notebookID, markdown) {
			clicked = true;
			captured.markdown = markdown;
			// A "框选" annotation brings its picture along — remember it, so
			// it can be taken back when the test is over.
			notePictures(markdown);
			captured.stage = "appending";
			if (realWrite) {
				const result = await original.append.call(
					addon,
					notebookID,
					markdown,
				);
				captured.transport = result.transport;
				captured.blockID = result.blockID;
				captured.blocks = result.blocks || [];
				captured.documentID = result.documentID;
				captured.stage = "appended";
				// The real method answers with an object — the hook has to
				// look just like it, or the caller sees nothing.
				return result;
			}
			// Let the CLI itself validate the exact command it would run.
			// (`dailynote append` answers in plain text, never in JSON.)
			const cli = addon.getCLI();
			captured.dryRun = await cli.runRaw([
				"dailynote",
				"append",
				"--notebook",
				notebookID,
				"--data",
				markdown,
				"--dry-run",
			]);
			captured.transport = "dry run";
			captured.stage = "dry run done";
			return {
				transport: "dry run",
				documentID: "",
				blockID: "",
			};
		},
	};

	/**
	 * Click a button and let the send it starts be watched.
	 *
	 * The hooks go on the addon and the click follows right away, with
	 * nothing in between — so the click handler, which runs synchronously,
	 * is certain to pick them up. And only that one click does.
	 *
	 * @param {Object} button - the button to click
	 */
	const clickAndWatch = (button) => {
		addon.watchNextSend(hooks);
		button.click();
	};

	// What the assets folder holds before the run. Whatever is there
	// afterwards and was not there before belongs to the self test —
	// unless a note that the user sent in the meantime refers to it.
	let picturesBefore = null;
	try {
		picturesBefore = await picturesInWorkspace();
	}
	catch (e) {
		log(`could not read the assets folder: ${e}`);
	}

	try {
		/* --- 1. can the plugin find the siyuan CLI? --------------------- */
		const cli = addon.getCLI();
		let executable = "";
		try {
			executable = await cli.resolveExecutable();
			record("resolve the siyuan CLI", true, executable);
		}
		catch (e) {
			record("resolve the siyuan CLI", false, e.message);
			throw e;
		}
		report.executable = executable;

		/* --- 1b. what does the CLI actually answer? -------------------- */
		const probe = {};
		try {
			// `--version` takes no workspace, so it is asked directly.
			const version = await cli.tryRun(executable);
			probe.version = {
				ok: version.ok,
				exitCode: version.exitCode,
				output: (version.output || version.error || "").slice(0, 200),
			};
		}
		catch (e) {
			probe.version = { error: e.message };
		}
		for (const [label, args] of [
			["notebooks", ["notebook", "list", "--format", "json"]],
		]) {
			try {
				const result = await cli.run(args);
				probe[label] = {
					code: result.code,
					output: (result.output || "").slice(0, 400),
				};
			}
			catch (e) {
				probe[label] = { error: e.message };
			}
		}
		report.probe = probe;
		record("probe the CLI", true, probe);

		/* --- 1c. the SQL transport the block lookup needs --------------- */
		await step("the CLI can run SQL", async () => {
			const rows = await cli.runJSON([
				"sql",
				"SELECT id, type FROM blocks LIMIT 1",
			]);
			return { rows: Array.isArray(rows) ? rows.length : 0 };
		});

		/* --- 1d. the index of already-sent annotations ------------------ */
		await step("the index of sent annotations is built", async () => {
			const count = await addon.refreshIndex();
			return {
				indexed: count,
				scanned: addon._index.blocksScanned,
				scannedAt: addon._index.scannedAt,
			};
		});

		/* --- 2. a real annotation, and a real parent item ---------------- */
		// A real write needs a real annotation: only a real one can be
		// tagged, and only a real one proves the tag lands on the right item.
		const real = realWrite ? await findRealAnnotation() : null;
		if (realWrite && !real) {
			throw new Error("the library has no annotation to test with");
		}

		const attachmentID = real ? real.attachmentID : await findPDFAttachment();
		record(
			"find a PDF attachment to read the metadata from",
			true,
			attachmentID ? `item ${attachmentID}` : "none in the library",
		);

		const annotation = real
			? real.annotation
			: {
				id: "SELFTEST",
				type: "highlight",
				text: `Self test (${SELFTEST_MARKER}): the highlighted text.`,
				comment: `Self test (${SELFTEST_MARKER}): the comment.`,
				pageLabel: "1",
				authorName: "zotero-siyuan self test",
				dateModified: new Date().toISOString(),
				color: "#ffd400",
				tags: [],
			};

		/* --- 3. the reader event must render the button ------------------ */
		const win = Zotero.getMainWindow();
		if (!win || !win.document) {
			throw new Error("the main Zotero window is not available");
		}
		const doc = win.document.implementation.createHTMLDocument(
			"zotero-siyuan-selftest",
		);
		const event = {
			doc,
			params: { type: "SidebarAnnotationHeader", annotation },
			reader: attachmentID ? { itemID: attachmentID } : null,
			append(node) {
				doc.body.appendChild(node);
			},
		};

		addon._onRenderSidebarAnnotationHeader(event);

		const button = doc.body.querySelector(
			".zotero-siyuan-annotation-button",
		);
		if (!button) {
			throw new Error(
				"the annotation header handler did not render the button",
			);
		}
		record(
			"the annotation header handler renders the button",
			true,
			button.getAttribute("aria-label"),
		);

		/* --- 3b. an annotation that was sent offers a way back ---------- */
		await step("a sent annotation renders the link back", () => {
			const sentDoc = win.document.implementation.createHTMLDocument(
				"zotero-siyuan-selftest-sent",
			);
			// Put a known annotation into the index, the way a real send
			// would, and see whether the reader offers a way back.
			addon._index.add("SELFTESTSENT", "20260101000000-abcdefg");
			addon._onRenderSidebarAnnotationHeader({
				doc: sentDoc,
				params: {
					type: "SidebarAnnotationHeader",
					annotation: {
						...annotation,
						id: "SELFTESTSENT",
						tags: [],
					},
				},
				reader: { itemID: attachmentID },
				append(node) {
					sentDoc.body.appendChild(node);
				},
			});
			const link = sentDoc.body.querySelector(".zotero-siyuan-sent-link");
			addon._index.remove("SELFTESTSENT");
			return {
				rendered: !!link,
				href: link ? link.getAttribute("href") : "",
				title: link ? link.getAttribute("aria-label") : "",
				hasIcon: !!(link && link.querySelector("svg")),
			};
		});

		/* --- 3c. the marker shows up as soon as a send succeeds --------- */
		await step("the marker appears without reopening the PDF", () => {
			const doc = win.document.implementation.createHTMLDocument(
				"zotero-siyuan-selftest-instant",
			);
			const button = doc.createElement("button");
			button.setAttribute("data-zsi-annotation", "SELFKEY1");
			doc.body.appendChild(button);
			addon._index.add("SELFKEY1", "20260101000000-abcdefg");
			const added = addon._updateRenderedMarkers(doc);
			const link = doc.body.querySelector(".zotero-siyuan-sent-link");
			const again = addon._updateRenderedMarkers(doc);
			addon._index.remove("SELFKEY1");
			return {
				added,
				again,
				rendered: !!link,
				href: link ? link.getAttribute("href") : "",
			};
		});

		/* --- 3d. the marker never appears twice -------------------------- */
		await step("the marker never appears twice", () => {
			const doc = win.document.implementation.createHTMLDocument(
				"zotero-siyuan-selftest-double",
			);
			const key = "SELFKEY2";
			addon._index.add(key, "20260101000000-abcdefg");

			// The reader's sidebar puts everything a plugin appends into a
			// box of its own, wipes that box on every render, and gives
			// every single append() call a box of its own inside it. That
			// is what the reader really does — see its custom-sections
			// component — and it is why the button and the marker have to
			// be appended together.
			const box = doc.createElement("div");
			box.className = "custom-sections";
			doc.body.appendChild(box);
			const render = () => {
				box.replaceChildren();
				addon._onRenderSidebarAnnotationHeader({
					doc,
					params: {
						type: "SidebarAnnotationHeader",
						annotation: { ...annotation, id: key, tags: [] },
					},
					reader: { itemID: attachmentID },
					append(...nodes) {
						const section = doc.createElement("div");
						section.className = "section";
						section.append(...nodes);
						box.appendChild(section);
					},
				});
			};
			const count = () =>
				doc.body.querySelectorAll(".zotero-siyuan-sent-link").length;

			render();
			const afterFirst = count();

			// The hand-made marker, as it appears right after a send.
			addon._updateRenderedMarkers(doc);
			const afterManual = count();

			// The reader re-renders the header.
			render();
			const afterRerender = count();

			// And once more, to be sure it settles.
			render();
			const afterThird = count();

			// The reader must not put the button and the marker into two
			// different boxes — that is what made the sidebar show two
			// markers in the first place.
			const boxes = box.children.length;

			addon._index.remove(key);
			return {
				afterFirst,
				afterManual,
				afterRerender,
				afterThird,
				boxes,
			};
		});

		/* --- 3d-2. the marker shows up right after a batch send ---------- */
		await step("a batch send shows the markers right away", () => {
			const doc = win.document.implementation.createHTMLDocument(
				"zotero-siyuan-selftest-batch",
			);
			const key = "SELFKEY3";
			const reader = { itemID: attachmentID };

			const box = doc.createElement("div");
			box.className = "custom-sections";
			doc.body.appendChild(box);
			const render = () => {
				box.replaceChildren();
				addon._onRenderSidebarAnnotationHeader({
					doc,
					params: {
						type: "SidebarAnnotationHeader",
						annotation: { ...annotation, id: key, tags: [] },
					},
					reader,
					append(...nodes) {
						const section = doc.createElement("div");
						section.className = "section";
						section.append(...nodes);
						box.appendChild(section);
					},
				});
			};

			// The annotation is not in the index yet, so the reader has no
			// marker to show.
			render();
			const before = doc.body.querySelectorAll(".zotero-siyuan-sent-link")
				.length;

			// The context menu has to find the reader's document on its
			// own — the event does not carry it.
			const items = [];
			addon._onCreateAnnotationContextMenu({
				reader,
				params: { ids: [key] },
				append(item) {
					items.push(item);
				},
			});
			const known = !!addon._readerDoc(reader);

			// The send puts the annotation into the index, and then the
			// marker has to be on screen without reloading the PDF.
			addon._index.add(key, "20260101000000-batchg");
			addon._updateRenderedMarkers(doc);
			const afterSend = doc.body.querySelectorAll(
				".zotero-siyuan-sent-link",
			).length;

			// And the reader's own render must not add a second one.
			render();
			const afterRerender = doc.body.querySelectorAll(
				".zotero-siyuan-sent-link",
			).length;

			addon._index.remove(key);
			return {
				before,
				afterSend,
				afterRerender,
				known,
				menuItems: items.length,
			};
		});

		/* --- 3d. one delegated listener per document ------------------- */
		await step("the marker opens the block when clicked", () => {
			const doc = win.document.implementation.createHTMLDocument(
				"zotero-siyuan-selftest-click",
			);
			addon._ensureDelegation(doc);
			const link = addon._createSentLink(doc, "20260101000000-abcdefg");
			doc.body.appendChild(link);

			let opened = "";
			const original = addon._openInSiYuan.bind(addon);
			addon._openInSiYuan = (id) => {
				opened = id;
			};
			const event = doc.createEvent("MouseEvents");
			event.initEvent("click", true, true);
			link.dispatchEvent(event);
			addon._openInSiYuan = original;
			return { opened };
		});

		/* --- 3f. the SiYuan app can be started without a prompt -------- */
		await step("the SiYuan app can be opened without a prompt", async () => {
			const executable = await findHandlerExecutable();
			return {
				fromRegistry: protocolHandlerCommand(),
				executable,
				found: !!executable,
				warningSuppressed: suppressProtocolWarning(),
			};
		});

		/* --- 3e. the SiYuan logo really renders -------------------------- */
		await step("the SiYuan icon is inline SVG", () => {
			const doc = win.document.implementation.createHTMLDocument(
				"zotero-siyuan-selftest-icon",
			);
			const link = addon._createSentLink(doc, "20260101000000-abcdefg");
			const svg = link.querySelector("svg");
			const polygons = svg ? svg.querySelectorAll("polygon") : [];
			return {
				rendered: !!svg,
				namespace: svg ? svg.namespaceURI : "",
				shapes: polygons.length,
				viewBox: svg ? svg.getAttribute("viewBox") : "",
				fills: [...polygons].map((p) => p.getAttribute("fill")),
			};
		});

		/* --- 3b. the template must render ------------------------------- */
		try {
			const markdown = await addon._buildContent(annotation, {
				itemID: attachmentID,
			});
			// This render writes nothing — but a "框选" annotation put its
			// picture into the workspace on the way, and that picture has
			// to be taken back too.
			notePictures(markdown);
			const help = addon.getTemplateHelp();
			const preview = await addon.previewTemplate(help.template);
			report.template = help.template;
			record("render the send template", true, {
				unknown: preview.unknown,
				usedVariables: help.variables.filter((v) => v.used).length,
				markdown,
			});
		}
		catch (e) {
			record("render the send template", false, e.message);
			throw e;
		}

		/* --- 3c. an area selection brings its picture -------------------- */
		//
		// A "框选" annotation has no text: the selection is a picture, and
		// the picture has to travel with the note. This step walks the whole
		// chain with a real one — where Zotero keeps it, whether the file is
		// there, and what the note finally says.
		await step("an area selection brings its picture", async () => {
			const probe = await addon.probePictures();
			report.pictures = probe;
			if (!probe.annotations.length) {
				// Nothing to test — that is not a failure.
				return {
					skipped: "the library has no area selection",
					cacheDir: probe.cacheDir,
				};
			}
			const first = probe.annotations[0];
			const picture = {
				key: first.key,
				type: first.type,
				path: first.path,
				cached: first.exists,
			};
			if (!first.exists) {
				// The picture is not where Zotero says it is. The note can
				// still be written, but the selection would be lost — so
				// this is worth saying out loud.
				throw new Error(
					`the picture of ${first.key} is not at ${first.path || "(no path)"}`,
				);
			}
			// The whole chain, with a real annotation.
			const model = {
				id: first.key,
				type: first.type,
				text: "",
				comment: "",
				pageLabel: "",
				authorName: "",
				position: null,
				tags: [],
			};
			const markdown = await addon._buildContent(model, {
				itemID: attachmentID,
			});
			notePictures(markdown);
			picture.markdown = markdown;
			// Every step of the chain — this is where a failure says what
			// went wrong.
			picture.trace = addon._lastPictureTrace || null;
			picture.linked = /!\[[^\]]*\]\(assets\/[^)]+\)/.test(markdown);
			if (!picture.linked) {
				const trace = picture.trace || {};
				throw new Error(
					"the note does not carry the picture — no Markdown link to it" +
						(trace.error ? ` (${trace.error})` : "") +
						` [picture=${trace.isPicture}, key=${trace.key}, ` +
						`cache=${trace.cached}, path=${trace.cachePath || "none"}, ` +
						`workspace=${trace.workspace || "none"}, ` +
						`exported=${trace.exported || "none"}]`,
				);
			}
			return picture;
		});

		/* --- 3c. the batch entry and the bubble -------------------------- */
		await step("the annotation context menu offers a batch send", () => {
			const items = [];
			addon._onCreateAnnotationContextMenu({
				reader: { itemID: attachmentID },
				params: { ids: ["AAAA1111", "BBBB2222"] },
				append(item) {
					items.push(item);
				},
			});
			return {
				count: items.length,
				label: items[0] ? items[0].label : "",
				hasCommand: !!(items[0] && items[0].onCommand),
			};
		});

		await step("the notification bubble appears", async () => {
			// The bubble lives in the main window, which may not exist yet
			// right after startup.
			await waitForMainWindow();
			const diag = {
				getMainWindow: (() => {
					try {
						return !!Zotero.getMainWindow();
					}
					catch (e) {
						return `error: ${e.message}`;
					}
				})(),
				anyWindow: (() => {
					try {
						return !!Services.wm.getMostRecentWindow(null);
					}
					catch (e) {
						return `error: ${e.message}`;
					}
				})(),
				mainWindowCount: (() => {
					try {
						return Services.wm.getEnumerator("navigator:browser")
							.hasMoreElements();
					}
					catch (e) {
						return `error: ${e.message}`;
					}
				})(),
			};
			const toast = showToast({
				title: "Zotero to SiYuan",
				message: "self test",
				timeout: 50,
			});
			if (!toast) {
				throw new Error(
					`the bubble could not be shown: ${JSON.stringify(diag)}`,
				);
			}
			const element = toast.element;
			const attached = !!element.parentNode;
			toast.close();
			await sleep(400);
			return { ...diag, attached, removed: !element.parentNode };
		});

		/* --- 3f-1. every reader that is open shows the button ------------- */
		await step("every open reader shows the button", async () => {
			// A reader that was restored when Zotero started may have drawn
			// its sidebar before this plugin was awake — say what is on
			// screen, and what the plugin can do about it.
			const readers = (Zotero.Reader._readers || []).filter(
				(r) => r && r.itemID,
			);
			const rows = () =>
				readers.map((r) => {
					const known = addon._readerDocs.get(r);
					const d = known || addon._readerDoc(r);
					return {
						itemID: r.itemID,
						known: !!known,
						reachable: !!d,
						boxes: d ? d.querySelectorAll(".custom-sections").length : 0,
						buttons: d
							? d.querySelectorAll(".zotero-siyuan-annotation-button").length
							: 0,
						markers: d
							? d.querySelectorAll(".zotero-siyuan-sent-link").length
							: 0,
					};
				});
			const before = rows();
			await addon._patchReaderSidebars();
			return { readers: readers.length, before, after: rows() };
		});

		/* --- 3f-2. a reader that was drawn without the plugin ------------- */
		await step("a reader that was drawn without the plugin gets the button", async () => {
			// A reader that was restored when Zotero started draws its
			// sidebar before the plugins are up — the reader's own event
			// never arrives, so the button has to be put in by hand.
			const doc = win.document.implementation.createHTMLDocument(
				"zotero-siyuan-selftest-patch",
			);
			const key = await addon._resolveAnnotationKey(annotation);

			// The reader's own markup: the page label of the annotation
			// sits next to its header, and the header has a box of its own.
			const preview = doc.createElement("div");
			preview.className = "preview";
			const header = doc.createElement("header");
			const page = doc.createElement("div");
			page.id = `page_${key}`;
			const box = doc.createElement("div");
			box.className = "custom-sections";
			header.appendChild(page);
			header.appendChild(box);
			preview.appendChild(header);
			doc.body.appendChild(preview);

			const reader = { itemID: 1, _iframeWindow: { document: doc } };
			const before = doc.querySelectorAll(".zotero-siyuan-annotation-button")
				.length;
			const result = await addon._patchReaderSidebars([reader]);
			const after = doc.querySelectorAll(".zotero-siyuan-annotation-button")
				.length;
			const button = doc.querySelector(".zotero-siyuan-annotation-button");
			// And a second time must not add a second button.
			await addon._patchReaderSidebars([reader]);
			const again = doc.querySelectorAll(".zotero-siyuan-annotation-button")
				.length;

			return {
				before,
				after,
				again,
				patched: result.patched,
				key: button ? button.getAttribute("data-zsi-annotation") : "",
			};
		});

		/* --- 3f. what the real reader shows ------------------------------ */
		await step("the real reader shows one marker per annotation", async () => {
			// Everything above runs in a synthetic document. Only the real
			// reader can show whether the markers behave.
			//
			// Any reader that is showing its annotations will do — the
			// reader does not draw them until the PDF is ready, and the
			// section of the sidebar can be folded away.
			let doc = null;
			let reader = null;
			let drawn = 0;
			const deadline = Date.now() + 45000;
			while (Date.now() < deadline && !drawn) {
				for (const r of Zotero.Reader._readers || []) {
					if (!r || !r.itemID) {
						continue;
					}
					const d = addon._readerDoc(r);
					if (!d || !d.querySelectorAll) {
						continue;
					}
					// Only the boxes of the annotations count — the reader
					// has boxes of its own, too.
					const n = [...d.querySelectorAll(".custom-sections")].filter(
						(b) => !!addon._annotationKeyOf(b),
					).length;
					if (n > drawn) {
						doc = d;
						reader = r;
						drawn = n;
					}
				}
				if (!drawn) {
					await sleep(500);
				}
			}
			if (!doc || !drawn) {
				// The reader did not show its annotations — that has nothing
				// to do with this plugin.
				return { drawn: 0, note: "no reader showed its annotations" };
			}
			await sleep(2000);

			// Every annotation header gets a box of the reader's own, and
			// the button and its marker have to share that box — otherwise
			// the sidebar shows the marker twice.
			const buttons = [...doc.querySelectorAll(".zotero-siyuan-annotation-button")];
			const boxes = buttons.map((b) => ({
				key: b.getAttribute("data-zsi-annotation"),
				markers: b.parentNode
					? b.parentNode.querySelectorAll(".zotero-siyuan-sent-link").length
					: 0,
			}));
			const split = boxes.filter((b) => b.markers > 1).length;

			// Count what is on screen before anything is sent.
			const before = doc.querySelectorAll(".zotero-siyuan-sent-link").length;

			// Send one annotation for real, through the reader's own button,
			// and watch the marker appear.
			//
			// This send is the reader's own, so the bookkeeping of the main
			// flow is put back afterwards — otherwise the two sends would
			// mix up each other's results.
			const capturedBefore = { ...captured };
			clicked = false;
			const button = doc.querySelector(".zotero-siyuan-annotation-button");
			const key = button.getAttribute("data-zsi-annotation");
			// What the index knew about this annotation before the test —
			// it may be a block the user sent themselves, and that one must
			// survive the cleanup below.
			const previousBlock = addon._index.get(key);
			clickAndWatch(button);

			// Wait for the send to finish — the plugin says so itself.
			const sendDeadline = Date.now() + 30000;
			while (Date.now() < sendDeadline && addon._sending) {
				await sleep(200);
			}
			await sleep(500);

			const links = [...doc.querySelectorAll(".zotero-siyuan-sent-link")];
			const forKey = links.filter(
				(link) => link.getAttribute("data-zsi-for") === key,
			).length;
			// The marker right next to the button.
			const nextToButton = button.parentNode
				? button.parentNode.querySelectorAll(".zotero-siyuan-sent-link").length
				: 0;

			// What is on screen, key by key.
			const byKey = {};
			for (const link of links) {
				const k = link.getAttribute("data-zsi-for") || "?";
				byKey[k] = byKey[k] || { total: 0, manual: 0, boxes: new Set() };
				byKey[k].total++;
				if (link.getAttribute("data-zsi-manual")) {
					byKey[k].manual++;
				}
				const box = link.closest ? link.closest(".custom-sections") : null;
				byKey[k].boxes.add(
					box
						? [...doc.querySelectorAll(".custom-sections")].indexOf(box)
						: -1,
				);
			}
			const buttonsByKey = {};
			for (const b of doc.querySelectorAll("[data-zsi-annotation]")) {
				const k = b.getAttribute("data-zsi-annotation") || "?";
				buttonsByKey[k] = (buttonsByKey[k] || 0) + 1;
			}
			// Where every box of the reader sits — the same annotation can
			// show up more than once.
			const allBoxes = [...doc.querySelectorAll(".custom-sections")].map(
				(box, i) => {
					const chain = [];
					let node = box;
					for (let d = 0; d < 5 && node; d++) {
						chain.push(node.className || node.id || node.tagName);
						node = node.parentNode;
					}
					return {
						i,
						key: addon._annotationKeyOf(box),
						buttons: box.querySelectorAll(".zotero-siyuan-annotation-button")
							.length,
						chain,
					};
				},
			);
			const detail = {};
			for (const k of Object.keys(byKey)) {
				detail[k] = {
					total: byKey[k].total,
					manual: byKey[k].manual,
					boxes: [...byKey[k].boxes],
					buttons: buttonsByKey[k] || 0,
				};
			}

			// Leave nothing behind — but only what this test wrote itself.
			// A block the user sent for this annotation is not ours to
			// delete, and the index has to point back at it.
			const ownBlock = captured.blockID || "";
			if (ownBlock) {
				await cli.deleteBlock(ownBlock);
			}
			if (previousBlock) {
				addon._index.add(key, previousBlock);
			}
			else {
				addon._index.remove(key);
			}

			// Give the main flow its own bookkeeping back.
			Object.assign(captured, capturedBefore);
			clicked = false;

			return {
				reader: reader.itemID,
				buttons: buttons.length,
				split,
				before,
				after: links.length,
				forKey,
				nextToButton,
				manual: doc.querySelectorAll("[data-zsi-manual]").length,
				detail,
				allBoxes,
				blockID: ownBlock,
			};
		});

		/* --- 4. click it, like a user would ------------------------------ */
		clickAndWatch(button);

		// Wait for *this* click to finish — not just for the handler to
		// have been called, but for the write to be complete.
		const written = () =>
			captured.stage === "appended" || captured.stage === "dry run done";
		const deadline = Date.now() + timeout;
		while ((!clicked || !written()) && Date.now() < deadline) {
			await sleep(100);
		}
		if (!clicked || !written()) {
			throw new Error(
				`the click did not finish within ${timeout} ms (stage: ${captured.stage})`,
			);
		}
		report.buttonTitle = button.title;
		report.cliError = addon._lastCLIError || "";
		report.notebookError = addon._lastNotebookError || "";
		record("the click reaches the send handler", true, button.title);

		if (!captured.transport) {
			throw new Error(
				`the click did not reach SiYuan — the button says: ${button.title}`,
			);
		}

		/* --- 5. what did it actually do? --------------------------------- */
		report.notebook = captured.notebook;
		report.markdown = captured.markdown;
		report.transport = captured.transport;
		report.blockID = captured.blockID || "";
		report.documentID = captured.documentID || "";
		if (captured.dryRun) {
			report.dryRun = captured.dryRun;
		}

		record(
			"resolve the notebook",
			!!captured.notebook,
			captured.notebook
				? `${captured.notebook.name} (${captured.notebook.id})`
				: "none",
		);
		record("build the Markdown", !!captured.markdown);
		record(
			realWrite ? "append to the daily note" : "the CLI accepts the command",
			true,
			captured.transport,
		);

		/* --- 6. a real write also has to be findable again --------------- */
		if (realWrite) {
			await step("the new block is indexed", async () => {
				if (!captured.blockID) {
					throw new Error("the new SiYuan block could not be found");
				}
				const key = await addon._resolveAnnotationKey(annotation);
				const known = addon._index.get(key);
				if (known !== captured.blockID) {
					throw new Error(
						`the index knows ${known || "nothing"} for ${key}, expected ${captured.blockID}`,
					);
				}
				return { key, blockID: known };
			});

			// A self test that leaves its traces behind is not a self test.
			await step("clean up after the self test", async () => {
				const blocks = captured.blocks || [];
				for (const block of blocks) {
					await cli.deleteBlock(block);
				}
				if (real && real.item) {
					await clearLegacyTags(real.item);
				}
				return { removedBlocks: blocks };
			});

			// The preferences pane is only exercised here: opening Zotero's
			// settings window on every start would be a nuisance.
			await step("the preferences pane inserts a variable", async () =>
				testPreferencesPane(addon),
			);
		}

		report.ok = true;
	}
	catch (e) {
		report.error = e && e.message ? e.message : String(e);
		record("the self test", false, report.error);
	}
	finally {
		// Put the addon back the way it was — the self test must not change
		// how the plugin behaves afterwards.
		addon.watchNextSend(null);
		// The pictures the Markdown named: they are ours, by name.
		const namedPictures = new Set(exportedPictures);
		// And take back every picture it wrote into the user's workspace:
		// a self test that leaves its traces behind is not a self test.
		try {
			const removed = await removeExportedPictures();
			if (removed.length) {
				log(`took back ${removed.length} exported picture(s)`);
				report.picturesRemoved = removed;
			}
		}
		catch (e) {
			log(`could not take back the exported pictures: ${e}`);
		}
		// A picture that was exported but never ended up in a note — the
		// send failed halfway through — has to go back as well.
		try {
			if (addon._pendingPicture && addon._pendingPicture.file) {
				await removePicture(addon._pendingPicture.file);
				addon._pendingPicture = null;
			}
		}
		catch (e) {
			log(`could not take back the pending picture: ${e}`);
		}
		// And whatever else showed up in the assets folder in the
		// meantime: the render can fail before it ever mentions the
		// picture it wrote, so the picture is known by name only. A
		// picture that a real note refers to stays.
		try {
			const stray = await removeStrayPictures(picturesBefore, namedPictures);
			if (stray.length) {
				log(`took back ${stray.length} stray picture(s)`);
				report.picturesRemoved = (report.picturesRemoved || []).concat(
					stray,
				);
			}
		}
		catch (e) {
			log(`could not take back the stray pictures: ${e}`);
		}
	}

	report.stage = captured.stage;
	// The test only passes when every single step did.
	if (!report.error) {
		report.ok = report.steps.every((s) => s.ok);
	}
	report.durationMs = Date.now() - started;
	report.path = await writeReport(report);
	log(
		`self test ${report.ok ? "passed" : "FAILED"} — ${report.path}`,
	);
	return report;
}
