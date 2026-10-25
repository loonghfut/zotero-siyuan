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
