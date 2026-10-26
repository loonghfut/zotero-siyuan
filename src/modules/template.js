/**
 * Zotero → SiYuan — the send template.
 *
 * A template is plain Markdown with `{{variable}}` placeholders. It is
 * rendered with the metadata of the annotation and appended to the SiYuan
 * daily note.
 *
 * Two pieces of syntax:
 *
 *   {{name}}            — the value of a variable
 *   {{#if name}}…{{/if}} — the body, only when the variable is not empty
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
 */
export const DEFAULT_TEMPLATE = [
	"> [!quote] 摘录 · {{title}}",
	"{{quoteCallout}}",
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
 * Is a variable "there"?
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
 * Resolve the conditionals of a template.
 *
 * A conditional whose variable is filled keeps its body — and the body may
 * hold conditionals of its own, which are resolved as well. One whose
 * variable is empty is removed completely, together with both of its tags.
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
		if (isFilled(values[name])) {
			result += renderConditionals(text.slice(bodyStart, bodyEnd), values, unknown);
		}
		index = afterEnd;
	}
	return result;
}

/**
 * Render a template.
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
		if (!Object.prototype.hasOwnProperty.call(values, name)) {
			if (!unknown.includes(name)) {
				unknown.push(name);
			}
			return "";
		}
		const value = values[name];
		return value == null ? "" : String(value);
	});

	return { text, unknown };
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
