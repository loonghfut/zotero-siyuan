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
 *
 * This file is only the assembly point: the addon's behaviour lives in
 * `app/`, one file per concern. Zotero talks to a single object, so the
 * pieces are mixed into one prototype below instead of being wired by hand.
 */

import {
	BUILD,
	PLUGIN_ID,
} from "./app/constants.js";
import { runSelfTest } from "./modules/selftest/index.js";
import { forgetPictures } from "./modules/siyuan-image.js";
import { SiYuanIndex } from "./modules/siyuan-index.js";
import { suppressProtocolWarning } from "./modules/siyuan-launcher.js";
import { initLocale } from "./utils/locale.js";
import {
	getPref,
	prefFlag,
} from "./utils/prefs.js";

import content from "./app/content.js";
import diagnosticsApi from "./app/diagnostics-api.js";
import lookup from "./app/lookup.js";
import preferencesApi from "./app/preferences-api.js";
import readerMarks from "./app/reader-marks.js";
import readerUi from "./app/reader-ui.js";
import send from "./app/send.js";
import transport from "./app/transport.js";

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
    // the attachments whose blocks are in the index. The listeners are kept
    // with their document, so they can be taken off at shutdown.
    this._delegatedDocs = new WeakSet();
    this._delegations = [];
    // The markers this plugin put into a reader document by hand, filed by
    // annotation. The reader redraws a header now and then and would leave
    // two markers behind, so they have to be found again — without walking
    // the whole document for every header it draws. See `_manualLinksOf`.
    this._manualLinks = new WeakMap();
    // The timers behind the button's short messages, so a shutdown can stop
    // them from reaching into a reader that is no longer ours.
    this._flashTimers = new Set();
    // The reader documents whose send buttons are disabled because a send is
    // running. A header that is drawn meanwhile has to arrive disabled too.
    this._busyDocs = new WeakSet();
    // The PDF and its parent item of a batch, looked up once for all of the
    // annotations in it instead of once per annotation.
    this._batchMemo = null;
    // attachment itemID → when its blocks were last looked up (see
    // `INDEX_TTL_MS`), and the sends that are running right now.
    this._indexedAttachments = new Map();
    this._inflight = new Set();
    // Set when the plugin is being shut down — a watcher tick that is
    // already in flight must not schedule another one.
    this._shutDown = false;
    // The notebook the notes go into, and when it was looked up. Listing
    // the notebooks is a process per call, and nothing changes them while
    // the user is sending notes.
    this._notebookCache = null;
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
    // The SiYuan workspace the notes go into, and the HTTP fallback client.
    this._workspaceDir = "";
    this._workspaceKey = null;
    this._workspaceAt = 0;
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
    // The bundles have to be open before anything can draw a label, and
    // which ones can be opened depends on the files that were packaged —
    // that check is asynchronous.
    await initLocale();
    this._shutDown = false;

    // A rejected registration would otherwise be an unhandled rejection —
    // and the pane would simply be missing, with nothing in the log.
    //
    // The pane is one object spread over several files; Zotero loads them
    // into the pane's own scope in this order, and `preferences-boot.js`
    // starts the pane once every part has added its methods.
    Promise.resolve(
      Zotero.PreferencePanes.register({
        pluginID: PLUGIN_ID,
        src: "content/preferences.xhtml",
        scripts: [
          "content/preferences.js",
          "content/preferences-template.js",
          "content/preferences-variables.js",
          "content/preferences-pictures.js",
          "content/preferences-actions.js",
          "content/preferences-boot.js",
        ],
        stylesheets: ["content/styles.css"],
      }),
    ).catch((e) => {
      Zotero.logError(
        new Error(`ZoteroSiYuan: could not register the preferences pane: ${e}`),
      );
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

    // Nothing is spawned and nothing is scanned here on purpose.
    //
    // Resolving the CLI runs `siyuan --version`, and an index refresh walks
    // the whole workspace database with a leading-`LIKE` query that no index
    // can help with. Both happen when they are needed instead: the CLI on
    // the first send (or the first connection test), the index per PDF when
    // its sidebar is drawn — see `_ensureAttachmentIndexed`. A plugin that
    // costs a process and a full scan on every Zotero start is a plugin
    // people notice.

    // Run the self test in the background, but only when it is asked for.
    // It drives the same code path a user's click takes, so its report is
    // the plugin's own proof that it works inside Zotero.
    //
    // It is off by default: a test that runs on every start costs seconds
    // of polling and — in older versions — even clicked a real button in a
    // real reader, which looked like the user had sent something.
    if (prefFlag("selfTest")) {
      const realWrite = prefFlag("selfTestWrite");
      runSelfTest({
        addon: this,
        notebookPref: getPref("notebook", ""),
        realWrite,
        // No UI step on startup: it would open the preferences window.
        ui: false,
      }).catch((e) => {
        Zotero.debug(`ZoteroSiYuan: self test failed: ${e}`);
      });
    }

    // A reader that was restored when Zotero started may have drawn its
    // sidebar before this plugin was awake — look after those.
    this._startSidebarWatcher();

    // The desktop app is normally started directly, so no confirmation
    // dialog appears. This only matters for the fallback path — and it is
    // the same preference the dialog's "remember my choice" box writes.
    // It changes a browser-wide preference, so it happens only when the
    // user asked for it.
    if (prefFlag("silentProtocol")) {
      if (suppressProtocolWarning()) {
        Zotero.debug(
          "ZoteroSiYuan: the browser will not ask before opening siyuan:// links",
        );
      }
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

    // The watcher polls the readers for up to three minutes; without this
    // it keeps running after the plugin was disabled or replaced.
    this._shutDown = true;
    if (this._watchTimer) {
      clearTimeout(this._watchTimer);
      this._watchTimer = null;
    }

    // The delegated listeners live in reader documents, which outlive the
    // plugin. Take them off — and the buttons and markers they served, or
    // a sidebar keeps offering a button that belongs to a plugin that is
    // no longer there.
    for (const { doc, handler } of this._delegations || []) {
      try {
        doc.removeEventListener("click", handler);
        for (const node of doc.querySelectorAll(
          ".zotero-siyuan-annotation-button, .zotero-siyuan-sent-link",
        )) {
          node.remove();
        }
      }
      catch (e) {
        // The reader is already gone.
      }
    }
    this._delegations = [];

    // A send that is still running may still be writing — wait for it, or
    // the picture pointer is taken away before the note that names it lands.
    await this._waitForInflight(5000);
    this._pendingSendHooks = null;
    this._pendingPicture = null;
    this._sending = false;
    this._batchMemo = null;
    this._busyDocs = new WeakSet();
    // The compressed pictures are kept in memory for a faster second send;
    // a plugin that is gone has no business holding on to them.
    forgetPictures();
    // The button messages: the buttons they belong to are about to be
    // removed, so the timers have nothing left to restore.
    for (const timer of this._flashTimers) {
      clearTimeout(timer);
    }
    this._flashTimers.clear();
    this._manualLinks = new WeakMap();
    this._http = null;
    this._httpKey = null;
    this._notebookCache = null;
    this._labels = null;
    // The sample annotation behind the template preview is a library item;
    // a plugin that is gone has no business holding on to it.
    this._sampleCache = null;
  }

  async onMainWindowLoad() {
    // The plugin does not touch the main window's DOM.
  }

  async onMainWindowUnload() {
    // Nothing to clean up in the main window.
  }

  /* -------------------------------------------------------------------- UI */
}

/* --------------------------------------------------------------- assembly */

/**
 * One object, many files.
 *
 * Every module in `app/` exports an object whose methods expect `this` to be
 * the addon — they are moved onto the prototype, so Zotero still sees a
 * single plugin instance (`Zotero.ZoteroSiYuan`) with all of its methods.
 */
Object.assign(
  ZoteroSiYuanAddon.prototype,
  content,
  diagnosticsApi,
  lookup,
  preferencesApi,
  readerMarks,
  readerUi,
  send,
  transport,
);

/* ------------------------------------------------------------------ export */

const addon = new ZoteroSiYuanAddon();

_globalThis.addon = addon;
Zotero.ZoteroSiYuan = addon;
