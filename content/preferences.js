/**
 * Zotero → SiYuan — preferences pane script.
 *
 * Zotero loads pane scripts into their own scope (`loadSubScript(script,
 * pane.scope)`), so plugin-scope globals are NOT visible here. The pane
 * therefore talks to the shared `Zotero` object only, and re-implements the
 * small amount of CLI access it needs.
 *
 * No inline event handlers are used: Firefox applies a baseline
 * `script-src chrome: resource: moz-src:` CSP to chrome documents, and Zotero
 * intends to drop its temporary exemption.
 */

"use strict";

var ZoteroSiYuanPreferences = {
	_rootURI: '',

	init: function () {
		this._rootURI = (Zotero.zoteroSiYuan && Zotero.zoteroSiYuan.rootURI) || '';
		this._applyLabels();
		this._wireTestButton();
	},

	/**
	 * Fill in any label the document's own l10n did not resolve. The
	 * preferences window is a chrome document and normally sees the
	 * app-wide `zotero-plugins` Fluent source; this keeps the pane readable
	 * if that ever stops being true.
	 */
	_applyLabels: function () {
		var elements = document.querySelectorAll('[data-l10n-id]');
		for (var element of elements) {
			if (element.textContent && element.textContent.trim()) {
				continue;
			}
			var id = element.getAttribute('data-l10n-id');
			var text = this._lookup(id);
			if (text) {
				element.textContent = text;
			}
		}
	},

	_lookup: function (id) {
		if (this._rootURI) {
			try {
				if (!this._l10n) {
					this._l10n = new Localization(
						[this._rootURI + 'locale/en-US/zotero-siyuan.ftl'],
						true,
						{ baseURI: this._rootURI }
					);
				}
				var value = this._l10n.formatValueSync(id);
				if (value) {
					return value;
				}
			}
			catch (e) {
				// Fall through
			}
		}
		try {
			var fromZotero = Zotero.getString(id);
			if (fromZotero && fromZotero !== id) {
				return fromZotero;
			}
		}
		catch (e) {
			// Fall through
		}
		return '';
	},

	_wireTestButton: function () {
		var button = document.getElementById('zotero-siyuan-test-button');
		if (!button) {
			return;
		}
		button.addEventListener('click', function () {
			this.test();
		}.bind(this));
	},

	_setResult: function (text, isError) {
		var result = document.getElementById('zotero-siyuan-test-result');
		if (!result) {
			return;
		}
		result.textContent = text;
		result.style.color = isError ? 'var(--accent-red, #d33)' : 'var(--accent-green, #2a7)';
	},

	_read: function (name, fallback) {
		var value = Zotero.Prefs.get('extensions.zotero-siyuan.' + name, true);
		if (value === undefined || value === null || value === '') {
			return fallback;
		}
		return value;
	},

	test: async function () {
		this._setResult(this._lookup('zotero-siyuan-prefs-testing') || 'Testing…', false);
		try {
			if (!Zotero.zoteroSiYuan || !Zotero.zoteroSiYuan.diagnose) {
				throw new Error('The plugin is not running. Restart Zotero and try again.');
			}
			var report = await Zotero.zoteroSiYuan.diagnose();
			if (!report.ok) {
				throw new Error(report.error);
			}
			var names = report.notebooks.map(function (n) { return n.name; }).join(', ');
			this._setResult(
				(this._lookup('zotero-siyuan-prefs-ok') || 'Connected. Notebooks: ') + names,
				false
			);
		}
		catch (e) {
			this._setResult(e.message, true);
		}
	}
};

(function () {
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', function () {
			ZoteroSiYuanPreferences.init();
		}, { once: true });
	}
	else {
		ZoteroSiYuanPreferences.init();
	}
}());
