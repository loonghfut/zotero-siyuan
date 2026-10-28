/**
 * Zotero → SiYuan — the local copy of the sent markers, and the notes whose
 * SiYuan block disappeared.
 *
 * The index itself lives in memory and is rebuilt from the workspace. This
 * module keeps a small JSON copy in a Zotero preference so the markers
 * still appear when SiYuan is not running, and it turns "a block the cache
 * knows is gone" into something the user can act on.
 */

import { getString } from "../utils/locale.js";
import { getPref, setPref } from "../utils/prefs.js";
import {
  sentCacheKey,
  parseSentCache,
  serializeSentCache,
  sentCacheEntries,
} from "../modules/sent-cache.js";
import { showToast } from "../modules/toast.js";

export default {
  /** Which workspace the cached mapping belongs to. */
  _sentCacheWorkspace() {
    return sentCacheKey(getPref("cliPath", ""), getPref("workspace", ""));
  },

  /**
   * Load the cache into the index before the workspace is read.
   *
   * This is what keeps the markers on screen when SiYuan is closed. A
   * cache that belongs to another workspace is ignored — its markers lead
   * to blocks that no longer exist for this user.
   */
  _loadSentCache() {
    this._sentCache = new Map();
    const parsed = parseSentCache(getPref("sentCache", ""));
    const key = this._sentCacheWorkspace();
    if (parsed.key && parsed.key !== key) {
      Zotero.debug(
        "ZoteroSiYuan: the sent cache belongs to another workspace — ignored",
      );
      return;
    }
    for (const entry of parsed.entries) {
      this._sentCache.set(entry.annotationKey, entry);
    }
    this._index.seed(parsed.entries);
    if (parsed.entries.length) {
      Zotero.debug(
        `ZoteroSiYuan: ${parsed.entries.length} sent marker(s) restored from the local cache`,
      );
    }
  },

  /**
   * Follow a change of the index into the cache.
   *
   * @param {Object} change - { type, key, blockID, documentID, blocks,
   *   details, removed }
   */
  _indexChanged(change) {
    if (!change) {
      return;
    }
    if (!this._sentCache) {
      this._sentCache = new Map();
    }
    if (change.type === "add") {
      // A note that was deleted and sent again has a block again; if it is
      // deleted once more, that is a fresh piece of news.
      if (this._deletedNotified) {
        this._deletedNotified.delete(change.key);
      }
      this._sentCache.set(change.key, {
        annotationKey: change.key,
        blockID: change.blockID,
        documentID: change.documentID || "",
        at: Date.now(),
      });
      this._saveSentCacheSoon();
      return;
    }
    if (change.type === "remove") {
      this._sentCache.delete(change.key);
      this._saveSentCacheSoon();
      return;
    }
    if (change.type !== "snapshot") {
      return;
    }
    // A scan replaces the whole mapping. It is authoritative, so entries
    // it does not mention are gone — but the ones that are still there
    // keep the time they were cached at, so the limit evicts the oldest.
    const previous = this._sentCache;
    const next = new Map();
    for (const entry of sentCacheEntries(change.blocks, change.details)) {
      const old = previous.get(entry.annotationKey);
      next.set(entry.annotationKey, {
        ...entry,
        at: old ? old.at : entry.at,
      });
    }
    this._sentCache = next;
    this._saveSentCacheSoon();
    this._notifyDeletedNotes(change.removed || []);
  },

  /** Write the cache after a burst of changes, not on every one. */
  _saveSentCacheSoon() {
    if (this._shutDown) {
      // The final state was flushed by `onShutdown`; a timer started now
      // would outlive the plugin that owns it.
      return;
    }
    if (this._sentCacheTimer) {
      clearTimeout(this._sentCacheTimer);
    }
    this._sentCacheTimer = setTimeout(() => {
      this._sentCacheTimer = null;
      this._flushSentCache();
    }, 400);
  },

  /** Write the cache now. */
  _flushSentCache() {
    if (!this._sentCache) {
      return;
    }
    try {
      setPref(
        "sentCache",
        serializeSentCache(
          this._sentCacheWorkspace(),
          [...this._sentCache.values()],
        ),
      );
    }
    catch (e) {
      Zotero.debug(`ZoteroSiYuan: could not write the sent cache: ${e}`);
    }
  },

  /**
   * Tell the user that notes they sent are no longer in SiYuan.
   *
   * One bubble for the batch, not one per annotation: a workspace that was
   * cleaned up would otherwise produce a wall of messages. The action
   * resends them — the annotations are still in Zotero, and a marker that
   * leads nowhere is worse than a second note the user asked for.
   *
   * @param {Array<{key: String, blockID: String}>} removed
   */
  _notifyDeletedNotes(removed) {
    const list = Array.isArray(removed) ? removed : [];
    if (!list.length) {
      return;
    }
    if (!this._deletedNotified) {
      this._deletedNotified = new Set();
    }
    const fresh = list.filter((entry) => {
      const key = entry && entry.key;
      if (!key || this._deletedNotified.has(key)) {
        return false;
      }
      this._deletedNotified.add(key);
      return true;
    });
    if (!fresh.length) {
      return;
    }
    const keys = fresh.map((entry) => entry.key);
    // Take the markers out of every open reader now: the reader may not
    // redraw that header for a long time, and a marker that leads nowhere
    // is worse than no marker.
    for (const reader of this._openReaders()) {
      const doc = this._readerDoc(reader);
      if (!doc) {
        continue;
      }
      for (const key of keys) {
        this._removeSentMarker(doc, key);
      }
    }
    try {
      showToast({
        title: getString(
          "zoteroSiYuan-deleted-title",
          "A sent note was deleted in SiYuan",
        ),
        message: getString(
          "zoteroSiYuan-deleted-message",
          "%d annotation(s) had a note in SiYuan that is no longer there. " +
            "The marker was removed.",
        ).replace("%d", String(fresh.length)),
        timeout: 15000,
        actions: [
          {
            label: getString(
              "zoteroSiYuan-deleted-resend",
              "Send them again",
            ),
            primary: true,
            onClick: () => this._resendAnnotations(keys),
          },
          {
            label: getString("zoteroSiYuan-deleted-ignore", "Ignore"),
          },
        ],
      });
    }
    catch (e) {
      Zotero.debug(`ZoteroSiYuan: could not report the deleted notes: ${e}`);
    }
  },

  /**
   * Send annotations again, one after another.
   *
   * A deleted block can belong to any PDF, so each annotation resolves its
   * own attachment — a batch would put notes of different papers into the
   * first one's document.
   *
   * @param {String[]} keys
   */
  async _resendAnnotations(keys) {
    for (const key of keys || []) {
      try {
        const item = await this._getAnnotationItem({ id: key });
        if (!item) {
          continue;
        }
        const annotation = await this._annotationFromItem(item);
        const reader = await this._readerForAnnotation(annotation);
        await this._send(annotation, reader, null, { alreadySent: "send" });
      }
      catch (e) {
        Zotero.logError(`ZoteroSiYuan: could not resend ${key}: ${e}`);
      }
    }
  },

  /** The main window's document, when one is open. */
  _mainDoc() {
    try {
      const win = Zotero.getMainWindow();
      return (win && win.ZoteroPane && win.ZoteroPane.document) || null;
    }
    catch (e) {
      return null;
    }
  },
};
