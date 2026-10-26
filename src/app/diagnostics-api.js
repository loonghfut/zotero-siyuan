/**
 * Zotero → SiYuan — the self test and the diagnostics report.
 */

import { getPref } from "../utils/prefs.js";
import { SAMPLE_CACHE_MS } from "./constants.js";
import { runDiagnostics } from "../modules/diagnostics.js";
import { runSelfTest } from "../modules/selftest/index.js";
import { SiYuanHTTP } from "../modules/siyuan-http.js";

export default {
  /**
   * Run the end-to-end self test on demand.
   *
   * It drives the same code path a click takes — the reader event, the
   * button, the handler — so a passing report means the plugin really works
   * in this Zotero, not just in a script that mimics it.
   *
   * @param {Object} options
   * @param {Boolean} options.realWrite - really append to the daily note
   */
  async selfTest({ realWrite = false, ui = true } = {}) {
    return await runSelfTest({
      addon: this,
      notebookPref: getPref("notebook", ""),
      realWrite,
      // The preferences pane is a place where touching the reader is
      // expected; a test that runs on startup is not. The caller decides.
      ui,
    });
  },

  /**
   * Write a diagnostics report and answer with its path.
   *
   * The report says what the plugin found — the CLI, the workspace, the
   * kernel — so a failure can be looked at without a GUI round-trip.
   */
  async diagnose() {
    const report = await this.getCLI().diagnose();
    report.http = { ok: false, error: "" };
    if (report.ok) {
      return report;
    }
    // The HTTP API is the fallback transport — check it too.
    try {
      const http = await SiYuanHTTP.discover(getPref("workspace", ""));
      const notebooks = await http.listNotebooks();
      report.http = {
        ok: true,
        host: http.host,
        port: http.port,
        workspace: http.workspaceDir,
        notebooks: notebooks.map((n) => n.name),

      };
      // The plugin works as long as *one* transport does. Reporting a
      // failure while the HTTP API answers sent users after a CLI that is
      // only one of two ways in.
      report.cliError = report.error || "";
      report.error = "";
      report.ok = true;
      report.transport = "http";
      if (!report.workspace) {
        report.workspace = http.workspaceDir;
      }
      if (!report.notebooks || !report.notebooks.length) {
        report.notebooks = notebooks;
      }
    }
    catch (e) {
      report.http = { ok: false, error: e.message };
      // Neither transport works — now a written report is worth having.
      try {
        await runDiagnostics({ executable: getPref("cliPath", "") });
      }
      catch (e2) {
        // ignore
      }
    }
    return report;
  },

  /**
   * A real annotation to preview the template with.
   *
   * A real one is worth much more than a made-up one: the user sees their
   * own paper, their own wording, and the real metadata. Picking it costs a
   * query and several item reads, so the answer is kept for a moment: the
   * preview runs on every keystroke, and none of it changes while the user
   * is editing a template.
   *
   * @returns {Promise<Object>}
   */
  async _sample() {
    if (
      this._sampleCache &&
      Date.now() - this._sampleCache.at < SAMPLE_CACHE_MS
    ) {
      return this._sampleCache.sample;
    }
    const sample = await this._loadSample();
    this._sampleCache = { at: Date.now(), sample };
    return sample;
  },

  /**
   * Look for the annotation the preview is rendered with.
   * @returns {Promise<Object>}
   */
  async _loadSample() {
    try {
      const rows = await Zotero.DB.queryAsync(
        "SELECT itemID FROM itemAnnotations " +
          "WHERE itemID NOT IN (SELECT itemID FROM deletedItems) " +
          "ORDER BY itemID DESC LIMIT 25",
      );
      for (const row of rows || []) {
        const annotation = await Zotero.Items.getAsync(row.itemID);
        if (!annotation || !annotation.parentItemID) {
          continue;
        }
        const attachment = await Zotero.Items.getAsync(annotation.parentItemID);
        if (!attachment) {
          continue;
        }
        const parentItem = attachment.parentItemID
          ? await Zotero.Items.getAsync(attachment.parentItemID)
          : null;
        let position = null;
        try {
          position = annotation.annotationPosition
            ? JSON.parse(annotation.annotationPosition)
            : null;
        }
        catch (e) {
          position = null;
        }
        return {
          annotation: {
            id: annotation.key,
            type: annotation.annotationType || "highlight",
            text: annotation.annotationText || "",
            comment: annotation.annotationComment || "",
            pageLabel: annotation.annotationPageLabel || "",
            authorName: annotation.annotationAuthorName || "",
            position,
          },
          parentItem,
          attachment,
          annotationKey: annotation.key,

        };
      }
    }
    catch (e) {
      Zotero.debug(`ZoteroSiYuan: could not find an annotation to preview: ${e}`);
    }

    // Nothing in the library yet — show a made-up one.
    return {
      annotation: {
        id: "SAMPLE",
        type: "highlight",
        text: "This is what the highlighted text looks like.",
        comment: "This is what your comment looks like.",
        pageLabel: "12",
        authorName: "steve",
        position: { pageIndex: 11 },
      },
      parentItem: null,
      attachment: null,
      annotationKey: "",

    };
  }

};
