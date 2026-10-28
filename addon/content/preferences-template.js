/**
 * Zotero → SiYuan — the template editor, the presets, and the shelf.
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
    if (
      !area ||
      !addon ||
      (!addon.setTemplate && !addon.setItemTemplate)
    ) {
      return;
    }
    // The box edits one of the two templates; the switch says which.
    this._saveTemplateText(area.value);
    this._setStatus(
      this._templateSlot === "item" && !String(area.value).trim()
        ? this._text(
            "zoteroSiYuan-pref-template-item-inherit",
            "Empty — the common template will be used",
          )
        : this._text("zoteroSiYuan-pref-template-saved", "Saved"),
      false,
    );
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
    // The slot matters: the notes / info / abstract templates are checked
    // for the variable that carries their body, not only for names and
    // conditionals.
    var result =
      addon && addon.checkTemplate
        ? addon.checkTemplate(template, this._templateSlot)
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
    if (!addon || (!addon.resetTemplate && !addon.resetItemTemplate)) {
      return;
    }
    var value = this._resetTemplateText();
    var area = document.getElementById(this.TEMPLATE_ID);
    if (area) {
      area.value = value;
      this._caret = value.length;
      this._caretEnd = this._caret;
    }
    this._setStatus(
      this._text(
        this._templateSlot === "item"
          ? "zoteroSiYuan-pref-template-item-reset-done"
          : "zoteroSiYuan-pref-template-reset-done",
        this._templateSlot === "item"
          ? "Back to the common template"
          : "Default restored",
      ),
      false,
    );
    this._showProblems(value);
    this._refreshUsedVariables();
    this._schedulePreview();
  },


  /* ----------------------------------------------- the templates I saved */

  /**
   * Fill the list of the templates the user saved.
   *
   * The list is the shelf: the shapes worked out once and kept. Without it
   * a template that took an hour to get right is lost the moment another
   * one is typed over it.
   *
   * @param {String} [selectedId] - the one to pick afterwards
   */
  _renderSavedTemplates: function (selectedId) {
    var select = document.getElementById(this.SAVED_ID);
    var addon = Zotero.ZoteroSiYuan;
    if (!select || !addon || !addon.getSavedTemplates) {
      return;
    }
    var list = addon.getSavedTemplates() || [];
    select.textContent = "";
    for (var i = 0; i < list.length; i++) {
      var option = document.createElementNS(this.XHTML, "option");
      option.value = list[i].id;
      option.textContent = list[i].name;
      select.appendChild(option);
    }
    if (!list.length) {
      var empty = document.createElementNS(this.XHTML, "option");
      empty.value = "";
      empty.textContent = this._text(
        "zoteroSiYuan-pref-templates-empty",
        "Nothing saved yet",
      );
      select.appendChild(empty);
    }
    // An empty shelf has nothing to put into the editor and nothing to
    // take off it. The buttons say so by being greyed out — a button that
    // silently does nothing when it is pressed is worse than no button.
    select.disabled = !list.length;
    this._enableSavedButtons(list.length > 0);
    if (selectedId) {
      for (var j = 0; j < list.length; j++) {
        if (list[j].id === selectedId) {
          select.value = selectedId;
          break;
        }
      }
    }
  },


  /** Grey out "apply" and "delete" when the shelf is empty. */
  _enableSavedButtons: function (enabled) {
    var ids = [this.LOAD_ID, this.DELETE_ID];
    for (var i = 0; i < ids.length; i++) {
      var button = document.getElementById(ids[i]);
      if (button) {
        button.disabled = !enabled;
      }
    }
  },


  /** The saved template with this id, as the shelf has it now. */
  _savedEntry: function (id) {
    var addon = Zotero.ZoteroSiYuan;
    if (!id || !addon || !addon.getSavedTemplates) {
      return null;
    }
    var list = addon.getSavedTemplates() || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) {
        return list[i];
      }
    }
    return null;
  },


  /**
   * Another template was picked from the list.
   *
   * Its name goes into the box, so pressing "save" puts the editor back
   * into *that* template instead of making a copy under a new name.
   */
  _savedTemplatePicked: function () {
    var select = document.getElementById(this.SAVED_ID);
    var nameBox = document.getElementById(this.SAVED_NAME_ID);
    if (!select || !nameBox) {
      return;
    }
    // Picking another one also takes back a "delete" that was armed for
    // the one before it.
    this._deleteArm = null;
    var entry = this._savedEntry(String(select.value || ""));
    if (entry) {
      nameBox.value = entry.name;
    }
  },


  /**
   * Put the template that is in the editor on the shelf.
   *
   * Where it goes follows from what the box says: a name that is already
   * there replaces that template, a new one starts another, and no name at
   * all — with one picked from the list — updates the one that is picked.
   */
  saveMyTemplate: function () {
    var area = document.getElementById(this.TEMPLATE_ID);
    var nameBox = document.getElementById(this.SAVED_NAME_ID);
    var select = document.getElementById(this.SAVED_ID);
    var addon = Zotero.ZoteroSiYuan;
    if (!area || !addon || !addon.saveSavedTemplate) {
      return;
    }
    var name = nameBox ? String(nameBox.value || "").trim() : "";
    var id = select && select.value ? String(select.value) : "";
    if (!name && !id) {
      this._setStatus(
        this._text(
          "zoteroSiYuan-pref-template-need-name",
          "Give the template a name first",
        ),
        true,
      );
      return;
    }
    var result = addon.saveSavedTemplate({
      // A name of its own wins: with one, the editor is saved as that
      // template; without one, as the template that is picked.
      id: name ? "" : id,
      name: name,
      template: area.value,
      // Which of the two templates this is, so loading it later puts it
      // back in the same place.
      slot: this._templateSlot,
      // A template also remembers where its notes go — "one document per
      // paper" is part of what the template is for.
      ...this._destinationSettings(),
    });
    if (!result.ok) {
      this._setStatus(this._savedError(result.error), true);
      return;
    }
    var entry = result.entry;
    if (nameBox && entry) {
      nameBox.value = entry.name;
    }
    this._renderSavedTemplates(entry ? entry.id : "");
    this._setStatus(
      (result.created
        ? this._text("zoteroSiYuan-pref-template-save-new", "Saved")
        : this._text("zoteroSiYuan-pref-template-save-updated", "Updated")) +
        " " +
        (entry ? entry.name : ""),
      false,
    );
  },


  /** Why a template could not be saved, in the user's words. */
  _savedError: function (error) {
    if (error === "empty") {
      return this._text(
        "zoteroSiYuan-pref-template-save-empty",
        "The template is empty — there is nothing to save",
      );
    }
    if (error === "limit") {
      return this._text(
        "zoteroSiYuan-pref-template-save-limit",
        "The shelf is full — delete one first",
      );
    }
    return this._text(
      "zoteroSiYuan-pref-template-need-name",
      "Give the template a name first",
    );
  },


  /**
   * Put a saved template back into the editor.
   *
   * The pane stores what the editor holds when the editor says it
   * changed — so the event is fired on purpose here: without it the
   * template would be in the box but not in use.
   */
  applySavedTemplate: function () {
    var select = document.getElementById(this.SAVED_ID);
    var area = document.getElementById(this.TEMPLATE_ID);
    if (!select || !area) {
      return;
    }
    var entry = this._savedEntry(String(select.value || ""));
    if (!entry) {
      this._setStatus(
        this._text(
          "zoteroSiYuan-pref-template-need-pick",
          "Pick one of your templates first",
        ),
        true,
      );
      return;
    }
    // A template is either the common one or the one for a document per
    // item. Loading it puts the editor back on the side it came from, or
    // an item template would quietly become the daily-note one.
    var slots = ["note", "item", "info", "abstract", "notes"];
    var slot = slots.indexOf(entry.slot) === -1 ? "note" : entry.slot;
    if (slot !== this._templateSlot) {
      this._templateSlot = slot;
      var scope = document.getElementById(this.TEMPLATE_SCOPE_ID);
      if (scope) {
        scope.value = slot;
      }
    }
    area.value = entry.template;
    var nameBox = document.getElementById(this.SAVED_NAME_ID);
    if (nameBox) {
      nameBox.value = entry.name;
    }
    this._caret = area.value.length;
    this._caretEnd = area.value.length;
    this.onTemplateInput();
    this._refreshUsedVariables();
    // A template can carry where its notes go. An older one carries
    // nothing, and then the destination in the settings is left alone.
    this.applyTemplateDestination(entry);
    this._setStatus(
      this._text("zoteroSiYuan-pref-template-loaded", "Loaded") +
        " " +
        entry.name,
      false,
    );
  },


  /**
   * Take a saved template off the shelf.
   *
   * There is no undo, and a template can hold an hour of work — so the
   * first press only asks and says what it would take away. A second
   * press on the same one does it.
   */
  deleteSavedTemplate: function () {
    var select = document.getElementById(this.SAVED_ID);
    var addon = Zotero.ZoteroSiYuan;
    if (!select || !addon || !addon.deleteSavedTemplate) {
      return;
    }
    var id = String(select.value || "");
    var entry = this._savedEntry(id);
    if (!entry) {
      this._setStatus(
        this._text(
          "zoteroSiYuan-pref-template-need-pick",
          "Pick one of your templates first",
        ),
        true,
      );
      return;
    }
    if (this._deleteArm !== id) {
      this._deleteArm = id;
      this._setStatus(
        this._text(
          "zoteroSiYuan-pref-template-delete-ask",
          "Press Delete again to remove",
        ) +
          " " +
          entry.name,
        false,
      );
      return;
    }
    this._deleteArm = null;
    var result = addon.deleteSavedTemplate(id);
    this._renderSavedTemplates();
    this._setStatus(
      result.ok
        ? this._text("zoteroSiYuan-pref-template-deleted", "Deleted") +
            " " +
            entry.name
        : this._text(
            "zoteroSiYuan-pref-template-need-pick",
            "Pick one of your templates first",
          ),
      !result.ok,
    );
  },


});
