/**
 * Zotero → SiYuan — the three "send one section" commands.
 *
 * The item menu can send an item's details, its abstract or its notes on
 * their own. Each renders its section with its own template and hands the
 * result to `_sendItemMarkdown`, which writes it where the settings say —
 * the writing itself lives in `item-send.js`.
 */

import { getString } from "../utils/locale.js";
import {
  ITEM_SECTION_ABSTRACT,
  ITEM_SECTION_INFO,
  ITEM_SECTION_NOTES,
} from "../modules/block-attrs.js";
import {
  abstractMarkdown,
  itemInfoMarkdown,
  notesMarkdown,
} from "../modules/item-note.js";

export default {
  /** The item's metadata, as a note of its own. */
  async _sendItemInfo(item) {
    const pdfs = await this._pdfAttachments(item);
    const vars = await this._itemVars(item, pdfs[0] || null);
    const text = itemInfoMarkdown(
      vars,
      this._itemSectionTemplate("itemInfoTemplate"),
    );
    if (!text) {
      this._notifyItemInfo(
        getString(
          "zoteroSiYuan-item-no-content",
          "This item has nothing to put in its document.",
        ),
      );
      return null;
    }
    return await this._sendItemMarkdown(item, text, {
      vars,
      section: ITEM_SECTION_INFO,
    });
  },

  /** The item's abstract. */
  async _sendItemAbstract(item) {
    const pdfs = await this._pdfAttachments(item);
    const vars = await this._itemVars(item, pdfs[0] || null);
    const text = abstractMarkdown(
      vars,
      "",
      this._itemSectionTemplate("itemAbstractTemplate"),
    );
    if (!text) {
      this._notifyItemInfo(
        getString("zoteroSiYuan-item-no-abstract", "This item has no abstract."),
      );
      return null;
    }
    return await this._sendItemMarkdown(item, text, {
      vars,
      section: ITEM_SECTION_ABSTRACT,
    });
  },

  /** The item's child notes. */
  async _sendItemNotes(item) {
    const pdfs = await this._pdfAttachments(item);
    const vars = await this._itemVars(item, pdfs[0] || null);
    // The notes may bring pictures with them; the send holds on to them
    // until SiYuan has the note that refers to them.
    return await this._withItemPictures(async () => {
      const notes = await this._itemNotes(item);
      if (!notes.length) {
        this._notifyItemInfo(
          getString("zoteroSiYuan-item-no-notes", "This item has no notes."),
        );
        return null;
      }
      const text = notesMarkdown(
        vars,
        notes,
        this._itemSectionTemplate("itemNotesTemplate"),
      );
      if (!text) {
        this._notifyItemInfo(
          getString("zoteroSiYuan-item-no-notes", "This item has no notes."),
        );
        return null;
      }
      return await this._sendItemMarkdown(item, text, {
        vars,
        section: ITEM_SECTION_NOTES,
      });
    });
  },

};
