/**
 * Zotero → SiYuan — the item-list context menu.
 *
 * The reader is not the only way in. An item can be selected in the list
 * before anything is opened, and from there its information, abstract,
 * notes or annotations can go to SiYuan. The menu is built into the item
 * tree's own popup, so it sits where the user already right-clicks.
 */

import { getString } from "../utils/locale.js";

const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
const MENU_ID = "zotero-siyuan-item-menu";

export default {
  /**
   * Add the menu to a main window.
   *
   * `bootstrap.js` hands the window itself to the hook, while Zotero's own
   * `onMainWindowLoad` payload is `{ window }` — both shapes are accepted so
   * the hook keeps working whichever way it is called.
   *
   * @param {Object} [event] - { window }, or the window
   */
  async onMainWindowLoad(event = {}) {
    const win = (event && event.window) || event;
    this._installItemMenuWhenReady(win);
  },

  /**
   * Put the menu into every main window that is already open.
   *
   * Zotero calls `onMainWindowLoad` only for a window that opens after the
   * plugin started. A plugin that is installed or re-enabled while Zotero is
   * running never hears about the window that is already there — which is
   * how the menu ended up missing. The windows that exist now are found
   * here instead.
   */
  installItemMenus() {
    let windows = [];
    try {
      windows = Zotero.getMainWindows() || [];
    }
    catch (e) {
      return;
    }
    for (const win of windows) {
      try {
        this._installItemMenuWhenReady(win);
      }
      catch (e) {
        Zotero.logError(`ZoteroSiYuan: could not install the item menu: ${e}`);
      }
    }
  },

  /** Install into a window now, or as soon as its document has loaded. */
  _installItemMenuWhenReady(win) {
    if (!win || !win.document) {
      return;
    }
    if (win.document.readyState === "complete") {
      this._installItemMenu(win);
      return;
    }
    // A window that is still loading has no item tree yet; its `load` is the
    // first moment the popup exists.
    const onLoad = () => {
      win.removeEventListener("load", onLoad);
      if (this._shutDown) {
        return;
      }
      this._installItemMenu(win);
    };
    win.addEventListener("load", onLoad);
  },

  /**
   * Take the menu out again.
   *
   * @param {Object} [event] - { window }, or the window
   */
  async onMainWindowUnload(event = {}) {
    const win = (event && event.window) || event;
    if (!win) {
      return;
    }
    this._removeItemMenu(win);
  },

  /**
   * The targets the item menu acts on.
   *
   * A user right-clicks the PDF row far more often than the parent paper,
   * and an annotation row more often still. Those are child items, so the
   * selection is walked up to the item that owns the bibliographic data.
   * A standalone PDF has no such parent and is its own target. Selecting
   * both a parent and one of its children still sends once.
   */
  _selectedSendTargets(win) {
    try {
      const pane = win && win.ZoteroPane;
      const items = (pane && pane.getSelectedItems && pane.getSelectedItems()) || [];
      const seen = new Set();
      const targets = [];
      for (const item of items) {
        const target = this._sendTargetOf(item);
        if (target && !seen.has(target.id)) {
          seen.add(target.id);
          targets.push(target);
        }
      }
      return targets;
    }
    catch (e) {
      return [];
    }
  },

  /** The top-level item a selection belongs to, or a standalone PDF. */
  _sendTargetOf(item) {
    let current = item;
    let fallbackPDF = null;
    // A depth limit keeps a malformed parent chain from looping.
    for (let step = 0; step < 4 && current; step++) {
      try {
        if (current.isRegularItem && current.isRegularItem()) {
          return current;
        }
        if (
          !fallbackPDF &&
          current.isPDFAttachment &&
          current.isPDFAttachment()
        ) {
          fallbackPDF = current;
        }
        const parentID = current.parentItemID;
        if (!parentID) {
          return fallbackPDF;
        }
        current = Zotero.Items.get(parentID);
      }
      catch (e) {
        return fallbackPDF;
      }
    }
    return fallbackPDF;
  },

  /** Build the menu once per window. */
  _installItemMenu(win) {
    if (this._shutDown) {
      return;
    }
    const doc = win.document;
    if (!doc || doc.getElementById(MENU_ID)) {
      return;
    }
    const parent = doc.getElementById("zotero-itemmenu");
    if (!parent) {
      Zotero.debug("ZoteroSiYuan: the item menu was not found");
      return;
    }
    const menu = doc.createXULElement("menu");
    menu.id = MENU_ID;
    menu.setAttribute(
      "label",
      getString("zoteroSiYuan-item-menu", "Send to SiYuan"),
    );
    const popup = doc.createXULElement("menupopup");
    menu.appendChild(popup);

    const entries = [
      ["_sendItemInfo", "zoteroSiYuan-item-menu-info", "Send the item details"],
      ["_sendItemAbstract", "zoteroSiYuan-item-menu-abstract", "Send the abstract"],
      ["_sendItemNotes", "zoteroSiYuan-item-menu-notes", "Send the notes"],
      [
        "_sendItemAnnotations",
        "zoteroSiYuan-item-menu-annotations",
        "Send all annotations",
      ],
      [
        "_syncItemDocument",
        "zoteroSiYuan-item-menu-document",
        "Sync this item (details, abstract, notes)",
      ],
    ];
    for (const [method, labelID, fallback] of entries) {
      const item = doc.createXULElement("menuitem");
      item.setAttribute("label", getString(labelID, fallback));
      item.addEventListener("command", (e) => {
        e.preventDefault();
        this._runForSelection(win, method);
      });
      popup.appendChild(item);
    }
    parent.appendChild(menu);

    // Collections, searches and other rows have no item to send. Hiding the
    // menu there is better than a command that does nothing.
    const onShowing = () => {
      menu.hidden = !this._selectedSendTargets(win).length;
    };
    parent.addEventListener("popupshowing", onShowing);
    menu.hidden = !this._selectedSendTargets(win).length;

    if (!this._itemMenus) {
      this._itemMenus = new WeakMap();
    }
    this._itemMenus.set(win, { menu, parent, onShowing });
  },

  /** Remove the menu from a window. */
  _removeItemMenu(win) {
    const entry = this._itemMenus && this._itemMenus.get(win);
    if (!entry) {
      return;
    }
    try {
      entry.parent.removeEventListener("popupshowing", entry.onShowing);
      entry.menu.remove();
    }
    catch (e) {
      // The window is closing anyway.
    }
    this._itemMenus.delete(win);
  },

  /** Run one of the item actions for every selected item. */
  async _runForSelection(win, method) {
    const items = this._selectedSendTargets(win);
    if (!items.length || typeof this[method] !== "function") {
      return;
    }
    for (const item of items) {
      try {
        await this[method](item);
      }
      catch (error) {
        // A failure before the write even starts — reading the notes, for
        // instance — never reaches the send's own error bubble, so it is
        // shown here: a command that silently did nothing looks broken.
        Zotero.logError(`ZoteroSiYuan: ${method} failed: ${error}`);
        this._notifyItemError(error, item);
      }
    }
  },
};
