/**
 * Zotero → SiYuan — the surface the preferences pane calls, and prefs access.
 */

import { getString } from "../utils/locale.js";
import {
	getPref,
	prefFlag,
	setPref,
} from "../utils/prefs.js";
import { collectMetadata } from "../modules/metadata.js";
import {
	conditionalToken,
	insertConditional,
	insertConditionalTag,
	insertToken,
	insertVariable,
	variableToken,
} from "../modules/template-edit.js";
import {
	DEFAULT_TEMPLATE,
	TEMPLATE_PRESETS,
	TEMPLATE_VARIABLES,
	renderTemplate,
	templateVariables,
	validateTemplate,
} from "../modules/template.js";
import {
	DEFAULT_ABSTRACT_TEMPLATE,
	DEFAULT_INFO_TEMPLATE,
	DEFAULT_NOTES_TEMPLATE,
	missingBodyVariable,
	noteVars,
} from "../modules/item-note.js";
import {
	TEMPLATES_PREF,
	deleteSavedTemplate as removeFromShelf,
	parseSavedTemplates,
	saveTemplate as putOnShelf,
	serializeSavedTemplates,
} from "../modules/template-store.js";

export default {
  /**
   * A localized string.
   *
   * The preferences pane runs in its own scope and cannot see the plugin's
   * modules, so it asks the plugin instance for its strings.
   */
  getString(id, fallback) {
    return getString(id, fallback);
  },

  /**
   * Read a preference.
   *
   * The preferences pane runs in its own scope and cannot see the plugin's
   * modules, so it asks the plugin instance for its settings.
   *
   * @param {String} key
   * @param {*} fallback
   * @returns {*}
   */
  getPref(key, fallback) {
    return getPref(key, fallback);
  },

  /**
   * Store a preference.
   *
   * @param {String} key
   * @param {*} value
   */
  setPref(key, value) {
    return setPref(key, value);
  },

  /**
   * Read a switch preference, whichever way it was stored.
   *
   * Zotero keeps booleans as real booleans, but an older version of this
   * plugin wrote `"1"` — so both spellings are accepted.
   *
   * @param {String} key
   * @param {Boolean} [fallback]
   * @returns {Boolean}
   */
  isPrefTrue(key, fallback = false) {
    return prefFlag(key, fallback);
  },

  /**
   * The notebooks SiYuan has, for the settings dropdown.
   *
   * The pane cannot spawn a process itself, so it asks the plugin. HTTP is
   * the fallback for a machine where the CLI cannot run but the kernel is
   * reachable — the same two transports the send path has.
   *
   * @returns {Promise<Array<{id: String, name: String}>>}
   */
  async listNotebooks() {
    try {
      return await this.getCLI().listNotebooks();
    }
    catch (cliError) {
      try {
        const http = await this._httpClient();
        return await http.listNotebooks();
      }
      catch (httpError) {
        throw new Error(
          `the siyuan CLI failed: ${cliError.message} — ` +
            `the SiYuan HTTP API failed too: ${httpError.message}`,
        );
      }
    }
  },

  /**
   * Insert a token into the template at the caret.
   *
   * The preferences pane cannot use the plugin's modules directly — it runs
   * in its own scope — so it asks the plugin instance to do the editing.
   *
   * @param {String} text - the current template
   * @param {String} token - what to insert
   * @param {Number} start - where the insertion starts
   * @param {Number} end - what the insertion replaces
   * @returns {{value: String, caret: Number}}
   */
  insertToken(text, token, start, end) {
    return insertToken(text, token, start, end);
  },

  /**
   * Insert a variable into the template, keeping it readable.
   *
   * A callout has to start a line of its own, and the indentation of the
   * line it lands on is kept.
   */
  insertVariable(text, token, start, end) {
    return insertVariable(text, token, start, end);
  },

  /** The token of a template variable. */
  variableToken(name) {
    return variableToken(name);
  },

  /**
   * Put a conditional around the selection, or an empty one in its place.
   *
   * The tags go on lines of their own, and the text that was selected is
   * left exactly as it was.
   */
  insertConditional(text, name, start, end) {
    return insertConditional(text, name, start, end);
  },

  /**
   * Put a single conditional tag — `{{else}}` or `{{/if}}` — on its own line.
   */
  insertConditionalTag(text, tag, start, end) {
    return insertConditionalTag(text, tag, start, end);
  },

  /** The token that opens a conditional. */
  conditionalToken(name) {
    return conditionalToken(name);
  },

  /** The templates that are ready to use. */
  getTemplatePresets() {
    return TEMPLATE_PRESETS.map((preset) => ({
      id: preset.id,
      name: preset.name,
      template: preset.template,
    }));
  },

  /**
   * The pref behind each template the pane can edit.
   *
   * One editor serves all of them: the switch decides which preference the
   * box reads and writes, so the preview, the variables and the problem
   * list keep working the same way for every one.
   */
  _templateSlotPref(slot) {
    switch (String(slot || "")) {
      case "item":
        return "itemTemplate";
      case "info":
        return "itemInfoTemplate";
      case "abstract":
        return "itemAbstractTemplate";
      case "notes":
        return "itemNotesTemplate";
      default:
        return "template";
    }
  },

  /**
   * What a slot uses when its preference is empty.
   *
   * The common template has a built-in default. The per-item one is empty
   * on purpose — it means "use the common one". The three section templates
   * have a built-in shape each, so an empty preference shows that shape and
   * changing it saves a copy.
   */
  _templateSlotDefault(slot) {
    switch (String(slot || "")) {
      case "item":
        return this.getTemplate();
      case "info":
        return DEFAULT_INFO_TEMPLATE;
      case "abstract":
        return DEFAULT_ABSTRACT_TEMPLATE;
      case "notes":
        return DEFAULT_NOTES_TEMPLATE;
      default:
        return DEFAULT_TEMPLATE;
    }
  },

  /** The template one slot really uses, whether or not it is stored. */
  getTemplateForSlot(slot) {
    const stored = String(
      getPref(this._templateSlotPref(slot), "") || "",
    ).trim();
    if (stored) {
      return stored;
    }
    return this._templateSlotDefault(slot);
  },

  /** Store one slot's template; the default is stored as "not customized". */
  setTemplateForSlot(slot, template) {
    const text = String(template == null ? "" : template);
    const fallback = String(this._templateSlotDefault(slot) || "").trim();
    const value = text.trim() && text.trim() !== fallback ? text : "";
    return setPref(this._templateSlotPref(slot), value);
  },

  /** Forget one slot's template, so its built-in shape is used again. */
  resetTemplateForSlot(slot) {
    return setPref(this._templateSlotPref(slot), "");
  },

  /**
   * What is wrong with a template, if anything.
   *
   * A section template is checked against its own section as well: a notes
   * template that never names `{{noteCallout}}` writes the heading and
   * drops every note. The pane has to say so while it is still being
   * edited — the send does not put the text back on its own.
   *
   * @param {String} template
   * @param {String} [slot] - `note`, `item`, `info`, `abstract`, `notes`
   * @returns {{unknown: String[], unbalanced: Number, problems: String[]}}
   */
  checkTemplate(template, slot = "") {
    const result = validateTemplate(template);
    const missing = missingBodyVariable(slot, template);
    if (missing) {
      result.problems.push(
        `the body is missing — add {{${missing}}}, or the content of this ` +
          "section is not written",
      );
    }
    return result;
  },

  /** The template in use — the user's, or the built-in default. */
  getTemplate() {
    const template = getPref("template", "");
    return template || DEFAULT_TEMPLATE;
  },

  /**
   * The template a destination kind uses.
   *
   * A note that becomes a document of its own is often a reading note with
   * a different shape, so "one document per item" may have a template of
   * its own. Empty means "the same one as everywhere else", which is what a
   * user who never touched the second editor expects.
   *
   * @param {String} [kind] - "daily", "document" or "item"
   * @returns {String}
   */
  getTemplateFor(kind) {
    if (kind === "item") {
      const own = String(getPref("itemTemplate", "") || "");
      if (own.trim()) {
        return own;
      }
    }
    return this.getTemplate();
  },

  /** The per-item template exactly as it is stored ("" = use the common one). */
  getItemTemplate() {
    return String(getPref("itemTemplate", "") || "");
  },

  /** Store the per-item template. */
  setItemTemplate(template) {
    return setPref("itemTemplate", String(template == null ? "" : template));
  },

  /** Forget the per-item template, so item documents use the common one. */
  resetItemTemplate() {
    return setPref("itemTemplate", "");
  },

  /**
   * The raw template preference — empty means "use the built-in template".
   * The self test needs it to put the user's setup back exactly as it was.
   */
  getTemplatePref() {
    return getPref("template", "");
  },

  /** Store the user's template. */
  setTemplate(template) {
    return setPref("template", String(template == null ? "" : template));
  },

  /** Forget the user's template and go back to the default. */
  resetTemplate() {
    return setPref("template", "");
  },

  /* -------------------------------------------------- where a note goes */

  /**
   * The destination settings, as the pane shows them.
   *
   * A template can carry these, so the pane reads them before saving one
   * and writes them back when one is loaded.
   *
   * @returns {{destination: String, targetDocument: String,
   *   itemDocName: String, itemDocPath: String}}
   */
  getDestinationSettings() {
    const value = String(getPref("destination", "daily") || "").trim();
    return {
      destination: ["daily", "document", "item"].includes(value)
        ? value
        : "daily",
      targetDocument: String(getPref("targetDocument", "") || ""),
      itemDocName: String(getPref("itemDocName", "{{title}}") || "{{title}}"),
      itemDocPath: String(getPref("itemDocPath", "/") || "/"),
    };
  },

  /**
   * Put destination settings back — from a saved template.
   *
   * Only the known fields and known destination kinds are written, so a
   * template that was edited by hand cannot put an arbitrary value into a
   * preference the send path reads.
   *
   * @param {Object} settings
   * @returns {{destination: String, targetDocument: String,
   *   itemDocName: String, itemDocPath: String}}
   */
  applyDestinationSettings(settings = {}) {
    const value = String((settings && settings.destination) || "").trim();
    if (["daily", "document", "item"].includes(value)) {
      setPref("destination", value);
    }
    for (const key of ["targetDocument", "itemDocName", "itemDocPath"]) {
      const raw = settings && settings[key];
      if (typeof raw === "string") {
        setPref(key, raw);
      }
    }
    return this.getDestinationSettings();
  },

  /* ----------------------------------------------------- the user's shelf */

  /**
   * The templates the user saved.
   *
   * The pane runs in its own scope and cannot read the preference itself,
   * so it asks for the shelf every time it draws one.
   *
   * @returns {Array<{id: String, name: String, template: String}>}
   */
  getSavedTemplates() {
    return parseSavedTemplates(getPref(TEMPLATES_PREF, ""));
  },

  /**
   * Put the template being edited on the shelf.
   *
   * @param {{id?: String, name?: String, template?: String}} entry
   * @returns {{ok: Boolean, created: Boolean, error: String,
   *   entry: Object|null, templates: Array}}
   */
  saveSavedTemplate(entry = {}) {
    const shelf = parseSavedTemplates(getPref(TEMPLATES_PREF, ""));
    const result = putOnShelf(shelf, entry);
    if (result.error) {
      return {
        ok: false,
        created: false,
        error: result.error,
        entry: null,
        templates: result.list,
      };
    }
    setPref(TEMPLATES_PREF, serializeSavedTemplates(result.list));
    return {
      ok: true,
      created: result.created,
      error: "",
      entry: result.entry,
      templates: result.list,
    };
  },

  /**
   * Take a template off the shelf.
   *
   * @param {String} id
   * @returns {{ok: Boolean, removed: Object|null, templates: Array}}
   */
  deleteSavedTemplate(id) {
    const shelf = parseSavedTemplates(getPref(TEMPLATES_PREF, ""));
    const result = removeFromShelf(shelf, id);
    if (!result.removed) {
      return { ok: false, removed: null, templates: result.list };
    }
    setPref(TEMPLATES_PREF, serializeSavedTemplates(result.list));
    return { ok: true, removed: result.removed, templates: result.list };
  },

  /**
   * The cheat sheet the preferences pane shows: every variable with its
   * explanation, plus the ones the current template actually uses.
   *
   * @param {String} [slot] - "note" (the common template), "item" (the one
   *   for a document per item), or one of the three literature-note
   *   sections: "info", "abstract", "notes"
   */
  getTemplateHelp(slot = "note") {
    const name = ["note", "item", "info", "abstract", "notes"].includes(slot)
      ? slot
      : "note";
    const stored = String(
      getPref(this._templateSlotPref(name), "") || "",
    );
    const fallback = this._templateSlotDefault(name);
    // The per-item slot is shown exactly as it is stored, so an empty box
    // means "use the common template". The section slots show their
    // built-in shape instead — a blank box there looks like a mistake.
    const template = name === "item"
      ? stored
      : (stored || fallback);
    const used = templateVariables(template || fallback);
    return {
      slot: name,
      template,
      stored,
      defaultTemplate: fallback,
      usedNames: used,
      variables: TEMPLATE_VARIABLES.map((variable) => ({
        ...variable,
        used: used.includes(variable.name),
      })),

    };
  },

  /**
   * Render a template with a real annotation, for the live preview.
   * @param {String} template
   * @returns {Promise<{text: String, unknown: String[]}>}
   */
  async previewTemplate(template) {
    const sample = await this._sample();
    const vars = collectMetadata({
      ...sample,
      annotationKey: sample.annotationKey,
      extra: this._now(),
    });
    // The notes section is rendered once per child note, so the preview
    // needs one of its own — otherwise `{{noteCallout}}` looks like a
    // variable nobody defines.
    return renderTemplate(
      template || DEFAULT_TEMPLATE,
      noteVars(
        vars,
        getString(
          "zoteroSiYuan-template-sample-note",
          "This is what a child note looks like.",
        ),
      ),
    );
  }

};
