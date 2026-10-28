/**
 * Zotero → SiYuan — the buttons that talk to the plugin: test, rescan, self test.
 *
 * One of several scripts that share the pane's scope: the object itself is
 * created in `preferences.js`, this file only adds its own methods. The order
 * of the parts does not matter — the pane is wired up by
 * `preferences-boot.js`, which is registered last.
 */

Object.assign(ZoteroSiYuanPreferences, {

  /**
   * Run one of the buttons' jobs, and only one at a time.
   *
   * Each of these starts a workspace scan, a whole self test or a round of
   * diagnostics. A second click while the first is running used to start a
   * second one — two full-table queries, two report files, and whichever
   * answer arrives last is the one the user sees.
   *
   * @param {Function} job
   * @returns {Promise<void>}
   */
  _runOnce: async function (job) {
    if (this._busy) {
      return;
    }
    this._busy = true;
    try {
      await job.call(this);
    }
    finally {
      this._busy = false;
    }
  },

  /** The "rescan" button — see `_rescan`. */
  rescan: async function () {
    await this._runOnce(this._rescan);
  },

  /** The "self test" button — see `_selfTest`. */
  selfTest: async function () {
    await this._runOnce(this._selfTest);
  },

  /** The "test the connection" button — see `_test`. */
  test: async function () {
    await this._runOnce(this._test);
  },

  /* ------------------------------------------------- where a note goes */

  /**
   * Show the destination settings the plugin really has.
   *
   * The inputs with a `preference` attribute are bound by Zotero, but the
   * two dropdowns are not — and a template that was just loaded has to be
   * reflected without reopening the pane.
   */
  _restoreDestinationSettings: function () {
    var addon = Zotero.ZoteroSiYuan;
    if (!addon || !addon.getDestinationSettings) {
      return;
    }
    var settings = addon.getDestinationSettings();
    var destination = document.getElementById(this.DESTINATION_ID);
    if (destination) {
      destination.value = settings.destination;
    }
    var target = document.getElementById(this.TARGET_DOCUMENT_ID);
    if (target) {
      target.value = settings.targetDocument;
    }
    var name = document.getElementById(this.ITEM_DOC_NAME_ID);
    if (name) {
      name.value = settings.itemDocName;
    }
    var path = document.getElementById(this.ITEM_DOC_PATH_ID);
    if (path) {
      path.value = settings.itemDocPath;
    }
    var sent = document.getElementById(this.SENT_ACTION_ID);
    if (sent) {
      sent.value = String(addon.getPref("sentAction", "ask") || "ask");
    }
    this._syncDestinationFields();
  },

  /** Only the fields the chosen destination actually uses. */
  _syncDestinationFields: function () {
    var select = document.getElementById(this.DESTINATION_ID);
    var kind = select ? String(select.value || "daily") : "daily";
    var targetRow = document.getElementById(this.TARGET_DOCUMENT_ROW_ID);
    var itemRow = document.getElementById(this.ITEM_DOC_ROW_ID);
    if (targetRow) {
      targetRow.style.display = kind === "document" ? "" : "none";
    }
    if (itemRow) {
      itemRow.style.display = kind === "item" ? "" : "none";
    }
  },

  /** The destination dropdown changed. */
  _saveDestination: function (value) {
    var addon = Zotero.ZoteroSiYuan;
    if (addon && addon.setPref) {
      addon.setPref("destination", String(value || "daily"));
    }
    this._syncDestinationFields();
  },

  /** What a click on an already-sent annotation does. */
  _saveSentAction: function (value) {
    var addon = Zotero.ZoteroSiYuan;
    if (addon && addon.setPref) {
      addon.setPref("sentAction", String(value || "ask"));
    }
  },

  /**
   * Where the notes of the template in the editor go.
   *
   * The pane does not read preferences itself — the plugin owns them — so
   * the settings are asked for before a template is saved.
   *
   * @returns {Object}
   */
  _destinationSettings: function () {
    var addon = Zotero.ZoteroSiYuan;
    return addon && addon.getDestinationSettings
      ? addon.getDestinationSettings()
      : {};
  },

  /**
   * Take the destination a loaded template carries.
   *
   * A template saved before destinations existed carries none, and then
   * the current setting is left alone.
   *
   * @param {Object} entry - a saved template
   * @returns {Boolean} whether a destination was applied
   */
  applyTemplateDestination: function (entry) {
    var addon = Zotero.ZoteroSiYuan;
    if (!entry || !addon || !addon.applyDestinationSettings) {
      return false;
    }
    var fields = ["destination", "targetDocument", "itemDocName", "itemDocPath"];
    var found = false;
    for (var i = 0; i < fields.length; i++) {
      if (entry[fields[i]]) {
        found = true;
        break;
      }
    }
    if (!found) {
      return false;
    }
    addon.applyDestinationSettings(entry);
    this._restoreDestinationSettings();
    return true;
  },

  /**
   * Rebuild the list of the annotations that have been sent.
   *
   * The mapping lives in the SiYuan workspace, so it is read back from
   * there — nothing is stored in the Zotero library.
   */
  _rescan: async function () {
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
        this._text("zoteroSiYuan-pref-rescanned", "Sent annotations found") +
          " " +
          count,
        false,
      );
    }
    catch (e) {
      this._setResult(e.message, true);
    }
  },


  /**
   * Run the end-to-end self test: the same code path a click takes, so a
   * passing result means the plugin really works in this Zotero.
   */
  _selfTest: async function () {
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
      // The pane's button honours the same `selfTestWrite` switch the
      // startup test does — a test that says it writes has to write.
      var realWrite = Zotero.ZoteroSiYuan.isPrefTrue
        ? Zotero.ZoteroSiYuan.isPrefTrue("selfTestWrite")
        : false;
      var report = await Zotero.ZoteroSiYuan.selfTest({ realWrite: realWrite });
      if (!report.ok) {
        throw new Error(report.error);
      }
      this._setResult(
        this._text("zoteroSiYuan-pref-selftest-ok", "Self test passed") +
          " " +
          report.path,
        false,
      );
    }
    catch (e) {
      this._setResult(
        this._text("zoteroSiYuan-pref-selftest-failed", "Self test failed") +
          " " +
          e.message,
        true,
      );
    }
  },


  /** Check both transports and say what the plugin sees. */
  _test: async function () {
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
      var names = Array.isArray(report.notebooks)
        ? report.notebooks
          .map(function (n) {
            return n && n.name ? n.name : String(n);
          })
          .join(", ")
        : "";
      var text =
        this._text("zoteroSiYuan-pref-ok", "Connected, notebooks") + " " + names;
      if (report.transport === "http") {
        // Only one of the two ways in works — say which one, or the
        // message looks like the usual success.
        text +=
          "  |  " +
          this._text(
            "zoteroSiYuan-pref-http-only",
            "via the SiYuan HTTP API (the CLI is not usable)",
          );
      }
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
      // The report the message came from is already on disk (the plugin
      // wrote it while diagnosing), so it is not asked for a second time —
      // that would only repeat the whole probe and slow the failure down.
      this._setResult(e.message, true);
    }
  },
});
