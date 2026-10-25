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
import { blockIDFromTags, markSent } from "./modules/sent.js";
import { showToast } from "./modules/toast.js";
import {
	DEFAULT_TEMPLATE,
	TEMPLATE_VARIABLES,
	renderTemplate,
	templateVariables,
} from "./modules/template.js";
import { insertToken, variableToken } from "./modules/template-edit.js";
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
const BUILD = "sent-marker";

const BUTTON_STYLE =
  "display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;min-width:20px;padding:0;margin:0 2px;border:0;border-radius:3px;background:transparent;color:inherit;cursor:pointer;opacity:.65;";

const SENT_LINK_STYLE =
  "display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;min-width:18px;padding:0;margin:0 2px;border:0;border-radius:3px;background:transparent;color:var(--accent-green, #2a7);cursor:pointer;opacity:.9;text-decoration:none;font-size:12px;line-height:1;";

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

  _onRenderSidebarAnnotationHeader(event) {
    const doc = event && event.doc;
    const params = event && event.params;
    const annotation = params && params.annotation;
    if (!doc || !annotation) {
      return;
    }

    const button = doc.createElement("button");
    button.className = "zotero-siyuan-annotation-button";
    button.type = "button";
    button.style.cssText = BUTTON_STYLE;

    const label = getString("zoteroSiYuan-button-label", "Send to SiYuan");
    button.setAttribute("aria-label", label);
    button.title = label;
    button.innerHTML = ICON_SVG;

    button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._send(annotation, event.reader, button);
    });

    // append() must be called synchronously, before this handler returns.
    event.append(button);

    // Already sent? Offer a way back to the SiYuan block. The reader hands
    // the tags over with the annotation, so this needs no lookup.
    const sentBlockID = blockIDFromTags(annotation.tags);
    if (sentBlockID) {
      const link = doc.createElement("a");
      link.className = "zotero-siyuan-sent-link";
      link.href = siyuanBlockLink(sentBlockID);
      link.style.cssText = SENT_LINK_STYLE;
      const label = getString(
        "zoteroSiYuan-sent-title",
        "Already sent to SiYuan — click to open that block",
      );
      link.title = label;
      link.setAttribute("aria-label", label);
      link.textContent = "↗";
      link.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._openInSiYuan(sentBlockID);
      });
      event.append(link);
    }
  }

  /** Open a SiYuan block in the desktop app. */
  _openInSiYuan(blockID) {
    const url = siyuanBlockLink(blockID);
    if (!url) {
      return;
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
    event.append({
      label:
        ids.length === 1
          ? getString("zoteroSiYuan-menu-send-one", "Send to SiYuan")
          : getString("zoteroSiYuan-menu-send-many", "Send to SiYuan")
              .replace("%d", String(ids.length)),
      onCommand: () => {
        this._sendMany(ids, reader);
      },
    });
  }

  /* ---------------------------------------------------------------- write */

  async _send(annotation, reader, button) {
    if (this._sending) {
      return;
    }
    this._sending = true;
    button.style.opacity = "1";
    button.disabled = true;

    try {
      const result = await this._sendAnnotation(annotation, reader);
      this._flash(button, getString("zoteroSiYuan-done", "Sent to SiYuan"), false);
      Zotero.debug(
        `ZoteroSiYuan: appended an annotation to the SiYuan daily note in notebook ${result.notebook.name} (${result.notebook.id}) via ${result.transport}` +
          (result.blockID ? `, block ${result.blockID}` : "") +
          (result.tagged ? ", the annotation is tagged" : ""),
      );
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
   * @returns {Promise<Object>} what happened
   */
  async _sendAnnotation(annotation, reader) {
    const markdown = await this._buildContent(annotation, reader);
    const notebook = await this._resolveNotebook();
    const sent = (await this._append(notebook.id, markdown)) || {};
    // `_append` answers with an object; accept a plain string too, so a
    // change there cannot silently lose the block id.
    const transport = typeof sent === "string" ? sent : sent.transport;
    const blockID = typeof sent === "string" ? "" : sent.blockID || "";
    const tagged = await this._markSent(annotation, blockID);
    return { transport, blockID, tagged, notebook, markdown };
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
   */
  async _sendMany(ids, reader) {
    if (this._sending) {
      return;
    }
    this._sending = true;
    let sent = 0;
    let failed = 0;
    let lastBlock = "";
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

  /** The token of a template variable. */
  variableToken(name) {
    return variableToken(name);
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
        const http = await SiYuanHTTP.discover(getPref("workspace", ""));
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
   * @returns {Promise<{transport: String, documentID: String, blockID: String}>}
   */
  async _append(notebookID, markdown) {
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
        const http = await SiYuanHTTP.discover(getPref("workspace", ""));
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
   * Record on the annotation which SiYuan block it went to, so the reader
   * can offer a link back.
   */
  async _markSent(annotation, blockID) {
    if (!blockID) {
      return false;
    }
    try {
      const item = await this._getAnnotationItem(annotation);
      if (!item) {
        return false;
      }
      await markSent(item, blockID);
      return true;
    }
    catch (e) {
      Zotero.debug(`ZoteroSiYuan: could not tag the annotation: ${e}`);
      return false;
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
      return await Zotero.Items.getByLibraryAndKeyAsync(
        Zotero.Libraries.userLibraryID,
        String(id),
      );
    }
    catch (e) {
      return null;
    }
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

  async diagnose() {    const report = await this.getCLI().diagnose();
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

  async _getParentItem(reader) {
    try {
      const itemID = reader && reader.itemID;
      if (!itemID) {
        return null;
      }
      const attachment = await Zotero.Items.getAsync(itemID);
      if (!attachment || !attachment.parentItemID) {
        return null;
      }
      return await Zotero.Items.getAsync(attachment.parentItemID);
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
   * @returns {Promise<String>} the Markdown
   */
  async _buildContent(annotation, reader) {
    const parentItem = await this._getParentItem(reader);
    const attachment = await this._getAttachment(reader);
    const annotationKey = await this._resolveAnnotationKey(annotation);
    const vars = collectMetadata({
      annotation,
      parentItem,
      attachment,
      annotationKey,
      extra: this._now(),
    });
    const { text, unknown } = renderTemplate(this.getTemplate(), vars);
    if (unknown.length) {
      Zotero.debug(
        `ZoteroSiYuan: the template uses variables that do not exist: ${unknown.join(", ")}`,
      );
    }
    return text;
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
