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
    });

    document.addEventListener("change", (e) => {
      var target = e.target;
      if (target && target.id === this.ONLY_USED_ID) {
        this._renderVariables(this._filteredVariables());
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

  /**
   * Put a template that is ready to use into the editor.
   *
   * Writing a template from scratch is the hardest part of using the
   * plugin, so the shapes most people want are one click away.
   */
  applyPreset: function () {
    var addon = Zotero.ZoteroSiYuan;
    var select = document.getElementById(this.PRESET_ID);
    var area = document.getElementById(this.TEMPLATE_ID);
    if (!addon || !select || !area) {
      return;
    }
    var presets = addon.getTemplatePresets ? addon.getTemplatePresets() : [];
    var chosen = null;
    for (var i = 0; i < presets.length; i++) {
      if (presets[i].id === select.value) {
        chosen = presets[i];
        break;
      }
    }
    if (!chosen) {
      return;
    }
    area.value = chosen.template;
    this._caret = area.value.length;
    this.onTemplateInput();
    this._setStatus(
      this._text("zoteroSiYuan-pref-preset-applied", "Template replaced"),
      false,
    );
  },

  /**
   * Rebuild the list of the annotations that have been sent.
   *
   * The mapping lives in the SiYuan workspace, so it is read back from
   * there — nothing is stored in the Zotero library.
   */
  rescan: async function () {
    this._setResult(
      this._text("zoteroSiYuan-pref-rescanning", "Scanning SiYuan…"),
      false,
    );
    try {
      if (!Zotero.ZoteroSiYuan || !Zotero.ZoteroSiYuan.refreshIndex) {
        throw new Error("The plugin is not running. Restart Zotero and try again.");
      }
      var count = await Zotero.ZoteroSiYuan.refreshIndex();
      this._setResult(
        this._text("zoteroSiYuan-pref-rescanned", "Sent annotations found: ") +
          count,
        false,
      );
    }
    catch (e) {
      this._setResult(e.message, true);
    }
  },

  /**
   * Remember where the caret is and how far the selection reaches.
   *
   * The selection changes without an input event — the arrow keys, a drag
   * through the text — so every way of changing it is watched.
   *
   * @param {Object} target - the element the event came from
   */
  _trackCaret: function (target) {
    if (!target || target.id !== this.TEMPLATE_ID) {
      return;
    }
    this._caret = target.selectionStart;
    this._caretEnd = target.selectionEnd;
  },

  /**
   * Where the next insertion goes.
   *
   * The editor may have lost the focus already — a button takes it — so
   * the place that was remembered is used then.
   *
   * @param {Object} area - the template editor
   * @returns {{start: Number, end: Number}}
   */
  _selectionRange: function (area) {
    var focused =
      area.ownerDocument && area.ownerDocument.activeElement === area;
    if (focused) {
      return { start: area.selectionStart, end: area.selectionEnd };
    }
    if (typeof this._caret === "number") {
      return {
        start: this._caret,
        end:
          typeof this._caretEnd === "number" ? this._caretEnd : this._caret,
      };
    }
    return { start: area.value.length, end: area.value.length };
  },

  /**
   * Insert a variable into the template at the caret.
   *
   * @param {String} name - the variable name, without the braces
   */
  insertVariable: function (name) {
    var area = document.getElementById(this.TEMPLATE_ID);
    var addon = Zotero.ZoteroSiYuan;
    if (!area || !addon || !addon.insertToken) {
      return;
    }

    var token = addon.variableToken
      ? addon.variableToken(name)
      : "{{" + name + "}}";

    var range = this._selectionRange(area);

    // A callout has to start a line of its own, and the indentation of the
    // line it lands on is kept — so the template stays readable.
    var result = addon.insertVariable
      ? addon.insertVariable(area.value, token, range.start, range.end)
      : addon.insertToken(area.value, token, range.start, range.end);
    area.value = result.value;
    this._caret = result.caret;
    this._caretEnd = result.caret;

    // Take the focus back, so several variables can be inserted in a row.
    this._focusCaret(area, result.caret);

    // Let the pane know the template changed, so it is saved and previewed.
    this._fireInput(area, token);

    this._setStatus(
      this._text("zoteroSiYuan-pref-inserted", "Inserted ") + token,
      false,
    );
  },

  /**
   * Put a conditional around the selected text.
   *
   * With a selection the block wraps it — the text itself is not touched.
   * Without one an empty block is made, and the caret lands between the
   * two tags.
   *
   * @param {String} name - the variable to test
   */
  insertConditional: function (name) {
    var area = document.getElementById(this.TEMPLATE_ID);
    var addon = Zotero.ZoteroSiYuan;
    if (!area || !addon || !addon.insertConditional) {
      return;
    }
    var range = this._selectionRange(area);
    var result = addon.insertConditional(
      area.value,
      name,
      range.start,
      range.end,
    );
    area.value = result.value;
    this._caret = result.caret;
    this._caretEnd = result.caret;
    this._focusCaret(area, result.caret);
    this._fireInput(area, "{{#if " + name + "}}");
    this._setStatus(
      this._text("zoteroSiYuan-pref-inserted", "Inserted ") +
        "{{#if " +
        name +
        "}}",
      false,
    );
  },

  /**
   * Put a single conditional tag on a line of its own.
   *
   * @param {String} tag - `{{else}}` or `{{/if}}`
   */
  insertConditionalTag: function (tag) {
    var area = document.getElementById(this.TEMPLATE_ID);
    var addon = Zotero.ZoteroSiYuan;
    if (!area || !addon || !addon.insertConditionalTag) {
      return;
    }
    var range = this._selectionRange(area);
    var result = addon.insertConditionalTag(
      area.value,
      tag,
      range.start,
      range.end,
    );
    area.value = result.value;
    this._caret = result.caret;
    this._caretEnd = result.caret;
    this._focusCaret(area, result.caret);
    this._fireInput(area, tag);
    this._setStatus(
      this._text("zoteroSiYuan-pref-inserted", "Inserted ") + tag,
      false,
    );
  },

  /** The variable the conditional dropdown is on. */
  _chosenConditionalVariable: function () {
    var select = document.getElementById(this.CONDITIONAL_VARIABLE_ID);
    var name = select ? String(select.value || "") : "";
    return name || "comment";
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

  /** Wait for the pane's fragment to be inserted into the document. */
  _waitForPane: function (attempt) {
    attempt = attempt || 0;
    if (attempt > 60) {
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

  onPaneReady: function () {
    var addon = Zotero.ZoteroSiYuan;
    if (!addon || !addon.getTemplateHelp) {
      return;
    }
    var help = addon.getTemplateHelp();
    var area = document.getElementById(this.TEMPLATE_ID);
    if (area) {
      area.value = help.template;
    }
    this._variables = help.variables || [];
    this._renderPresets();
    this._renderVariables(this._filteredVariables());
    this._renderConditionalVariables();
    this._showProblems(help.template);
    this._refreshPreview();
  },

  /* ------------------------------------------------------------- template */

  onTemplateInput: function () {
    var area = document.getElementById(this.TEMPLATE_ID);
    var addon = Zotero.ZoteroSiYuan;
    if (!area || !addon || !addon.setTemplate) {
      return;
    }
    addon.setTemplate(area.value);
    this._setStatus(this._text("zoteroSiYuan-pref-template-saved", "Saved"), false);
    this._showProblems(area.value);
    this._schedulePreview();
  },

  /**
   * Say what is wrong with the template, if anything.
   *
   * A variable that does not exist is simply left out of the note, and a
   * conditional that is never closed swallows the rest of the template.
   * Both are worth saying while the user is still typing.
   */
  _showProblems: function (template) {
    var box = document.getElementById(this.PROBLEMS_ID);
    if (!box) {
      return;
    }
    var addon = Zotero.ZoteroSiYuan;
    var result =
      addon && addon.checkTemplate
        ? addon.checkTemplate(template)
        : { problems: [] };
    box.textContent = "";
    if (!result.problems || !result.problems.length) {
      box.style.display = "none";
      return;
    }
    box.style.display = "block";
    for (var i = 0; i < result.problems.length; i++) {
      var line = document.createElementNS(this.XHTML, "div");
      line.textContent = result.problems[i];
      box.appendChild(line);
    }
  },

  /** Fill the list of ready-made templates. */
  _renderPresets: function () {
    var select = document.getElementById(this.PRESET_ID);
    var addon = Zotero.ZoteroSiYuan;
    if (!select || !addon || !addon.getTemplatePresets) {
      return;
    }
    var presets = addon.getTemplatePresets();
    select.textContent = "";
    for (var i = 0; i < presets.length; i++) {
      var option = document.createElementNS(this.XHTML, "option");
      option.value = presets[i].id;
      option.textContent = presets[i].name;
      select.appendChild(option);
    }
  },

  /**
   * Fill the list of the variables a conditional may test.
   *
   * The list is the same one the cheat sheet shows, so a name the user
   * knows from there can be picked here as well.
   */
  _renderConditionalVariables: function () {
    var select = document.getElementById(this.CONDITIONAL_VARIABLE_ID);
    if (!select) {
      return;
    }
    select.textContent = "";
    for (var i = 0; i < this._variables.length; i++) {
      var option = document.createElementNS(this.XHTML, "option");
      option.value = this._variables[i].name;
      option.textContent = "{{" + this._variables[i].name + "}}";
      select.appendChild(option);
    }
    // The comment is the variable a conditional is used for most often.
    for (var j = 0; j < this._variables.length; j++) {
      if (this._variables[j].name === "comment") {
        select.value = "comment";
        break;
      }
    }
  },

  /**
   * The variables the list shows: the ones that match what was typed, and
   * — when that is asked for — only the ones the template already uses.
   */
  _filteredVariables: function () {
    var filterBox = document.getElementById(this.FILTER_ID);
    var filter = filterBox ? String(filterBox.value || "").trim().toLowerCase() : "";
    var onlyUsedBox = document.getElementById(this.ONLY_USED_ID);
    var onlyUsed = onlyUsedBox ? !!onlyUsedBox.checked : false;
    if (!filter && !onlyUsed) {
      return this._variables;
    }
    return this._variables.filter(function (variable) {
      if (onlyUsed && !variable.used) {
        return false;
      }
      if (!filter) {
        return true;
      }
      var haystack =
        variable.name.toLowerCase() + " " + (variable.hint || "").toLowerCase();
      return haystack.indexOf(filter) !== -1;
    });
  },

  resetTemplate: function () {
    var addon = Zotero.ZoteroSiYuan;
    if (!addon || !addon.resetTemplate) {
      return;
    }
    addon.resetTemplate();
    var area = document.getElementById(this.TEMPLATE_ID);
    if (area) {
      area.value = addon.getTemplate();
    }
    this._setStatus(this._text("zoteroSiYuan-pref-template-reset-done", "Default restored"), false);
    this._schedulePreview();
  },

  _schedulePreview: function () {
    var self = this;
    if (this._previewTimer) {
      clearTimeout(this._previewTimer);
    }
    this._previewTimer = setTimeout(function () {
      self._previewTimer = null;
      self._refreshPreview();
      self._refreshUsedVariables();
    }, 250);
  },

  /** Mark the variables the current template already uses. */
  _refreshUsedVariables: function () {
    var addon = Zotero.ZoteroSiYuan;
    if (!addon || !addon.getTemplateHelp) {
      return;
    }
    var help = addon.getTemplateHelp();
    var used = help.usedNames || [];
    var rows = document.querySelectorAll(
      "#" + this.VARIABLES_ID + " tr[data-variable]",
    );
    for (var i = 0; i < rows.length; i++) {
      var name = rows[i].getAttribute("data-variable");
      if (used.indexOf(name) !== -1) {
        rows[i].classList.add("zotero-siyuan-variable-used");
      }
      else {
        rows[i].classList.remove("zotero-siyuan-variable-used");
      }
    }
  },

  _refreshPreview: function () {
    var self = this;
    var addon = Zotero.ZoteroSiYuan;
    var area = document.getElementById(this.TEMPLATE_ID);
    if (!addon || !addon.previewTemplate || !area) {
      return;
    }
    addon.previewTemplate(area.value).then(
      function (result) {
        var box = document.getElementById(self.PREVIEW_ID);
        if (box) {
          box.textContent = result.text;
        }
        if (result.unknown && result.unknown.length) {
          self._setStatus(
            self._text(
              "zoteroSiYuan-pref-template-unknown",
              "Unknown variables: ",
            ) + result.unknown.join(", "),
            true,
          );
        }
      },
      function (e) {
        self._setStatus(String(e && e.message ? e.message : e), true);
      },
    );
  },

  _renderVariables: function (variables) {
    var box = document.getElementById(this.VARIABLES_ID);
    if (!box) {
      return;
    }
    box.textContent = "";
    if (!variables || !variables.length) {
      var empty = document.createElementNS(this.XHTML, "p");
      empty.className = "zotero-siyuan-hint";
      empty.textContent = this._text(
        "zoteroSiYuan-pref-variables-empty",
        "No variable matches.",
      );
      box.appendChild(empty);
      return;
    }
    var table = document.createElementNS(this.XHTML, "table");
    var body = document.createElementNS(this.XHTML, "tbody");

    var groups = [];
    for (var i = 0; i < variables.length; i++) {
      var group = variables[i].group;
      if (groups.indexOf(group) === -1) {
        groups.push(group);
      }
    }

    for (var g = 0; g < groups.length; g++) {
      var heading = document.createElementNS(this.XHTML, "tr");
      var headingCell = document.createElementNS(this.XHTML, "td");
      headingCell.className = "zotero-siyuan-variable-group";
      headingCell.colSpan = 2;
      headingCell.textContent = groups[g];
      heading.appendChild(headingCell);
      body.appendChild(heading);

      for (var j = 0; j < variables.length; j++) {
        var variable = variables[j];
        if (variable.group !== groups[g]) {
          continue;
        }
        var row = document.createElementNS(this.XHTML, "tr");
        row.setAttribute("data-variable", variable.name);
        row.setAttribute("tabindex", "0");
        row.setAttribute(
          "title",
          this._text(
            "zoteroSiYuan-pref-insert-hint",
            "Click to insert at the cursor",
          ),
        );
        if (variable.used) {
          row.className = "zotero-siyuan-variable-used";
        }
        var name = document.createElementNS(this.XHTML, "td");
        name.className = "zotero-siyuan-variable-name";
        name.textContent = "{{" + variable.name + "}}";
        var hint = document.createElementNS(this.XHTML, "td");
        hint.textContent = variable.hint;
        row.appendChild(name);
        row.appendChild(hint);
        body.appendChild(row);
      }
    }

    table.appendChild(body);
    box.appendChild(table);
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

  /**
   * Look at the area selections in the library and report where their
   * pictures are.
   *
   * The picture of a "框选" annotation lives in Zotero's cache. When a
   * picture does not arrive, this is where the chain breaks — and this is
   * the button that shows it.
   */
  checkPictures: async function () {
    this._setResult(
      this._text("zoteroSiYuan-pref-checkingpictures", "Looking for area selections…"),
      false,
    );
    try {
      if (!Zotero.ZoteroSiYuan || !Zotero.ZoteroSiYuan.probePictures) {
        throw new Error(
          "The plugin is not running. Restart Zotero and try again.",
        );
      }
      var report = await Zotero.ZoteroSiYuan.probePictures();
      if (report.error) {
        throw new Error(report.error);
      }
      var total = report.annotations.length;
      var missing = report.annotations.filter(function (a) {
        return !a.exists;
      });
      var text =
        this._text("zoteroSiYuan-pref-pictures-found", "Area selections: ") +
        total +
        "  |  " +
        this._text("zoteroSiYuan-pref-pictures-missing", "missing: ") +
        missing.length +
        "  |  " +
        (report.cacheDir || "?");
      if (total && !missing.length) {
        this._setResult(text, false);
      }
      else if (!total) {
        this._setResult(
          this._text(
            "zoteroSiYuan-pref-pictures-none",
            "The library has no area selection.",
          ),
          false,
        );
      }
      else {
        this._setResult(
          text +
            "  |  " +
            missing
              .map(function (a) {
                return a.key + " (" + (a.path || "no path") + ")";
              })
              .join(", "),
          true,
        );
      }
    }
    catch (e) {
      this._setResult(e.message, true);
    }
  },

  /**
   * Run the end-to-end self test: the same code path a click takes, so a
   * passing result means the plugin really works in this Zotero.
   */
  selfTest: async function () {
    this._setResult(
      this._text("zoteroSiYuan-pref-selftesting", "Running the self test…"),
      false,
    );
    try {
      if (!Zotero.ZoteroSiYuan || !Zotero.ZoteroSiYuan.selfTest) {
        throw new Error(
          "The plugin is not running. Restart Zotero and try again.",
        );
      }
      var report = await Zotero.ZoteroSiYuan.selfTest({ realWrite: false });
      if (!report.ok) {
        throw new Error(report.error);
      }
      this._setResult(
        this._text("zoteroSiYuan-pref-selftest-ok", "Self test passed. ") +
          report.path,
        false,
      );
    }
    catch (e) {
      this._setResult(
        this._text("zoteroSiYuan-pref-selftest-failed", "Self test failed: ") +
          e.message,
        true,
      );
    }
  },

  test: async function () {
    this._setResult(this._text("zoteroSiYuan-pref-testing", "Testing…"), false);
    try {
      if (!Zotero.ZoteroSiYuan || !Zotero.ZoteroSiYuan.diagnose) {
        throw new Error(
          "The plugin is not running. Restart Zotero and try again.",
        );
      }
      var report = await Zotero.ZoteroSiYuan.diagnose();
      if (!report.ok) {
        throw new Error(report.error);
      }
      var names = report.notebooks
        .map(function (n) {
          return n.name;
        })
        .join(", ");
      var text =
        this._text("zoteroSiYuan-pref-ok", "Connected. Notebooks: ") + names;
      if (report.executable) {
        text += "  |  " + report.executable + "  |  " + report.workspace;
      }
      if (report.http && report.http.ok) {
        text +=
          "  |  HTTP: " +
          report.http.host +
          ":" +
          report.http.port +
          "  (" +
          report.http.workspace +
          ")";
      }
      this._setResult(text, false);
    }
    catch (e) {
      this._setResult(e.message, true);
      // Refresh the diagnostics report so the failure can be inspected.
      try {
        if (Zotero.ZoteroSiYuan && Zotero.ZoteroSiYuan.diagnose) {
          await Zotero.ZoteroSiYuan.diagnose();
        }
      }
      catch (e2) {
        // ignore
      }
    }
  },
};

ZoteroSiYuanPreferences.init();
