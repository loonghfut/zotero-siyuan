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
  RESET_BUTTON_ID: "zotero-prefpane-zoteroSiYuan-reset-template",
  TEMPLATE_ID: "zotero-prefpane-zoteroSiYuan-template",
  PREVIEW_ID: "zotero-prefpane-zoteroSiYuan-preview",
  VARIABLES_ID: "zotero-prefpane-zoteroSiYuan-variables",
  STATUS_ID: "zotero-prefpane-zoteroSiYuan-template-status",
  RESULT_ID: "zotero-prefpane-zoteroSiYuan-result",

  XHTML: "http://www.w3.org/1999/xhtml",

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
      else if (target.id === this.RESET_BUTTON_ID) {
        e.preventDefault();
        this.resetTemplate();
      }
    });

    document.addEventListener("input", (e) => {
      var target = e.target;
      if (target && target.id === this.TEMPLATE_ID) {
        this._caret = target.selectionStart;
        this.onTemplateInput();
      }
    });

    // Remember where the caret was, so a variable can be inserted there even
    // though clicking the list takes the focus away from the editor.
    document.addEventListener("focusin", (e) => {
      var target = e.target;
      if (target && target.id === this.TEMPLATE_ID) {
        this._caret = target.selectionStart;
      }
    });

    document.addEventListener("keydown", (e) => {
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

    var focused =
      area.ownerDocument && area.ownerDocument.activeElement === area;
    var start = focused ? area.selectionStart : this._caret;
    var end = focused ? area.selectionEnd : start;
    if (typeof start !== "number") {
      start = area.value.length;
    }

    var result = addon.insertToken(area.value, token, start, end);
    area.value = result.value;
    this._caret = result.caret;

    // Take the focus back, so several variables can be inserted in a row.
    try {
      area.focus();
      area.setSelectionRange(result.caret, result.caret);
    }
    catch (e) {
      // focus is a nicety, not a requirement
    }

    // Let the pane know the template changed, so it is saved and previewed.
    var event;
    try {
      event = new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: token,
      });
    }
    catch (e) {
      event = document.createEvent("Event");
      event.initEvent("input", true, false);
    }
    area.dispatchEvent(event);

    this._setStatus(
      this._text("zoteroSiYuan-pref-inserted", "Inserted ") + token,
      false,
    );
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
    this._renderVariables(help.variables);
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
    this._schedulePreview();
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
