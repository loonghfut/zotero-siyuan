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

  /** What is wrong with a template, if anything. */
  checkTemplate(template) {
    return validateTemplate(template);
  },

  /** The template in use — the user's, or the built-in default. */
  getTemplate() {
    const template = getPref("template", "");
    return template || DEFAULT_TEMPLATE;
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

  /**
   * The cheat sheet the preferences pane shows: every variable with its
   * explanation, plus the ones the current template actually uses.
   */
  getTemplateHelp() {
    const template = this.getTemplate();
    const used = templateVariables(template);
    return {
      template,
      defaultTemplate: DEFAULT_TEMPLATE,
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
    return renderTemplate(template || DEFAULT_TEMPLATE, vars);
  }

};
