/**
 * Zotero → SiYuan — where a note goes and sending without being asked:
 * the notebook dropdown, the filters of automatic sending, and the
 * pending queue.
 *
 * One of several scripts that share the pane's scope: the object itself is
 * created in `preferences.js`, this file only adds its own methods. The order
 * of the parts does not matter — the pane is wired up by
 * `preferences-boot.js`, which is registered last.
 */

Object.assign(ZoteroSiYuanPreferences, {
  /* ------------------------------------------------- the notebook dropdown */

  /**
   * Fill the notebook dropdown from SiYuan.
   *
   * The setting used to be a text box, and a name with a typo only failed
   * at send time. The pane cannot spawn a process, so the plugin lists the
   * notebooks for it. When SiYuan is not running the current choice is
   * still shown — a pane that empties a setting because nothing could be
   * listed would be worse than a stale list.
   */
  _loadNotebooks: async function () {
    var addon = Zotero.ZoteroSiYuan;
    var select = document.getElementById(this.NOTEBOOK_ID);
    if (!select || !addon || !addon.listNotebooks) {
      return;
    }
    if (this._loadingNotebooks) {
      // The pane opened a moment ago and the list is still on its way.
      // "Test connection" asks again right after it works, so that answer
      // has to be the one that is drawn.
      this._reloadNotebooks = true;
      return;
    }
    this._loadingNotebooks = true;
    var wanted = String(addon.getPref("notebook", "") || "");
    try {
      var notebooks = await addon.listNotebooks();
      this._renderNotebooks(notebooks, wanted);
    }
    catch (e) {
      this._renderNotebooks([], wanted);
    }
    finally {
      this._loadingNotebooks = false;
      if (this._reloadNotebooks) {
        this._reloadNotebooks = false;
        this._loadNotebooks();
      }
    }
  },

  /**
   * Draw the dropdown: "automatic" first, then the notebooks SiYuan has.
   *
   * @param {Array<{id: String, name: String}>} notebooks
   * @param {String} wanted - the preference (a name, or an id from an
   *   older install)
   */
  _renderNotebooks: function (notebooks, wanted) {
    var select = document.getElementById(this.NOTEBOOK_ID);
    if (!select) {
      return;
    }
    var doc = select.ownerDocument;
    var value = String(wanted || "");
    var selected = "";
    while (select.options.length > 1) {
      select.remove(1);
    }
    for (var i = 0; i < (notebooks || []).length; i++) {
      var notebook = notebooks[i] || {};
      var name = String(notebook.name || "");
      var id = String(notebook.id || "");
      if (!name && !id) {
        continue;
      }
      var option = doc.createElementNS(this.XHTML, "option");
      option.value = name || id;
      option.textContent = name || id;
      select.appendChild(option);
      if (value && (value === name || value === id)) {
        selected = option.value;
      }
    }
    if (value && !selected) {
      // The notebook a previous version was told to use is not in the list
      // — keep it visible and selected instead of silently changing where
      // the notes go.
      var missing = doc.createElementNS(this.XHTML, "option");
      missing.value = value;
      missing.textContent = this._text(
        "zoteroSiYuan-pref-notebook-missing",
        "%s (not found in SiYuan)",
      ).replace("%s", value);
      select.appendChild(missing);
      selected = value;
    }
    select.value = selected;
  },

  /** Store the notebook the dropdown shows. */
  _saveNotebook: function (value) {
    var addon = Zotero.ZoteroSiYuan;
    if (addon && addon.setPref) {
      addon.setPref("notebook", String(value || ""));
    }
  },

  /* ------------------------------------------------- automatic sending */

  /** Show what the plugin has stored for automatic sending. */
  _restoreAutoSendSettings: function () {
    var addon = Zotero.ZoteroSiYuan;
    if (!addon || !addon.getAutoSendSettings) {
      return;
    }
    var settings = addon.getAutoSendSettings();
    var box = document.getElementById(this.AUTO_SEND_ID);
    if (box) {
      box.checked = !!settings.enabled;
    }
    this._renderAutoFilters(settings.colors || [], settings.types || []);
    var tags = document.getElementById(this.AUTO_TAGS_ID);
    if (tags) {
      tags.value = (settings.tags || []).join(", ");
    }
    var itemTypes = document.getElementById(this.AUTO_ITEM_TYPES_ID);
    if (itemTypes) {
      itemTypes.value = (settings.itemTypes || []).join(", ");
    }
    this._refreshQueueStatus(settings.pending);
  },

  /** Tick the colour and annotation-kind boxes the plugin has stored. */
  _renderAutoFilters: function (colors, types) {
    this._tickAutoFilterBox(this.AUTO_COLORS_ID, "color", colors);
    this._tickAutoFilterBox(this.AUTO_TYPES_ID, "type", types);
  },

  /**
   * Set one row of checkboxes from a filter list.
   *
   * The boxes themselves are static markup — see the comment in the pane —
   * so only `checked` has to change here.
   *
   * @param {String} id - the box
   * @param {String} kind - "color" or "type"
   * @param {String[]} selected
   */
  _tickAutoFilterBox: function (id, kind, selected) {
    var box = document.getElementById(id);
    if (!box) {
      return;
    }
    var chosen = Array.isArray(selected) ? selected : [];
    var inputs = box.querySelectorAll("input[data-auto-" + kind + "]");
    for (var i = 0; i < inputs.length; i++) {
      var value = String(
        inputs[i].getAttribute("data-auto-" + kind) || "",
      ).toLowerCase();
      inputs[i].checked = value !== "" && chosen.indexOf(value) !== -1;
    }
  },

  /** Add or remove one value of a filter. */
  _toggleAutoFilter: function (kind, value, on) {
    var addon = Zotero.ZoteroSiYuan;
    if (!addon || !addon.getAutoSendSettings || !addon.setAutoSendFilter) {
      return;
    }
    var key = kind === "type" ? "types" : "colors";
    var list = (addon.getAutoSendSettings()[key] || []).slice();
    var index = list.indexOf(value);
    if (on && index === -1) {
      list.push(value);
    }
    else if (!on && index !== -1) {
      list.splice(index, 1);
    }
    else {
      return;
    }
    addon.setAutoSendFilter(key, list);
  },

  /**
   * Store a text filter after the typing stops.
   *
   * The value is written on every keystroke otherwise — a preference write
   * per character, and a half-typed tag could briefly match annotations.
   */
  _saveAutoFilterText: function (name, value) {
    var addon = Zotero.ZoteroSiYuan;
    if (!addon || !addon.setAutoSendFilter) {
      return;
    }
    var self = this;
    if (!this._autoFilterTimers) {
      this._autoFilterTimers = {};
    }
    if (this._autoFilterTimers[name]) {
      clearTimeout(this._autoFilterTimers[name]);
    }
    this._autoFilterTimers[name] = setTimeout(function () {
      self._autoFilterTimers[name] = null;
      addon.setAutoSendFilter(name, value);
    }, 400);
  },

  /** Turn automatic sending on or off. */
  _saveAutoSend: function (enabled) {
    var addon = Zotero.ZoteroSiYuan;
    if (addon && addon.setAutoSendEnabled) {
      addon.setAutoSendEnabled(!!enabled);
    }
    this._refreshQueueStatus();
  },

  /** Say how many annotations are waiting in the queue. */
  _refreshQueueStatus: function (info) {
    var addon = Zotero.ZoteroSiYuan;
    var status = document.getElementById(this.AUTO_QUEUE_STATUS_ID);
    if (!status) {
      return;
    }
    if (!info && addon && addon.getPendingQueueInfo) {
      info = addon.getPendingQueueInfo();
    }
    var count = (info && info.count) || 0;
    status.textContent = count
      ? this._text(
        "zoteroSiYuan-pref-auto-queue-status",
        "Pending queue: %d",
      ).replace("%d", String(count))
      : this._text(
        "zoteroSiYuan-pref-auto-queue-empty",
        "The pending queue is empty",
      );
    status.style.color = count ? "var(--accent-orange, #b35900)" : "";
  },

  /** The "retry now" button. */
  _retryAutoQueue: async function () {
    var addon = Zotero.ZoteroSiYuan;
    var status = document.getElementById(this.AUTO_QUEUE_STATUS_ID);
    if (!addon || !addon.retryPendingQueue || this._queueRetrying) {
      return;
    }
    this._queueRetrying = true;
    if (status) {
      status.textContent = this._text(
        "zoteroSiYuan-pref-auto-queue-retrying",
        "Retrying…",
      );
      status.style.color = "";
    }
    var result = { sent: 0, left: 0 };
    var failure = "";
    try {
      result = await addon.retryPendingQueue({ force: true });
    }
    catch (e) {
      failure = String((e && e.message) || e);
    }
    finally {
      this._queueRetrying = false;
    }
    if (!status) {
      return;
    }
    if (failure) {
      status.textContent = failure;
      status.style.color = "var(--accent-red, #d33)";
      return;
    }
    var parts = [];
    if (result.sent) {
      parts.push(
        this._text(
          "zoteroSiYuan-pref-auto-queue-sent",
          "%d sent from the queue",
        ).replace("%d", String(result.sent)),
      );
    }
    if (result.left) {
      parts.push(
        this._text(
          "zoteroSiYuan-pref-auto-queue-left",
          "%d could not be sent yet; they will be retried automatically",
        ).replace("%d", String(result.left)),
      );
    }
    if (!parts.length) {
      parts.push(
        this._text(
          "zoteroSiYuan-pref-auto-queue-empty",
          "The pending queue is empty",
        ),
      );
    }
    status.textContent = parts.join("  |  ");
    status.style.color = result.left
      ? "var(--accent-orange, #b35900)"
      : "var(--accent-green, #2a7)";
  },

  /** The "clear the queue" button. */
  _clearAutoQueue: function () {
    var addon = Zotero.ZoteroSiYuan;
    if (!addon || !addon.clearPendingQueue) {
      return;
    }
    addon.clearPendingQueue();
    this._refreshQueueStatus({ count: 0 });
    var status = document.getElementById(this.AUTO_QUEUE_STATUS_ID);
    if (status) {
      status.textContent = this._text(
        "zoteroSiYuan-pref-auto-queue-cleared",
        "The pending queue was cleared",
      );
    }
  },

});
