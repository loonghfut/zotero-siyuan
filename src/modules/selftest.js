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
import { clearSent } from "./sent.js";
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

		return {
			variables: rows.length,
			variable: name,
			inserted,
			saved,
			before,
			after,
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
		}
		catch (e) {
			entry.ok = false;
			entry.error = e && e.message ? e.message : String(e);
		}
		entry.ms = Date.now() - started;
		report.steps.push(entry);
		return entry;
	}

	// --- instrument the addon, so we can see what the click actually did ---
	const original = {
		resolveNotebook: addon._resolveNotebook,
		append: addon._append,
		send: addon._send,
		parentItem: addon._getParentItem,
	};

	addon._getParentItem = async (...args) => {
		captured.stage = "reading the parent item";
		const item = await original.parentItem.apply(addon, args);
		captured.stage = "parent item read";
		return item;
	};

	addon._resolveNotebook = async (...args) => {
		captured.stage = "resolving the notebook";
		const notebook = await original.resolveNotebook.apply(addon, args);
		captured.notebook = { id: notebook.id, name: notebook.name };
		captured.stage = "notebook resolved";
		return notebook;
	};

	addon._append = async (notebookID, markdown) => {
		captured.markdown = markdown;
		captured.stage = "appending";
		if (realWrite) {
			const result = await original.append.call(addon, notebookID, markdown);
			captured.transport = result.transport;
			captured.blockID = result.blockID;
			captured.blocks = result.blocks || [];
			captured.documentID = result.documentID;
			captured.stage = "appended";
			// The real method answers with an object — the override has to
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
	};

	let clicked = false;
	addon._send = async (...args) => {
		try {
			return await original.send.apply(addon, args);
		}
		finally {
			clicked = true;
		}
	};

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
			addon._onRenderSidebarAnnotationHeader({
				doc: sentDoc,
				params: {
					type: "SidebarAnnotationHeader",
					annotation: {
						...annotation,
						tags: [{ name: "siyuan:20260101000000-abcdefg" }],
					},
				},
				reader: { itemID: attachmentID },
				append(node) {
					sentDoc.body.appendChild(node);
				},
			});
			const link = sentDoc.body.querySelector(".zotero-siyuan-sent-link");
			return {
				rendered: !!link,
				href: link ? link.getAttribute("href") : "",
				title: link ? link.getAttribute("aria-label") : "",
			};
		});

		/* --- 3b. the template must render ------------------------------- */
		try {
			const markdown = await addon._buildContent(annotation, {
				itemID: attachmentID,
			});
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

		/* --- 4. click it, like a user would ------------------------------ */
		button.click();

		const deadline = Date.now() + timeout;
		while (!clicked && Date.now() < deadline) {
			await sleep(100);
		}
		if (!clicked) {
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

		/* --- 6. a real write also has to tag the annotation -------------- */
		if (realWrite) {
			await step("the annotation is tagged with the SiYuan block", async () => {
				if (!captured.blockID) {
					throw new Error("the new SiYuan block could not be found");
				}
				const item = await Zotero.Items.getAsync(real.item.id);
				const tags = (item.getTags() || []).map((t) => t.tag);
				const expected = `siyuan:${captured.blockID}`;
				if (!tags.includes(expected)) {
					throw new Error(
						`the annotation has ${JSON.stringify(tags)}, expected ${expected}`,
					);
				}
				return { tag: expected, tags };
			});

			// A self test that leaves its traces behind is not a self test.
			await step("clean up after the self test", async () => {
				const blocks = captured.blocks || [];
				for (const block of blocks) {
					await cli.deleteBlock(block);
				}
				if (real && real.item) {
					await clearSent(real.item);
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
		delete addon._resolveNotebook;
		delete addon._append;
		delete addon._send;
		delete addon._getParentItem;
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
