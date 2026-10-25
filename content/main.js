/**
 * Zotero → SiYuan — main plugin code.
 *
 * Adds a small button to every annotation header in the Zotero PDF reader's
 * side panel. Clicking it appends the annotation (its highlighted text, its
 * comment and the bibliographic metadata) to today's SiYuan daily note.
 *
 * The button is injected through Zotero.Reader's `renderSidebarAnnotationHeader`
 * event, whose payload is:
 *
 *   event.doc     — the reader iframe document
 *   event.params  — { type: 'SidebarAnnotationHeader', annotation: {...} }
 *   event.append  — appends nodes into the annotation header (synchronous!)
 *   event.reader  — the Reader tab instance
 *
 * The annotation model carries: id, type, text, comment, color, pageLabel,
 * authorName, isAuthorNameAuthoritative, dateModified, position, sortIndex,
 * image, tags. `id` is the Zotero item key of the annotation.
 */

"use strict";

var ZS_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><path fill="currentColor" d="M9 2.5 15.5 8 9 13.5V9.6H2.5V6.4H9V2.5Z"/></svg>';

var ZS_BUTTON_STYLE = 'display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;min-width:20px;padding:0;margin:0 2px;border:0;border-radius:3px;background:transparent;color:inherit;cursor:pointer;opacity:.65;';

var ZoteroSiYuan = class {
	constructor(options) {
		this.id = options.id;
		this.version = options.version;
		this.rootURI = options.rootURI;

		this._l10n = null;
		this._sending = false;
		this._onRenderSidebarAnnotationHeader = this._renderSidebarAnnotationHeader.bind(this);
	}

	async init() {
		// The preferences pane is loaded into its own scope, so it cannot see
		// plugin-scope globals. Publish what it needs on the shared Zotero
		// object.
		Zotero.zoteroSiYuan = {
			rootURI: this.rootURI,
			version: this.version,
			diagnose: () => this._getCLI().diagnose()
		};

		// Make the plugin's Fluent file resolvable through Zotero.getString() as
		// well. Zotero 10 already registers plugin FTL files app-wide; this is a
		// belt-and-braces path for the main-window context.
		try {
			Zotero.ftl.addResourceIds([this.rootURI + 'locale/en-US/zotero-siyuan.ftl']);
		}
		catch (e) {
			Zotero.debug('ZoteroSiYuan: could not add the Fluent file to Zotero.ftl: ' + e);
		}

		Zotero.PreferencePanes.register({
			pluginID: this.id,
			src: 'content/preferences.xhtml',
			scripts: ['content/preferences.js'],
			stylesheets: ['content/styles.css']
		});

		Zotero.Reader.registerEventListener(
			'renderSidebarAnnotationHeader',
			this._onRenderSidebarAnnotationHeader,
			this.id
		);

		Zotero.debug('ZoteroSiYuan ' + this.version + ' started (plugin id ' + this.id + ')');
	}

	destroy() {
		Zotero.Reader.unregisterEventListener(
			'renderSidebarAnnotationHeader',
			this._onRenderSidebarAnnotationHeader
		);
		try {
			Zotero.ftl.removeResourceIds([this.rootURI + 'locale/en-US/zotero-siyuan.ftl']);
		}
		catch (e) {
			// Nothing to clean up
		}
		if (Zotero.zoteroSiYuan) {
			delete Zotero.zoteroSiYuan;
		}
	}

	/* ------------------------------------------------------------------ UI */

	_renderSidebarAnnotationHeader(event) {
		var doc = event && event.doc;
		var params = event && event.params;
		var annotation = params && params.annotation;
		if (!doc || !annotation) {
			return;
		}

		var button = doc.createElement('button');
		button.className = 'zotero-siyuan-annotation-button';
		button.type = 'button';
		button.style.cssText = ZS_BUTTON_STYLE;

		var label = this._getString('zotero-siyuan-button-label', 'Send to SiYuan');
		button.setAttribute('aria-label', label);
		button.title = label;
		button.innerHTML = ZS_ICON_SVG;

		var self = this;
		button.addEventListener('click', function (e) {
			e.preventDefault();
			e.stopPropagation();
			self._send(annotation, event.reader, button);
		});

		// append() must be called synchronously, before this handler returns.
		event.append(button);
	}

	/* --------------------------------------------------------------- write */

	async _send(annotation, reader, button) {
		if (this._sending) {
			return;
		}
		this._sending = true;
		button.style.opacity = '1';
		button.disabled = true;

		try {
			var cli = this._getCLI();
			var parentItem = await this._getParentItem(reader);
			var markdown = ZS_FORMAT.buildMarkdown({
				annotation: annotation,
				parentItem: parentItem,
				strings: this._formatStrings()
			});

			var notebook = await cli.resolveNotebook(this._getPref('notebook', ''));
			await cli.appendToDailyNote(notebook.id, markdown);

			this._flash(button, this._getString('zotero-siyuan-done', 'Sent to SiYuan'), false);
			Zotero.debug('ZoteroSiYuan: appended an annotation to the SiYuan daily note in notebook '
				+ notebook.name + ' (' + notebook.id + ')');
		}
		catch (e) {
			Zotero.logError('ZoteroSiYuan: ' + e);
			this._flash(button, this._getString('zotero-siyuan-failed', 'Failed: ') + e.message, true);
		}
		finally {
			this._sending = false;
			button.disabled = false;
			button.style.opacity = '';
		}
	}

	/** Briefly show a message in the button's tooltip. */
	_flash(button, message, isError) {
		button.title = message;
		button.style.opacity = '1';
		if (isError) {
			button.style.color = 'var(--accent-red, #d33)';
		}
		var self = this;
		setTimeout(function () {
			button.title = self._getString('zotero-siyuan-button-label', 'Send to SiYuan');
			button.style.opacity = '';
			button.style.color = '';
		}, 4000);
	}

	/* ------------------------------------------------------------- helpers */

	async _getParentItem(reader) {
		try {
			var itemID = reader && reader.itemID;
			if (!itemID) {
				return null;
			}
			var attachment = await Zotero.Items.getAsync(itemID);
			if (!attachment || !attachment.parentItemID) {
				return null;
			}
			return await Zotero.Items.getAsync(attachment.parentItemID);
		}
		catch (e) {
			Zotero.debug('ZoteroSiYuan: could not resolve the parent item: ' + e);
			return null;
		}
	}

	_formatStrings() {
		return {
			quoteTitle: this._getString('zotero-siyuan-quote-title', 'Quote'),
			commentTitle: this._getString('zotero-siyuan-comment-title', 'Comment'),
			authorLabel: this._getString('zotero-siyuan-label-author', 'Author'),
			yearLabel: this._getString('zotero-siyuan-label-year', 'Year'),
			publicationLabel: this._getString('zotero-siyuan-label-publication', 'Publication'),
			pageLabel: this._getString('zotero-siyuan-label-page', 'Page'),
			annotatorLabel: this._getString('zotero-siyuan-label-annotator', 'Annotated by'),
			sourceLabel: this._getString('zotero-siyuan-label-source', 'Source'),
			emptyAnnotation: this._getString('zotero-siyuan-empty-annotation', '(empty annotation)')
		};
	}

	/* --------------------------------------------------------------- prefs */

	_getPref(name, fallback) {
		var value = Zotero.Prefs.get('extensions.zotero-siyuan.' + name, true);
		if (value === undefined || value === null || value === '') {
			return fallback;
		}
		return value;
	}

	/**
	 * Build a client for the SiYuan command line interface.
	 *
	 * The CLI works on the workspace directly, so no API token, host or port
	 * is involved: an empty workspace means "whatever the CLI currently uses".
	 */
	_getCLI() {
		return new SiYuanCLI({
			executable: this._getPref('cliPath', ''),
			workspace: this._getPref('workspace', '')
		});
	}

	/* --------------------------------------------------------------- l10n */

	/**
	 * Resolve a message id from the plugin's Fluent file.
	 *
	 * The reader UI does not use `document.l10n` (it has its own Fluent
	 * bundles), so plugin strings cannot be resolved from inside the reader
	 * document. We read them in the plugin scope instead.
	 */
	_getString(id, fallback) {
		try {
			if (!this._l10n) {
				this._l10n = new Localization(
					[this.rootURI + 'locale/en-US/zotero-siyuan.ftl'],
					true,
					{ baseURI: this.rootURI }
				);
			}
			var value = this._l10n.formatValueSync(id);
			if (value) {
				return value;
			}
		}
		catch (e) {
			Zotero.debug('ZoteroSiYuan: Fluent lookup failed for "' + id + '": ' + e);
		}
		try {
			var fromZotero = Zotero.getString(id);
			if (fromZotero && fromZotero !== id) {
				return fromZotero;
			}
		}
		catch (e) {
			// Fall through to the hard-coded default
		}
		return fallback;
	}
};
