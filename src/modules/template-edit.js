/**
 * Zotero → SiYuan — editing the send template.
 *
 * The pure part of "insert a variable at the cursor", kept out of the
 * preferences pane so it can be tested without a browser.
 */

/**
 * Insert a token into a text, replacing the selection.
 *
 * The caret ends up right after the inserted token, so several variables
 * can be inserted one after another.
 *
 * @param {String} text - the current text
 * @param {String} token - what to insert
 * @param {Number} start - where the insertion starts
 * @param {Number} end - what the insertion replaces
 * @returns {{value: String, caret: Number}} the new text and the new caret
 */
export function insertToken(text, token, start, end) {
	const value = String(text == null ? "" : text);
	const insert = String(token == null ? "" : token);

	let from = Number.isInteger(start) ? start : value.length;
	let to = Number.isInteger(end) ? end : from;

	// Out-of-range positions are clamped rather than trusted.
	from = Math.max(0, Math.min(from, value.length));
	to = Math.max(from, Math.min(to, value.length));

	return {
		value: value.slice(0, from) + insert + value.slice(to),
		caret: from + insert.length,
	};
}

/**
 * The token of a template variable.
 * @param {String} name
 * @returns {String}
 */
export function variableToken(name) {
	return `{{${String(name || "").trim()}}}`;
}

/**
 * The variables that carry a whole block of their own.
 *
 * They bring their "> " on every line, so they have to start a line of
 * their own — dropped into the middle of a line, the blockquote is lost
 * and the note comes out wrong.
 */
export const BLOCK_VARIABLES = [
	"quoteCallout",
	"commentCallout",
	"imageCallout",
	"metadata",
];

/**
 * Is this variable a whole block?
 * @param {String} name
 * @returns {Boolean}
 */
export function isBlockVariable(name) {
	return BLOCK_VARIABLES.includes(String(name || "").trim());
}

/**
 * Insert a variable into a template, keeping the template readable.
 *
 * A callout variable carries its own "> " on every one of its lines, so
 * it has to start a line of its own — dropped into the middle of a line,
 * the blockquote is lost and the note comes out wrong. The indentation
 * of the line it lands on is kept.
 *
 * @param {String} text - the current text
 * @param {String} token - what to insert, e.g. `{{quoteCallout}}`
 * @param {Number} start - where the insertion starts
 * @param {Number} end - what the insertion replaces
 * @returns {{value: String, caret: Number}} the new text and the new caret
 */
export function insertVariable(text, token, start, end) {
	const value = String(text == null ? "" : text);
	const insert = String(token == null ? "" : token);

	let from = Number.isInteger(start) ? start : value.length;
	let to = Number.isInteger(end) ? end : from;
	from = Math.max(0, Math.min(from, value.length));
	to = Math.max(from, Math.min(to, value.length));

	const lineStart = value.lastIndexOf("\n", from - 1) + 1;
	const head = value.slice(lineStart, from);
	const indent = /^[ \t]*/.exec(head)[0];
	const atLineStart = head.trim() === "";

	// A whole block needs a line of its own.
	const name = /^\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}$/.exec(insert);
	const ownLine =
		insert.startsWith(">") ||
		insert.indexOf("\n") !== -1 ||
		(name ? isBlockVariable(name[1]) : false);

	let prefix = "";
	if (ownLine && !atLineStart) {
		// Break the line, and keep its indentation.
		prefix = `\n${indent}`;
	}

	return {
		value: value.slice(0, from) + prefix + insert + value.slice(to),
		caret: from + prefix.length + insert.length,
	};
}
