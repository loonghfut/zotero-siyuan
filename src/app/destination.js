/**
 * Zotero → SiYuan — where a note goes.
 *
 * Today's daily note is the default, but it is not the only place a note
 * can belong: a fixed document, or one document per item for a literature
 * note. This module answers "which document is this?" and leaves the write
 * itself to `transport.js`.
 */

import { getString } from "../utils/locale.js";
import { getPref } from "../utils/prefs.js";
import { NOTEBOOK_CACHE_MS } from "./constants.js";
import { isBlockID } from "../modules/siyuan.js";
import { renderTemplate } from "../modules/template.js";

export default {
  /* ---------------------------------------------------------- destination */

  /**
   * Where a note goes: today's daily note, a fixed document, or a document
   * of its own for the item.
   *
   * @returns {String} "daily" | "document" | "item"
   */
  _destinationKind() {
    const value = String(getPref("destination", "daily") || "").trim();
    return value === "document" || value === "item" ? value : "daily";
  },

  /**
   * Resolve the place the note goes to.
   *
   * @param {Object} options
   * @param {Object|null} options.notebook
   * @param {Object} options.vars - the template variables
   * @returns {Promise<Object>} { kind, notebook, documentID, title }
   */
  async _resolveDestination({ notebook = null, vars = {} } = {}) {
    const kind = this._destinationKind();
    if (kind === "document") {
      return await this._resolveFixedDocument();
    }
    if (kind === "item") {
      return await this._resolveItemDocument(notebook, vars);
    }
    return { kind: "daily", notebook, documentID: "", title: "" };
  },

  /**
   * A document the user named in the settings — by id, or by title.
   *
   * @returns {Promise<Object>}
   */
  async _resolveFixedDocument() {
    const wanted = String(getPref("targetDocument", "") || "").trim();
    if (!wanted) {
      throw new Error(
        getString(
          "zoteroSiYuan-no-target-document",
          "No target document is configured.",
        ),
      );
    }
    if (isBlockID(wanted)) {
      return { kind: "document", notebook: null, documentID: wanted, title: "" };
    }
    if (!this._documentCache) {
      this._documentCache = new Map();
    }
    const key = `title|${this._cliKey || ""}|${wanted}`;
    const cached = this._documentCache.get(key);
    if (cached && Date.now() - cached.at < NOTEBOOK_CACHE_MS) {
      return { ...cached.target };
    }
    let documentID = "";
    try {
      documentID = await this.getCLI().findDocumentByTitle(wanted);
    }
    catch (e) {
      Zotero.debug(
        `ZoteroSiYuan: could not look the target document up with the CLI: ${e.message}`,
      );
    }
    if (!documentID) {
      try {
        const http = await this._httpClient();
        const rows = await http.sql(
          "SELECT id FROM blocks " +
            `WHERE type = 'd' AND content = '${wanted.replace(/'/g, "''")}' ` +
            "ORDER BY updated DESC LIMIT 1",
        );
        documentID = rows && rows[0] && rows[0].id ? rows[0].id : "";
      }
      catch (e) {
        Zotero.debug(
          `ZoteroSiYuan: could not look the target document up over HTTP: ${e.message}`,
        );
      }
    }
    if (!documentID) {
      throw new Error(
        getString(
          "zoteroSiYuan-target-document-not-found",
          "No document titled “%s” was found.",
        ).replace("%s", wanted),
      );
    }
    const target = {
      kind: "document",
      notebook: null,
      documentID,
      title: wanted,
    };
    this._documentCache.set(key, { at: Date.now(), target });
    return { ...target };
  },

  /**
   * The document that belongs to the item being annotated.
   *
   * It is created once and stamped with `custom-zotero-item-key`, so a
   * later send finds it again without storing anything in the Zotero
   * library. A document with the same title is reused too — that is what a
   * user who made the literature note by hand expects.
   *
   * @param {Object} notebook
   * @param {Object} vars
   * @returns {Promise<Object>}
   */
  async _resolveItemDocument(notebook, vars) {
    if (!notebook || !notebook.id) {
      throw new Error("The SiYuan notebook could not be resolved.");
    }
    const itemKey = String(vars.itemKey || vars.attachmentKey || "").trim();
    if (!itemKey) {
      throw new Error("The Zotero item has no key.");
    }
    if (!this._itemDocs) {
      this._itemDocs = new Map();
    }
    const key = `${this._cliKey || ""}|${notebook.id}|${itemKey}`;
    const cached = this._itemDocs.get(key);
    if (cached) {
      return { ...cached, notebook };
    }

    let documentID = "";
    try {
      documentID = await this.getCLI().findDocumentByAttribute(
        "custom-zotero-item-key",
        itemKey,
      );
    }
    catch (e) {
      Zotero.debug(
        `ZoteroSiYuan: could not look the item document up with the CLI: ${e.message}`,
      );
    }
    if (!documentID) {
      try {
        const http = await this._httpClient();
        const rows = await http.sql(
          "SELECT id FROM blocks " +
            `WHERE type = 'd' AND ial LIKE '%custom-zotero-item-key="${itemKey.replace(/"/g, "")}"%' ` +
            "ORDER BY updated DESC LIMIT 1",
        );
        documentID = rows && rows[0] && rows[0].id ? rows[0].id : "";
      }
      catch (e) {
        Zotero.debug(
          `ZoteroSiYuan: could not look the item document up over HTTP: ${e.message}`,
        );
      }
    }

    const title = this._itemDocTitle(vars);
    if (!documentID) {
      // A document with the same title may already exist — do not make a
      // second literature note for the same paper.
      try {
        documentID = await this.getCLI().findDocumentByTitle(title);
      }
      catch (e) {
        documentID = "";
      }
    }
    if (!documentID) {
      documentID = await this._createItemDocument(notebook, title);
    }
    // Stamp the document even when it was found by title: the next send
    // should find it by the key, which does not change when the title does.
    await this._stampItemDocument(documentID, itemKey);

    const target = { kind: "item", notebook, documentID, title };
    this._itemDocs.set(key, target);
    return { ...target };
  },

  /** The title of a per-item document, rendered with the template variables. */
  _itemDocTitle(vars) {
    const template = String(getPref("itemDocName", "{{title}}") || "{{title}}");
    let title = "";
    try {
      title = renderTemplate(template, vars || {}).text.trim();
    }
    catch (e) {
      title = "";
    }
    title = title || String(vars.title || "").trim() || String(vars.itemKey || "");
    title = title
      .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    return title || "SiYuan note";
  },

  /** Create the document a per-item send needs, with the CLI first. */
  async _createItemDocument(notebook, title) {
    const path = String(getPref("itemDocPath", "/") || "/").trim() || "/";
    try {
      return await this.getCLI().createDocument(notebook.id, title, { path });
    }
    catch (cliError) {
      Zotero.debug(
        `ZoteroSiYuan: the CLI could not create the item document (${cliError.message}); trying the HTTP API`,
      );
      try {
        const http = await this._httpClient();
        return await http.createDocument(notebook.id, path, title);
      }
      catch (httpError) {
        throw new Error(
          getString(
            "zoteroSiYuan-item-document-failed",
            "Could not create the SiYuan document for this item: %s",
          ).replace(
            "%s",
            `the CLI failed: ${cliError.message} — the HTTP API failed too: ${httpError.message}`,
          ),
        );
      }
    }
  },

  /** Mark a document as the one that belongs to a Zotero item. */
  async _stampItemDocument(documentID, itemKey) {
    const attrs = { "custom-zotero-item-key": itemKey };
    try {
      await this.getCLI().setBlockAttrs(documentID, attrs);
      return;
    }
    catch (cliError) {
      Zotero.debug(
        `ZoteroSiYuan: could not stamp the item document with the CLI (${cliError.message}); trying HTTP`,
      );
    }
    try {
      const http = await this._httpClient();
      await http.setBlockAttrs(documentID, attrs);
    }
    catch (e) {
      // The in-memory cache still points at the right document for this
      // session; a missing stamp only means a later session may create a
      // second document.
      Zotero.debug(
        `ZoteroSiYuan: could not stamp the item document: ${e.message}`,
      );
    }
  },
};