/**
 * Zotero → SiYuan — the template editor, the preview, and the presets.
 *
 * One of several scripts that share the pane's scope: the object itself is
 * created in `preferences.js`, this file only adds its own methods. The order
 * of the parts does not matter — the pane is wired up by
 * `preferences-boot.js`, which is registered last.
 */

Object.assign(ZoteroSiYuanPreferences, {

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
    // The preview is asked for on every keystroke and the answer takes a
    // moment. Without a stamp, a slow answer for an earlier text would
    // overwrite the preview of what is in the box now.
    this._previewToken = (this._previewToken || 0) + 1;
    var token = this._previewToken;
    addon.previewTemplate(area.value).then(
      function (result) {
        if (token !== self._previewToken) {
          return;
        }
        var box = document.getElementById(self.PREVIEW_ID);
        if (box) {
          box.textContent = result.text;
        }
        if (result.unknown && result.unknown.length) {
          self._setStatus(
            self._text(
              "zoteroSiYuan-pref-template-unknown",
              "Unknown variables",
            ) +
              " " +
              result.unknown.join(", "),
            true,
          );
        }
      },
      function (e) {
        if (token !== self._previewToken) {
          return;
        }
        self._setStatus(String(e && e.message ? e.message : e), true);
      },
    );
  },
});
