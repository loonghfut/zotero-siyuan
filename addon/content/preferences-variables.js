/**
 * Zotero → SiYuan — the list of variables, and the picker for a conditional.
 *
 * One of several scripts that share the pane's scope: the object itself is
 * created in `preferences.js`, this file only adds its own methods. The order
 * of the parts does not matter — the pane is wired up by
 * `preferences-boot.js`, which is registered last.
 */

Object.assign(ZoteroSiYuanPreferences, {

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
});
