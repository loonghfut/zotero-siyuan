/**
 * Zotero → SiYuan — editing the send template.
 *
 * The pure part of "insert a variable at the cursor", kept out of the
 * preferences pane so it can be tested without a browser.
 */

import { CONDITIONAL_ELSE, CONDITIONAL_END } from "./template.js";

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

/**
 * The token that opens a conditional.
 *
 * @param {String} name - the variable to test
 * @returns {String}
 */
export function conditionalToken(name) {
	return `{{#if ${String(name || "").trim()}}}`;
}

/**
 * The line a position is on, and the indentation of that line.
 *
 * @param {String} text
 * @param {Number} from
 * @returns {{indent: String, atLineStart: Boolean}}
 */
function lineContext(text, from) {
	const lineStart = text.lastIndexOf("\n", from - 1) + 1;
	const lineEnd = text.indexOf("\n", lineStart);
	const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
	const head = text.slice(lineStart, from);
	return {
		indent: /^[ \t]*/.exec(line)[0],
		// Is there anything but whitespace before the cursor on this line?
		atLineStart: head.trim() === "",
	};
}

/**
 * Whether something follows the insertion on its line.
 *
 * A tag that shares a line with the text around it is hard to read — and
 * easy to break by accident. So when there is more on that line, the tag
 * gets a line of its own.
 *
 * @param {String} text
 * @param {Number} to - where the insertion ends
 * @returns {String} a newline, or ""
 */
function tailAfter(text, to) {
	const lineEnd = text.indexOf("\n", to);
	const rest = text.slice(to, lineEnd === -1 ? text.length : lineEnd);
	return rest.trim() === "" ? "" : "\n";
}

/**
 * Put a conditional around the selection — or an empty one in its place.
 *
 * The tags stand on lines of their own, so the Markdown between them keeps
 * the shape it had. The text that was selected is left exactly as it was:
 * only the tags follow the indentation of the line the selection starts on.
 *
 * Without a selection an empty block is made, and the caret lands on the
 * line between the two tags — ready to be written on.
 *
 * @param {String} text - the current text
 * @param {String} name - the variable to test
 * @param {Number} start - where the insertion starts
 * @param {Number} end - what the insertion replaces
 * @returns {{value: String, caret: Number}} the new text and the new caret
 */
export function insertConditional(text, name, start, end) {
	const value = String(text == null ? "" : text);
	const open = conditionalToken(name);

	let from = Number.isInteger(start) ? start : value.length;
	let to = Number.isInteger(end) ? end : from;
	from = Math.max(0, Math.min(from, value.length));
	to = Math.max(from, Math.min(to, value.length));

	const selected = value.slice(from, to);
	const { indent, atLineStart } = lineContext(value, from);

	// The block starts on a line of its own.
	const prefix = atLineStart ? "" : `\n${indent}`;

	// The body: the selected text, or an empty line to write on.
	const body = selected ? `${selected}\n` : `${indent}\n`;
	const tail = tailAfter(value, to);
	const inserted = `${prefix}${open}\n${body}${indent}${CONDITIONAL_END}${tail}`;

	// The caret ends up inside the block: at the end of what was selected,
	// or on the empty line between the tags.
	const caret =
		from +
		prefix.length +
		open.length +
		1 +
		(selected ? selected.length : indent.length);

	return {
		value: value.slice(0, from) + inserted + value.slice(to),
		caret,
	};
}

/**
 * Put a single conditional tag on a line of its own.
 *
 * The `{{else}}` and the `{{/if}}` are the two ends of a block, and a tag
 * that shares a line with the text around it is hard to read — and easy to
 * break by accident.
 *
 * @param {String} text - the current text
 * @param {String} tag - `{{else}}` or `{{/if}}`
 * @param {Number} start - where the insertion starts
 * @param {Number} end - what the insertion replaces
 * @returns {{value: String, caret: Number}} the new text and the new caret
 */
export function insertConditionalTag(text, tag, start, end) {
	const value = String(text == null ? "" : text);
	const insert = String(tag == null ? "" : tag);

	let from = Number.isInteger(start) ? start : value.length;
	let to = Number.isInteger(end) ? end : from;
	from = Math.max(0, Math.min(from, value.length));
	to = Math.max(from, Math.min(to, value.length));

	const { indent, atLineStart } = lineContext(value, from);
	const prefix = atLineStart ? "" : `\n${indent}`;
	const tail = tailAfter(value, to);
	const inserted = `${prefix}${insert}${tail}`;

	return {
		value: value.slice(0, from) + inserted + value.slice(to),
		caret: from + inserted.length,
	};
}

export { CONDITIONAL_ELSE, CONDITIONAL_END };
