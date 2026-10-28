/**
 * Zotero → SiYuan — the notes that are about an item, not an annotation.
 *
 * The send template is written for one annotation: it has `{{quote}}`,
 * `{{comment}}`, `{{page}}`. An item-level send has none of those, so it
 * builds its own Markdown here — the item's metadata, its abstract, its
 * child notes, or every annotation it has.
 *
 * Keeping this in a module without Zotero access means the formatting can
 * be checked without a library, and the item menu only has to fetch items.
 */

import { getString } from "../utils/locale.js";
import { toCalloutBody } from "./metadata.js";

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decode the few entities Zotero notes contain. */
function decodeEntities(text) {
  return String(text || "")
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (m, code) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] || m);
}

/**
 * Zotero stores child notes as HTML; SiYuan wants Markdown.
 *
 * This is not a general HTML converter — a note that carries a table or a
 * picture is flattened to its text. A personal note in a literature
 * document is better than a missing one, and the note itself stays in
 * Zotero as the source.
 *
 * @param {String} html
 * @returns {String}
 */
export function noteHtmlToMarkdown(html) {
  let text = String(html || "");
  // Paragraphs and line breaks first, so the block elements below keep
  // their own spacing.
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<hr[^>]*>/gi, "\n---\n");
  text = text.replace(
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
    (m, level, body) =>
      `\n${"#".repeat(Number(level))} ${stripInline(body)}\n`,
  );
  text = text.replace(
    /<li[^>]*>([\s\S]*?)<\/li>/gi,
    (m, body) => `- ${stripInline(body)}\n`,
  );
  text = text.replace(
    /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
    (m, body) =>
      `> ${stripInline(body).replace(/\n/g, "\n> ")}\n`,
  );
  text = text.replace(/<\/(p|div|section|article|tr)>/gi, "\n\n");
  text = stripInline(text);
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/** Remove the remaining tags and decode entities. */
function stripInline(text) {
  return decodeEntities(String(text || "").replace(/<[^>]+>/g, ""));
}

/** A localized heading for one of the item-level sections. */
function heading(key, fallback) {
  return getString(key, fallback);
}

/**
 * The item's own information: the same metadata block an annotation send
 * appends, without any annotation values.
 *
 * @param {Object} vars - from `collectMetadata`
 * @returns {String}
 */
export function itemInfoMarkdown(vars) {
  const title = String((vars && vars.title) || "").trim();
  const body = String((vars && vars.metadata) || "").trim();
  const header = heading("zoteroSiYuan-item-info", "Item details");
  if (!title && !body) {
    return "";
  }
  const head = title ? `${header}: ${title}` : header;
  return `> [!note] ${head}\n${body ? toCalloutBody(body) : ""}`.trimEnd();
}

/**
 * The abstract as its own callout.
 *
 * @param {Object} vars
 * @param {String} [abstract]
 * @returns {String}
 */
export function abstractMarkdown(vars, abstract = "") {
  const text = String(abstract || (vars && vars.abstract) || "").trim();
  if (!text) {
    return "";
  }
  return (
    `> [!abstract] ${heading("zoteroSiYuan-item-abstract", "Abstract")}\n` +
    toCalloutBody(text)
  );
}

/**
 * The child notes, one callout each.
 *
 * @param {Object} vars
 * @param {String[]} notes - Markdown of each note
 * @returns {String}
 */
export function notesMarkdown(vars, notes = []) {
  const list = (Array.isArray(notes) ? notes : [])
    .map((note) => String(note || "").trim())
    .filter(Boolean);
  if (!list.length) {
    return "";
  }
  const title = heading("zoteroSiYuan-item-notes", "Notes");
  return list
    .map((note) => `> [!note] ${title}\n${toCalloutBody(note)}`)
    .join("\n\n");
}
