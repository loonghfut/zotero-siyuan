/**
 * Zotero → SiYuan — the buttons and sidebar patching in the PDF reader.
 */

import { getString } from "../utils/locale.js";
import {
	BUSY_OPACITY,
	BUTTON_STYLE,
	ICON_SVG,
	WATCH_FIRST_DELAY,
	WATCH_MAX_DELAY,
	WATCH_MIN_TICKS,
	WATCH_WINDOW_MS,
} from "./constants.js";

export default {
  /** The localized labels, resolved once. */
  _label(name, fallback) {
    if (!this._labels) {
      this._labels = {};
    }
    if (this._labels[name] === undefined) {
      this._labels[name] = getString(name, fallback);
    }
    return this._labels[name];
  },

  /**
   * The reader is drawing an annotation's header — put the button in.
   *
   * The append has to happen synchronously, before this handler returns,
   * and the button and the marker go in **one** call: the reader wraps
   * every call in a box of its own, so two calls would put them in two
   * boxes that cannot see each other.
   */
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
  },

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

    // A header that is drawn while a send is running arrives ready-made —
    // it must not offer a click that the send would only refuse.
    if (this._busyDocs && this._busyDocs.has(doc)) {
      button.disabled = true;
      button.style.opacity = BUSY_OPACITY;
    }

    button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._send(annotation, reader, button);
    });

    return button;
  },

  /**
   * Turn every send button of a reader on or off.
   *
   * A send writes one note at a time, and two of them at once would fight
   * over the same daily note in SiYuan. Disabling all of them — not only
   * the one that was clicked — makes that visible instead of leaving the
   * user with buttons that look ready and refuse to work.
   *
   * @param {Object} doc - the reader document
   * @param {Boolean} busy - true while a send is running
   * @returns {Number} how many buttons were touched
   */
  _setReaderBusy(doc, busy) {
    if (!doc || !doc.querySelectorAll) {
      return 0;
    }
    if (!this._busyDocs) {
      this._busyDocs = new WeakSet();
    }
    if (busy) {
      this._busyDocs.add(doc);
    }
    else {
      this._busyDocs.delete(doc);
    }
    let touched = 0;
    for (const button of doc.querySelectorAll(
      ".zotero-siyuan-annotation-button",
    )) {
      button.disabled = !!busy;
      button.style.opacity = busy ? BUSY_OPACITY : "";
      button.style.cursor = busy ? "progress" : "";
      touched++;
    }
    return touched;
  },

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
  },

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
  },

  /**
   * The readers that are open right now.
   *
   * @returns {Object[]} the reader tabs that have a PDF
   */
  _openReaders() {
    try {
      const list = (Zotero.Reader && Zotero.Reader._readers) || [];
      return list.filter((reader) => reader && reader.itemID);
    }
    catch (e) {
      return [];
    }
  },

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
   * @returns {Promise<Object>} how many headers were patched, and how many
   *   readers are still loading
   */
  async _patchReaderSidebars(readers) {
    const list = readers || this._openReaders();
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

      // The index has to know this PDF, or no marker can be shown for it.
      // It is loaded in the background here as well, for a reader whose
      // sidebar the plugin never saw being drawn.
      this._ensureAttachmentIndexed(reader, doc);

      // A reader the plugin already sees redraws itself and hands the
      // plugin the event again, so there is nothing to patch: looking for
      // the button again would only cost a DOM query per annotation, every
      // two seconds, for three minutes.
      if (this._renderedDocs.has(doc)) {
        continue;
      }

      const boxes = doc.querySelectorAll(".custom-sections");
      if (!boxes.length) {
        // A reader without annotations. There is nothing to patch, and there
        // never will be from here: an annotation added later makes the reader
        // draw the sidebar again, and that render reaches the plugin. Waiting
        // for it would keep the watcher alive for a PDF that has nothing to
        // show.
        continue;
      }
      // Which headers still need a button, and which annotation each one is.
      // They are collected first so the items can be read a few at a time:
      // one read after another made a 200-annotation PDF 200 waits in a row,
      // in a loop that runs every two seconds.
      const wanted = [];
      for (const box of boxes) {
        if (box.querySelector(".zotero-siyuan-annotation-button")) {
          continue;
        }
        const key = this._annotationKeyOf(box);
        if (key) {
          wanted.push({ box, key });
        }
      }
      const items = this._prefetchAnnotationItems(
        wanted.map((entry) => entry.key),
      );
      for (const { box, key } of wanted) {
        const item = await items.get(key);
        if (!item) {
          pending++;
          continue;
        }
        const section = doc.createElement("div");
        section.className = "section";
        section.appendChild(
          this._createButton(doc, await this._annotationFromItem(item), reader),
        );
        const blockID = this._index.get(key);
        if (blockID) {
          const link = this._createSentLink(doc, blockID, key, true);
          // Recorded, so the reader's own render can take it away instead
          // of leaving two markers next to each other.
          this._addManualLink(doc, key, link);
          section.appendChild(link);
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
  },

  /**
   * Look after the readers for a while after the start.
   *
   * Only for the readers that were drawn *before* this plugin was awake:
   * every other sidebar is drawn with the plugin listening, so the reader
   * hands over the render event and nothing has to be patched.
   *
   * That gives the watcher three ways to end, and it takes the first one
   * that comes up:
   *
   *   - there is no reader open at all, so there is nothing to look at;
   *   - every reader it can see is dealt with (no longer loading);
   *   - the ceiling is reached, which only happens while a PDF is still
   *     loading.
   *
   * Between two looks it backs off from one second to five, so a slow
   * reader costs a handful of queries rather than one per second.
   */
  _startSidebarWatcher() {
    if (this._watchTimer) {
      return;
    }
    // Zotero started without a PDF open: every reader from now on draws its
    // sidebar with the plugin listening, so there is nothing to patch and
    // nothing to poll for.
    if (!this._openReaders().length) {
      Zotero.debug(
        "ZoteroSiYuan: no reader is open — the sidebar watcher is not needed",
      );
      return;
    }
    const started = Date.now();
    let ticks = 0;
    let delay = WATCH_FIRST_DELAY;
    const tick = async () => {
      this._watchTimer = null;
      if (this._shutDown) {
        return;
      }
      ticks++;
      // A reader that was closed since the last look needs no button. When
      // the last one is gone the watcher has nothing left to do at all.
      const readers = this._openReaders();
      if (!readers.length) {
        Zotero.debug(
          `ZoteroSiYuan: the sidebar watcher stopped after ${ticks} look(s) — no reader is open`,
        );
        return;
      }
      let state = null;
      try {
        state = await this._patchReaderSidebars(readers);
      }
      catch (e) {
        Zotero.debug(`ZoteroSiYuan: could not patch the sidebars: ${e}`);
      }
      if (this._shutDown) {
        return;
      }
      // Nothing patched and nothing loading: every reader the plugin can
      // see either already has its buttons or draws them itself from here
      // on. Polling on would only be a query per second for nothing.
      const done =
        state &&
        !state.patched &&
        !state.pending &&
        ticks >= WATCH_MIN_TICKS;
      if (done) {
        Zotero.debug(
          `ZoteroSiYuan: the sidebar watcher stopped after ${ticks} look(s)`,
        );
        return;
      }
      if (Date.now() - started >= WATCH_WINDOW_MS) {
        Zotero.debug(
          `ZoteroSiYuan: the sidebar watcher gave up after ${ticks} look(s) — a reader is still loading`,
        );
        return;
      }
      this._watchTimer = setTimeout(tick, delay);
      delay = Math.min(Math.round(delay * 1.6), WATCH_MAX_DELAY);
    };
    // Not on the startup path: the first look runs once the window is up.
    this._watchTimer = setTimeout(tick, WATCH_FIRST_DELAY);
  },

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

};
