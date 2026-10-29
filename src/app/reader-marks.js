/**
 * Zotero → SiYuan — the "sent" markers and the links back to SiYuan.
 */

import { SENT_ICON_STYLE, SENT_LINK_STYLE } from "./constants.js";
import { createSiyuanIcon } from "../modules/icons.js";
import { siyuanBlockLink } from "../modules/metadata.js";
import { showToast } from "../modules/toast.js";
import { INDEX_TTL_MS } from "../modules/siyuan-index.js";
import { launchExternally } from "../modules/siyuan-launcher.js";
import { fill, getString } from "../utils/locale.js";
import { getPref } from "../utils/prefs.js";

export default {
  /**
   * The hand-made markers of one reader document, by annotation key.
   *
   * A marker the plugin put in by hand is invisible to the reader, so the
   * reader's own render has to find it again and take it away — and finding
   * it must not cost a walk over the whole document: a sidebar renders one
   * header per annotation, hundreds of them, and a document-wide query per
   * header is exactly the kind of cost that makes a long PDF open slowly.
   *
   * The map is filled once per document (which also catches markers a
   * previous session left behind) and kept in step as markers are added.
   *
   * @param {Object} doc - the reader document
   * @returns {Map} annotation key → Set of elements
   */
  _manualLinksOf(doc) {
    let byKey = this._manualLinks.get(doc);
    if (!byKey) {
      byKey = new Map();
      for (const node of doc.querySelectorAll("[data-zsi-manual]")) {
        this._rememberManualLink(byKey, node);
      }
      this._manualLinks.set(doc, byKey);
    }
    return byKey;
  },

  /** File a hand-made marker under its annotation. */
  _rememberManualLink(byKey, node) {
    const key = node.getAttribute("data-zsi-for") || "";
    if (!key) {
      return;
    }
    let forKey = byKey.get(key);
    if (!forKey) {
      forKey = new Set();
      byKey.set(key, forKey);
    }
    forKey.add(node);
  },

  /**
   * A marker that was put in by hand — recorded, so the reader's own render
   * can take it away again.
   *
   * @param {Object} doc - the reader document
   * @param {String} annotationKey
   * @param {Object} node - the marker
   */
  _addManualLink(doc, annotationKey, node) {
    if (!doc || !annotationKey || !node) {
      return;
    }
    this._rememberManualLink(this._manualLinksOf(doc), node);
  },

  /**
   * Remove the markers that were inserted by hand for one annotation.
   *
   * Only the hand-made ones: the reader wipes its own box on every render
   * and puts a fresh marker in it, so a hand-made one that is still around
   * would stand next to it and the sidebar would show two.
   *
   * @param {Object} doc - the reader document
   * @param {String} annotationKey
   * @returns {Number} how many were removed
   */
  _dropManualLinks(doc, annotationKey) {
    if (!doc || !doc.querySelectorAll || !annotationKey) {
      return 0;
    }
    const byKey = this._manualLinksOf(doc);
    const forKey = byKey.get(annotationKey);
    if (!forKey) {
      return 0;
    }
    let removed = 0;
    for (const node of forKey) {
      // The reader may have wiped the box this marker was in.
      if (node.isConnected) {
        node.remove();
        removed++;
      }
    }
    byKey.delete(annotationKey);
    return removed;
  },

  /**
   * Remove every marker of one annotation, hand-made or drawn by the
   * reader.
   *
   * "Replace" writes a new block for the same annotation, and the old
   * marker points at a block that no longer exists. The hand-made ones are
   * remembered by `_manualLinksOf`; the reader's own ones are in the
   * document until its next render.
   *
   * @param {Object} doc - the reader document
   * @param {String} annotationKey
   * @returns {Number} how many were removed
   */
  _removeSentMarker(doc, annotationKey) {
    const key = String(annotationKey || "");
    let removed = this._dropManualLinks(doc, key);
    if (!doc || !doc.querySelectorAll || !/^[A-Za-z0-9]+$/.test(key)) {
      return removed;
    }
    for (const link of doc.querySelectorAll(
      `.zotero-siyuan-sent-link[data-zsi-for="${key}"]`,
    )) {
      link.remove();
      removed++;
    }
    return removed;
  },

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
  },

  /**
   * Handle the clicks on the markers with a single listener per document.
   * @param {Object} doc - the reader document
   */
  _ensureDelegation(doc) {
    if (!doc || this._delegatedDocs.has(doc)) {
      return;
    }
    this._delegatedDocs.add(doc);
    const handler = (e) => {
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
      this._openSentLink(link).catch((error) => {
        Zotero.logError(`ZoteroSiYuan: could not follow the marker: ${error}`);
      });
    };
    doc.addEventListener("click", handler);
    // Remembered with its document, so `onShutdown` can take it off. A
    // reader document outlives the plugin.
    this._delegations.push({ doc, handler });
  },

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
    // One pass over the document, not one per button: a PDF with hundreds
    // of annotations would otherwise run a document-wide query hundreds of
    // times.
    const existing = new Map();
    for (const link of doc.querySelectorAll(".zotero-siyuan-sent-link")) {
      const key = link.getAttribute("data-zsi-for");
      if (key && !existing.has(key)) {
        existing.set(key, link);
      }
    }
    // The markers that are not the reader's own. Filled here, once per
    // document, so the header renders below never have to look for them.
    const manual = this._manualLinksOf(doc);
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
      const marker = existing.get(key);
      if (marker) {
        // A second send creates a new block — make the marker point there.
        if (marker.getAttribute("data-block-id") !== blockID) {
          marker.setAttribute("data-block-id", blockID);
          marker.href = siyuanBlockLink(blockID);
        }
        continue;
      }
      const parent = button.parentNode;
      if (!parent) {
        continue;
      }
      const link = this._createSentLink(doc, blockID, key, true);
      // Right next to the button, and inside the box the reader wipes on
      // every render — so the reader's own marker replaces it later
      // instead of standing next to it.
      parent.insertBefore(link, button.nextSibling);
      this._rememberManualLink(manual, link);
      existing.set(key, link);
      added++;
    }
    return added;
  },

  /**
   * Follow a marker, checking first that its block is still there.
   *
   * The block can be deleted in SiYuan at any time. Opening the desktop app
   * on a dead block is a click that appears to do nothing — so the block is
   * checked, and a missing one turns into an offer to send the annotation
   * again. An unreachable SiYuan is not a deleted block: the link is opened
   * as before.
   *
   * @param {Object} link - the marker that was clicked
   */
  async _openSentLink(link) {
    if (!link) {
      return;
    }
    const blockID = link.getAttribute("data-block-id") || "";
    const key = link.getAttribute("data-zsi-for") || "";
    const exists = await this._blockExists(blockID);
    if (exists !== false) {
      this._openInSiYuan(blockID);
      return;
    }
    // The marker is not updated by the reader any more: its block is gone.
    const doc = link.ownerDocument || null;
    this._removeSentMarker(doc, key);
    if (key) {
      this._index.remove(key);
    }
    await this._offerResend(key, doc);
  },

  /**
   * Offer to send an annotation whose SiYuan note was deleted.
   *
   * @param {String} key - the annotation key
   * @param {Object} [doc] - where the marker was
   */
  async _offerResend(key, doc = null) {
    if (!key) {
      return;
    }
    let annotation = null;
    try {
      const item = await this._getAnnotationItem({ id: key });
      if (item) {
        annotation = await this._annotationFromItem(item);
      }
    }
    catch (e) {
      annotation = null;
    }
    try {
      showToast({
        doc,
        title: getString(
          "zoteroSiYuan-deleted-title",
          "A sent note was deleted in SiYuan",
        ),
        message: getString(
          "zoteroSiYuan-deleted-message-one",
          "The note this marker pointed at is gone. Send the annotation again?",
        ),
        timeout: 15000,
        actions: annotation
          ? [
            {
              label: getString(
                "zoteroSiYuan-deleted-resend",
                "Send them again",
              ),
              primary: true,
              onClick: async () => {
                const reader = await this._readerForAnnotation(annotation);
                await this._send(annotation, reader, null, {
                  alreadySent: "send",
                });
                if (doc) {
                  this._updateRenderedMarkers(doc);
                }
              },
            },
            { label: getString("zoteroSiYuan-deleted-ignore", "Ignore") },
          ]
          : [{ label: getString("zoteroSiYuan-deleted-ignore", "Ignore") }],
      });
    }
    catch (e) {
      Zotero.debug(`ZoteroSiYuan: could not offer to resend: ${e}`);
    }
  },

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
  },

  /**
   * Which SiYuan workspace the index belongs to.
   *
   * The mapping lives in the workspace, so a different workspace has a
   * different index — answering a reader from the old one would show
   * markers that lead nowhere.
   *
   * @returns {Promise<String>}
   */
  async _indexWorkspaceKey() {
    const configured = String(getPref("workspace", "") || "").trim();
    let dir = "";
    try {
      dir = await this._resolveWorkspaceDir();
    }
    catch (e) {
      dir = "";
    }
    return `${getPref("cliPath", "")}|${dir || configured}`;
  },

  /**
   * The transport the index reads the workspace with.
   *
   * The CLI comes first: it needs no token and no port. But a machine where
   * the CLI cannot be spawned still has a kernel that answers the same SQL
   * over HTTP — and without that, a restart left every PDF without its
   * markers even though sending itself worked fine.
   *
   * @returns {Object} something with `runJSON(["sql", statement])`
   */
  _indexTransport() {
    const cli = this.getCLI();
    const addon = this;
    return {
      runJSON: async (args) => {
        if (!args || args[0] !== "sql") {
          return await cli.runJSON(args);
        }
        try {
          return await cli.runJSON(args);
        }
        catch (cliError) {
          try {
            const http = await addon._httpClient();
            return await http.sql(args[1]);
          }
          catch (httpError) {
            throw new Error(
              fill(
                getString(
                  "zoteroSiYuan-error-index-transports",
                  "the CLI could not run the query (%s); the SiYuan HTTP API " +
                    "could not either (%s)",
                ),
                cliError.message,
                httpError.message,
              ),
            );
          }
        }
      },
    };
  },

  /**
   * Load the blocks of a PDF into the index, in the background.
   * @param {Object} reader - the reader tab
   * @param {Object} doc - the reader document
   */
  _ensureAttachmentIndexed(reader, doc) {
    const itemID = reader && reader.itemID;
    if (!itemID) {
      return;
    }
    // "Indexed" is only true for a while: the workspace changes behind the
    // plugin's back — a note edited, deleted, or synced in from another
    // machine — and a PDF indexed an hour ago would keep showing the
    // markers of an hour ago.
    const at = this._indexedAttachments.get(itemID);
    if (at && Date.now() - at < INDEX_TTL_MS) {
      return;
    }
    this._indexedAttachments.set(itemID, Date.now());
    (async () => {
      try {
        const attachment = await Zotero.Items.getAsync(itemID);
        const key = attachment && attachment.key;
        if (!key) {
          return;
        }
        const found = await this._index.refreshForAttachment(
          this._indexTransport(),
          key,
          { key: await this._indexWorkspaceKey() },
        );
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
  },

  /**
   * Rebuild the index of already-sent annotations from the workspace.
   *
   * @returns {Promise<Number>} how many annotations are known
   * @throws when the workspace cannot be read — a rescan that did not run
   *   must not be reported to the user as "found 0"
   */
  async refreshIndex() {
    // Forced: this is the call the preferences pane makes when the user
    // asks for a fresh look, so a recent scan is not reused. A failure is
    // not turned into a number here: the caller says "0" otherwise, and
    // that looks exactly like a workspace with nothing in it.
    await this._index.ensureScanned(this._indexTransport(), {
      force: true,
      key: await this._indexWorkspaceKey(),
    });
    const count = this._index.size;
    Zotero.debug(
      `ZoteroSiYuan: the index knows ${count} sent annotation(s) ` +
        `(${this._index.blocksScanned} block(s) scanned)`,
    );
    // The index itself answers every PDF from now on; the per-attachment
    // stamps only decide when to look again.
    this._indexedAttachments.clear();
    // Now that the index knows what was sent, the readers that were
    // patched before can get their markers, too.
    this._patchReaderSidebars();
    return count;
  }

};
