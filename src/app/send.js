/**
 * Zotero → SiYuan — the send pipeline: one annotation, or a batch of them.
 */

import { getString } from "../utils/locale.js";
import { siyuanBlockLink } from "../modules/metadata.js";
import { showToast } from "../modules/toast.js";
import { isWriteUnknown } from "../modules/siyuan-process.js";

export default {
  /**
   * The hooks of the send that is about to happen — and only that one.
   *
   * The self test puts its hooks on the addon right before it clicks the
   * button, and the click handler calls `_send` synchronously. So the hooks
   * are taken by exactly the send they were meant for, and a real click —
   * which carries none — is never watched, redirected or delayed.
   *
   * @returns {Object|null} the hooks, or null for a real send
   */
  _takeSendHooks() {
    const hooks = this._pendingSendHooks;
    this._pendingSendHooks = null;
    return hooks || null;
  },

  /**
   * Keep a running send reachable, so a shutdown can wait for it.
   *
   * Without this, disabling the plugin in the middle of a send leaves the
   * promise writing into a plugin whose state has already been taken away:
   * the note still lands, but the picture it names is forgotten.
   *
   * @param {Promise} job
   * @returns {Promise} the same promise
   */
  _trackInflight(job) {
    this._inflight.add(job);
    const drop = () => this._inflight.delete(job);
    job.then(drop, drop);
    return job;
  },

  /**
   * Wait for the sends that are still running.
   *
   * Not forever: a SiYuan that never answers must not keep Zotero from
   * finishing. Five seconds is longer than a healthy write takes and
   * shorter than the shutdown timeout.
   *
   * @param {Number} [ms]
   */
  async _waitForInflight(ms = 5000) {
    const pending = [...(this._inflight || [])];
    if (!pending.length) {
      return;
    }
    let timer = null;
    try {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise((resolve) => {
          timer = setTimeout(resolve, ms);
        }),
      ]);
    }
    finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  },

  /**
   * The click on an annotation's button.
   *
   * One send at a time: the buttons of the reader are disabled while it
   * runs, and a click that slips through says "sending" instead of doing
   * nothing at all.
   */
  async _send(annotation, reader, button) {
    return await this._trackInflight(
      this._runSend(annotation, reader, button),
    );
  },

  /** One send, start to finish — see `_send`. */
  async _runSend(annotation, reader, button) {
    // The hooks are picked up here, synchronously: the click handler calls
    // `_send` before it returns, so a hook that was put on the addon just
    // before the click is certain to be the one this send uses — and a
    // click that carries no hook is never affected by the self test.
    const hooks = this._takeSendHooks();

    if (this._shutDown) {
      // The plugin is being disabled: nothing new may start, or it would
      // write into a state that is already being torn down.
      return;
    }
    if (this._sending) {
      // Another send is still running. Say so, instead of doing nothing —
      // a button that does not react looks like a broken plugin.
      this._flash(
        button,
        getString("zoteroSiYuan-busy", "Sending…"),
        false,
      );
      return;
    }
    const doc = (button && button.ownerDocument) || null;
    this._sending = true;
    // Every button of this reader, not only the one that was clicked: the
    // second click of a user who is unsure whether the first one worked
    // must not queue a second note.
    this._setReaderBusy(doc, true);
    if (button) {
      button.disabled = true;
      button.style.opacity = "1";
    }

    try {
      const result = await this._sendAnnotation(annotation, reader, hooks);
      // A send the self test watched is not the user's send: it must not
      // turn the button into "sent" or pop a bubble, or the user believes
      // they sent something they did not.
      if (!hooks) {
        this._flash(
          button,
          getString("zoteroSiYuan-done", "Sent to SiYuan"),
          false,
        );
        this._notify(result, doc);
      }
      Zotero.debug(
        `ZoteroSiYuan: appended an annotation to the SiYuan daily note in notebook ${result.notebook.name} (${result.notebook.id}) via ${result.transport}` +
          (result.blockID ? `, block ${result.blockID}` : ""),
      );
      // The marker shows up right away — no need to reopen the PDF.
      if (result.blockID && button) {
        this._updateRenderedMarkers(button.ownerDocument);
      }
    }
    catch (e) {
      Zotero.logError(`ZoteroSiYuan: ${e}`);
      this._flash(button, `${getString("zoteroSiYuan-failed")} ${e.message}`, true);
      // A tooltip is not a failure report: it is clipped and gone in four
      // seconds. A watched send (the self test) says nothing to the user.
      if (!hooks) {
        this._notifyError(e, doc);
      }
    }
    finally {
      this._sending = false;
      this._setReaderBusy(doc, false);
      if (button) {
        button.disabled = false;
        button.style.opacity = "";
      }
    }
  },

  /**
   * Render one annotation and send it to SiYuan.
   *
   * The single-annotation button and the batch action share this, so both
   * behave exactly the same.
   *
   * @param {Object} annotation - the reader's annotation model
   * @param {Object} reader - the reader tab
   * @param {Object} [hooks] - what the self test watches this send with
   * @returns {Promise<Object>} what happened
   */
  async _sendAnnotation(annotation, reader, hooks = null) {
    // The notebook comes first: resolving it can fail (SiYuan not running,
    // no notebook configured), and a send that fails there should not have
    // put a picture into the workspace at all — the picture and the note
    // have to belong to the same workspace.
    if (hooks && hooks.stage) {
      hooks.stage("resolving the notebook");
    }
    const notebook = await this._resolveNotebook();
    if (hooks && hooks.notebook) {
      hooks.notebook(notebook);
    }

    let markdown;
    try {
      // The picture goes into the workspace while the content is built, so
      // a failure here has to take it back too.
      markdown = await this._buildContent(annotation, reader, hooks);
    }
    catch (e) {
      await this._dropPicture();
      throw e;
    }

    let sent;
    try {
      sent = (await this._append(notebook.id, markdown, hooks)) || {};
    }
    catch (e) {
      // The write started but its answer never arrived — it may well be in
      // the daily note, and that note refers to this picture. Deleting it
      // would leave a broken image behind, so it stays.
      if (!isWriteUnknown(e)) {
        await this._dropPicture();
      }
      throw e;
    }
    // The note is in SiYuan, so the picture that came with it belongs to
    // the note now.
    this._pendingPicture = null;
    // `_append` answers with an object; accept a plain string too, so a
    // change there cannot silently lose the block id.
    const transport = typeof sent === "string" ? sent : sent.transport;
    const blockID = typeof sent === "string" ? "" : sent.blockID || "";
    // Remember it right away — no need to wait for the next scan.
    const annotationKey = await this._resolveAnnotationKey(annotation);
    if (annotationKey && blockID) {
      this._index.add(annotationKey, blockID);
    }
    return { transport, blockID, notebook, markdown };
  },

  /**
   * The bubble that says a send failed.
   *
   * It does not time out: an error is read, not glimpsed, and the one case
   * that really matters — the write may or may not have landed — cannot be
   * understood from a message that disappears.
   *
   * @param {Error} error
   * @param {Object} [doc] - the document to show it in
   */
  _notifyError(error, doc = null) {
    const unknown = isWriteUnknown(error);
    const message = unknown
      ? getString(
        "zoteroSiYuan-failed-unknown",
        "The note may already be in SiYuan, but no answer came back. " +
          "Check today's daily note before sending it again — its picture " +
          "was kept, so nothing is broken.",
      )
      : String((error && error.message) || error);
    try {
      showToast({
        doc,
        title: getString(
          "zoteroSiYuan-failed-title",
          "Could not send to SiYuan",
        ),
        message,
        // Nothing removes it but the user.
        timeout: 0,
      });
    }
    catch (e) {
      Zotero.debug(`ZoteroSiYuan: could not show the error: ${e}`);
    }
  },

  /** The bubble that confirms the write and offers a way back to SiYuan. */
  _notify(result, doc = null) {
    try {
      showToast({
        // The reader the send came from, so the answer appears where the
        // user is looking instead of in the library behind it.
        doc,
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
  },

  /**
   * How many of how many — the line of a batch that is under way.
   *
   * @param {Number} done
   * @param {Number} total
   * @returns {String}
   */
  _batchProgress(done, total) {
    return getString(
      "zoteroSiYuan-toast-batch-progress",
      "Sending %d/%d…",
    )
      .replace("%d", String(done))
      .replace("%d", String(total));
  },

  /**
   * What a batch has to say when it is done.
   *
   * @param {Number} sent
   * @param {Number} failed
   * @returns {String}
   */
  _batchSummary(sent, failed) {
    const parts = [
      getString("zoteroSiYuan-toast-batch-sent", "%d sent").replace(
        "%d",
        String(sent),
      ),
    ];
    if (failed) {
      parts.push(
        getString("zoteroSiYuan-toast-batch-failed", "%d failed").replace(
          "%d",
          String(failed),
        ),
      );
    }
    return parts.join(", ");
  },

  /**
   * Which annotations of a batch did not go in, and why.
   *
   * "3 failed" tells the user nothing they can act on. The first few are
   * named with their reason, so the usual causes — a locked workspace, a
   * picture that could not be found — are visible without a log.
   *
   * @param {Object[]} failed - { key, message }
   * @returns {String}
   */
  _batchFailureMessage(failed) {
    const lines = failed.slice(0, 3).map((entry) =>
      `${entry.key}: ${entry.message}`
    );
    if (failed.length > lines.length) {
      lines.push(
        getString("zoteroSiYuan-toast-batch-more", "…and %d more").replace(
          "%d",
          String(failed.length - lines.length),
        ),
      );
    }
    return lines.join("\n");
  },

  /**
   * Send several annotations at once.
   *
   * One after another on purpose: every append is a process of its own, and
   * two of them at a time would fight over the same daily note in SiYuan.
   * The batch is not silent, though — one bubble says how far it is, and
   * every annotation that goes in moves it on. What did not go in is named,
   * and can be tried again without redoing the rest.
   *
   * @param {String[]} ids - the annotation keys
   * @param {Object} reader - the reader tab
   * @param {Object} doc - the reader document
   */
  async _sendMany(ids, reader, doc) {
    return await this._trackInflight(
      this._runSendMany(ids, reader, doc),
    );
  },

  /** One batch, start to finish — see `_sendMany`. */
  async _runSendMany(ids, reader, doc) {
    const total = ids.length;
    // The document of the reader, so the markers can be added right away.
    const target = doc || this._readerDoc(reader);
    if (this._shutDown) {
      return;
    }
    if (this._sending) {
      // Another send is still running — say so instead of doing nothing.
      showToast({
        doc: target,
        title: getString("zoteroSiYuan-busy", "Sending…"),
        message: getString("zoteroSiYuan-busy-hint", "Wait for it to finish."),
      });
      return;
    }
    this._sending = true;
    // Everything below — including the progress bubble itself — runs inside
    // the try: a bubble that cannot be shown (the reader was closed, the
    // document is gone) must not leave the send lock held forever, which
    // would make every later send say "busy" until Zotero restarts.
    let progress = null;
    let sent = 0;
    const failedItems = [];
    let lastBlock = "";
    try {
      this._setReaderBusy(target, true);
      // The PDF and its parent item are the same for every annotation of the
      // batch — looking them up once instead of once per annotation saves two
      // library reads per note.
      this._batchMemo = {
        attachments: new Map(),
        parents: new Map(),
      };
      // No timeout: the bubble goes away when the batch says it is done.
      progress = showToast({
        doc: target,
        title: getString("zoteroSiYuan-busy", "Sending…"),
        message: this._batchProgress(0, total),
        timeout: 0,
      });
      // The annotation items are read in the background, a few at a time,
      // so the first note does not wait for the whole list and the loop
      // below does not read them one after another.
      const items = this._prefetchAnnotationItems(ids);
      for (const id of ids) {
        try {
          const item = await items.get(id);
          if (!item) {
            failedItems.push({
              key: id,
              message: getString(
                "zoteroSiYuan-toast-missing-annotation",
                "the annotation is no longer in the library",
              ),
            });
            continue;
          }
          const annotation = await this._annotationFromItem(item);
          const result = await this._sendAnnotation(annotation, reader);
          sent++;
          if (result.blockID) {
            lastBlock = result.blockID;
          }
        }
        catch (e) {
          failedItems.push({
            key: id,
            message: String((e && e.message) || e).split("\n")[0],
          });
          Zotero.logError(`ZoteroSiYuan: ${e}`);
        }
        finally {
          if (progress) {
            progress.update({
              message: this._batchProgress(sent + failedItems.length, total),
            });
          }
        }
      }
      // The markers show up right away, like they do for a single send.
      if (target) {
        this._updateRenderedMarkers(target);
      }
      const done = {
        title: getString("zoteroSiYuan-toast-batch-title", "Sent to SiYuan"),
        message: this._batchSummary(sent, failedItems.length),
        link: siyuanBlockLink(lastBlock),
        linkLabel: getString("zoteroSiYuan-toast-open", "Open in SiYuan"),
        onLink: lastBlock ? () => this._openInSiYuan(lastBlock) : null,
        timeout: 9000,
      };
      if (progress) {
        progress.update(done);
      }
      else {
        showToast({ doc: target, ...done });
      }
      // A failure that is only counted cannot be acted on. This bubble
      // stays, names the annotations, and offers the retry.
      if (failedItems.length) {
        try {
          showToast({
            doc: target,
            title: getString(
              "zoteroSiYuan-toast-batch-failed-title",
              "Not everything was sent",
            ),
            message: this._batchFailureMessage(failedItems),
            link: "",
            linkLabel: getString(
              "zoteroSiYuan-toast-batch-retry",
              "Retry the failed ones",
            ),
            onLink: () =>
              this._sendMany(
                failedItems.map((entry) => entry.key),
                reader,
                target,
              ),
            timeout: 0,
          });
        }
        catch (e) {
          Zotero.debug(`ZoteroSiYuan: could not report the failures: ${e}`);
        }
      }
    }
    finally {
      this._sending = false;
      this._batchMemo = null;
      this._setReaderBusy(target, false);
    }
  },

  /**
   * Watch the next send, without changing it.
   *
   * The self test uses this to see what a click really does. The hooks are
   * taken by the very next send and by that one only — a click that comes
   * after them is a real one again.
   *
   * @param {Object} hooks - { stage, notebook, append }
   */
  watchNextSend(hooks) {
    this._pendingSendHooks = hooks || null;
  },

  /**
   * Briefly show a message in the button's tooltip.
   *
   * The timer is kept, so a plugin that is disabled in the meantime does not
   * reach back into a button that no longer belongs to it — and the label it
   * restores comes from the cache, not from a lookup per message.
   */
  _flash(button, message, isError) {
    if (!button) {
      return;
    }
    button.title = message;
    button.style.opacity = "1";
    if (isError) {
      button.style.color = "var(--accent-red, #d33)";
    }
    const restore = () => {
      this._flashTimers.delete(timer);
      button.title = this._label("zoteroSiYuan-button-label", "Send to SiYuan");
      button.style.opacity = "";
      button.style.color = "";
    };
    const timer = setTimeout(restore, 4000);
    this._flashTimers.add(timer);
  }

};
