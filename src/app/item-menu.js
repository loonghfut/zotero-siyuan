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

  /** The regular items that are selected in a window. */
  _selectedRegularItems(win) {
    try {
      const pane = win && win.ZoteroPane;
      const items = (pane && pane.getSelectedItems && pane.getSelectedItems()) || [];
      return items.filter(
        (item) => item && item.isRegularItem && item.isRegularItem(),
      );
    }
    catch (e) {
      return [];
    }
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
        this._runForSelection(win, method).catch((error) => {
          Zotero.logError(`ZoteroSiYuan: ${method} failed: ${error}`);
        });
      });
      popup.appendChild(item);
    }
    parent.appendChild(menu);

    // Collections, searches and other rows have no item to send. Hiding the
    // menu there is better than a command that does nothing.
    const onShowing = () => {
      menu.hidden = !this._selectedRegularItems(win).length;
    };
    parent.addEventListener("popupshowing", onShowing);
    menu.hidden = !this._selectedRegularItems(win).length;

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
    const items = this._selectedRegularItems(win);
    if (!items.length || typeof this[method] !== "function") {
      return;
    }
    for (const item of items) {
      await this[method](item);
    }
  },
};
