/**
 * Zotero → SiYuan — the picture settings, and the check for area selections.
 *
 * One of several scripts that share the pane's scope: the object itself is
 * created in `preferences.js`, this file only adds its own methods. The order
 * of the parts does not matter — the pane is wired up by
 * `preferences-boot.js`, which is registered last.
 */

Object.assign(ZoteroSiYuanPreferences, {

  /**
   * Show what the plugin has stored about the pictures.
   *
   * The settings are stored by the plugin itself — the pane only asks it
   * for the value and hands a new one back.
   */
  _restoreImageSettings: function () {
    var addon = Zotero.ZoteroSiYuan;
    if (!addon || !addon.getPref) {
      return;
    }
    var compress = document.getElementById(this.IMAGE_COMPRESS_ID);
    if (compress) {
      compress.checked = addon.isPrefTrue
        ? addon.isPrefTrue("imageCompress", true)
        : String(addon.getPref("imageCompress", "1")) !== "0";
    }
    var quality = this._qualityValue();
    this._showQuality(quality);
  },


  /**
   * The compression quality, as a number inside the bounds.
   *
   * @returns {Number}
   */
  _qualityValue: function () {
    var addon = Zotero.ZoteroSiYuan;
    var stored = addon && addon.getPref
      ? Number(addon.getPref("imageQuality", "82"))
      : 82;
    if (!isFinite(stored) || stored <= 0) {
      stored = 82;
    }
    return Math.min(
      this.IMAGE_QUALITY_MAX,
      Math.max(this.IMAGE_QUALITY_MIN, Math.round(stored)),
    );
  },


  /**
   * Show the quality in both of its controls, and keep them in step.
   *
   * The slider and the number are two ways of saying the same thing —
   * the slider for finding a value, the number for setting one exactly.
   *
   * @param {Number} value
   */
  _showQuality: function (value) {
    var number = document.getElementById(this.IMAGE_QUALITY_ID);
    var slider = document.getElementById(this.IMAGE_QUALITY_RANGE_ID);
    if (number) {
      number.value = String(value);
    }
    if (slider) {
      slider.value = String(value);
    }
  },


  /**
   * Store one of the picture settings.
   *
   * @param {String} key
   * @param {String} value
   */
  _saveImageSetting: function (key, value) {
    var addon = Zotero.ZoteroSiYuan;
    if (!addon || !addon.setPref) {
      return;
    }
    addon.setPref(key, value);
    this._setResult(
      this._text("zoteroSiYuan-pref-image-saved", "Saved"),
      false,
    );
  },


  /**
   * Bring a value inside the bounds, without storing it.
   *
   * Dragging the slider fires `input` for every pixel; the number box has
   * to follow, but a preference write per pixel would be absurd.
   *
   * @param {String} raw
   * @returns {Number}
   */
  _syncQuality: function (raw) {
    var value = Number(raw);
    if (!isFinite(value)) {
      value = this._qualityValue();
    }
    value = Math.min(
      this.IMAGE_QUALITY_MAX,
      Math.max(this.IMAGE_QUALITY_MIN, Math.round(value)),
    );
    this._showQuality(value);
    return value;
  },


  /**
   * The user set the quality — by hand or with the slider.
   *
   * @param {String} raw - what the control says
   */
  _setQuality: function (raw) {
    var value = this._syncQuality(raw);
    this._saveImageSetting("imageQuality", String(value));
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
        this._text("zoteroSiYuan-pref-pictures-found", "Area selections") +
        " " +
        total +
        " · " +
        this._text("zoteroSiYuan-pref-pictures-missing", "Missing") +
        " " +
        missing.length +
        " · " +
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
});
