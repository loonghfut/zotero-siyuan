/**
 * Zotero → SiYuan — the preferences pane, driven the way a user drives it.
 */

import { VERSION } from "../../version.js";
import { sleep } from "./report.js";


export async function testPreferencesPane(addon) {
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

		// --- the picture settings --------------------------------------
		// The compression quality has to be shown as it was stored, and
		// setting it has to be stored again — that is the whole point of
		// the setting.
		const slider = doc.getElementById(
			"zotero-prefpane-zoteroSiYuan-image-quality-range",
		);
		const number = doc.getElementById(
			"zotero-prefpane-zoteroSiYuan-image-quality",
		);
		const compressBox = doc.getElementById(
			"zotero-prefpane-zoteroSiYuan-image-compress",
		);
		if (!slider || !number || !compressBox) {
			throw new Error("the pane has no settings for the pictures");
		}
		const storedQuality = String(addon.getPref("imageQuality", "82"));
		const picture = {
			quality: number.value,
			slider: slider.value,
			compress: compressBox.checked,
			stored: storedQuality,
		};
		if (number.value !== storedQuality) {
			throw new Error(
				`the pane shows the quality ${number.value}, but ${storedQuality} is stored`,
			);
		}

		// Setting it has to be stored again — and the old value put back.
		number.value = "60";
		number.dispatchEvent(new win.Event("change", { bubbles: true }));
		await sleep(250);
		picture.after = String(addon.getPref("imageQuality", "82"));
		if (picture.after !== "60") {
			throw new Error(
				`the quality was set to 60, but ${picture.after} is stored`,
			);
		}
		number.value = storedQuality;
		number.dispatchEvent(new win.Event("change", { bubbles: true }));
		await sleep(250);
		picture.restored = String(addon.getPref("imageQuality", "82"));
		if (picture.restored !== storedQuality) {
			throw new Error(
				`the quality was put back to ${storedQuality}, but ${picture.restored} is stored`,
			);
		}

		return {
			variables: rows.length,
			variable: name,
			inserted,
			saved,
			before,
			after,
			conditionals,
			picture,
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
 * The version of the plugin that is really installed.
 *
 * It is written into the code on every build. The addon manager keeps the
 * version of the *manifest* in its own cache, and that cache can be a
 * version behind — the script itself is read fresh. So the version that
 * comes with the code is the one that counts.
 *
 * @returns {String}
 */
function pluginVersion() {
	return String(VERSION || "");
}

