/**
 * Zotero → SiYuan — sending new annotations without being asked, and the
 * queue of the ones that could not be sent.
 *
 * This is off by default. When it is on, it still has to be quiet: only the
 * annotations that match every filter are sent, and a send that fails
 * because SiYuan is not running goes into a queue instead of a bubble.
 * The queue is retried on the next start, and as soon as a later send
 * proves that SiYuan is back.
 */

import { getString } from "../utils/locale.js";
import { getPref, prefFlag, setPref } from "../utils/prefs.js";
import { matchesAutoFilters, splitFilter } from "../modules/auto-filter.js";import {
  addPending,
  failPending,
  parsePendingQueue,
  removePending,
  serializePendingQueue,
} from "../modules/pending-queue.js";
import { isWriteUnknown } from "../modules/siyuan-process.js";
import { showToast } from "../modules/toast.js";

// How long after the notifier fires an annotation is looked at.
const AUTO_SEND_DELAY_MS = 1200;

// How long the queue waits before its first retry, and the cap after that.
const QUEUE_FIRST_RETRY_MS = 60000;
const QUEUE_MAX_RETRY_MS = 1800000;

export default {
  /* ------------------------------------------------------- the filters */

  /** Is automatic sending on? */
  _autoSendEnabled() {
    return prefFlag("autoSend", false);
  },

  /** The filters, as lists. */
  _autoFilters() {
    return {
      colors: splitFilter(getPref("autoSendColors", "")),
      tags: splitFilter(getPref("autoSendTags", "")),
      types: splitFilter(getPref("autoSendTypes", "")),
      itemTypes: splitFilter(getPref("autoSendItemTypes", "")),
    };
  },

  /**
   * The settings the pane draws.
   *
   * @returns {Object}
   */
  getAutoSendSettings() {
    const filters = this._autoFilters();
    return {
      enabled: this._autoSendEnabled(),
      colors: filters.colors,
      tags: filters.tags,
      types: filters.types,
      itemTypes: filters.itemTypes,
      pending: this.getPendingQueueInfo(),
    };
  },

  /** Turn automatic sending on or off. */
  setAutoSendEnabled(value) {
    setPref("autoSend", value ? "1" : "0");
    if (value) {
      this._scheduleQueueRetry(2000);
    }
    else {
      this._cancelQueueRetry();
    }
    return this._autoSendEnabled();
  },

  /**
   * Replace one filter.
   *
   * @param {String} name - "colors" | "tags" | "types" | "itemTypes"
   * @param {Array|String} value
   */
  setAutoSendFilter(name, value) {
    const allowed = ["colors", "tags", "types", "itemTypes"];
    if (!allowed.includes(name)) {
      return this._autoFilters();
    }
    const text = Array.isArray(value) ? value.join(",") : String(value || "");
    setPref(`autoSend${name[0].toUpperCase()}${name.slice(1)}`, text);
    return this._autoFilters();
  },

  /* --------------------------------------------------- the notification */

  /** Start listening for new annotation items. */
  _registerAutoSend() {
    if (this._autoSendObserver) {
      return;
    }
    this._autoSendTimers = new Set();
    this._autoSendObserver = {
      notify: (event, type, ids) => this._onAutoSendNotify(event, type, ids),
    };
    try {
      this._autoSendObserverID = Zotero.Notifier.registerObserver(
        this._autoSendObserver,
        ["item"],
        "zoteroSiYuan",
      );
    }
    catch (e) {
      this._autoSendObserver = null;
      Zotero.logError(`ZoteroSiYuan: could not watch new annotations: ${e}`);
    }
  },

  /** Stop listening, and cancel the sends that are still waiting. */
  _unregisterAutoSend() {
    if (this._autoSendObserverID) {
      try {
        Zotero.Notifier.unregisterObserver(this._autoSendObserverID);
      }
      catch (e) {
        // The notifier is gone with Zotero.
      }
    }
    this._autoSendObserverID = null;
    this._autoSendObserver = null;
    for (const timer of this._autoSendTimers || []) {
      clearTimeout(timer);
    }
    this._autoSendTimers = new Set();
    this._cancelQueueRetry();
  },

  /** A Zotero item was added — is it an annotation? */
  _onAutoSendNotify(event, type, ids) {
    if (event !== "add" || type !== "item" || !this._autoSendEnabled()) {
      return;
    }
    for (const id of ids || []) {
      this._autoSendLater(Number(id), 0);
    }
  },

  /** Look at an annotation a moment later, when Zotero has finished saving it. */
  _autoSendLater(itemID, attempt) {
    if (!itemID || this._shutDown) {
      return;
    }
    const timer = setTimeout(async () => {
      this._autoSendTimers.delete(timer);
      try {
        await this._maybeAutoSend(itemID, attempt);
      }
      catch (e) {
        Zotero.logError(`ZoteroSiYuan: automatic send failed: ${e}`);
      }
    }, AUTO_SEND_DELAY_MS + attempt * 1500);
    this._autoSendTimers.add(timer);
  },

  /**
   * Send one new annotation, if it passes the filters.
   *
   * @param {Number} itemID
   * @param {Number} attempt
   */
  async _maybeAutoSend(itemID, attempt = 0) {
    if (this._shutDown || !this._autoSendEnabled()) {
      return;
    }
    let item = null;
    try {
      item = await Zotero.Items.getAsync(itemID);
    }
    catch (e) {
      return;
    }
    if (!item || !item.isAnnotation || !item.isAnnotation()) {
      return;
    }
    // Another send is running. A new annotation is not lost by waiting a
    // little; queueing it would make it look like a failure.
    if (this._sending) {
      if (attempt < 6) {
        this._autoSendLater(itemID, attempt + 1);
      }
      return;
    }
    const annotation = await this._annotationFromItem(item);
    const parentType = await this._annotationItemType(item);
    if (!matchesAutoFilters(annotation, parentType, this._autoFilters())) {
      return;
    }
    const key = await this._resolveAnnotationKey(annotation);
    if (!key || this._index.get(key)) {
      return;
    }
    const reader = await this._readerForAnnotation(annotation);
    this._sending = true;
    try {
      await this._sendAnnotation(annotation, reader, null, { auto: true });
      // The sidebar may have drawn this annotation before the note was in
      // SiYuan; without this its ↗ would wait for the next redraw.
      this._refreshMarkerOf(reader && reader.itemID);
      Zotero.debug(
        `ZoteroSiYuan: automatically sent annotation ${key}`,
      );
    }
    catch (e) {
      // A write whose answer was lost may already be in SiYuan — sending it
      // again from the queue would put it there twice.
      if (isWriteUnknown(e)) {
        Zotero.logError(`ZoteroSiYuan: ${e}`);
      }
      else if (e && e.permanent) {
        Zotero.logError(`ZoteroSiYuan: automatic send refused: ${e.message}`);
      }
      else {
        this._queueFailed(key, e);
      }
    }
    finally {
      this._sending = false;
    }
  },

  /**
   * The Zotero type of the item an annotation belongs to.
   *
   * An annotation's parent is the PDF attachment, not the paper — the
   * filter is about the paper, so it is one step further up.
   */
  async _annotationItemType(annotationItem) {
    try {
      let item = annotationItem;
      for (let step = 0; step < 2 && item && item.parentItemID; step++) {
        item = await Zotero.Items.getAsync(item.parentItemID);
      }
      return (item && item.itemType) || "";
    }
    catch (e) {
      return "";
    }
  },

  /**
   * Redraw the markers of an open reader that shows this PDF.
   *
   * @param {Number|String} itemID - the PDF attachment
   */
  _refreshMarkerOf(itemID) {
    if (!itemID) {
      return;
    }
    try {
      for (const reader of this._openReaders()) {
        if (reader && String(reader.itemID) === String(itemID)) {
          const doc = this._readerDoc(reader);
          if (doc) {
            this._updateRenderedMarkers(doc);
          }
          return;
        }
      }
    }
    catch (e) {
      Zotero.debug(`ZoteroSiYuan: could not refresh the markers: ${e}`);
    }
  },

  /* ---------------------------------------------------- the pending queue */

  /** The queue, loaded from the preference on first use. */
  _pendingQueueEntries() {
    if (!Array.isArray(this._pendingQueue)) {
      this._pendingQueue = parsePendingQueue(getPref("pendingQueue", ""));
    }
    return this._pendingQueue;
  },

  /** What the pane shows about the queue. */
  getPendingQueueInfo() {
    const list = this._pendingQueueEntries();
    return {
      count: list.length,
      keys: list.map((entry) => entry.key),
      enabled: this._autoSendEnabled(),
    };
  },

  /** Put a failed automatic send into the queue. */
  _queueFailed(key, error) {
    if (!key) {
      return;
    }
    const before = this._pendingQueueEntries().length;
    const result = addPending(this._pendingQueue, key);
    this._pendingQueue = result.list;
    setPref("pendingQueue", serializePendingQueue(this._pendingQueue));
    if (result.added && before === 0) {
      try {
        showToast({
          title: getString(
            "zoteroSiYuan-queue-title",
            "SiYuan is not reachable",
          ),
          message: getString(
            "zoteroSiYuan-queue-message",
            "The annotation was added to the pending queue and will be sent " +
              "when SiYuan is back.",
          ),
          timeout: 9000,
        });
      }
      catch (e) {
        // A bubble is a nicety; the queue is what matters.
      }
    }
    Zotero.debug(
      `ZoteroSiYuan: ${key} is waiting in the send queue: ${error && error.message}`,
    );
    this._scheduleQueueRetry(QUEUE_FIRST_RETRY_MS);
  },

  /** Clear the queue — the user asked for it. */
  clearPendingQueue() {
    this._pendingQueue = [];
    setPref("pendingQueue", "[]");
    this._cancelQueueRetry();
    return this.getPendingQueueInfo();
  },

  /** Try again soon, after a send just proved the connection works. */
  _retryPendingQueueSoon() {
    if (this._pendingQueueEntries().length && this._autoSendEnabled()) {
      this._scheduleQueueRetry(2000);
    }
  },

  /** Schedule a retry, replacing the one that was waiting. */
  _scheduleQueueRetry(delay) {
    this._cancelQueueRetry();
    if (this._shutDown || !this._autoSendEnabled()) {
      return;
    }
    if (!this._pendingQueueEntries().length) {
      return;
    }
    this._queueTimer = setTimeout(() => {
      this._queueTimer = null;
      this.retryPendingQueue().catch((e) => {
        Zotero.logError(`ZoteroSiYuan: the queue retry failed: ${e}`);
      });
    }, Math.max(1000, Number(delay) || QUEUE_FIRST_RETRY_MS));
  },

  /** Stop the waiting retry. */
  _cancelQueueRetry() {
    if (this._queueTimer) {
      clearTimeout(this._queueTimer);
      this._queueTimer = null;
    }
  },

  /**
   * Send what is in the queue.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.force] - run even when automatic sending is
   *   off (the pane's "retry now" button)
   * @returns {Promise<{sent: Number, left: Number}>}
   */
  async retryPendingQueue({ force = false } = {}) {
    if (this._queueRunning || this._shutDown) {
      return { sent: 0, left: this._pendingQueueEntries().length };
    }
    if (this._sending) {
      // A click is writing right now. The queue is not lost; try again
      // after it, instead of writing two notes at the same time.
      this._scheduleQueueRetry(QUEUE_FIRST_RETRY_MS);
      return { sent: 0, left: this._pendingQueueEntries().length };
    }
    if (!force && !this._autoSendEnabled()) {
      return { sent: 0, left: this._pendingQueueEntries().length };
    }
    if (!this._pendingQueueEntries().length) {
      return { sent: 0, left: 0 };
    }
    this._queueRunning = true;
    // The queue and a click share the same lock: a note written by a click
    // while a retry is in the workspace would be a second concurrent send.
    this._sending = true;
    let sent = 0;
    let queue = this._pendingQueueEntries().slice();
    // One redraw per PDF, not one per annotation: a queue of twenty notes
    // from one paper would otherwise walk its sidebar twenty times.
    const attachments = new Set();
    try {
      for (const entry of queue.slice()) {
        const key = entry.key;
        const item = await this._getAnnotationItem({ id: key });
        if (!item) {
          queue = removePending(queue, key);
          continue;
        }
        if (this._index.get(key)) {
          queue = removePending(queue, key);
          continue;
        }
        const annotation = await this._annotationFromItem(item);
        const reader = await this._readerForAnnotation(annotation);
        try {
          await this._sendAnnotation(annotation, reader, null, { auto: true });
          sent++;
          queue = removePending(queue, key);
          if (reader && reader.itemID) {
            attachments.add(reader.itemID);
          }
        }
        catch (e) {
          if (isWriteUnknown(e) || (e && e.permanent)) {
            Zotero.logError(`ZoteroSiYuan: ${key} left the queue: ${e}`);
            queue = removePending(queue, key);
          }
          else {
            queue = failPending(queue, key);
          }
        }
      }
    }
    finally {
      this._queueRunning = false;
      this._sending = false;
      this._pendingQueue = queue;
      setPref("pendingQueue", serializePendingQueue(queue));
    }
    for (const itemID of attachments) {
      this._refreshMarkerOf(itemID);
    }
    if (sent && !queue.length) {
      try {
        showToast({
          title: getString(
            "zoteroSiYuan-queue-done-title",
            "The queue was sent",
          ),
          message: getString(
            "zoteroSiYuan-queue-done-message",
            "%d annotation(s) that were waiting have been sent to SiYuan.",
          ).replace("%d", String(sent)),
        });
      }
      catch (e) {
        // The queue is empty; the bubble is optional.
      }
    }
    if (queue.length) {
      const attempts = Math.max(
        0,
        ...queue.map((entry) => Number(entry.attempts) || 0),
      );
      const delay = Math.min(
        QUEUE_MAX_RETRY_MS,
        QUEUE_FIRST_RETRY_MS * Math.pow(2, Math.min(attempts, 5)),
      );
      this._scheduleQueueRetry(delay);
    }
    else {
      this._cancelQueueRetry();
    }
    return { sent, left: queue.length };
  },
};
