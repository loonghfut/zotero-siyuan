/**
 * Zotero → SiYuan — the send pipeline: one annotation, or a batch of them.
 */

import { getString } from "../utils/locale.js";
import { getPref } from "../utils/prefs.js";
import {
  annotationAttributes,
  markBlock,
} from "../modules/block-attrs.js";
import { siyuanBlockLink } from "../modules/metadata.js";
import {
  pictureAssetNames,
  pictureFile,
  removePicture,
} from "../modules/siyuan-image.js";
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
   *
   * @param {Object} annotation
   * @param {Object} reader
   * @param {Object} button
   * @param {Object} [options] - { alreadySent, replaceEntry, doc }
   * @returns {Promise<void>}
   */
  async _send(annotation, reader, button, options = {}) {
    return await this._trackInflight(
      this._runSend(annotation, reader, button, options),
    );
  },

  /** One send, start to finish — see `_send`. */
  async _runSend(annotation, reader, button, options = {}) {
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
    const doc = (button && button.ownerDocument) || options.doc || null;
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

    // Already sent? Ask what the user wants — unless they already said so
    // in the settings, or this is the self test (which must never pop a
    // question at the user).
    if (!hooks && !options.alreadySent) {
      const check = await this._alreadySent(annotation);
      if (check.entry) {
        const action = this._sentAction();
        if (action === "skip") {
          this._notifySkipped(check.entry, doc);
          return;
        }
        if (action === "ask") {
          this._askAlreadySent(annotation, reader, button, check, doc);
          return;
        }
        if (action === "replace") {
          options = { ...options, replaceEntry: check.entry };
        }
      }
    }

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
      const result = await this._sendAnnotation(
        annotation,
        reader,
        hooks,
        { ...options, doc },
      );
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
        `ZoteroSiYuan: appended an annotation to SiYuan ` +
          (result.notebook
            ? `in notebook ${result.notebook.name} (${result.notebook.id})`
            : `in document ${result.documentID}`) +
          ` via ${result.transport}` +
          (result.blockID ? `, block ${result.blockID}` : ""),
      );
      // The marker shows up right away — no need to reopen the PDF.
      if (result.blockID && button) {
        this._updateRenderedMarkers(button.ownerDocument);
      }
      // A send that worked proves SiYuan is back: the automatic sends that
      // were waiting can go now instead of at the next timer.
      if (typeof this._retryPendingQueueSoon === "function") {
        this._retryPendingQueueSoon();
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

  /** How a click on an already-sent annotation behaves. */
  _sentAction() {
    const value = String(getPref("sentAction", "ask") || "").trim();
    if (value === "skip" || value === "send" || value === "replace") {
      return value;
    }
    return "ask";
  },

  /**
   * What the index knows about this annotation.
   *
   * @param {Object} annotation
   * @returns {Promise<{key: String, entry: Object|null}>}
   */
  async _alreadySent(annotation) {
    const key = await this._resolveAnnotationKey(annotation);
    const entry = key ? this._index.getEntry(key) : null;
    return { key, entry: entry || null };
  },

  /**
   * Ask what to do with an annotation that is already in SiYuan.
   *
   * The bubble stays until the user picks one of the three answers, or
   * closes it. Sending again and replacing are ordinary sends with a
   * remembered choice, so the button's busy state, the write and the
   * marker all stay in one place.
   *
   * @param {Object} annotation
   * @param {Object} reader
   * @param {Object} button
   * @param {{key: String, entry: Object}} check
   * @param {Object} doc
   */
  _askAlreadySent(annotation, reader, button, check, doc = null) {
    const entry = check.entry;
    try {
      showToast({
        doc,
        title: getString(
          "zoteroSiYuan-already-sent-title",
          "This annotation was already sent",
        ),
        message: getString(
          "zoteroSiYuan-already-sent-message",
          "It is already in SiYuan. Open the existing note, send another " +
            "one, or replace the last one?",
        ),
        // The question waits for an answer.
        timeout: 0,
        actions: [
          {
            label: getString(
              "zoteroSiYuan-already-sent-open",
              "Open existing",
            ),
            primary: true,
            onClick: () => this._openInSiYuan(entry.blockID),
          },
          {
            label: getString(
              "zoteroSiYuan-already-sent-send",
              "Send anyway",
            ),
            onClick: () =>
              this._send(annotation, reader, button, { alreadySent: "send" }),
          },
          {
            label: getString(
              "zoteroSiYuan-already-sent-replace",
              "Replace last",
            ),
            onClick: () =>
              this._send(annotation, reader, button, {
                alreadySent: "replace",
                replaceEntry: entry,
              }),
          },
        ],
      });
    }
    catch (e) {
      Zotero.debug(`ZoteroSiYuan: could not ask about the old note: ${e}`);
    }
  },

  /**
   * Say that an annotation was left out because it is already in SiYuan.
   *
   * @param {Object} entry
   * @param {Object} doc
   */
  _notifySkipped(entry, doc = null) {
    try {
      showToast({
        doc,
        title: getString(
          "zoteroSiYuan-already-sent-title",
          "This annotation was already sent",
        ),
        message: getString(
          "zoteroSiYuan-already-sent-skipped",
          "This annotation was already sent — skipped.",
        ),
        link: siyuanBlockLink(entry.blockID),
        linkLabel: getString("zoteroSiYuan-toast-open", "Open in SiYuan"),
        onLink: entry.blockID ? () => this._openInSiYuan(entry.blockID) : null,
      });
    }
    catch (e) {
      Zotero.debug(`ZoteroSiYuan: could not report the skipped send: ${e}`);
    }
  },

  /**
   * Render one annotation and send it to SiYuan.
   *
   * The single-annotation button and the batch action share the rendering,
   * so both behave exactly the same.
   *
   * @param {Object} annotation - the reader's annotation model
   * @param {Object} reader - the reader tab
   * @param {Object} [hooks] - what the self test watches this send with
   * @param {Object} [options]
   * @param {Object} [options.replaceEntry] - the note this send replaces
   * @param {Object} [options.doc] - the reader document
   * @returns {Promise<Object>} what happened
   */
  async _sendAnnotation(annotation, reader, hooks = null, options = {}) {
    // The notebook comes first: resolving it can fail (SiYuan not running,
    // no notebook configured), and a send that fails there should not have
    // put a picture into the workspace at all — the picture and the note
    // have to belong to the same workspace.
    if (hooks && hooks.stage) {
      hooks.stage("resolving the notebook");
    }
    // A fixed document is addressed by its own id; the notebook setting is
    // not used to find it, so it does not have to be valid either. The self
    // test watches the daily-note path, so it keeps the notebook too.
    const notebook = hooks
      ? await this._resolveNotebook()
      : this._destinationKind() === "document"
        ? null
        : await this._resolveNotebook();
    if (hooks && hooks.notebook && notebook) {
      hooks.notebook(notebook);
    }
    // "One document per item" can have a template of its own, so the shape
    // of the note is decided before the values are collected: the template
    // decides whether the annotation's date has to be looked up. The self
    // test watches the daily-note path and uses its template.
    const template = this.getTemplateFor(hooks ? "daily" : this._destinationKind());

    let vars;
    let markdown;
    let destination;
    try {
      if (hooks && hooks.stage) {
        hooks.stage("building the note");
      }
      vars = await this._buildVars(annotation, reader, hooks, { template });
      // Where the note goes is decided with the values the template will
      // use: a document per item is named after the item. Deciding it
      // before the markdown is written means a destination that cannot be
      // found fails before anything is appended.
      if (hooks && hooks.stage) {
        hooks.stage("resolving the destination");
      }
      // The self test watches the daily-note path — the same one its hooks
      // know how to dry-run and clean up. The user's destination must not
      // turn the test into a document create it cannot take back.
      destination = hooks
        ? { kind: "daily", notebook, documentID: "", title: "" }
        : await this._resolveDestination({ notebook, vars });
      markdown = await this._buildContent(annotation, reader, hooks, {
        vars,
        template,
      });
      // The whole note is one super block, and its attributes are written on
      // that container in the same `block append`: the index, the reader
      // link and "replace" then all work with one block id.
      markdown = markBlock(markdown, annotationAttributes(vars));
    }
    catch (e) {
      // The picture goes into the workspace while the content is built, so
      // a failure here has to take it back too.
      await this._dropPicture();
      throw e;
    }

    let sent;
    try {
      sent = (await this._append(notebook ? notebook.id : "", markdown, hooks, {
        target: destination,
      })) || {};
    }
    catch (e) {
      // The write started but its answer never arrived — it may well be in
      // the document, and that note refers to this picture. Deleting it
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
    const documentID = (typeof sent === "object" && sent.documentID) ||
      destination.documentID || "";
    // Remember it right away — no need to wait for the next scan.
    const annotationKey = vars.annotationId || "";
    if (annotationKey && blockID) {
      this._index.add(annotationKey, blockID, {
        documentID,
        blocks: Array.isArray(sent.blocks) && sent.blocks.length
          ? sent.blocks
          : [blockID],
        markdown,
      });
    }

    // Replacing writes the new note first, so a failed write leaves the old
    // one in place. Only after the new one is safely in SiYuan is the old
    // block taken back.
    let replaced = true;
    if (options.replaceEntry && annotationKey) {
      replaced = await this._replacePrevious(
        options.replaceEntry,
        annotationKey,
        options.doc || null,
      );
      // `_replacePrevious` forgets the old entry; the index has to point at
      // the new block either way — when the deletion failed, that is what
      // keeps the marker from leading to the note the user just replaced.
      if (blockID) {
        this._index.add(annotationKey, blockID, {
          documentID,
          blocks: Array.isArray(sent.blocks) && sent.blocks.length
            ? sent.blocks
            : [blockID],
          markdown,
        });
      }
    }

    return {
      transport,
      blockID,
      notebook,
      markdown,
      documentID,
      destination,
      replaced,
    };
  },

  /**
   * Take the note of a previous send back.
   *
   * The index remembers the blocks and the Markdown of the send that wrote
   * it, so the blocks and their pictures can be removed. After a restart
   * only the anchor block is known; its siblings are recovered from the
   * creation second by `_sentBlockRows`.
   *
   * @param {Object} entry - what the index knew about the old note
   * @param {String} annotationKey
   * @param {Object} [doc] - the reader document, so its marker goes too
   * @returns {Promise<Boolean>} whether the old blocks were deleted
   */
  async _replacePrevious(entry, annotationKey, doc = null) {
    if (!entry || !entry.blockID) {
      return true;
    }
    const rows = await this._sentBlockRows(entry);
    const markdown = [entry.markdown || ""]
      .concat(rows.map((row) => row.markdown || ""))
      .join("\n");
    const deleted = await this._deleteBlocks(rows.map((row) => row.id));

    // The pictures this note brought along, and only those: a picture the
    // user added by hand does not carry the plugin's name.
    const workspace = await this._resolveWorkspaceDir().catch(() => "");
    if (workspace) {
      for (const name of pictureAssetNames(markdown)) {
        if (name.startsWith("zotero-siyuan-")) {
          await removePicture(pictureFile(workspace, `assets/${name}`));
        }
      }
    }

    this._index.remove(annotationKey);
    // The marker points at a block that is gone. Removing it now is what
    // makes the marker of the new note appear in its place.
    this._removeSentMarker(doc, annotationKey);
    this._indexedAttachments.clear();
    if (!deleted) {
      Zotero.logError(
        "ZoteroSiYuan: the old note could not be deleted — both notes are " +
          "in SiYuan now.",
      );
    }
    return deleted;
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
          : `${
            (result.destination && result.destination.title) ||
            result.documentID ||
            "SiYuan"
          } · ${result.transport}`,
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
