/**
 * Zotero → SiYuan — preferences pane script.
 *
 * The pane is loaded into its own scope (`new Cu.Sandbox(window)` in
 * Zotero's preferences code), so it cannot see the plugin's modules. It talks
 * to the shared `Zotero.ZoteroSiYuan` instance instead.
 *
 * Zotero loads the pane scripts *before* it inserts the pane fragment into
 * the DOM, so the button does not exist yet when this script runs. Therefore
 * the clicks are handled by delegation on the document, which does exist,
 * and the pane's own elements are looked up once they appear.
 *
 * No inline event handlers: Firefox applies a baseline
 * `script-src chrome: resource: moz-src:` CSP to chrome documents, and Zotero
 * intends to drop its temporary exemption.
 */

"use strict";

var ZoteroSiYuanPreferences = {
  BUTTON_ID: "zotero-prefpane-zoteroSiYuan-test",
  SELFTEST_BUTTON_ID: "zotero-prefpane-zoteroSiYuan-selftest",
  CHECK_PICTURES_ID: "zotero-prefpane-zoteroSiYuan-checkpictures",
  RESET_BUTTON_ID: "zotero-prefpane-zoteroSiYuan-reset-template",
  RESCAN_BUTTON_ID: "zotero-prefpane-zoteroSiYuan-rescan",
  TEMPLATE_ID: "zotero-prefpane-zoteroSiYuan-template",
  PREVIEW_ID: "zotero-prefpane-zoteroSiYuan-preview",
  VARIABLES_ID: "zotero-prefpane-zoteroSiYuan-variables",
  STATUS_ID: "zotero-prefpane-zoteroSiYuan-template-status",
  RESULT_ID: "zotero-prefpane-zoteroSiYuan-result",
  PRESET_ID: "zotero-prefpane-zoteroSiYuan-template-preset",
  PRESET_APPLY_ID: "zotero-prefpane-zoteroSiYuan-template-preset-apply",
  PROBLEMS_ID: "zotero-prefpane-zoteroSiYuan-template-problems",
  FILTER_ID: "zotero-prefpane-zoteroSiYuan-variable-filter",
  ONLY_USED_ID: "zotero-prefpane-zoteroSiYuan-variable-only-used",
  CONDITIONAL_VARIABLE_ID: "zotero-prefpane-zoteroSiYuan-conditional-variable",
  CONDITIONAL_IF_ID: "zotero-prefpane-zoteroSiYuan-conditional-if",
  CONDITIONAL_ELSE_ID: "zotero-prefpane-zoteroSiYuan-conditional-else",
  CONDITIONAL_END_ID: "zotero-prefpane-zoteroSiYuan-conditional-end",
  IMAGE_COMPRESS_ID: "zotero-prefpane-zoteroSiYuan-image-compress",
  IMAGE_QUALITY_ID: "zotero-prefpane-zoteroSiYuan-image-quality",
  IMAGE_QUALITY_RANGE_ID: "zotero-prefpane-zoteroSiYuan-image-quality-range",

  // The bounds of the compression quality. The value is the JPEG quality
  // in percent: 10 is small and rough, 100 is big and faithful.
  IMAGE_QUALITY_MIN: 10,
  IMAGE_QUALITY_MAX: 100,

  XHTML: "http://www.w3.org/1999/xhtml",

  // Every variable the plugin knows about, and the ones the current
  // template already uses.
  _variables: [],

  // Where the caret is, and how far the selection reaches.
  //
  // Clicking a button takes the focus away from the editor, so the place
  // has to be remembered while the editor still has it — and a selection
  // is worth keeping, because a conditional wraps it.
  _caret: null,
  _caretEnd: null,



  init: function () {
    if (typeof document === "undefined") {
      return;
    }

    // The pane's scripts are re-run every time the pane is opened, but the
    // document (and its listeners) is not — so bind only once.
    var root = document.documentElement;
    if (!root || root.getAttribute("data-zsiyuan-bound")) {
      this._waitForPane();
      return;
    }
    root.setAttribute("data-zsiyuan-bound", "1");

    document.addEventListener("click", (e) => {
      var target = e.target;
      // The place the caret is at is worth knowing before the click takes
      // the focus away from the editor.
      this._trackCaret(target);
      if (!target || !target.id) {
        // The variable list is not a button — it carries the variable name
        // on the row itself.
        var row = target.closest && target.closest("[data-variable]");
        if (row) {
          e.preventDefault();
          this.insertVariable(row.getAttribute("data-variable"));
        }
        return;
      }
      if (target.id === this.BUTTON_ID) {
        e.preventDefault();
        this.test();
      }
      else if (target.id === this.SELFTEST_BUTTON_ID) {
        e.preventDefault();
        this.selfTest();
      }
      else if (target.id === this.CHECK_PICTURES_ID) {
        e.preventDefault();
        this.checkPictures();
      }
      else if (target.id === this.RESET_BUTTON_ID) {
        e.preventDefault();
        this.resetTemplate();
      }
      else if (target.id === this.PRESET_APPLY_ID) {
        e.preventDefault();
        this.applyPreset();
      }
      else if (target.id === this.CONDITIONAL_IF_ID) {
        e.preventDefault();
        this.insertConditional(this._chosenConditionalVariable());
      }
      else if (target.id === this.CONDITIONAL_ELSE_ID) {
        e.preventDefault();
        this.insertConditionalTag("{{else}}");
      }
      else if (target.id === this.CONDITIONAL_END_ID) {
        e.preventDefault();
        this.insertConditionalTag("{{/if}}");
      }
      else if (target.id === this.RESCAN_BUTTON_ID) {
        e.preventDefault();
        this.rescan();
      }
    });

    document.addEventListener("input", (e) => {
      var target = e.target;
      if (!target) {
        return;
      }
      if (target.id === this.TEMPLATE_ID) {
        this._trackCaret(target);
        this.onTemplateInput();
      }
      else if (target.id === this.FILTER_ID) {
        this._renderVariables(this._filteredVariables());
      }
      else if (target.id === this.IMAGE_QUALITY_RANGE_ID) {
        // Dragging the slider updates the number next to it; the value is
        // stored when the drag is over (`change`), not on every pixel.
        this._syncQuality(target.value);
      }
    });

    document.addEventListener("change", (e) => {
      var target = e.target;
      if (!target) {
        return;
      }
      if (target.id === this.ONLY_USED_ID) {
        this._renderVariables(this._filteredVariables());
      }
      else if (target.id === this.IMAGE_COMPRESS_ID) {
        this._saveImageSetting("imageCompress", target.checked ? "1" : "0");
      }
      else if (
        target.id === this.IMAGE_QUALITY_ID ||
        target.id === this.IMAGE_QUALITY_RANGE_ID
      ) {
        this._setQuality(target.value);
      }
    });
    // Remember where the caret was, so a variable can be inserted there even
    // though clicking the list takes the focus away from the editor.
    document.addEventListener("focusin", (e) => {
      this._trackCaret(e.target);
    });

    // The caret also moves without an input event — the arrow keys, a drag
    // through the text. Every way of changing it is watched, so the
    // selection is still there when a button is pressed.
    document.addEventListener("keyup", (e) => {
      this._trackCaret(e.target);
    });
    document.addEventListener("select", (e) => {
      this._trackCaret(e.target);
    });

    document.addEventListener("keydown", (e) => {
      // Tab puts two spaces in, instead of jumping to the next control —
      // the template is Markdown, and indentation matters in it.
      if (e.key === "Tab" && e.target && e.target.id === this.TEMPLATE_ID) {
        e.preventDefault();
        var area = e.target;
        var start = area.selectionStart;
        var end = area.selectionEnd;
        var result = this._insert(area.value, "  ", start, end);
        area.value = result.value;
        this._caret = result.caret;
        this._caretEnd = result.caret;
        this._focusCaret(area, result.caret);
        this.onTemplateInput();
        return;
      }
      if (e.key !== "Enter" && e.key !== " ") {
        return;
      }
      var target = e.target;
      var row = target.closest && target.closest("[data-variable]");
      if (row) {
        e.preventDefault();
        this.insertVariable(row.getAttribute("data-variable"));
      }
    });

    this._waitForPane();
  },


  /** Wait for the pane's fragment to be inserted into the document. */
  _waitForPane: function (attempt) {
    attempt = attempt || 0;
    // Fifteen seconds: the pane's markup is parsed and localized after
    // this script runs, and on a cold start with many locales that is not
    // instant. Giving up early leaves an empty editor with no way back.
    if (attempt > 150) {
      return;
    }
    if (document.getElementById(this.TEMPLATE_ID)) {
      this.onPaneReady();
      return;
    }
    var self = this;
    setTimeout(function () {
      self._waitForPane(attempt + 1);
    }, 100);
  },


  onPaneReady: function (attempt) {
    var addon = Zotero.ZoteroSiYuan;
    if (!addon || !addon.getTemplateHelp) {
      // The pane can be opened before the plugin finished starting. An
      // empty pane that never fills itself is worse than a short wait.
      attempt = attempt || 0;
      if (attempt < 50) {
        var self = this;
        setTimeout(function () {
          self.onPaneReady(attempt + 1);
        }, 100);
      }
      return;
    }
    var help = addon.getTemplateHelp();
    var area = document.getElementById(this.TEMPLATE_ID);
    if (area) {
      area.value = help.template;
    }
    // A `data-l10n-id` on an `<input>` has nothing to localize — the
    // placeholder is an attribute, so it is set here.
    var filter = document.getElementById(this.FILTER_ID);
    if (filter) {
      filter.placeholder = this._text(
        "zoteroSiYuan-pref-variables-filter",
        "Filter by name or meaning…",
      );
    }
    this._variables = help.variables || [];
    this._renderPresets();
    this._renderVariables(this._filteredVariables());
    this._renderConditionalVariables();
    this._restoreImageSettings();
    this._showProblems(help.template);
    this._refreshPreview();
  },


  /** Put the caret somewhere and keep the focus in the editor. */
  _focusCaret: function (area, caret) {
    try {
      area.focus();
      area.setSelectionRange(caret, caret);
    }
    catch (e) {
      // focus is a nicety, not a requirement
    }
  },


  /** Tell the pane that the template changed. */
  _fireInput: function (area, data) {
    var event;
    try {
      event = new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: data || "",
      });
    }
    catch (e) {
      event = document.createEvent("Event");
      event.initEvent("input", true, false);
    }
    area.dispatchEvent(event);
  },


  /** The plain insertion, used for the Tab key. */
  _insert: function (text, token, start, end) {
    var addon = Zotero.ZoteroSiYuan;
    if (addon && addon.insertToken) {
      return addon.insertToken(text, token, start, end);
    }
    return {
      value: text.slice(0, start) + token + text.slice(end),
      caret: start + token.length,
    };
  },


  _setStatus: function (text, isError) {
    var status = document.getElementById(this.STATUS_ID);
    if (!status) {
      return;
    }
    status.textContent = text;
    status.style.color = isError
      ? "var(--accent-red, #d33)"
      : "var(--accent-green, #2a7)";
  },


  /* --------------------------------------------------------------- shared */

  _result: function () {
    if (typeof document === "undefined") {
      return null;
    }
    return document.getElementById(this.RESULT_ID);
  },


  _setResult: function (text, isError) {
    var result = this._result();
    if (!result) {
      return;
    }
    result.textContent = text;
    result.style.color = isError
      ? "var(--accent-red, #d33)"
      : "var(--accent-green, #2a7)";
  },


  _text: function (id, fallback) {
    try {
      var value = Zotero.ZoteroSiYuan && Zotero.ZoteroSiYuan.getString ? Zotero.ZoteroSiYuan.getString(id) : null;
      if (value && value !== id) {
        return value;
      }
    }
    catch (e) {
      // fall through
    }
    return fallback;
  },
};
