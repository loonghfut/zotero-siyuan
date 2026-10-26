/**
 * Zotero → SiYuan — the send template.
 *
 * A template is plain Markdown with `{{variable}}` placeholders. It is
 * rendered with the metadata of the annotation and appended to the SiYuan
 * daily note.
 *
 * Three pieces of syntax:
 *
 *   {{name}}            — the value of a variable
 *   {{#if name}}…{{/if}} — the body, only when the variable is not empty
 *   {{else}}            — the other branch, taken when it is empty
 *
 * The conditional matters because an annotation may have no comment: without
 * it the template would leave an empty `> [!note]` block behind.
 */

/**
 * Every variable a template understands. The preferences pane shows this
 * list as a cheat sheet, so the wording here is what the user reads.
 */
export const TEMPLATE_VARIABLES = [
	// the annotation
	{ name: "quote", group: "注释", hint: "选中的原文（多行，原样输出）" },
	{ name: "quoteCallout", group: "注释", hint: "选中的原文，每行自动加 “> ”" },
	{ name: "quoteInline", group: "注释", hint: "选中的原文，转义成一行" },
	{ name: "comment", group: "注释", hint: "你写的评论（多行，原样输出）" },
	{ name: "commentCallout", group: "注释", hint: "你写的评论，每行自动加 “> ”" },
	{ name: "commentInline", group: "注释", hint: "你写的评论，转义成一行" },
	{ name: "page", group: "注释", hint: "注释所在页的标签，如 “12” 或 “xii”" },
	{ name: "pageNumber", group: "注释", hint: "注释所在页的数字" },
	{ name: "annotator", group: "注释", hint: "批注人的名字" },
	{ name: "annotatorDate", group: "注释", hint: "批注的最后修改时间" },
	{ name: "annotationType", group: "注释", hint: "highlight / underline / note" },
	{ name: "annotationId", group: "注释", hint: "这条注释的唯一 key" },
	{ name: "annotationTags", group: "注释", hint: "这条注释自己的标签" },
	{ name: "image", group: "注释", hint: "框选注释的截图（Markdown 图片），没有则为空" },
	{ name: "imageCallout", group: "注释", hint: "框选注释的截图，每行加 “> ”" },

	// the item
	{ name: "title", group: "文献", hint: "文献标题" },
	{ name: "titleInline", group: "文献", hint: "标题，转义后可安全放进链接" },
	{ name: "authors", group: "文献", hint: "全部作者，用「、」分隔" },
	{ name: "author", group: "文献", hint: "第一作者" },
	{ name: "year", group: "文献", hint: "从日期里取出的四位年份" },
	{ name: "publication", group: "文献", hint: "期刊 / 会议 / 出版社" },
	{ name: "volume", group: "文献", hint: "卷号" },
	{ name: "issue", group: "文献", hint: "期号" },
	{ name: "pages", group: "文献", hint: "页码范围" },
	{ name: "doi", group: "文献", hint: "DOI" },
	{ name: "isbn", group: "文献", hint: "ISBN" },
	{ name: "url", group: "文献", hint: "文献的 URL" },
	{ name: "abstract", group: "文献", hint: "摘要全文" },
	{ name: "itemType", group: "文献", hint: "journalArticle / book …" },
	{ name: "tags", group: "文献", hint: "条目的标签" },
	{ name: "itemKey", group: "文献", hint: "条目的 key" },
	{ name: "attachmentKey", group: "文献", hint: "PDF 附件的 key" },

	// when
	{ name: "date", group: "时间", hint: "当天日期，如 2026-10-25" },
	{ name: "time", group: "时间", hint: "发送时刻，如 18:54" },
	{ name: "timestamp", group: "时间", hint: "完整时间戳，如 2026-10-25 18:54:33" },

	// links
	{ name: "zoteroLink", group: "链接", hint: "打开条目的 zotero:// 链接" },
	{
		name: "zoteroAnnotationLink",
		group: "链接",
		hint: "直接跳到这条注释的 PDF 位置",
	},

	// composite
	{
		name: "metadata",
		group: "组合",
		hint: "作者/年份/出处/页码/批注人/来源，整块",
	},
];

/**
 * The template used until the user writes their own: the same shape the
 * plugin produced before templates existed.
 *
 * The picture of a "框选" annotation sits on the same line as the quote:
 * a "框选" annotation has no text of its own, so only one of the two is
 * ever filled — and a line of its own would break the callout apart.
 */
export const DEFAULT_TEMPLATE = [
	"> [!quote] 摘录 · {{title}}",
	"{{imageCallout}}{{quoteCallout}}",
	"",
	"{{#if comment}}> [!note] 批注",
	"{{commentCallout}}",
	"",
	"{{/if}}{{metadata}}",
].join("\n");

const VARIABLE = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;
// Not a global regex on purpose: `exec` on a global one keeps its
// `lastIndex` between calls, and the search below starts at a different
// place every time.
const CONDITIONAL = /\{\{#if\s+([A-Za-z][A-Za-z0-9]*)\s*\}\}/;

/**
 * The tag that starts the other branch of a conditional.
 *
 * It looks like a variable — it is written with braces, just like one —
 * but it is not: it is a marker, and it must never be looked up among the
 * variables.
 */
export const CONDITIONAL_ELSE = "{{else}}";

/**
 * The tag that closes a conditional.
 */
export const CONDITIONAL_END = "{{/if}}";

/**
 * The name of that marker, as the variable pattern sees it.
 */
const ELSE_NAME = "else";

/**
 * A variable that has no value.
 *
 * It is not an empty string: an empty string would leave a blank line
 * behind, and a blank line is a place in the note that nothing fills.
 * The marker says "this was a variable, and it was empty", so the line
 * can be taken away afterwards.
 */
const EMPTY = "\u0001";

/**
 * A conditional that was not taken.
 *
 * Its body is gone — but the place it took is still there, and it has
 * to be taken away with it.
 */
const SKIPPED = "\u0002";

/**
 * Is this variable "there"?
 *
 * An empty string counts as "not there" — that is what makes the
 * conditional hide a block when there is no comment.
 */
function isFilled(value) {
	return value !== undefined &&
		value !== null &&
		String(value).trim() !== "";
}

/**
 * The end of the conditional that starts at `from`.
 *
 * The conditionals may be nested, so the matching `{{/if}}` is the one that
 * closes the *outermost* open conditional — not simply the first one that
 * turns up. A regular expression cannot count, so the tags are walked by
 * hand.
 *
 * @param {String} text - the whole template
 * @param {Number} from - where the body of the conditional starts
 * @returns {{bodyEnd: Number, afterEnd: Number}} the end of the body and
 *   the end of the whole block
 */
function findConditionalEnd(text, from) {
	const token = /\{#if\s+[A-Za-z][A-Za-z0-9]*\s*\}|\{\{\/if\}\}/g;
	let depth = 1;
	token.lastIndex = from;
	let match;
	while ((match = token.exec(text))) {
		if (match[0] === "{{/if}}") {
			depth--;
			if (depth === 0) {
				return { bodyEnd: match.index, afterEnd: match.index + match[0].length };
			}
		}
		else {
			depth++;
		}
	}
	// No matching end — the template is broken, so the rest is left alone.
	return { bodyEnd: -1, afterEnd: -1 };
}

/**
 * The `{{else}}` that belongs to the conditional whose body starts at
 * `from`.
 *
 * The conditionals may be nested, and a nested one may have an `{{else}}`
 * of its own — that one belongs to the inner block, not to this one. So
 * the tags are walked by hand and the depth is counted, the same way the
 * matching `{{/if}}` is found.
 *
 * @param {String} text - the whole template
 * @param {Number} from - where the body of the conditional starts
 * @param {Number} to - where the body ends
 * @returns {Number} the position of the `{{else}}`, or -1 when there is none
 */
function findElse(text, from, to) {
	const token =
		/\{\{#if\s+[A-Za-z][A-Za-z0-9]*\s*\}|\{\{\/if\}\}|\{\{else\}\}/g;
	let depth = 0;
	token.lastIndex = from;
	let match;
	while ((match = token.exec(text))) {
		if (match.index >= to) {
			break;
		}
		if (match[0] === "{{/if}}") {
			depth--;
			if (depth < 0) {
				break;
			}
		}
		else if (match[0] === CONDITIONAL_ELSE) {
			if (depth === 0) {
				return match.index;
			}
		}
		else {
			depth++;
		}
	}
	return -1;
}

/**
 * Resolve the conditionals of a template.
 *
 * A conditional whose variable is filled keeps its body — and the body may
 * hold conditionals of its own, which are resolved as well. One whose
 * variable is empty is removed completely, together with both of its tags.
 *
 * A conditional may have an `{{else}}`: the branch that is taken when the
 * variable is empty. The branch that is not taken goes away with its lines.
 *
 * @param {String} text
 * @param {Object} values
 * @param {String[]} unknown - collects the names that do not exist
 * @returns {String}
 */
export function renderConditionals(text, values, unknown = []) {
	let result = "";
	let index = 0;
	while (index < text.length) {
		const open = text.slice(index).match(CONDITIONAL);
		if (!open) {
			result += text.slice(index);
			break;
		}
		const openStart = index + open.index;
		const name = open[1];
		result += text.slice(index, openStart);

		if (!Object.prototype.hasOwnProperty.call(values, name)) {
			if (!unknown.includes(name)) {
				unknown.push(name);
			}
		}

		const bodyStart = openStart + open[0].length;
		const { bodyEnd, afterEnd } = findConditionalEnd(text, bodyStart);
		if (afterEnd === -1) {
			// Unbalanced — keep what is left as it is.
			result += text.slice(openStart);
			break;
		}

		// The body may hold an `{{else}}` of its own. Only the one that
		// belongs to this conditional counts — the ones deeper down belong
		// to the conditionals nested in it.
		const elseAt = findElse(text, bodyStart, bodyEnd);
		const thenText =
			elseAt === -1
				? text.slice(bodyStart, bodyEnd)
				: text.slice(bodyStart, elseAt);
		const elseText =
			elseAt === -1
				? ""
				: text.slice(elseAt + CONDITIONAL_ELSE.length, bodyEnd);

		if (isFilled(values[name])) {
			result += renderConditionals(thenText, values, unknown);
		}
		else if (elseText) {
			// The other branch is taken. The place the first branch took is
			// still marked, so the lines it used go with it.
			result += SKIPPED + renderConditionals(elseText, values, unknown);
		}
		else {
			result += SKIPPED;
		}
		index = afterEnd;
	}
	return result;
}

/**
 * Render a template.
 *
 * A variable without a value does not leave a blank line behind: when a
 * line held nothing but variables, and none of them had a value, the
 * whole line goes. A line that holds text of its own stays — "作者："
 * without a name is still something the reader asked for.
 *
 * @param {String} template
 * @param {Object} vars - the values from `collectMetadata()`
 * @returns {{text: String, unknown: String[]}} the rendered text and the
 *   names of variables the template asked for but that do not exist
 */
export function renderTemplate(template, vars) {
	const unknown = [];
	const values = vars || {};
	let text = String(template == null ? "" : template);

	// The conditionals first, so their bodies may contain variables
	// themselves.
	text = renderConditionals(text, values, unknown);

	text = text.replace(VARIABLE, (match, name) => {
		if (name === ELSE_NAME) {
			// The branch marker. It only gets here when the template is
			// broken — a balanced conditional eats its own `{{else}}`.
			// The checker says so; here it is left as it is.
			return match;
		}
		if (!Object.prototype.hasOwnProperty.call(values, name)) {
			if (!unknown.includes(name)) {
				unknown.push(name);
			}
			return EMPTY;
		}
		const value = values[name];
		if (value == null) {
			return EMPTY;
		}
		const plain = String(value);
		return plain.trim() === "" ? EMPTY : plain;
	});

	return { text: dropEmptyLines(text), unknown };
}

/**
 * Take away the lines that nothing fills.
 *
 * A line that held nothing but variables — and none of them had a value
 * — is a blank line in the note that nobody asked for. It goes.
 *
 * A line that holds text of its own stays: "作者：" without a name is
 * still what the template asked for.
 *
 * @param {String} text - the rendered Markdown
 * @returns {String}
 */
function dropEmptyLines(text) {
	const kept = [];
	for (const line of String(text || "").split("\n")) {
		const marked = line.includes(EMPTY) || line.includes(SKIPPED);
		if (marked) {
			const rest = line.split(EMPTY).join("").split(SKIPPED).join("");
			if (rest.trim() === "") {
				// Nothing but empty values — the line goes with them.
				continue;
			}
		}
		kept.push(line.split(EMPTY).join("").split(SKIPPED).join(""));
	}
	return kept.join("\n");
}

/**
 * The variables a template uses, in the order they appear.
 * @param {String} template
 * @returns {String[]}
 */
export function templateVariables(template) {
	const names = [];
	const text = String(template || "");
	for (const match of text.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g)) {
		// The branch marker looks like a variable, but it is not one.
		if (match[1] === ELSE_NAME) {
			continue;
		}
		if (!names.includes(match[1])) {
			names.push(match[1]);
		}
	}
	for (const match of text.matchAll(/\{\{#if\s+([A-Za-z][A-Za-z0-9]*)\s*\}\}/g)) {
		if (!names.includes(match[1])) {
			names.push(match[1]);
		}
	}
	return names;
}

/**
 * The names of the variables that exist.
 * @returns {String[]}
 */
export function knownVariableNames() {
	return TEMPLATE_VARIABLES.map((variable) => variable.name);
}

/**
 * Check a template before it is used.
 *
 * Two things go wrong in a template that is typed by hand: a variable
 * that does not exist (it is simply left out of the note), and a
 * conditional that is never closed (the rest of the template is thrown
 * away). Both are found here, while the user is still typing.
 *
 * @param {String} template
 * @returns {{unknown: String[], unbalanced: Number, problems: String[]}}
 */
export function validateTemplate(template) {
	const text = String(template == null ? "" : template);
	const known = new Set(knownVariableNames());
	const unknown = [];
	const problems = [];

	for (const name of templateVariables(text)) {
		if (!known.has(name) && !unknown.includes(name)) {
			unknown.push(name);
		}
	}

	// Count the conditionals that are opened and closed. The engine
	// pairs them with brackets, so a missing `{{/if}}` swallows the rest
	// of the template — worth saying out loud.
	//
	// The stack holds the open conditionals; every one of them counts its
	// own `{{else}}`s, so an `{{else}}` that belongs to no conditional —
	// or a second one in the same block — is found as well.
	const stack = [];
	let lowest = 0;
	let strayElse = 0;
	let doubleElse = 0;
	for (const match of text.matchAll(
		/\{\{#if\s+[A-Za-z][A-Za-z0-9]*\s*\}\}|\{\{\/if\}\}|\{\{else\}\}/g,
	)) {
		if (match[0].startsWith("{{#if")) {
			stack.push(0);
		}
		else if (match[0] === CONDITIONAL_ELSE) {
			if (!stack.length) {
				strayElse++;
			}
			else {
				stack[stack.length - 1]++;
				if (stack[stack.length - 1] > 1) {
					doubleElse++;
				}
			}
		}
		else if (stack.length) {
			stack.pop();
		}
		else {
			lowest = Math.min(lowest, -1);
		}
	}
	const unbalanced = stack.length > 0 ? stack.length : -lowest;

	if (unknown.length) {
		problems.push(`unknown variables: ${unknown.join(", ")}`);
	}
	if (unbalanced > 0) {
		problems.push(
			`${unbalanced} conditional${unbalanced > 1 ? "s are" : " is"} not closed`,
		);
	}
	else if (unbalanced < 0) {
		problems.push("there is a {{/if}} without a {{#if}}");
	}
	if (strayElse) {
		problems.push("there is an {{else}} without a {{#if}}");
	}
	if (doubleElse) {
		problems.push("a conditional has more than one {{else}}");
	}

	return { unknown, unbalanced, problems };
}

/**
 * Make sure the picture of an area selection ends up in the note.
 *
 * A "框选" annotation has no text: what the user selected is the
 * picture. A template that was written before the picture existed does
 * not mention it — and the selection would simply be lost.
 *
 * So the picture is appended when the template did not ask for it. A
 * template that *does* ask for it (`{{image}}` or `{{imageCallout}}`)
 * keeps it exactly where it put it.
 *
 * @param {String} text - the rendered Markdown
 * @param {String} image - the Markdown of the picture, or ""
 * @returns {String}
 */
export function appendPicture(text, image) {
	const picture = String(image || "").trim();
	if (!picture) {
		return text;
	}
	if (String(text || "").includes(picture)) {
		// The template has it already.
		return text;
	}
	const body = String(text || "").replace(/\s+$/, "");
	return body ? `${body}\n\n${picture}\n` : `${picture}\n`;
}

/**
 * Templates that are ready to use.
 *
 * Writing a template from scratch is the hardest part of using the
 * plugin — these are the shapes most people want, so they can start
 * from one of them and change what they need.
 */
export const TEMPLATE_PRESETS = [
	{
		id: "default",
		name: "默认：摘录 + 批注 + 元信息",
		template: DEFAULT_TEMPLATE,
	},
	{
		id: "minimal",
		name: "极简：只有摘录和回链",
		template: [
			"> {{quoteInline}}",
			"",
			"[{{title}}]({{zoteroAnnotationLink}})",
		].join("\n"),
	},
	{
		id: "picture",
		name: "框选图片单独一行",
		template: [
			"> [!quote] 摘录 · {{title}}",
			"{{imageCallout}}{{quoteCallout}}",
			"",
			"{{#if comment}}> [!note] 批注",
			"{{commentCallout}}",
			"",
			"{{/if}}{{metadata}}",
		].join("\n"),
	},
	{
		id: "full",
		name: "全文笔记：摘要 + 标签 + 时间",
		template: [
			"> [!quote] 摘录 · {{title}}",
			"{{imageCallout}}{{quoteCallout}}",
			"",
			"{{#if comment}}> [!note] 批注",
			"{{commentCallout}}",
			"",
			"{{/if}}{{#if abstract}}> [!abstract] 摘要",
			"{{abstract}}",
			"",
			"{{/if}}{{metadata}}",
			"{{#if tags}}标签：{{tags}}",
			"",
			"{{/if}}发送于 {{timestamp}}",
		].join("\n"),
	},
];
