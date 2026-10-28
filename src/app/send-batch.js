/**
 * Zotero → SiYuan — a batch of annotations in one write.
 *
 * A batch used to append every annotation with a process of its own: ten
 * notes cost ten `block append` calls, and each one waited for the one
 * before it. Here the notes are rendered first and then written **once**,
 * which is one process for the whole batch.
 *
 * One append produces many blocks, so the write has to say which block
 * belongs to which annotation. Every note ends with an invisible link that
 * carries `zsi=batch`; the blocks of the write are ordered by the document's
 * own `sort` column, so the link closes its note and the next block starts
 * the next one.
 */

import { getString } from "../utils/locale.js";
import {
  ANNOTATION_KEY_ATTR,
  annotationAttributes,
  attributeValue,
  insertAttributes,
} from "../modules/block-attrs.js";
import { siyuanBlockLink } from "../modules/metadata.js";
import { parseAnnotationKey } from "../modules/siyuan-index.js";
import { showToast } from "../modules/toast.js";
import { isWriteUnknown } from "../modules/siyuan-process.js";

export default {
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
   * @param {Number} [skipped]
   * @returns {String}
   */
  _batchSummary(sent, failed, skipped = 0) {
    const parts = [
      getString("zoteroSiYuan-toast-batch-sent", "%d sent").replace(
        "%d",
        String(sent),
      ),
    ];
    if (skipped) {
      parts.push(
        getString(
          "zoteroSiYuan-toast-batch-skipped",
          "%d skipped (already sent)",
        ).replace("%d", String(skipped)),
      );
    }
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
   * Say how a batch ended — one bubble for the count, one that stays when
   * something has to be retried.
   *
   * @param {Object} options
   */
  _batchDone({
    target = null,
    progress = null,
    reader = null,
    sent = 0,
    skipped = 0,
    failedItems = [],
    allKeys = [],
    lastBlock = "",
  } = {}) {
    const done = {
      title: getString("zoteroSiYuan-toast-batch-title", "Sent to SiYuan"),
      message: this._batchSummary(sent, failedItems.length, skipped),
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
    if (!failedItems.length) {
      return;
    }
    try {
      showToast({
        doc: target,
        title: getString(
          "zoteroSiYuan-toast-batch-failed-title",
          "Not everything was sent",
        ),
        message: this._batchFailureMessage(failedItems),
        timeout: 0,
        actions: [
          {
            label: getString(
              "zoteroSiYuan-toast-batch-retry",
              "Retry the failed ones",
            ),
            primary: true,
            onClick: () =>
              this._sendMany(
                failedItems.map((entry) => entry.key),
                reader,
                target,
              ),
          },
          {
            label: getString(
              "zoteroSiYuan-toast-batch-retry-all",
              "Retry all",
            ),
            onClick: () => this._sendMany(allKeys, reader, target),
          },
        ],
      });
    }
    catch (e) {
      Zotero.debug(`ZoteroSiYuan: could not report the failures: ${e}`);
    }
  },

  /**
   * Send several annotations at once.
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
    let skipped = 0;
    let lastBlock = "";
    let notebook = null;
    const built = [];
    const failedItems = [];
    const jobs = [];
    try {
      this._setReaderBusy(target, true);
      // No timeout: the bubble goes away when the batch says it is done.
      progress = showToast({
        doc: target,
        title: getString("zoteroSiYuan-busy", "Sending…"),
        message: this._batchProgress(0, total),
        timeout: 0,
      });
      // The PDF and its parent item are the same for every annotation of the
      // batch — looking them up once instead of once per annotation saves two
      // library reads per note.
      this._batchMemo = {
        attachments: new Map(),
        parents: new Map(),
      };
      // Every picture this batch puts into the workspace. A write that never
      // happens has to take all of them back, not just the last one.
      this._batchPictures = [];

      const items = this._prefetchAnnotationItems(ids);
      const action = this._sentAction();
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
          const key = await this._resolveAnnotationKey(annotation);
          const entry = key ? this._index.getEntry(key) : null;
          // A batch is not the place for a question per annotation: with
          // "ask" (the default) the ones already in SiYuan are left out and
          // counted, and the summary says so.
          if (entry && action !== "send" && action !== "replace") {
            skipped++;
            continue;
          }
          jobs.push({
            key,
            annotation,
            entry: action === "replace" ? entry : null,
          });
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
              message: this._batchProgress(
                jobs.length + skipped + failedItems.length,
                total,
              ),
            });
          }
        }
      }
      if (!jobs.length) {
        this._batchDone({
          target, progress, reader, sent, skipped, failedItems, allKeys: ids,
          lastBlock,
        });
        return;
      }

      // One connection, one place to put the notes.
      notebook = this._destinationKind() === "document"
        ? null
        : await this._resolveNotebook();
      // Every note of a batch goes to the same kind of place, so they are
      // rendered with the same template.
      const template = this.getTemplateFor(this._destinationKind());
      let firstVars = null;
      for (const job of jobs) {
        try {
          const vars = await this._buildVars(job.annotation, reader, null, {
            template,
          });
          if (!firstVars) {
            firstVars = vars;
          }
          const markdown = await this._buildContent(
            job.annotation,
            reader,
            null,
            { vars, template },
          );
          built.push({
            ...job,
            vars,
            markdown: this._withBatchAnchor(
              insertAttributes(markdown, annotationAttributes(vars)),
              vars,
            ),
          });
        }
        catch (e) {
          // The picture of this one note is the only thing to take back —
          // the rest of the batch is still worth writing.
          await this._dropPicture();
          failedItems.push({
            key: job.key,
            message: String((e && e.message) || e).split("\n")[0],
          });
          Zotero.logError(`ZoteroSiYuan: ${e}`);
        }
      }
      if (!built.length) {
        this._batchDone({
          target, progress, reader, sent, skipped, failedItems, allKeys: ids,
          lastBlock,
        });
        return;
      }

      const destination = await this._resolveDestination({
        notebook,
        vars: firstVars || {},
      });
      // One write for the whole batch.
      const joined = built.map((job) => job.markdown).join("\n\n");
      let written;
      try {
        written = await this._append(notebook ? notebook.id : "", joined, null, {
          target: destination,
          collectBlocks: true,
        });
      }
      catch (e) {
        const message = String((e && e.message) || e).split("\n")[0];
        for (const job of built) {
          failedItems.push({ key: job.key, message });
        }
        if (isWriteUnknown(e)) {
          // The note may already be there and refer to the pictures; taking
          // them back would leave broken images behind.
          this._batchPictures = null;
        }
        else {
          await this._dropPictures();
        }
        Zotero.logError(`ZoteroSiYuan: the batch write failed: ${e}`);
        this._batchDone({
          target, progress, reader, sent, skipped, failedItems, allKeys: ids,
          lastBlock,
        });
        return;
      }
      this._batchPictures = null;
      this._pendingPicture = null;

      const documentID = written.documentID || destination.documentID || "";
      const { groups, mapped } = this._groupBatchRows(
        written.blockRows || [],
        built,
      );
      for (let i = 0; i < built.length; i++) {
        const job = built[i];
        let blockIDs = mapped ? groups[i] : [];
        if (!blockIDs.length && i === 0 && written.blockID) {
          // Without the anchors only the first block of the write is
          // certainly this annotation's. Saying so is better than marking
          // the wrong note as sent.
          blockIDs = [written.blockID];
        }
        if (!blockIDs.length) {
          continue;
        }
        this._index.add(job.key, blockIDs[0], {
          documentID,
          blocks: blockIDs,
          markdown: job.markdown,
        });
        lastBlock = blockIDs[blockIDs.length - 1] || blockIDs[0];
        if (job.entry) {
          await this._replacePrevious(job.entry, job.key, target);
          this._index.add(job.key, blockIDs[0], {
            documentID,
            blocks: blockIDs,
            markdown: job.markdown,
          });
        }
      }
      sent = built.length;
      // The markers show up right away, like they do for a single send.
      if (target) {
        this._updateRenderedMarkers(target);
      }
      this._batchDone({
        target, progress, reader, sent, skipped, failedItems, allKeys: ids,
        lastBlock,
      });
    }
    catch (e) {
      // The notebook or the destination could not be resolved: nothing was
      // written, so every note that was built has to be reported.
      const message = String((e && e.message) || e).split("\n")[0];
      if (built.length) {
        await this._dropPictures();
      }
      // A destination that cannot be resolved fails before anything is
      // built — the annotations themselves are fine, and saying so is what
      // makes the "retry" button meaningful.
      const reported = new Set(failedItems.map((entry) => entry.key));
      for (const job of jobs) {
        if (!reported.has(job.key)) {
          reported.add(job.key);
          failedItems.push({ key: job.key, message });
        }
      }
      Zotero.logError(`ZoteroSiYuan: the batch could not be sent: ${e}`);
      this._batchDone({
        target, progress, reader, sent, skipped, failedItems, allKeys: ids,
        lastBlock,
      });
    }
    finally {
      this._sending = false;
      this._batchMemo = null;
      this._batchPictures = null;
      this._setReaderBusy(target, false);
    }
  },

  /**
   * Mark the end of one note in a batch.
   *
   * The link is invisible (its text is a zero-width space), so it does not
   * change what the note looks like — but it is in the block's Markdown, so
   * the written blocks can be grouped by the note they close.
   *
   * @param {String} markdown
   * @param {Object} vars - the template variables
   * @returns {String}
   */
  _withBatchAnchor(markdown, vars) {
    const text = String(markdown || "").replace(/\s+$/, "");
    const link = String((vars && vars.zoteroAnnotationLink) || "").trim();
    if (!link) {
      // Without a link there is nothing to recognise the note by. The
      // content still goes in; only the exact block mapping is lost.
      return text;
    }
    const anchor = `[​](${link}${link.includes("?") ? "&" : "?"}zsi=batch)`;
    const lines = text.split("\n");
    let last = lines.length - 1;
    while (last >= 0 && !lines[last].trim()) {
      last--;
    }
    if (last < 0) {
      return anchor;
    }
    if (/^\s*\{:/.test(lines[last])) {
      // The last line is the block IAL. Appending the link to it would put
      // the link inside the attribute line, and SiYuan would drop the IAL —
      // so the anchor gets a block of its own after the note.
      lines.splice(last + 1, 0, "", anchor);
      return lines.join("\n");
    }
    lines[last] = `${lines[last]} ${anchor}`;
    return lines.join("\n");
  },

  /**
   * Group the blocks of one write by the annotation they belong to.
   *
   * The rows come back in document order (`sort`), which is the order the
   * notes were written in. Every note's **first** block carries the
   * annotation key as an attribute, so that is the primary map — it works
   * even when the template never wrote a Zotero link. The `zsi=batch` anchor
   * is the fallback for a write made before the attributes existed.
   *
   * @param {Object[]} blockRows - rows with id, markdown and ial
   * @param {Object[]} jobs - the notes, in write order
   * @returns {{groups: String[][], mapped: Boolean}}
   */
  _groupBatchRows(blockRows, jobs) {
    const rows = Array.isArray(blockRows) ? blockRows : [];
    const groups = jobs.map(() => []);
    const byKey = new Map();
    jobs.forEach((job, index) => {
      if (job && job.key) {
        byKey.set(job.key, index);
      }
    });
    // The first block of a note says which note it starts. This does not
    // need the invisible anchor at all — which matters when the template
    // never wrote a link and `_withBatchAnchor` had nothing to attach to.
    if (rows.some((row) => attributeValue(row.ial, ANNOTATION_KEY_ATTR))) {
      const byAttribute = jobs.map(() => []);
      let current = -1;
      for (const row of rows) {
        const key = attributeValue(row.ial, ANNOTATION_KEY_ATTR) ||
          parseAnnotationKey(row.markdown);
        if (key && byKey.has(key)) {
          current = byKey.get(key);
        }
        if (current >= 0 && byAttribute[current]) {
          byAttribute[current].push(row.id);
        }
      }
      if (byAttribute.every((group) => group.length > 0)) {
        return { groups: byAttribute, mapped: true };
      }
    }
    const anchors = new Set();
    for (const row of rows) {
      if (row && String(row.markdown || "").includes("zsi=batch")) {
        anchors.add(row.id);
      }
    }
    if (!anchors.size) {
      return { groups, mapped: false };
    }
    // The first note starts at the first block; every anchor closes the note
    // it is in, and the block after it starts the next one.
    let current = 0;
    for (const row of rows) {
      if (anchors.has(row.id)) {
        const key = parseAnnotationKey(row.markdown);
        if (key && byKey.has(key)) {
          current = byKey.get(key);
        }
        if (groups[current]) {
          groups[current].push(row.id);
        }
        current = Math.min(current + 1, jobs.length - 1);
      }
      else if (groups[current]) {
        groups[current].push(row.id);
      }
    }
    return {
      groups,
      mapped: groups.every((group) => group.length > 0),
    };
  },
};