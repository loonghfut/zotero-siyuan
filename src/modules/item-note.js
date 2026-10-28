/**
 * Zotero → SiYuan — the notes that are about an item, not an annotation.
 *
 * The send template is written for one annotation: it has `{{quote}}`,
 * `{{comment}}`, `{{page}}`. An item-level send has none of those, so each
 * of its three sections — information, abstract, notes — has a template of
 * its own. An empty template means the built-in shape below, which is what
 * the plugin wrote before templates existed.
 *
 * Keeping this in a module without Zotero access means the formatting can
 * be checked without a library, and the item menu only has to fetch items.
 */

import { getString } from "../utils/locale.js";
import { escapeInline, toCalloutBody } from "./metadata.js";
import { htmlToMarkdown } from "./note-html.js";
import { renderTemplate } from "./template.js";

/**
 * The information section until the user writes their own.
 *
 * The labels are variables rather than words baked into the template, so a
 * translated template and a translated interface agree.
 */
export const DEFAULT_INFO_TEMPLATE = [
  "> [!note] {{itemInfoLabel}}{{#if title}}: {{title}}{{/if}}",
  "{{#if metadataCallout}}{{metadataCallout}}{{/if}}",
].join("\n");

/** The abstract section until the user writes their own. */
export const DEFAULT_ABSTRACT_TEMPLATE = [
  "> [!abstract] {{itemAbstractLabel}}",
  "{{#if abstractCallout}}{{abstractCallout}}{{/if}}",
].join("\n");

/** One child note, until the user writes their own. */
export const DEFAULT_NOTES_TEMPLATE = [
  "> [!note] {{itemNotesLabel}}",
  "{{#if noteCallout}}{{noteCallout}}{{/if}}",
].join("\n");

/**
 * Zotero stores child notes as HTML; SiYuan wants Markdown.
 *
 * The converter lives in `note-html.js`; it keeps links, pictures, tables,
 * code and emphasis instead of flattening them to their text.
 *
 * @param {String} html
 * @returns {String}
 */
export function noteHtmlToMarkdown(html) {
  return htmlToMarkdown(html);
}

/** A localized heading for one of the item-level sections. */
function heading(key, fallback) {
  return getString(key, fallback);
}

/**
 * The values one section's template is rendered with.
 *
 * Everything the annotation template knows is there too — an item-level
 * template can use `{{title}}`, `{{authors}}`, `{{zoteroLink}}`, … — plus
 * the callout forms and the section labels.
 *
 * @param {Object} vars - from `collectMetadata`
 * @param {Object} [extra] - the values of one note, when rendering notes
 * @returns {Object}
 */
export function sectionVars(vars, extra = {}) {
  const base = vars || {};
  return {
    ...base,
    itemInfoLabel: heading("zoteroSiYuan-item-info", "Item details"),
    itemAbstractLabel: heading("zoteroSiYuan-item-abstract", "Abstract"),
    itemNotesLabel: heading("zoteroSiYuan-item-notes", "Notes"),
    metadataCallout: toCalloutBody(base.metadata || ""),
    abstractCallout: toCalloutBody(base.abstract || ""),
    ...extra,
  };
}

/**
 * Which variables carry the body of each section, and which one a template
 * should name.
 *
 * A template that mentions none of them renders the heading and silently
 * drops the content — the settings pane says so while the user is editing
 * (`checkTemplate`), instead of the send putting the text somewhere the
 * template did not ask for.
 */
const BODY_VARIABLES = {
  info: {
    names: ["metadata", "metadataCallout"],
    suggest: "metadataCallout",
  },
  abstract: {
    names: ["abstract", "abstractCallout"],
    suggest: "abstractCallout",
  },
  notes: {
    names: ["note", "noteCallout", "noteInline"],
    suggest: "noteCallout",
  },
};

/**
 * The variable a section template should name, when it names none of the
 * body variables.
 *
 * @param {String} slot - `info`, `abstract`, `notes`, or anything else
 * @param {String} template
 * @returns {String} the suggested variable, or "" when the template is fine
 */
export function missingBodyVariable(slot, template) {
  const entry = BODY_VARIABLES[String(slot || "")];
  if (!entry) {
    return "";
  }
  const text = String(template || "");
  const mentioned = entry.names.some((name) =>
    new RegExp(`\\{\\{(?:#if\\s+)?${name}\\s*\\}\\}`).test(text),
  );
  return mentioned ? "" : entry.suggest;
}

/**
 * Render one section template.
 *
 * @param {String} template
 * @param {Object} vars
 * @returns {String}
 */
function renderSection(template, vars) {
  try {
    return String(renderTemplate(template, vars).text || "").trim();
  }
  catch (e) {
    return "";
  }
}

/**
 * The item's own information: the same metadata block an annotation send
 * appends, without any annotation values.
 *
 * @param {Object} vars - from `collectMetadata`
 * @param {String} [template] - the user's template; empty = the built-in one
 * @returns {String}
 */
export function itemInfoMarkdown(vars, template = "") {
  const custom = String(template || "").trim();
  const hasContent =
    String((vars && vars.title) || "").trim() ||
    String((vars && vars.metadata) || "").trim();
  if (!custom && !hasContent) {
    return "";
  }
  return renderSection(custom || DEFAULT_INFO_TEMPLATE, sectionVars(vars));
}

/**
 * The abstract as its own callout.
 *
 * @param {Object} vars
 * @param {String} [abstract] - the text, when the caller has it already
 * @param {String} [template]
 * @returns {String}
 */
export function abstractMarkdown(vars, abstract = "", template = "") {
  const text = String(abstract || (vars && vars.abstract) || "").trim();
  const custom = String(template || "").trim();
  if (!text && !custom) {
    return "";
  }
  const values = sectionVars(vars, {
    abstract: text,
    abstractCallout: toCalloutBody(text),
  });
  return renderSection(custom || DEFAULT_ABSTRACT_TEMPLATE, values);
}

/**
 * The values one note's template is rendered with.
 *
 * Shared by the send and the settings pane's preview: a template that uses
 * `{{noteCallout}}` must not be reported as "unknown variable" just because
 * the preview has no child note of its own.
 *
 * @param {Object} vars - from `collectMetadata`
 * @param {String} note - the note's Markdown
 * @param {Number} [index] - 0-based position, rendered as a 1-based number
 * @returns {Object}
 */
export function noteVars(vars, note, index = 0) {
  const text = String(note || "");
  return sectionVars(vars, {
    note: text,
    noteInline: escapeInline(text),
    noteCallout: toCalloutBody(text),
    noteNumber: index + 1,
  });
}

/**
 * The child notes, one callout each.
 *
 * @param {Object} vars
 * @param {String[]} notes - Markdown of each note
 * @param {String} [template] - rendered once per note
 * @returns {String}
 */
export function notesMarkdown(vars, notes = [], template = "") {
  const list = (Array.isArray(notes) ? notes : [])
    .map((note) => String(note || "").trim())
    .filter(Boolean);
  if (!list.length) {
    return "";
  }
  const custom = String(template || "").trim();
  return list
    .map((note, index) =>
      renderSection(
        custom || DEFAULT_NOTES_TEMPLATE,
        noteVars(vars, note, index),
      )
    )
    .filter(Boolean)
    .join("\n\n");
}
