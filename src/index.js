/**
 * Zotero → SiYuan — plugin entry point.
 *
 * Adds a small button next to every annotation in the Zotero PDF reader's side
 * panel. Clicking it appends the annotation (its highlighted text, its comment
 * and the bibliographic metadata) to today's SiYuan daily note.
 *
 * The button is injected through Zotero.Reader's `renderSidebarAnnotationHeader`
 * event, whose payload is:
 *
 *   event.doc     — the reader iframe document
 *   event.params  — { type: 'SidebarAnnotationHeader', annotation: {...} }
 *   event.append  — appends nodes into the annotation header (synchronous!)
 *   event.reader  — the Reader tab instance
 */

import { SiYuanCLI, siyuanTimestamp } from "./modules/siyuan.js";
import { SiYuanHTTP } from "./modules/siyuan-http.js";
import { collectMetadata, siyuanBlockLink } from "./modules/metadata.js";
import { SiYuanIndex } from "./modules/siyuan-index.js";
import {
  annotationImageDataURL,
  annotationImagePath,
  cacheImagePath,
  exportPicture,
  findPicture,
  isPictureAnnotation,
  pictureMarkdown,
  pictureName,
  removePicture,
} from "./modules/siyuan-image.js";
import {
	launchExternally,
	suppressProtocolWarning,
} from "./modules/siyuan-launcher.js";
import { createSiyuanIcon } from "./modules/icons.js";
import { showToast } from "./modules/toast.js";
import {
	DEFAULT_TEMPLATE,
	TEMPLATE_PRESETS,
	TEMPLATE_VARIABLES,
	appendPicture,
	renderTemplate,
	templateVariables,
	validateTemplate,
} from "./modules/template.js";
import {
	insertToken,
	insertVariable,
	insertConditional,
	insertConditionalTag,
	conditionalToken,
	variableToken,
} from "./modules/template-edit.js";
import { runDiagnostics } from "./modules/diagnostics.js";
import { runSelfTest } from "./modules/selftest.js";
import { getPref, setPref } from "./utils/prefs.js";
import { getString, initLocale } from "./utils/locale.js";

const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><path fill="currentColor" d="M9 2.5 15.5 8 9 13.5V9.6H2.5V6.4H9V2.5Z"/></svg>';

const PLUGIN_ID = "zotero-siyuan@example.com";

/**
 * A marker that changes with every build.
 *
 * It is written to the debug log on startup, so it is always possible to
 * tell from a log which build is actually running.
 */
const BUILD = "index-scan";

const BUTTON_STYLE =
  "display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;min-width:20px;padding:0;margin:0 2px;border:0;border-radius:3px;background:transparent;color:inherit;cursor:pointer;opacity:.65;";

const SENT_LINK_STYLE =
  "display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;min-width:18px;padding:0;margin:0 2px;border:0;border-radius:3px;background:transparent;cursor:pointer;opacity:.85;text-decoration:none;";

const SENT_ICON_STYLE = "display:block;flex:none;";

class ZoteroSiYuanAddon {
  constructor() {
    this.data = {
      config: {
        addonRef: "zoteroSiYuan",
        addonName: "Zotero to SiYuan",
        addonID: PLUGIN_ID,
      },
      prefs: {},
      env: { NODE_ENV: "development" },
    };
    this._sending = false;
    // Which SiYuan block an annotation went to. The mapping lives in the
    // workspace, not in the Zotero library — see `modules/siyuan-index.js`.
    this._index = new SiYuanIndex();
    // Reader documents that already have the delegated click listener, and
    // the attachments whose blocks are in the index.
    this._delegatedDocs = new WeakSet();
    this._indexedAttachments = new Set();
    // Reader documents the plugin has seen a render event for. Their sidebar
    // is redrawn by the reader itself, and every redraw hands the plugin the
    // event again — so they never have to be patched by hand.
    this._renderedDocs = new WeakSet();
    // The self test watches the send path without changing it: it puts its
    // hooks here right before it clicks, and the click picks them up. A
    // click that carries no hooks — every real one — is never affected.
    this._pendingSendHooks = null;
    // The picture of the annotation that is being sent right now, and where
    // it was put. A send that never reaches SiYuan has to take it back —
    // the workspace belongs to the user.
    this._pendingPicture = null;
    // The SiYuan workspace the notes go into, and the HTTP fallback
    // client. Both are looked up once and kept — every lookup of the
    // client authenticates against the kernel, and the kernel counts the
    // failed attempts.
    this._workspaceDir = "";
    this._workspaceKey = null;
    this._http = null;
    this._httpKey = null;
    // The document of every reader that has rendered a sidebar. The reader
    // event for the context menu does not carry the document, so it is
    // remembered here while the sidebar renders.
    this._readerDocs = new WeakMap();
    // Resolving a Fluent message is not free, and a sidebar can render
    // hundreds of headers — so the labels are looked up once.
    this._labels = null;
    // Why the last CLI call failed — kept so the error the user sees can
    // name both transports instead of only the last one.
    this._lastCLIError = "";
    this._lastNotebookError = "";
    // The reader event is dispatched by Zotero, not by us, so the handler has
    // to be bound — otherwise `this` is not the plugin instance.
    this._onRenderSidebarAnnotationHeader =
      this._onRenderSidebarAnnotationHeader.bind(this);
    this._onCreateAnnotationContextMenu =
      this._onCreateAnnotationContextMenu.bind(this);
    this.hooks = {
      onStartup: this.onStartup.bind(this),
      onShutdown: this.onShutdown.bind(this),
      onMainWindowLoad: this.onMainWindowLoad.bind(this),
      onMainWindowUnload: this.onMainWindowUnload.bind(this),
    };
  }

  /* ------------------------------------------------------------ lifecycle */

  async onStartup() {
    initLocale();

    Zotero.PreferencePanes.register({
      pluginID: PLUGIN_ID,
      src: "content/preferences.xhtml",
      scripts: ["content/preferences.js"],
      stylesheets: ["content/styles.css"],
    });

    Zotero.Reader.registerEventListener(
      "renderSidebarAnnotationHeader",
      this._onRenderSidebarAnnotationHeader,
      PLUGIN_ID,
    );

    Zotero.debug(
      "ZoteroSiYuan: the reader listener is registered",
    );

    // The reader's context menu for annotations: the selected annotations
    // can be sent to SiYuan in one go.
    Zotero.Reader.registerEventListener(
      "createAnnotationContextMenu",
      this._onCreateAnnotationContextMenu,
      PLUGIN_ID,
    );

    Zotero.debug(
      `Zotero to SiYuan started (build: ${BUILD}) from ${_globalThis.rootURI}`,
    );

    // If the CLI cannot be resolved, write a full diagnostics report to the
    // temp directory so the failure can be inspected without a GUI
    // round-trip.
    try {
      await this.getCLI().resolveExecutable();
    }
    catch (e) {
      Zotero.debug(`ZoteroSiYuan: ${e.message}`);
      try {
        await runDiagnostics({ executable: getPref("cliPath", "") });
      }
      catch (e2) {
        Zotero.debug(`ZoteroSiYuan: diagnostics failed: ${e2}`);
      }
    }

    // Run the self test in the background. It drives the same code path a
    // user's click takes, so its report is the plugin's own proof that it
    // works inside Zotero — no GUI round-trip needed to check.
    if (String(getPref("selfTest", "1")) !== "0") {
      const realWrite = String(getPref("selfTestWrite", "")) === "1";
      runSelfTest({
        addon: this,
        notebookPref: getPref("notebook", ""),
        realWrite,
      }).catch((e) => {
        Zotero.debug(`ZoteroSiYuan: self test failed: ${e}`);
      });
    }

    // Build the index of already-sent annotations in the background, so the
    // reader can offer a way back to the SiYuan block.
    this.refreshIndex();

    // A reader that was restored when Zotero started may have drawn its
    // sidebar before this plugin was awake — look after those.
    this._startSidebarWatcher();

    // The desktop app is normally started directly, so no confirmation
    // dialog appears. This only matters for the fallback path — and it is
    // the same preference the dialog's "remember my choice" box writes.
    if (suppressProtocolWarning()) {
      Zotero.debug(
        "ZoteroSiYuan: the browser will not ask before opening siyuan:// links",
      );
    }
  }

  async onShutdown() {
    Zotero.Reader.unregisterEventListener(
      "renderSidebarAnnotationHeader",
      this._onRenderSidebarAnnotationHeader,
    );
    Zotero.Reader.unregisterEventListener(
      "createAnnotationContextMenu",
      this._onCreateAnnotationContextMenu,
    );
  }

  async onMainWindowLoad() {
    // The plugin does not touch the main window's DOM.
  }

  async onMainWindowUnload() {
    // Nothing to clean up in the main window.
  }

  /* -------------------------------------------------------------------- UI */

  /** The localized labels, resolved once. */
  _label(name, fallback) {
    if (!this._labels) {
      this._labels = {};
    }
    if (this._labels[name] === undefined) {
      this._labels[name] = getString(name, fallback);
    }
    return this._labels[name];
  }

  _onRenderSidebarAnnotationHeader(event) {
    const doc = event && event.doc;
    const params = event && event.params;
    const annotation = params && params.annotation;
    if (!doc || !annotation) {
      return;
    }

    // One delegated listener per reader document, instead of one per link —
    // a PDF with hundreds of annotations would otherwise pile up hundreds
    // of listeners.
    this._ensureDelegation(doc);

    // The plugin is now part of this sidebar: the reader redraws it and
    // hands the plugin the event again, so it never has to be patched.
    this._renderedDocs.add(doc);

    // Say it once per reader, so the log shows whether the sidebar was
    // rendered after the plugin started.
    if (!this._announcedDocs) {
      this._announcedDocs = new WeakSet();
    }
    if (!this._announcedDocs.has(doc)) {
      this._announcedDocs.add(doc);
      Zotero.debug("ZoteroSiYuan: the reader's sidebar was rendered");
    }

    // Remember the document: the context menu event does not carry it, and
    // the batch send needs it to add the markers right away.
    if (event.reader && typeof event.reader === "object") {
      try {
        this._readerDocs.set(event.reader, doc);
      }
      catch (e) {
        // A reader that cannot be a weak map key — not worth failing over.
      }
    }

    const button = this._createButton(doc, annotation, event.reader);
    const nodes = [button];

    // Already sent? Offer a way back to the SiYuan block. The mapping comes
    // from the workspace, so it works on every machine and leaves no trace
    // in the Zotero library.
    const sentBlockID = this._index.get(annotation.id);
    if (sentBlockID) {
      // A marker that was put in by hand — the one that appears right after
      // a send — is invisible to the reader, so it would stand next to the
      // one rendered here and the sidebar would show two. Drop the
      // hand-made one first.
      this._dropManualLinks(doc, annotation.id);
      nodes.push(this._createSentLink(doc, sentBlockID, annotation.id));
    }

    // append() must be called synchronously, before this handler returns.
    //
    // The button and the marker go in **one** call on purpose: the reader
    // wraps every single append() call in a box of its own, so two calls
    // would put the button and the marker into two different boxes — and
    // then neither of them can see the other.
    event.append(...nodes);

    // Make sure this PDF's blocks are in the index. The sidebar is
    // rendered synchronously, so this happens in the background — and the
    // markers are added the moment the answer arrives.
    this._ensureAttachmentIndexed(event.reader, doc);
  }

  /**
   * The button that sends an annotation to SiYuan.
   *
   * @param {Object} doc - the reader document
   * @param {Object} annotation - the reader's annotation model
   * @param {Object} reader - the reader instance
   * @returns {Object} the button
   */
  _createButton(doc, annotation, reader) {
    const button = doc.createElement("button");
    button.className = "zotero-siyuan-annotation-button";
    button.type = "button";
    button.style.cssText = BUTTON_STYLE;
    // The key is what the index is keyed by, so the marker can be added
    // later even if the index was not ready when the header was rendered.
    button.setAttribute("data-zsi-annotation", annotation.id || "");

    const label = this._label("zoteroSiYuan-button-label", "Send to SiYuan");
    button.setAttribute("aria-label", label);
    button.title = label;
    button.innerHTML = ICON_SVG;

    button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._send(annotation, reader, button);
    });

    return button;
  }

  /**
   * The document of a reader.
   *
   * The reader's context menu event does not carry the document, so it is
   * remembered while the sidebar renders. The reader's own window is the
   * fallback for the rare case where the sidebar has not rendered yet.
   *
   * @param {Object} reader - the reader instance
   * @returns {Object} the document
   */
  _readerDoc(reader) {
    // The reader's own window has the document that is on screen right
    // now — the reader may have drawn it again since.
    try {
      const win = reader && reader._iframeWindow;
      if (win && win.document && win.document.querySelectorAll) {
        return win.document;
      }
    }
    catch (e) {
      // The reader lives in another process — the sidebar has to render
      // first, then the document is known.
    }
    if (reader && this._readerDocs.has(reader)) {
      return this._readerDocs.get(reader);
    }
    return null;
  }

  /**
   * The key of the annotation a header belongs to.
   *
   * The reader names the page label of an annotation after its key, and
   * that label sits next to the header — so the key can be read out of the
   * page even when the header was drawn without this plugin.
   *
   * @param {Object} box - the reader's box for one annotation header
   * @returns {String} the key
   */
  _annotationKeyOf(box) {
    // The reader has boxes of its own that do not belong to an annotation —
    // the toolbar has one, for instance. Only the box of an annotation's
    // preview counts, and the page label of that preview is named after
    // the annotation's key.
    const preview = box.closest ? box.closest(".preview") : null;
    if (!preview || !preview.querySelector) {
      return "";
    }
    const label = preview.querySelector('[id^="page_"]');
    return label ? label.id.slice("page_".length) : "";
  }

  /**
   * Add the button to the headers of a reader that was drawn before this
   * plugin was awake.
   *
   * A reader that was restored when Zotero started draws its sidebar
   * before the plugins are up, so the reader's own event never reaches
   * this plugin and the sidebar would show no button at all.
   *
   * The reader wipes its box on every render, so the button that is put in
   * here is replaced by the reader's own one as soon as it draws again.
   *
   * @returns {Promise<Object>} how many headers were patched
   */
  async _patchReaderSidebars(readers) {
    const list =
      readers || (Zotero.Reader && Zotero.Reader._readers) || [];
    let patched = 0;
    let pending = 0;
    for (const reader of list) {
      if (!reader || !reader.itemID) {
        continue;
      }
      const doc = this._readerDoc(reader);
      if (!doc || !doc.querySelectorAll) {
        // The reader is still loading.
        pending++;
        continue;
      }
      // Remember it, so the rest of the plugin knows the reader as well.
      try {
        this._readerDocs.set(reader, doc);
      }
      catch (e) {
        // A reader that cannot be a weak map key.
      }

      // The marker is opened by a delegated listener, and this document has
      // never seen a render event — so it has no listener yet.
      this._ensureDelegation(doc);

      // A reader the plugin already sees redraws itself and hands the
      // plugin the event again, so there is nothing to patch: looking for
      // the button again would only cost a DOM query per annotation, every
      // two seconds, for three minutes.
      if (this._renderedDocs.has(doc)) {
        continue;
      }

      const boxes = doc.querySelectorAll(".custom-sections");
      if (!boxes.length) {
        // A reader without annotations — or one that is not ready yet.
        pending++;
        continue;
      }
      for (const box of boxes) {
        if (box.querySelector(".zotero-siyuan-annotation-button")) {
          continue;
        }
        const key = this._annotationKeyOf(box);
        const item = key ? await this._getAnnotationItem({ id: key }) : null;
        if (!item) {
          pending++;
          continue;
        }
        const section = doc.createElement("div");
        section.className = "section";
        section.appendChild(this._createButton(doc, this._annotationFromItem(item), reader));
        const blockID = this._index.get(key);
        if (blockID) {
          section.appendChild(this._createSentLink(doc, blockID, key, true));
        }
        box.appendChild(section);
        patched++;
      }
    }
    if (patched) {
      Zotero.debug(
        `ZoteroSiYuan: added the button to ${patched} annotation header(s) ` +
          "that were drawn before the plugin started",
      );
    }
    return { patched, pending };
  }

  /**
   * Look after the readers for a while after the start.
   *
   * The reader draws its sidebar when the PDF is ready, which can be a
   * long moment after it was restored — and it can happen before this
   * plugin is awake.
   */
  _startSidebarWatcher() {
    if (this._watchTimer) {
      return;
    }
    let ticks = 0;
    const tick = async () => {
      ticks++;
      try {
        await this._patchReaderSidebars();
      }
      catch (e) {
        Zotero.debug(`ZoteroSiYuan: could not patch the sidebars: ${e}`);
      }
      // Three minutes is enough for a PDF to load; after that the reader
      // draws its sidebar on its own and this plugin hears about it.
      if (ticks < 90) {
        this._watchTimer = setTimeout(tick, 2000);
      }
    };
    tick();
  }

  /**
   * Remove the markers that were inserted by hand for one annotation.
   *
   * Only the hand-made ones: the reader wipes its own box on every render
   * and puts a fresh marker in it, so a hand-made one that is still around
   * would stand next to it and the sidebar would show two.
   *
   * @param {Object} doc - the reader document
   * @param {String} annotationKey
   */
  _dropManualLinks(doc, annotationKey) {
    if (!doc || !doc.querySelectorAll) {
      return;
    }
    for (const node of doc.querySelectorAll("[data-zsi-manual]")) {
      if (node.getAttribute("data-zsi-for") === annotationKey) {
        node.remove();
      }
    }
  }

  /**
   * The "already sent" marker: the SiYuan logo, linking to the block.
   * @param {Object} doc - the reader document
   * @param {String} blockID - the SiYuan block
   * @param {String} annotationKey - the annotation it belongs to
   * @param {Boolean} manual - true when the plugin inserts it itself
   * @returns {Object} the element
   */
  _createSentLink(doc, blockID, annotationKey = "", manual = false) {
    const link = doc.createElement("a");
    link.className = "zotero-siyuan-sent-link";
    link.href = siyuanBlockLink(blockID);
    link.setAttribute("data-block-id", blockID);
    if (annotationKey) {
      link.setAttribute("data-zsi-for", annotationKey);
    }
    if (manual) {
      link.setAttribute("data-zsi-manual", "1");
    }
    link.style.cssText = SENT_LINK_STYLE;
    const label = this._label(
      "zoteroSiYuan-sent-title",
      "Already sent to SiYuan — click to open that block",
    );
    link.title = label;
    link.setAttribute("aria-label", label);

    const icon = createSiyuanIcon(doc, 14);
    icon.style.cssText = SENT_ICON_STYLE;
    link.appendChild(icon);

    return link;
  }


  /**
   * Handle the clicks on the markers with a single listener per document.
   * @param {Object} doc - the reader document
   */
  _ensureDelegation(doc) {
    if (!doc || this._delegatedDocs.has(doc)) {
      return;
    }
    this._delegatedDocs.add(doc);
    doc.addEventListener("click", (e) => {
      const target = e.target;
      const link =
        target && target.closest
          ? target.closest(".zotero-siyuan-sent-link")
          : null;
      if (!link) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      this._openInSiYuan(link.getAttribute("data-block-id"));
    });
  }

  /**
   * The marker that is already on screen for an annotation.
   *
   * The lookup covers the whole reader document, not just the box around
   * the button: the reader puts every append() call into a box of its own,
   * so the marker and the button do not have to sit next to each other.
   * An annotation key is unique, so a document-wide search cannot confuse
   * two annotations with each other.
   *
   * @param {Object} doc - the reader document
   * @param {String} annotationKey
   * @returns {Object} the element, or null
   */
  _existingMarker(doc, annotationKey) {
    if (!doc || !doc.querySelectorAll || !annotationKey) {
      return null;
    }
    for (const link of doc.querySelectorAll(".zotero-siyuan-sent-link")) {
      if (link.getAttribute("data-zsi-for") === annotationKey) {
        return link;
      }
    }
    return null;
  }

  /**
   * Add the marker to every annotation of a reader document that has been
   * sent but does not show it yet.
   *
   * This is what makes the marker appear right after a send, and what adds
   * it to an already open sidebar once the index arrives.
   *
   * @param {Object} doc - the reader document
   */
  _updateRenderedMarkers(doc) {
    if (!doc || !doc.querySelectorAll) {
      return 0;
    }
    let added = 0;
    const buttons = doc.querySelectorAll("[data-zsi-annotation]");
    for (const button of buttons) {
      const key = button.getAttribute("data-zsi-annotation");
      if (!key) {
        continue;
      }
      const blockID = this._index.get(key);
      if (!blockID) {
        continue;
      }
      // One marker per annotation, whether it was rendered by the reader or
      // put in by hand.
      const existing = this._existingMarker(doc, key);
      if (existing) {
        // A second send creates a new block — make the marker point there.
        if (existing.getAttribute("data-block-id") !== blockID) {
          existing.setAttribute("data-block-id", blockID);
          existing.href = siyuanBlockLink(blockID);
        }
        continue;
      }
      const parent = button.parentNode;
      if (!parent) {
        continue;
      }
      const marker = this._createSentLink(doc, blockID, key, true);
      // Right next to the button, and inside the box the reader wipes on
      // every render — so the reader's own marker replaces it later
      // instead of standing next to it.
      parent.insertBefore(marker, button.nextSibling);
      added++;
    }
    return added;
  }

  /**
   * Load the blocks of a PDF into the index, in the background.
   * @param {Object} reader - the reader tab
   * @param {Object} doc - the reader document
   */
  _ensureAttachmentIndexed(reader, doc) {
    const itemID = reader && reader.itemID;
    if (!itemID || this._indexedAttachments.has(itemID)) {
      return;
    }
    this._indexedAttachments.add(itemID);
    (async () => {
      try {
        const attachment = await Zotero.Items.getAsync(itemID);
        const key = attachment && attachment.key;
        if (!key) {
          return;
        }
        const found = await this._index.refreshForAttachment(this.getCLI(), key);
        Zotero.debug(
          `ZoteroSiYuan: indexed ${found} sent block(s) of attachment ${key}`,
        );
        this._updateRenderedMarkers(doc);
      }
      catch (e) {
        // Let it be tried again next time the PDF is opened.
        this._indexedAttachments.delete(itemID);
        Zotero.debug(
          `ZoteroSiYuan: could not index the attachment: ${e.message}`,
        );
      }
    })();
  }

  /**
   * Open a SiYuan block in the desktop app.
   *
   * The desktop app is started directly when possible, so no confirmation
   * dialog gets in the way; otherwise the URL goes through the system's
   * protocol handler.
   */
  async _openInSiYuan(blockID) {
    const url = siyuanBlockLink(blockID);
    if (!url) {
      return;
    }
    try {
      if (await launchExternally(url)) {
        return;
      }
    }
    catch (e) {
      Zotero.debug(`ZoteroSiYuan: could not start SiYuan directly: ${e}`);
    }
    try {
      Zotero.launchURL(url);
    }
    catch (e) {
      Zotero.debug(`ZoteroSiYuan: could not open ${url}: ${e}`);
    }
  }

  /**
   * Add "send to SiYuan" to the reader's annotation context menu.
   *
   * The reader hands over the ids of the selected annotations, which is
   * exactly what a batch send needs.
   */
  _onCreateAnnotationContextMenu(event) {
    const ids = (event && event.params && event.params.ids) || [];
    if (!ids.length) {
      return;
    }
    const reader = event.reader;
    // The context menu event does not carry the document, so it is looked
    // up — it is known as soon as the sidebar has rendered once.
    const doc = this._readerDoc(reader);
    event.append({
      label:
        ids.length === 1
          ? getString("zoteroSiYuan-menu-send-one", "Send to SiYuan")
          : getString("zoteroSiYuan-menu-send-many", "Send to SiYuan")
              .replace("%d", String(ids.length)),
      onCommand: () => {
        this._sendMany(ids, reader, doc);
      },
    });
  }

  /* ---------------------------------------------------------------- write */

  /**
   * The hooks of the send that is about to happen — and only that one.
   *
   * The self test puts its hooks on the addon right before it clicks the
   * button, and the click handler calls `_send` synchronously. So the hooks
   * are taken by exactly the send they were meant for, and a real click —
   * which carries none — is never watched, redirected or delayed.
   *
   * @returns {Object|null} the hooks, or null for a real send
   */
  _takeSendHooks() {
    const hooks = this._pendingSendHooks;
    this._pendingSendHooks = null;
    return hooks || null;
  }

  async _send(annotation, reader, button) {
    // The hooks are picked up here, synchronously: the click handler calls
    // `_send` before it returns, so a hook that was put on the addon just
    // before the click is certain to be the one this send uses — and a
    // click that carries no hook is never affected by the self test.
    const hooks = this._takeSendHooks();

    if (this._sending) {
      // Another send is still running. Say so, instead of doing nothing —
      // a button that does not react looks like a broken plugin.
      this._flash(
        button,
        getString("zoteroSiYuan-busy", "Sending…"),
        false,
      );
      return;
    }
    this._sending = true;
    button.style.opacity = "1";
    button.disabled = true;

    try {
      const result = await this._sendAnnotation(annotation, reader, hooks);
      this._flash(button, getString("zoteroSiYuan-done", "Sent to SiYuan"), false);
      Zotero.debug(
        `ZoteroSiYuan: appended an annotation to the SiYuan daily note in notebook ${result.notebook.name} (${result.notebook.id}) via ${result.transport}` +
          (result.blockID ? `, block ${result.blockID}` : ""),
      );
      // The marker shows up right away — no need to reopen the PDF.
      if (result.blockID && button) {
        this._updateRenderedMarkers(button.ownerDocument);
      }
      this._notify(result);
    }
    catch (e) {
      Zotero.logError(`ZoteroSiYuan: ${e}`);
      this._flash(button, `${getString("zoteroSiYuan-failed")} ${e.message}`, true);
    }
    finally {
      this._sending = false;
      button.disabled = false;
      button.style.opacity = "";
    }
  }

  /**
   * Render one annotation and send it to SiYuan.
   *
   * The single-annotation button and the batch action share this, so both
   * behave exactly the same.
   *
   * @param {Object} annotation - the reader's annotation model
   * @param {Object} reader - the reader tab
   * @param {Object} [hooks] - what the self test watches this send with
   * @returns {Promise<Object>} what happened
   */
  async _sendAnnotation(annotation, reader, hooks = null) {
    const markdown = await this._buildContent(annotation, reader, hooks);
    if (hooks && hooks.stage) {
      hooks.stage("resolving the notebook");
    }
    const notebook = await this._resolveNotebook();
    if (hooks && hooks.notebook) {
      hooks.notebook(notebook);
    }
    let sent;
    try {
      sent = (await this._append(notebook.id, markdown, hooks)) || {};
    }
    catch (e) {
      // The note never reached SiYuan — the picture that came with it has
      // to go back, or the workspace keeps a picture nobody refers to.
      await this._dropPicture();
      throw e;
    }
    // The note is in SiYuan, so the picture that came with it belongs to
    // the note now.
    this._pendingPicture = null;
    // `_append` answers with an object; accept a plain string too, so a
    // change there cannot silently lose the block id.
    const transport = typeof sent === "string" ? sent : sent.transport;
    const blockID = typeof sent === "string" ? "" : sent.blockID || "";
    // Remember it right away — no need to wait for the next scan.
    const annotationKey = await this._resolveAnnotationKey(annotation);
    if (annotationKey && blockID) {
      this._index.add(annotationKey, blockID);
    }
    return { transport, blockID, notebook, markdown };
  }

  /** The bubble that confirms the write and offers a way back to SiYuan. */
  _notify(result) {
    try {
      showToast({
        title: getString("zoteroSiYuan-toast-title", "Sent to SiYuan"),
        message: result.notebook
          ? `${result.notebook.name} · ${result.transport}`
          : result.transport,
        link: siyuanBlockLink(result.blockID),
        linkLabel: getString("zoteroSiYuan-toast-open", "Open in SiYuan"),
        onLink: result.blockID
          ? () => this._openInSiYuan(result.blockID)
          : null,
      });
    }
    catch (e) {
      Zotero.debug(`ZoteroSiYuan: could not show the notification: ${e}`);
    }
  }

  /**
   * Send several annotations at once.
   *
   * @param {String[]} ids - the annotation keys
   * @param {Object} reader - the reader tab
   * @param {Object} doc - the reader document
   */
  async _sendMany(ids, reader, doc) {
    if (this._sending) {
      // Another send is still running — say so instead of doing nothing.
      showToast({
        title: getString("zoteroSiYuan-busy", "Sending…"),
        message: getString("zoteroSiYuan-busy-hint", "Wait for it to finish."),
      });
      return;
    }
    this._sending = true;
    let sent = 0;
    let failed = 0;
    let lastBlock = "";
    // The document of the reader, so the markers can be added right away.
    const target = doc || this._readerDoc(reader);
    try {
      for (const id of ids) {
        try {
          const item = await this._getAnnotationItem({ id });
          if (!item) {
            failed++;
            continue;
          }
          const annotation = this._annotationFromItem(item);
          const result = await this._sendAnnotation(annotation, reader);
          sent++;
          if (result.blockID) {
            lastBlock = result.blockID;
          }
        }
        catch (e) {
          failed++;
          Zotero.logError(`ZoteroSiYuan: ${e}`);
        }
      }
      // The markers show up right away, like they do for a single send.
      if (target) {
        this._updateRenderedMarkers(target);
      }
      showToast({
        title: getString("zoteroSiYuan-toast-batch-title", "Sent to SiYuan"),
        message: failed
          ? `${sent} sent, ${failed} failed`
          : `${sent} sent`,
        link: siyuanBlockLink(lastBlock),
        linkLabel: getString("zoteroSiYuan-toast-open", "Open in SiYuan"),
        onLink: lastBlock ? () => this._openInSiYuan(lastBlock) : null,
      });
    }
    finally {
      this._sending = false;
    }
  }

  /** The reader's annotation model, built from a Zotero annotation item. */
  _annotationFromItem(item) {
    let position = null;
    try {
      position = item.annotationPosition
        ? JSON.parse(item.annotationPosition)
        : null;
    }
    catch (e) {
      position = null;
    }
    return {
      id: item.key,
      type: item.annotationType || "highlight",
      text: item.annotationText || "",
      comment: item.annotationComment || "",
      pageLabel: item.annotationPageLabel || "",
      authorName: item.annotationAuthorName || "",
      position,
      tags: (item.getTags() || []).map((t) => ({ name: t.tag })),
      // The picture of a "框选" annotation. It is looked up here, while the
      // item is at hand: the item knows which library it belongs to, and
      // that is what the cache path is built from.
      imagePath: annotationImagePath(item),
    };
  }

  /* ------------------------------------------------------------- template */

  /**
   * A localized string.
   *
   * The preferences pane runs in its own scope and cannot see the plugin's
   * modules, so it asks the plugin instance for its strings.
   */
  getString(id, fallback) {
    return getString(id, fallback);
  }

  /**
   * Insert a token into the template at the caret.
   *
   * The preferences pane cannot use the plugin's modules directly — it runs
   * in its own scope — so it asks the plugin instance to do the editing.
   *
   * @param {String} text - the current template
   * @param {String} token - what to insert
   * @param {Number} start - where the insertion starts
   * @param {Number} end - what the insertion replaces
   * @returns {{value: String, caret: Number}}
   */
  insertToken(text, token, start, end) {
    return insertToken(text, token, start, end);
  }

  /**
   * Insert a variable into the template, keeping it readable.
   *
   * A callout has to start a line of its own, and the indentation of the
   * line it lands on is kept.
   */
  insertVariable(text, token, start, end) {
    return insertVariable(text, token, start, end);
  }

  /** The token of a template variable. */
  variableToken(name) {
    return variableToken(name);
  }

  /**
   * Put a conditional around the selection, or an empty one in its place.
   *
   * The tags go on lines of their own, and the text that was selected is
   * left exactly as it was.
   */
  insertConditional(text, name, start, end) {
    return insertConditional(text, name, start, end);
  }

  /**
   * Put a single conditional tag — `{{else}}` or `{{/if}}` — on its own line.
   */
  insertConditionalTag(text, tag, start, end) {
    return insertConditionalTag(text, tag, start, end);
  }

  /** The token that opens a conditional. */
  conditionalToken(name) {
    return conditionalToken(name);
  }

  /** The templates that are ready to use. */
  getTemplatePresets() {
    return TEMPLATE_PRESETS.map((preset) => ({
      id: preset.id,
      name: preset.name,
      template: preset.template,
    }));
  }

  /** What is wrong with a template, if anything. */
  checkTemplate(template) {
    return validateTemplate(template);
  }

  /** The template in use — the user's, or the built-in default. */
  getTemplate() {
    const template = getPref("template", "");
    return template || DEFAULT_TEMPLATE;
  }

  /**
   * The raw template preference — empty means "use the built-in template".
   * The self test needs it to put the user's setup back exactly as it was.
   */
  getTemplatePref() {
    return getPref("template", "");
  }

  /** Store the user's template. */
  setTemplate(template) {
    return setPref("template", String(template == null ? "" : template));
  }

  /** Forget the user's template and go back to the default. */
  resetTemplate() {
    return setPref("template", "");
  }

  /**
   * The cheat sheet the preferences pane shows: every variable with its
   * explanation, plus the ones the current template actually uses.
   */
  getTemplateHelp() {
    const template = this.getTemplate();
    const used = templateVariables(template);
    return {
      template,
      defaultTemplate: DEFAULT_TEMPLATE,
      usedNames: used,
      variables: TEMPLATE_VARIABLES.map((variable) => ({
        ...variable,
        used: used.includes(variable.name),
      })),
    };
  }

  /**
   * Render a template with a real annotation, for the live preview.
   * @param {String} template
   * @returns {Promise<{text: String, unknown: String[]}>}
   */
  async previewTemplate(template) {
    const sample = await this._sample();
    const vars = collectMetadata({
      ...sample,
      annotationKey: sample.annotationKey,
      extra: this._now(),
    });
    return renderTemplate(template || DEFAULT_TEMPLATE, vars);
  }

  /** Briefly show a message in the button's tooltip. */
  _flash(button, message, isError) {
    button.title = message;
    button.style.opacity = "1";
    if (isError) {
      button.style.color = "var(--accent-red, #d33)";
    }
    setTimeout(() => {
      button.title = getString("zoteroSiYuan-button-label", "Send to SiYuan");
      button.style.opacity = "";
      button.style.color = "";
    }, 4000);
  }

  /* -------------------------------------------------------------- helpers */

  getCLI() {
    // The same client is reused, so the executable is resolved once instead
    // of spawning `siyuan --version` for every single command.
    const executable = getPref("cliPath", "");
    const workspace = getPref("workspace", "");
    const key = `${executable}|${workspace}`;
    if (!this._cli || this._cliKey !== key) {
      this._cli = new SiYuanCLI({ executable, workspace });
      this._cliKey = key;
    }
    return this._cli;
  }

  /**
   * Resolve the notebook, preferring the CLI and falling back to the kernel
   * HTTP API. The CLI is the transport we want, but a plugin that only works
   * when it can spawn a process is a plugin that breaks on some machines.
   */
  async _resolveNotebook() {
    const wanted = getPref("notebook", "");
    const cli = this.getCLI();
    try {
      return await cli.resolveNotebook(wanted);
    }
    catch (cliError) {
      this._lastNotebookError = cliError.message;
      Zotero.debug(
        `ZoteroSiYuan: the CLI could not resolve the notebook (${cliError.message}); trying the HTTP API`,
      );
      try {
        const http = await this._httpClient();
        return await http.resolveNotebook(wanted);
      }
      catch (httpError) {
        throw new Error(
          `the siyuan CLI failed: ${cliError.message} — ` +
            `the SiYuan HTTP API failed too: ${httpError.message}`,
        );
      }
    }
  }

  /**
   * Append to today's daily note, preferring the CLI.
   *
   * @param {String} notebookID
   * @param {String} markdown
   * @param {Object} [hooks] - what the self test watches this write with
   * @returns {Promise<{transport: String, documentID: String, blockID: String}>}
   */
  async _append(notebookID, markdown, hooks = null) {
    // The self test watches a send of its own, so it decides what the write
    // really does — a dry run, or a write it cleans up itself. A real send
    // carries no hooks and goes straight through.
    if (hooks && hooks.append) {
      return await hooks.append(notebookID, markdown);
    }
    const cli = this.getCLI();
    const since = siyuanTimestamp();
    try {
      const documentID = await cli.appendToDailyNote(notebookID, markdown);
      this._lastCLIError = "";
      const blocks = await this._findBlocks(cli, documentID, since);
      return {
        transport: "the siyuan CLI",
        documentID,
        blockID: blocks[0] || "",
        blocks,
      };
    }
    catch (cliError) {
      // Keep the reason: if the HTTP fallback fails too, the user needs to
      // see *both* failures, not just the last one.
      this._lastCLIError = cliError.message;
      Zotero.debug(
        `ZoteroSiYuan: the CLI could not write (${cliError.message}); trying the HTTP API`,
      );
      try {
        const http = await this._httpClient();
        const blockID = await http.appendDailyNote(notebookID, markdown);
        return {
          transport: "the SiYuan HTTP API",
          documentID: "",
          blockID: blockID || "",
          blocks: blockID ? [blockID] : [],
        };
      }
      catch (httpError) {
        throw new Error(
          `the siyuan CLI failed: ${cliError.message} — ` +
            `the SiYuan HTTP API failed too: ${httpError.message}`,
        );
      }
    }
  }

  /**
   * The SiYuan blocks a command has just created.
   *
   * The CLI answers with the id of the daily note document, so the blocks
   * themselves are looked up in the workspace's database. Failing to find
   * them is not fatal — the note was still written, only the "jump back"
   * link is missing.
   */
  async _findBlocks(cli, documentID, since) {
    if (!documentID) {
      return [];
    }
    try {
      return await cli.findBlocksSince(documentID, since);
    }
    catch (e) {
      Zotero.debug(
        `ZoteroSiYuan: could not find the new SiYuan block: ${e.message}`,
      );
      return [];
    }
  }

  /**
   * Rebuild the index of already-sent annotations from the workspace.
   *
   * @returns {Promise<Number>} how many annotations are known
   */
  async refreshIndex() {
    try {
      const count = await this._index.refresh(this.getCLI());
      Zotero.debug(
        `ZoteroSiYuan: the index knows ${count} sent annotation(s) ` +
          `(${this._index.blocksScanned} block(s) scanned)`,
      );
      // Now that the index knows what was sent, the readers that were
      // patched before can get their markers, too.
      this._patchReaderSidebars();
      return count;
    }
    catch (e) {
      Zotero.debug(`ZoteroSiYuan: could not build the index: ${e.message}`);
      return 0;
    }
  }

  /** The Zotero item behind the reader's annotation model. */
  async _getAnnotationItem(annotation) {
    const id = annotation && annotation.id;
    if (!id) {
      return null;
    }
    try {
      if (/^\d+$/.test(String(id))) {
        return await Zotero.Items.getAsync(Number(id));
      }
      const key = String(id);
      const item = await Zotero.Items.getByLibraryAndKeyAsync(
        Zotero.Libraries.userLibraryID,
        key,
      );
      if (item) {
        return item;
      }
      // The annotation may live in a group library — looking it up in
      // "My Library" alone would miss it, and with it the picture.
      for (const library of this._groupLibraries()) {
        try {
          const found = await Zotero.Items.getByLibraryAndKeyAsync(
            library.libraryID,
            key,
          );
          if (found) {
            return found;
          }
        }
        catch (e) {
          // The library may not be loaded — try the next one.
        }
      }
      return null;
    }
    catch (e) {
      return null;
    }
  }

  /** The group libraries, when Zotero knows about any. */
  _groupLibraries() {
    try {
      return (Zotero.Libraries.getAll() || []).filter(
        (library) =>
          library.libraryID !== Zotero.Libraries.userLibraryID,
      );
    }
    catch (e) {
      return [];
    }
  }

  /**
   * Watch the next send, without changing it.
   *
   * The self test uses this to see what a click really does. The hooks are
   * taken by the very next send and by that one only — a click that comes
   * after them is a real one again.
   *
   * @param {Object} hooks - { stage, notebook, append }
   */
  watchNextSend(hooks) {
    this._pendingSendHooks = hooks || null;
  }

  /**
   * Run the end-to-end self test on demand.
   *
   * It drives the same code path a click takes — the reader event, the
   * button, the handler — so a passing report means the plugin really works
   * in this Zotero, not just in a script that mimics it.
   *
   * @param {Object} options
   * @param {Boolean} options.realWrite - really append to the daily note
   */
  async selfTest({ realWrite = false } = {}) {
    return await runSelfTest({
      addon: this,
      notebookPref: getPref("notebook", ""),
      realWrite,
    });
  }

  async diagnose() {
    const report = await this.getCLI().diagnose();
    report.http = { ok: false, error: "" };
    if (!report.ok) {
      // The HTTP API is the fallback transport — check it too.
      try {
        const http = await SiYuanHTTP.discover(getPref("workspace", ""));
        const notebooks = await http.listNotebooks();
        report.http = {
          ok: true,
          host: http.host,
          port: http.port,
          workspace: http.workspaceDir,
          notebooks: notebooks.map((n) => n.name),
        };
      }
      catch (e) {
        report.http = { ok: false, error: e.message };
      }
      try {
        await runDiagnostics({ executable: getPref("cliPath", "") });
      }
      catch (e) {
        // ignore
      }
    }
    return report;
  }

  async _getParentItem(reader, hooks = null) {
    try {
      const itemID = reader && reader.itemID;
      if (!itemID) {
        return null;
      }
      if (hooks && hooks.stage) {
        hooks.stage("reading the parent item");
      }
      const attachment = await Zotero.Items.getAsync(itemID);
      if (!attachment || !attachment.parentItemID) {
        return null;
      }
      const parent = await Zotero.Items.getAsync(attachment.parentItemID);
      if (hooks && hooks.stage) {
        hooks.stage("parent item read");
      }
      return parent;
    }
    catch (e) {
      Zotero.debug(`ZoteroSiYuan: could not resolve the parent item: ${e}`);
      return null;
    }
  }

  /** The PDF attachment the reader is showing, if any. */
  async _getAttachment(reader) {
    try {
      const itemID = reader && reader.itemID;
      if (!itemID) {
        return null;
      }
      return await Zotero.Items.getAsync(itemID);
    }
    catch (e) {
      return null;
    }
  }

  /**
   * The annotation's key.
   *
   * Zotero's protocol handler wants the *key* (`getByLibraryAndKey`), while
   * the reader may hand out the numeric item id — so both are accepted.
   */
  async _resolveAnnotationKey(annotation) {
    const id = annotation && annotation.id;
    if (!id) {
      return "";
    }
    const text = String(id);
    if (!/^\d+$/.test(text)) {
      return text;
    }
    try {
      const item = await Zotero.Items.getAsync(Number(text));
      return item && item.key ? item.key : "";
    }
    catch (e) {
      return "";
    }
  }

  /** The date and time, as the template wants them. */
  _now() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
      now.getDate(),
    )}`;
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    return {
      date,
      time,
      timestamp: `${date} ${time}:${pad(now.getSeconds())}`,
    };
  }

  /**
   * Render the template for an annotation.
   * @param {Object} [hooks] - what the self test watches this render with
   * @returns {Promise<String>} the Markdown
   */
  async _buildContent(annotation, reader, hooks = null) {
    const parentItem = await this._getParentItem(reader, hooks);
    const attachment = await this._getAttachment(reader);
    const annotationKey = await this._resolveAnnotationKey(annotation);
    // A "框选" annotation has no text — the selection is a picture, and
    // the picture is put into the workspace before the note is written.
    const image = await this._preparePicture(annotation);
    const vars = collectMetadata({
      annotation,
      parentItem,
      attachment,
      annotationKey,
      image,
      extra: this._now(),
    });
    const { text, unknown } = renderTemplate(this.getTemplate(), vars);
    if (unknown.length) {
      Zotero.debug(
        `ZoteroSiYuan: the template uses variables that do not exist: ${unknown.join(", ")}`,
      );
    }
    return appendPicture(text, image);
  }

  /**
   * The picture of an area selection, ready to be put into the workspace.
   *
   * Zotero keeps the cropped picture in its cache; the reader also hands
   * it over as a data URL. The cache file is used when it is there — it
   * can be copied byte for byte — and the data URL is the fallback.
   *
   * A picture that cannot be found is not an error: the note is still
   * written, only without the picture. A missing picture must never cost
   * the user their comment.
   *
   * @param {Object} annotation - the reader's annotation model
   * @returns {Promise<String>} the Markdown of the picture, or ""
   */
  async _preparePicture(annotation) {
    // Every send starts without a picture; only a "框选" annotation gets
    // one, and a stale one from an earlier send must not be mistaken for
    // this send's picture.
    this._pendingPicture = null;
    // Every step of the chain, written down. When a picture does not
    // arrive, this is where the answer is — a failure that says nothing
    // is the hardest kind to find.
    const trace = {
      isPicture: false,
      key: "",
      cachePath: "",
      cached: false,
      dataURL: false,
      workspace: "",
      exported: "",
      error: "",
    };
    this._lastPictureTrace = trace;

    if (!isPictureAnnotation(annotation)) {
      return "";
    }
    trace.isPicture = true;
    const alt = getString("zoteroSiYuan-image-alt", "框选");
    const key = await this._resolveAnnotationKey(annotation);
    trace.key = key;
    if (!key) {
      trace.error = "the annotation has no key";
      Zotero.debug(
        "ZoteroSiYuan: the annotation has no key — the picture cannot be found",
      );
      return "";
    }

    // The cache file — the canonical copy.
    let source = null;
    let path = annotation.imagePath || "";
    if (!path) {
      // Most annotations live in "My Library", and their picture sits in a
      // folder that can be named without looking the item up at all.
      path = await findPicture(key, Zotero.Libraries.userLibraryID);
      trace.cachePath = path;
      trace.cached = !!path;
    }
    if (!path) {
      // A group library keeps its pictures in a folder of its own.
      const item = await this._getAnnotationItem({ id: key });
      if (item) {
        path = await annotationImagePath(item);
        trace.cachePath = path;
        trace.cached = !!path;
      }
    }
    if (path) {
      source = { path };
    }
    if (!source) {
      // The reader's own copy — the picture that came in with a sync.
      const dataURL = annotationImageDataURL(annotation);
      trace.dataURL = !!dataURL;
      if (dataURL) {
        source = { dataURL };
      }
    }
    if (!source) {
      trace.error = "no picture in the cache and none in the reader";
      Zotero.debug(
        "ZoteroSiYuan: the annotation has no picture to send — the cache file is missing",
      );
      return "";
    }

    const workspace = await this._resolveWorkspaceDir();
    trace.workspace = workspace;
    if (!workspace) {
      trace.error = "the SiYuan workspace is unknown";
      Zotero.debug(
        "ZoteroSiYuan: the SiYuan workspace is unknown — the picture cannot be placed",
      );
      return "";
    }

    try {
      const { asset, file } = await exportPicture(
        workspace,
        source,
        pictureName(key),
      );
      if (!asset) {
        trace.error = "the picture could not be placed";
        return "";
      }
      trace.exported = asset;
      // Remember where the picture went: a send that never reaches SiYuan
      // has to take it back.
      this._pendingPicture = { asset, file };
      return pictureMarkdown(asset, alt);
    }
    catch (e) {
      // The note is still worth writing without the picture.
      trace.error = String(e && e.message ? e.message : e);
      Zotero.logError(`ZoteroSiYuan: could not place the picture: ${e}`);
      return "";
    }
  }

  /**
   * What the plugin can see of the area selections in the library.
   *
   * The picture of a "框选" annotation lives in Zotero's cache. This walks
   * the library and reports what is really there — where the cache is,
   * which path the picture would have, and whether the file is on disk.
   * When a picture does not arrive, this is where the chain breaks.
   *
   * @returns {Promise<Object>} the report
   */
  async probePictures() {
    const report = {
      ok: false,
      cacheDir: "",
      workspace: "",
      annotations: [],
      error: "",
    };
    try {
      report.cacheDir = Zotero.DataDirectory.getSubdirectory("cache");
    }
    catch (e) {
      report.error = String(e && e.message ? e.message : e);
    }
    try {
      report.workspace = await this._resolveWorkspaceDir();
    }
    catch (e) {
      // The workspace is not needed to look at the cache.
    }
    try {
      const rows = await Zotero.DB.queryAsync(
        "SELECT itemID FROM itemAnnotations " +
          "WHERE itemID NOT IN (SELECT itemID FROM deletedItems) " +
          "ORDER BY itemID DESC LIMIT 200",
      );
      for (const row of rows || []) {
        const item = await Zotero.Items.getAsync(row.itemID);
        if (!item) {
          continue;
        }
        const type = String(item.annotationType || "").toLowerCase();
        if (!["image", "ink"].includes(type)) {
          continue;
        }
        const path = cacheImagePath(item.libraryID, item.key);
        let exists = false;
        try {
          exists = path ? await IOUtils.exists(path) : false;
        }
        catch (e) {
          exists = false;
        }
        report.annotations.push({
          key: item.key,
          type,
          libraryID: item.libraryID,
          path,
          exists,
        });
      }
      report.ok = true;
    }
    catch (e) {
      report.error = String(e && e.message ? e.message : e);
    }
    return report;
  }

  /**
   * Take back the picture of a send that never happened.
   *
   * A "框选" annotation brings its picture along, and the picture has to
   * be in the workspace before the note is written. When the write fails,
   * the picture would stay behind — and a workspace that fills up with
   * pictures no note refers to is litter.
   */
  async _dropPicture() {
    const picture = this._pendingPicture;
    this._pendingPicture = null;
    if (!picture) {
      return;
    }
    await removePicture(picture.file);
  }

  /**
   * The SiYuan workspace the notes go into.
   *
   * The workspace holds the assets, so the picture has to be put there
   * before the note is written.
   *
   * @returns {Promise<String>} the directory, or "" when it is unknown
   */
  async _resolveWorkspaceDir() {
    const configured = getPref("workspace", "");
    if (configured) {
      return configured;
    }
    const key = configured;
    if (this._workspaceKey !== key) {
      this._workspaceKey = key;
      this._workspaceDir = "";
    }
    if (this._workspaceDir) {
      return this._workspaceDir;
    }
    try {
      this._workspaceDir = await this.getCLI().currentWorkspace();
    }
    catch (e) {
      // The CLI is not reachable — the HTTP API knows the workspace too.
      try {
        const http = await this._httpClient();
        this._workspaceDir = http ? http.workspaceDir : "";
      }
      catch (e2) {
        this._workspaceDir = "";
      }
    }
    return this._workspaceDir;
  }

  /**
   * The HTTP fallback client — discovered once and kept.
   *
   * Every discovery authenticates against the kernel, and the kernel
   * counts the failed ones, so it is not done twice per send.
   *
   * @returns {Promise<SiYuanHTTP>}
   */
  async _httpClient() {
    const key = getPref("workspace", "");
    if (!this._http || this._httpKey !== key) {
      this._http = await SiYuanHTTP.discover(key);
      this._httpKey = key;
    }
    return this._http;
  }

  /**
   * A real annotation to preview the template with.
   *
   * A real one is worth much more than a made-up one: the user sees their
   * own paper, their own wording, and the real metadata.
   */
  async _sample() {
    try {
      const rows = await Zotero.DB.queryAsync(
        "SELECT itemID FROM itemAnnotations " +
          "WHERE itemID NOT IN (SELECT itemID FROM deletedItems) " +
          "ORDER BY itemID DESC LIMIT 25",
      );
      for (const row of rows || []) {
        const annotation = await Zotero.Items.getAsync(row.itemID);
        if (!annotation || !annotation.parentItemID) {
          continue;
        }
        const attachment = await Zotero.Items.getAsync(annotation.parentItemID);
        if (!attachment) {
          continue;
        }
        const parentItem = attachment.parentItemID
          ? await Zotero.Items.getAsync(attachment.parentItemID)
          : null;
        let position = null;
        try {
          position = annotation.annotationPosition
            ? JSON.parse(annotation.annotationPosition)
            : null;
        }
        catch (e) {
          position = null;
        }
        return {
          annotation: {
            id: annotation.key,
            type: annotation.annotationType || "highlight",
            text: annotation.annotationText || "",
            comment: annotation.annotationComment || "",
            pageLabel: annotation.annotationPageLabel || "",
            authorName: annotation.annotationAuthorName || "",
            position,
          },
          parentItem,
          attachment,
          annotationKey: annotation.key,
        };
      }
    }
    catch (e) {
      Zotero.debug(`ZoteroSiYuan: could not find an annotation to preview: ${e}`);
    }

    // Nothing in the library yet — show a made-up one.
    return {
      annotation: {
        id: "SAMPLE",
        type: "highlight",
        text: "This is what the highlighted text looks like.",
        comment: "This is what your comment looks like.",
        pageLabel: "12",
        authorName: "steve",
        position: { pageIndex: 11 },
      },
      parentItem: null,
      attachment: null,
      annotationKey: "",
    };
  }
}

/* ------------------------------------------------------------------ export */

const addon = new ZoteroSiYuanAddon();

_globalThis.addon = addon;
Zotero.ZoteroSiYuan = addon;
