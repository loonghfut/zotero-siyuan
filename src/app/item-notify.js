/**
 * Zotero → SiYuan — the bubbles an item-level send shows.
 *
 * Keeping these out of `item-send.js` gives the write path room to explain
 * itself. The methods still expect `this` to be the addon: they use its
 * reader opener and its main-window document.
 */

import { getString } from "../utils/locale.js";
import { siyuanBlockLink } from "../modules/metadata.js";
import { showToast } from "../modules/toast.js";

export default {
  /** The bubble for an item-level write. */
  _notifyItem(written, destination) {
    const blockID = (written && written.blockID) || "";
    const where =
      (destination && destination.title) ||
      (destination && destination.kind === "daily"
        ? getString("zoteroSiYuan-daily-note", "today's daily note")
        : "") ||
      (written && written.documentID) ||
      "SiYuan";
    // A literature-note sync has more to report: what happened to the
    // annotations, and to the notes that became documents of their own.
    // They belong in the same bubble, not in three.
    const extra = [
      written && written.annotationSummary,
      written && written.annotationWarning,
      written && written.noteDocumentSummary,
      written && written.noteDocumentWarning,
    ]
      .filter(Boolean)
      .join("\n");
    this._showItemToast({
      title: getString("zoteroSiYuan-item-sent-title", "Sent to SiYuan"),
      message: extra ? `${where}\n${extra}` : where,
      blockID,
    });
  },

  /** The bubble for a failed item-level write. */
  _notifyItemError(error, item = null) {
    const title = this._itemTitle(item);
    const message = String((error && error.message) || error);
    this._showItemToast({
      title: getString(
        "zoteroSiYuan-item-failed-title",
        "Could not send the item to SiYuan",
      ),
      message: title ? `${title}: ${message}` : message,
      // Nothing removes it but the user.
      timeout: 0,
    });
  },

  /** The bubble for a write that worked but could not clean up. */
  _notifyItemWarning(message, written = null) {
    const blockID = (written && written.blockID) || "";
    this._showItemToast({
      title: getString(
        "zoteroSiYuan-item-warning-title",
        "Sent, with a warning",
      ),
      message: String(message || ""),
      blockID,
      timeout: 15000,
    });
  },

  /** The bubble for "there is nothing to send" — not an error. */
  _notifyItemInfo(message) {
    this._showItemToast({
      title: getString(
        "zoteroSiYuan-item-nothing-title",
        "Nothing to send",
      ),
      message: String(message || ""),
      timeout: 8000,
    });
  },

  /** One item-level bubble, with the pieces every one of them shares. */
  _showItemToast({ title, message, blockID = "", timeout = undefined }) {
    try {
      showToast({
        title,
        message,
        link: siyuanBlockLink(blockID),
        linkLabel: getString("zoteroSiYuan-toast-open", "Open in SiYuan"),
        onLink: blockID ? () => this._openInSiYuan(blockID) : null,
        timeout,
        doc: this._mainDoc(),
      });
    }
    catch (e) {
      // The note is in SiYuan; the bubble is optional.
    }
  },

  /** The item's title, when it has one. */
  _itemTitle(item) {
    try {
      return String((item && item.getField && item.getField("title")) || "")
        .trim();
    }
    catch (e) {
      return "";
    }
  },
};
