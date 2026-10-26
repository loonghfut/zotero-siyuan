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

import { removePicture } from "../siyuan-image.js";

import { log, pluginVersion, sleep, writeReport } from "./report.js";
import { findPDFAttachment, findRealAnnotation } from "./fixtures.js";
import { testPreferencesPane } from "./pane.js";
import { createPictureBookkeeping } from "./pictures.js";
import { cleanUpAfterTheSelfTest } from "./steps/cleanup.js";
import {
	checkSentAnnotationRendersTheLinkBack,
	checkMarkerAppearsWithoutReopeningThePDF,
	checkMarkerNeverAppearsTwice,
	checkBatchSendShowsTheMarkersRightAway,
	checkMarkerOpensTheBlockWhenClicked,
	checkSiYuanAppCanBeOpenedWithoutAPrompt,
	checkSiYuanIconIsInlineSVG,
} from "./steps/markers.js";
import {
	checkAreaSelectionBringsItsPicture,
	checkAnnotationContextMenuOffersABatchSend,
	checkNotificationBubbleAppears,
} from "./steps/note.js";
import {
	checkEveryOpenReaderShowsTheButton,
	checkReaderThatWasDrawnWithoutThePluginGetsTheButton,
	checkRealReaderShowsOneMarkerPerAnnotation,
} from "./steps/readers.js";


/**
 * Run the full chain.
 *
 * @param {Object} options
 * @param {Object} options.addon - the plugin instance
 * @param {String} options.notebookPref - the configured notebook name/id
 * @param {Boolean} options.realWrite - really append to the daily note
 * @param {Boolean} options.ui - may the test touch the real reader (and
 *   open the preferences window)? Only from the preferences button.
 * @param {Number} options.timeout - how long the click may take
 * @returns {Promise<Object>} the report
 */
export async function runSelfTest({
	addon,
	notebookPref = "",
	realWrite = false,
	ui = false,
	timeout = 45000,
}) {
	const started = Date.now();
	const report = {
		at: new Date().toISOString(),
		zoteroVersion: Zotero.version,
		// Which code is really running. After replacing the XPI, this is
		// not always the code one expects — Firefox can keep the old
		// script for one more start.
		pluginVersion: pluginVersion(),
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
		// Whether `blocks` is "what this write created" (read before and
		// after the write) or only "what carries the same timestamp". Only
		// the first kind may be deleted.
		blocksExact: false,
		blockID: "",
		documentID: "",
	};

	// The pictures this test caused to be written into the workspace, and the
	// way back for them — see `pictures.js`.
	const pictures = createPictureBookkeeping(addon);
	const {
		exportedPictures,
		notePictures,
		removeStrayPictures,
		removeExportedPictures,
	} = pictures;


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
					// No hooks, and the sibling blocks as well: this is the
					// one caller that deletes what it wrote, and a note is
					// usually more than one block.
					null,
					{ collectBlocks: true },
				);
				captured.transport = result.transport;
				captured.blockID = result.blockID;
				captured.blocks = result.blocks || [];
				captured.blocksExact = !!result.blocksExact;
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
		picturesBefore = await pictures.picturesInWorkspace();
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

		/*
		 * What the steps in `steps/` get to see.
		 *
		 * They are separate files, so they cannot close over this run's
		 * locals. Rather than threading eight parameters through every
		 * call, the run is handed over as one object — read-only for
		 * almost all of them, which is why the mutable parts (`captured`)
		 * are shared objects rather than copies.
		 */
		const ctx = {
			addon,
			report,
			captured,
			realWrite,
			ui,
			notePictures,
			clickAndWatch,
			cli,
			real,
			attachmentID,
			annotation,
			win,
			doc,
			button,
			// The real-reader step clicks a button of its own; the run has
			// to forget that click, or the wait below would think its own
			// click had already happened.
			resetClick: () => {
				clicked = false;
			},
		};

		/* --- 3b. an annotation that was sent offers a way back ---------- */
		await step("a sent annotation renders the link back", () => checkSentAnnotationRendersTheLinkBack(ctx));

		/* --- 3c. the marker shows up as soon as a send succeeds --------- */
		await step("the marker appears without reopening the PDF", () => checkMarkerAppearsWithoutReopeningThePDF(ctx));

		/* --- 3d. the marker never appears twice -------------------------- */
		await step("the marker never appears twice", () => checkMarkerNeverAppearsTwice(ctx));

		/* --- 3d-2. the marker shows up right after a batch send ---------- */
		await step("a batch send shows the markers right away", () => checkBatchSendShowsTheMarkersRightAway(ctx));

		/* --- 3d. one delegated listener per document ------------------- */
		await step("the marker opens the block when clicked", () => checkMarkerOpensTheBlockWhenClicked(ctx));

		/* --- 3f. the SiYuan app can be started without a prompt -------- */
		await step("the SiYuan app can be opened without a prompt", () => checkSiYuanAppCanBeOpenedWithoutAPrompt(ctx));

		/* --- 3e. the SiYuan logo really renders -------------------------- */
		await step("the SiYuan icon is inline SVG", () => checkSiYuanIconIsInlineSVG(ctx));

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
		await step("an area selection brings its picture", () => checkAreaSelectionBringsItsPicture(ctx));

		/* --- 3c. the batch entry and the bubble -------------------------- */
		await step("the annotation context menu offers a batch send", () => checkAnnotationContextMenuOffersABatchSend(ctx));

		await step("the notification bubble appears", () => checkNotificationBubbleAppears(ctx));

		/* --- 3f-1. every reader that is open shows the button ------------- */
		await step("every open reader shows the button", () => checkEveryOpenReaderShowsTheButton(ctx));

		/* --- 3f-2. a reader that was drawn without the plugin ------------- */
		await step("a reader that was drawn without the plugin gets the button", () => checkReaderThatWasDrawnWithoutThePluginGetsTheButton(ctx));

		/* --- 3f. what the real reader shows ------------------------------ */
		await step("the real reader shows one marker per annotation", () => checkRealReaderShowsOneMarkerPerAnnotation(ctx));

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

			// A self test that leaves its traces behind is not a self test —
			// but taking them back must not cost the user a note, so only
			// blocks this run can prove it created are removed. The how and
			// why live in `steps/cleanup.js`.
			await step("clean up after the self test", () =>
				cleanUpAfterTheSelfTest(ctx),
			);

			// The preferences pane is only exercised here: opening Zotero's
			// settings window on every start would be a nuisance.
			if (ui) {
				await step("the preferences pane inserts a variable", async () =>
					testPreferencesPane(addon),
				);
			}
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

