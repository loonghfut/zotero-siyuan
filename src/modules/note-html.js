/**
 * Zotero → SiYuan — a child note's HTML as Markdown.
 *
 * Zotero stores notes as HTML. Flattening that to its text loses exactly the
 * parts a note is made of: the link that was pasted in, the picture that was
 * dragged in, the table of results, the code sample. This converter keeps
 * them.
 *
 * It is deliberately small and dependency-free: a tokenizer, a tree built
 * with a stack, and a renderer that knows the handful of elements Zotero's
 * editor can produce. Unknown elements are not dropped — their contents are
 * rendered, so a note written in another editor still arrives.
 *
 * It runs in the validation harness too, where there is no DOM, so it does
 * not use one here.
 */

/** Elements that never have children or a closing tag. */
const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "source"]);

/** Elements whose content is not part of the note. */
const SKIP = new Set(["script", "style", "head", "title", "template"]);

/** Elements that start a block of their own. */
const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "details",
  "div",
  "figure",
  "figcaption",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "ul",
]);

/**
 * Elements that only group blocks.
 *
 * A `div` is how a note says "these paragraphs belong together" — treating
 * it as a paragraph would flatten the headings, tables and code inside it.
 */
const CONTAINER = new Set([
  "address",
  "article",
  "aside",
  "details",
  "div",
  "figcaption",
  "figure",
  "footer",
  "header",
  "main",
  "nav",
  "section",
  "summary",
]);

/** Elements that carry emphasis, as Markdown does. */
const STRONG = new Set(["strong", "b"]);
const EM = new Set(["em", "i"]);
const STRIKE = new Set(["del", "s", "strike"]);

/** The elements a list item may contain besides its own text. */
const LISTS = new Set(["ul", "ol"]);

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  middot: "·",
  laquo: "«",
  raquo: "»",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  times: "×",
  divide: "÷",
  plusmn: "±",
  deg: "°",
  le: "≤",
  ge: "≥",
  ne: "≠",
  copy: "©",
  reg: "®",
  trade: "™",
  sect: "§",
  para: "¶",
  dagger: "†",
  bull: "•",
};

/**
 * Decode the entities a note can contain.
 *
 * A numeric entity is read by code point, so an emoji written as
 * `&#x1f600;` comes back as itself rather than as a question mark.
 *
 * @param {String} text
 * @returns {String}
 */
export function decodeEntities(text) {
  return String(text == null ? "" : text).replace(
    /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi,
    (match, body) => {
      const lower = String(body).toLowerCase();
      try {
        if (lower.startsWith("#x")) {
          return String.fromCodePoint(parseInt(lower.slice(2), 16));
        }
        if (lower.startsWith("#")) {
          return String.fromCodePoint(Number(lower.slice(1)));
        }
        return Object.prototype.hasOwnProperty.call(ENTITIES, lower)
          ? ENTITIES[lower]
          : match;
      }
      catch (e) {
        // A code point that does not exist is left as it was written.
        return match;
      }
    },
  );
}

/** The attributes of an opening tag. */
function parseAttributes(text) {
  const attrs = {};
  const pattern =
    /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match;
  while ((match = pattern.exec(String(text || "")))) {
    const value = match[2] !== undefined
      ? match[2]
      : match[3] !== undefined
        ? match[3]
        : match[4];
    attrs[match[1].toLowerCase()] = decodeEntities(value);
  }
  return attrs;
}

/**
 * Turn HTML into a tree.
 *
 * An element closed out of order — which real notes do contain — closes the
 * elements above it instead of being ignored: `<b><i>x</b>y</i>` would
 * otherwise make the rest of the note italic for no reason.
 *
 * @param {String} html
 * @returns {Object} the root node
 */
function parse(html) {
  const root = { tag: "#root", attrs: {}, children: [] };
  const stack = [root];
  const text = String(html || "").replace(/<!--[\s\S]*?-->/g, "");
  const tag = /<(\/?)([A-Za-z][A-Za-z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let index = 0;
  let match;
  // The depth of a skipped element (`script`, `style`, …). Its contents are
  // not the note, and its text must not land in the parent.
  let skip = null;
  while ((match = tag.exec(text))) {
    const name = match[2].toLowerCase();
    const closing = !!match[1];
    if (skip) {
      if (closing && name === skip.tag) {
        skip.depth--;
        if (!skip.depth) {
          skip = 0;
        }
      }
      index = match.index + match[0].length;
      continue;
    }
    if (match.index > index) {
      const raw = text.slice(index, match.index);
      if (raw) {
        stack[stack.length - 1].children.push({ tag: "#text", text: raw });
      }
    }
    index = match.index + match[0].length;
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    if (SKIP.has(name) && !match[4]) {
      skip = { tag: name, depth: 1 };
      continue;
    }
    const node = {
      tag: name,
      attrs: parseAttributes(match[3]),
      children: [],
    };
    stack[stack.length - 1].children.push(node);
    if (!VOID.has(name) && !match[4] && !SKIP.has(name)) {
      stack.push(node);
    }
  }
  if (index < text.length) {
    stack[stack.length - 1].children.push({
      tag: "#text",
      text: text.slice(index),
    });
  }
  return root;
}

/** Every character of a node's text, with entities decoded. */
function rawText(node) {
  let out = "";
  for (const child of node.children || []) {
    if (child.tag === "#text") {
      out += decodeEntities(child.text);
    }
    else if (child.tag === "br") {
      out += "\n";
    }
    else if (!SKIP.has(child.tag)) {
      out += rawText(child);
    }
  }
  return out;
}

/** Text as it reads in a paragraph: HTML whitespace is one space. */
function plainText(text) {
  return String(text || "").replace(/[ \t\r\n\f]+/g, " ");
}

/** A backtick span that cannot be closed by the code inside it. */
function codeSpan(code) {
  const value = String(code || "");
  if (!value) {
    return "";
  }
  const runs = value.match(/`+/g) || [];
  const fence = "`".repeat(
    runs.reduce((longest, run) => Math.max(longest, run.length), 0) + 1,
  );
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${pad}${value}${pad}${fence}`;
}

/** A fenced code block, with the language the note named. */
function codeBlock(code, language) {
  const value = String(code || "").replace(/^\n+|\n+$/g, "");
  if (!value) {
    return "";
  }
  const runs = value.match(/`{3,}/g) || [];
  const fence = "`".repeat(
    Math.max(3, runs.reduce((longest, run) => Math.max(longest, run.length), 0) + 1),
  );
  return `${fence}${language || ""}\n${value}\n${fence}`;
}

/** The language of a `<pre>` or its `<code>` child. */
function codeLanguage(node) {
  const classes = `${node.attrs.class || ""} ${
    (node.children || [])
      .filter((child) => child.tag === "code")
      .map((child) => child.attrs.class || "")
      .join(" ")
  }`;
  const match = classes.match(/(?:language|lang)-([A-Za-z0-9+#_-]+)/);
  return match ? match[1] : "";
}

/** The TeX a MathML element carries, when it carries one. */
function mathTex(node) {
  for (const child of node.children || []) {
    if (
      child.tag === "annotation" &&
      /tex/i.test(child.attrs.encoding || "")
    ) {
      return rawText(child).trim();
    }
    const nested = mathTex(child);
    if (nested) {
      return nested;
    }
  }
  return "";
}

/** An image, as Markdown. */
function imageMarkdown(attrs) {
  const src = String(attrs.src || "").trim();
  if (!src) {
    return "";
  }
  const alt = String(attrs.alt || "").replace(/[\[\]]/g, " ").trim();
  const title = String(attrs.title || "").trim();
  return `![${alt}](${src}${title ? ` "${title.replace(/"/g, "'")}"` : ""})`;
}

/** Render inline content. */
function inline(nodes) {
  let out = "";
  for (const node of nodes || []) {
    if (node.tag === "#text") {
      out += plainText(decodeEntities(node.text));
      continue;
    }
    if (SKIP.has(node.tag)) {
      continue;
    }
    if (node.tag === "br") {
      out += "\n";
      continue;
    }
    if (node.tag === "img") {
      out += imageMarkdown(node.attrs);
      continue;
    }
    if (node.tag === "code") {
      out += codeSpan(rawText(node));
      continue;
    }
    if (node.tag === "math") {
      const tex = mathTex(node);
      out += tex ? `$${tex}$` : plainText(rawText(node));
      continue;
    }
    const body = inline(node.children);
    if (STRONG.has(node.tag)) {
      out += body.trim() ? `**${body.trim()}**` : "";
    }
    else if (EM.has(node.tag)) {
      out += body.trim() ? `*${body.trim()}*` : "";
    }
    else if (STRIKE.has(node.tag)) {
      out += body.trim() ? `~~${body.trim()}~~` : "";
    }
    else if (node.tag === "a") {
      const href = String(node.attrs.href || "").trim();
      const text = body.trim();
      // A destination with a space or a bracket would end the link early.
      const target = /[\s()<>]/.test(href) ? `<${href}>` : href;
      out += href && text ? `[${text}](${target})` : text;
    }
    else if (BLOCK.has(node.tag)) {
      // A paragraph inside a sentence: keep it as its own text, not as a
      // broken line inside the sentence.
      out += body.trim() ? `\n\n${body.trim()}\n\n` : "";
    }
    else {
      out += body;
    }
  }
  return out;
}

/** Prefix every line of a block with "> ". */
function quote(text) {
  const body = String(text || "").replace(/^\n+|\n+$/g, "");
  if (!body) {
    return "";
  }
  return body
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

/** One list, at the depth it sits at. */
function renderList(node, depth = 0, ordered = false) {
  const pad = "  ".repeat(depth);
  const lines = [];
  let number = 1;
  for (const child of node.children || []) {
    if (child.tag !== "li") {
      const stray = inline([child]).trim();
      if (stray) {
        lines.push(`${pad}${ordered ? `${number++}. ` : "- "}${stray}`);
      }
      continue;
    }
    const own = child.children.filter(
      (entry) => entry.tag !== "#text" || entry.text.trim(),
    );
    const nested = own.filter((entry) => LISTS.has(entry.tag));
    const rest = own.filter((entry) => !LISTS.has(entry.tag));
    const text = inline(rest)
      .trim()
      .replace(/[ \t]*\n[ \t]*/g, " ")
      .replace(/\n{2,}/g, " ");
    lines.push(`${pad}${ordered ? `${number++}. ` : "- "}${text}`.trimEnd());
    for (const list of nested) {
      lines.push(renderList(list, depth + 1, list.tag === "ol"));
    }
  }
  return lines.join("\n");
}

/** One table, as a Markdown table. */
function renderTable(node) {
  const rows = [];
  const collect = (entry) => {
    for (const child of entry.children || []) {
      if (child.tag === "tr") {
        rows.push(child);
      }
      else if (child.tag === "thead" || child.tag === "tbody" || child.tag === "tfoot") {
        collect(child);
      }
    }
  };
  collect(node);
  const matrix = rows
    .map((row) =>
      (row.children || [])
        .filter((cell) => cell.tag === "td" || cell.tag === "th")
        .map((cell) =>
          inline(cell.children)
            .trim()
            .replace(/[ \t]*\n[ \t]*/g, " ")
            .replace(/\|/g, "\\|"),
        ),
    )
    .filter((row) => row.length);
  if (!matrix.length) {
    return "";
  }
  const width = matrix.reduce((most, row) => Math.max(most, row.length), 0);
  const line = (row) => {
    const cells = row.slice();
    while (cells.length < width) {
      cells.push("");
    }
    return `| ${cells.join(" | ")} |`;
  };
  const out = [line(matrix[0]), `| ${matrix[0].map(() => "---").join(" | ")} |`];
  for (const row of matrix.slice(1)) {
    out.push(line(row));
  }
  return out.join("\n");
}

/** One block element, as Markdown. */
function block(node) {
  const heading = /^h([1-6])$/.exec(node.tag);
  if (heading) {
    const text = inline(node.children).trim().replace(/\n+/g, " ");
    return text ? `${"#".repeat(Number(heading[1]))} ${text}` : "";
  }
  if (node.tag === "hr") {
    return "---";
  }
  if (node.tag === "pre") {
    return codeBlock(rawText(node), codeLanguage(node));
  }
  if (node.tag === "ul" || node.tag === "ol") {
    return renderList(node, 0, node.tag === "ol");
  }
  if (node.tag === "table") {
    return renderTable(node);
  }
  if (node.tag === "blockquote") {
    return quote(renderBlocks(node.children));
  }
  if (node.tag === "li") {
    // An item outside a list still reads as a bullet.
    return `- ${inline(node.children).trim()}`;
  }
  if (CONTAINER.has(node.tag) || node.tag === "details") {
    return renderBlocks(node.children);
  }
  return inline(node.children).trim();
}

/** A list of nodes, each block on its own. */
function renderBlocks(nodes) {
  const parts = [];
  let inlineRun = [];
  const flush = () => {
    if (!inlineRun.length) {
      return;
    }
    const text = inline(inlineRun).trim();
    if (text) {
      parts.push(text);
    }
    inlineRun = [];
  };
  for (const node of nodes || []) {
    if (node.tag === "#text" && !decodeEntities(node.text).trim()) {
      continue;
    }
    if (node.tag === "#text" || (!BLOCK.has(node.tag) && !LISTS.has(node.tag))) {
      inlineRun.push(node);
      continue;
    }
    flush();
    const text = block(node);
    if (text) {
      parts.push(text);
    }
  }
  flush();
  return parts.join("\n\n");
}

/**
 * Convert a Zotero note's HTML to Markdown.
 *
 * @param {String} html
 * @returns {String}
 */
export function htmlToMarkdown(html) {
  const tree = parse(html);
  return renderBlocks(tree.children)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
