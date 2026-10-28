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
import {
  ITEM_KEY_ATTR,
  LIBRARY_ID_ATTR,
  parseAttributes,
} from "../modules/block-attrs.js";
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
      const error = new Error(
        getString(
          "zoteroSiYuan-no-target-document",
          "No target document is configured.",
        ),
      );
      // Retrying an automatic send cannot fix a setting. The queue keeps it
      // out instead of trying the same failure every few minutes.
      error.permanent = true;
      throw error;
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
      const error = new Error(
        getString(
          "zoteroSiYuan-target-document-not-found",
          "No document titled “%s” was found.",
        ).replace("%s", wanted),
      );
      error.permanent = true;
      throw error;
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
      throw new Error(
        getString(
          "zoteroSiYuan-no-notebook",
          "The SiYuan notebook could not be resolved.",
        ),
      );
    }
    const itemKey = String(vars.itemKey || vars.attachmentKey || "").trim();
    if (!itemKey) {
      throw new Error(
        getString(
          "zoteroSiYuan-no-item-key",
          "The Zotero item has no key.",
        ),
      );
    }
    const libraryID = Number(vars.libraryID) || 0;
    if (!this._itemDocs) {
      this._itemDocs = new Map();
    }
    if (!this._itemDocPending) {
      this._itemDocPending = new Map();
    }
    const key = `${this._cliKey || ""}|${notebook.id}|${libraryID}|${itemKey}`;
    const cached = this._itemDocs.get(key);
    if (cached) {
      return { ...cached, notebook };
    }
    // Two sends of the same item can arrive together — a batch and a
    // click, or two menu commands. Without this, both would look the
    // document up, both would miss, and both would create one.
    const pending = this._itemDocPending.get(key);
    if (pending) {
      return { ...(await pending), notebook };
    }
    const job = this._findItemDocument(notebook, itemKey, libraryID, vars);
    this._itemDocPending.set(key, job);
    try {
      const target = await job;
      this._itemDocs.set(key, target);
      return { ...target, notebook };
    }
    finally {
      this._itemDocPending.delete(key);
    }
  },

  /**
   * Find or create the document an item owns.
   *
   * The search is deliberately layered: the library-aware attribute first,
   * then the key alone for documents stamped by an older version, then the
   * title for a note the user made by hand. A document that already
   * belongs to a *different* item (or a different library with the same
   * key) is never adopted — its owner would lose it.
   *
   * @param {Object} notebook
   * @param {String} itemKey
   * @param {Number} libraryID
   * @param {Object} vars
   * @returns {Promise<Object>}
   */
  async _findItemDocument(notebook, itemKey, libraryID, vars) {
    let documentID = "";

    // The precise question first: this item, in this library.
    if (libraryID) {
      documentID = await this._findItemDocumentByAttrs({
        [ITEM_KEY_ATTR]: itemKey,
        [LIBRARY_ID_ATTR]: String(libraryID),
      });
    }

    // A document stamped before the library id existed. It is only usable
    // when its item key is this one — and, if it has a library id after
    // all, when that library is this one too.
    if (!documentID) {
      documentID = await this._findItemDocumentByKey(itemKey);
      if (documentID) {
        const identity = await this._documentIdentity(documentID);
        if (this._itemDocumentTaken(identity, itemKey, libraryID)) {
          documentID = "";
        }
      }
    }

    let title = this._itemDocTitle(vars);
    // A document with the same title may already exist — do not make a
    // second literature note for the same paper.
    if (!documentID) {
      const byTitle = await this._documentByTitle(title);
      if (byTitle) {
        const identity = await this._documentIdentity(byTitle);
        if (this._itemDocumentTaken(identity, itemKey, libraryID)) {
          // Someone else's note with the same title. A new document has
          // to get a title of its own, or the next lookup would find the
          // same note again.
          title = this._uniqueItemDocTitle(title, itemKey);
        }
        else {
          documentID = byTitle;
        }
      }
    }
    if (!documentID) {
      documentID = await this._createItemDocument(notebook, title);
    }
    // Stamp the document even when it was found by title: the next send
    // should find it by the key, which does not change when the title does.
    await this._stampItemDocument(documentID, itemKey, libraryID);

    return { kind: "item", documentID, title };
  },

  /** A document by both attributes, with the CLI first and HTTP second. */
  async _findItemDocumentByAttrs(attrs) {
    try {
      const cli = this.getCLI();
      if (typeof cli.findDocumentByAttributes === "function") {
        const found = await cli.findDocumentByAttributes(attrs);
        if (found) {
          return found;
        }
      }
    }
    catch (e) {
      Zotero.debug(
        `ZoteroSiYuan: could not look the item document up with the CLI: ${e.message}`,
      );
    }
    try {
      const http = await this._httpClient();
      const clauses = [];
      for (const [name, value] of Object.entries(attrs || {})) {
        if (!/^[A-Za-z0-9_-]+$/.test(name) || !String(value || "").trim()) {
          continue;
        }
        clauses.push(
          `ial LIKE '%${name}="${String(value).replace(/["'\\]/g, "")}"%'`,
        );
      }
      if (!clauses.length) {
        return "";
      }
      const rows = await http.sql(
        "SELECT id FROM blocks " +
          `WHERE type = 'd' AND ${clauses.join(" AND ")} ` +
          "ORDER BY updated DESC LIMIT 1",
      );
      return rows && rows[0] && isBlockID(rows[0].id) ? rows[0].id : "";
    }
    catch (e) {
      Zotero.debug(
        `ZoteroSiYuan: could not look the item document up over HTTP: ${e.message}`,
      );
    }
    return "";
  },

  /** A document by the item key alone — the pre-library-id shape. */
  async _findItemDocumentByKey(itemKey) {
    try {
      const found = await this.getCLI()
        .findDocumentByAttribute(ITEM_KEY_ATTR, itemKey);
      if (found) {
        return found;
      }
    }
    catch (e) {
      Zotero.debug(
        `ZoteroSiYuan: could not look the item document up by key: ${e.message}`,
      );
    }
    try {
      const http = await this._httpClient();
      const rows = await http.sql(
        "SELECT id FROM blocks " +
          `WHERE type = 'd' AND ial LIKE '%${ITEM_KEY_ATTR}="${itemKey.replace(/["'\\]/g, "")}"%' ` +
          "ORDER BY updated DESC LIMIT 1",
      );
      return rows && rows[0] && isBlockID(rows[0].id) ? rows[0].id : "";
    }
    catch (e) {
      Zotero.debug(
        `ZoteroSiYuan: could not look the item document up by key over HTTP: ${e.message}`,
      );
    }
    return "";
  },

  /** The identity a document carries, when it can be read. */
  async _documentIdentity(documentID) {
    if (!isBlockID(documentID)) {
      return { itemKey: "", libraryID: 0 };
    }
    let ial = "";
    try {
      const rows = await this.getCLI().blockRows([documentID]);
      if (rows && rows[0]) {
        ial = rows[0].ial || "";
      }
    }
    catch (e) {
      Zotero.debug(
        `ZoteroSiYuan: could not read the item document's attributes: ${e.message}`,
      );
    }
    if (!ial) {
      try {
        const http = await this._httpClient();
        const rows = await http.sql(
          `SELECT id, ial FROM blocks WHERE id = '${documentID}' LIMIT 1`,
        );
        if (rows && rows[0]) {
          ial = rows[0].ial || "";
        }
      }
      catch (e) {
        Zotero.debug(
          `ZoteroSiYuan: could not read the item document's attributes over HTTP: ${e.message}`,
        );
      }
    }
    const attrs = parseAttributes(ial);
    return {
      itemKey: attrs[ITEM_KEY_ATTR] || "",
      libraryID: Number(attrs[LIBRARY_ID_ATTR]) || 0,
    };
  },

  /** Does this document already belong to another item? */
  _itemDocumentTaken(identity, itemKey, libraryID) {
    const found = identity || {};
    if (found.itemKey && found.itemKey !== itemKey) {
      return true;
    }
    if (found.libraryID && libraryID && found.libraryID !== libraryID) {
      return true;
    }
    return false;
  },

  /** A document by title, with the lookup failure treated as "none". */
  async _documentByTitle(title) {
    try {
      return await this.getCLI().findDocumentByTitle(title);
    }
    catch (e) {
      return "";
    }
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

  /**
   * A title that will not collide with a note that belongs to another item.
   *
   * The key is appended rather than a counter: it is stable, so a second
   * attempt finds the same new title instead of creating `(2)`, `(3)`, …
   *
   * @param {String} title
   * @param {String} itemKey
   * @returns {String}
   */
  _uniqueItemDocTitle(title, itemKey) {
    const base = String(title || "").trim() || "SiYuan note";
    const suffix = ` (${String(itemKey || "").slice(0, 8)})`;
    return `${base.slice(0, Math.max(1, 120 - suffix.length))}${suffix}`;
  },

  /** Forget the cached document of an item after a write failed. */
  _forgetItemDocument(documentID) {
    if (!documentID || !this._itemDocs) {
      return;
    }
    for (const [key, target] of [...this._itemDocs.entries()]) {
      if (target && target.documentID === documentID) {
        this._itemDocs.delete(key);
      }
    }
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
  async _stampItemDocument(documentID, itemKey, libraryID = 0) {
    const attrs = { [ITEM_KEY_ATTR]: itemKey };
    if (libraryID) {
      attrs[LIBRARY_ID_ATTR] = String(libraryID);
    }
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