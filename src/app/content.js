/**
 * Zotero → SiYuan — building the note — the template, the picture, and its cleanup.
 */

import { getString } from "../utils/locale.js";
import {
	getPref,
	prefFlag,
} from "../utils/prefs.js";
import { collectMetadata } from "../modules/metadata.js";
import {
	annotationImageDataURL,
	annotationImagePath,
	cacheImagePath,
	exportPicture,
	findPicture,
	isPictureAnnotation,
	pictureMarkdown,
	pictureName,
	removePicture,
} from "../modules/siyuan-image.js";
import {
	appendPicture,
	renderTemplate,
	templateVariables,
} from "../modules/template.js";

export default {
  /**
   * Collect the values the template is rendered with.
   *
   * A batch needs the same values twice — once to decide where its notes go
   * (a document per item is named after the item) and once to render them.
   * Keeping the collection here means the second use costs nothing and the
   * two cannot disagree.
   *
   * @param {Object} annotation - the reader's annotation model
   * @param {Object} reader - the reader tab
   * @param {Object} [hooks] - what the self test watches this render with
   * @param {Object} [known]
   * @param {Object} [known.attachment] - the PDF, when the caller has it
   * @param {String} [known.annotationKey] - the annotation key, when known
   * @returns {Promise<Object>} the template variables
   */
  async _buildVars(annotation, reader, hooks = null, known = {}) {
    // The attachment is needed twice — as the PDF the picture belongs to and
    // as the way to the item that holds the metadata — so it is looked up
    // once and passed on.
    const attachment = Object.prototype.hasOwnProperty.call(known, "attachment")
      ? known.attachment
      : await this._getAttachment(reader);
    const parentItem = await this._getParentItem(reader, hooks, attachment);
    const annotationKey = known.annotationKey !== undefined
      ? known.annotationKey
      : await this._resolveAnnotationKey(annotation);
    // A "框选" annotation has no text — the selection is a picture, and
    // the picture is put into the workspace before the note is written.
    const image = await this._preparePicture(annotation, annotationKey);
    const annotationDate = await this._annotationDate(annotation);
    return collectMetadata({
      annotation,
      parentItem,
      attachment,
      annotationKey,
      image,
      annotationDate,
      extra: this._now(),
    });
  },

  /**
   * Render the template for an annotation.
   *
   * @param {Object} annotation
   * @param {Object} reader
   * @param {Object} [hooks] - what the self test watches this render with
   * @param {Object} [options]
   * @param {Object} [options.vars] - values from `_buildVars`, when the
   *   caller already has them
   * @param {String} [options.template] - the template to use
   * @returns {Promise<String>} the Markdown
   */
  async _buildContent(annotation, reader, hooks = null, options = {}) {
    const vars = options.vars || (await this._buildVars(annotation, reader, hooks));
    const { text, unknown } = renderTemplate(
      options.template || this.getTemplate(),
      vars,
    );
    if (unknown.length) {
      Zotero.debug(
        `ZoteroSiYuan: the template uses variables that do not exist: ${unknown.join(", ")}`,
      );
    }
    return appendPicture(text, vars.image || "");
  },

  /**
   * The picture of an area selection, ready to be put into the workspace.
   *
   * Zotero keeps the cropped picture in its cache; the reader also hands
   * it over as a data URL. The cache file is used when it is there — it
   * can be copied byte for byte — and the data URL is the fallback.
   *
   * A picture that cannot be found is not an error: the note is still
   * written, only without the picture. A missing picture must never cost
   * the user their comment.
   *
   * @param {Object} annotation - the reader's annotation model
   * @param {String} [annotationKey] - its key, when the caller already knows it
   * @returns {Promise<String>} the Markdown of the picture, or ""
   */
  async _preparePicture(annotation, annotationKey = "") {
    // Every send starts without a picture; only a "框选" annotation gets
    // one, and a stale one from an earlier send must not be mistaken for
    // this send's picture.
    this._pendingPicture = null;
    // Every step of the chain, written down. When a picture does not
    // arrive, this is where the answer is — a failure that says nothing
    // is the hardest kind to find.
    const trace = {
      isPicture: false,
      key: "",
      cachePath: "",
      cached: false,
      dataURL: false,
      workspace: "",
      exported: "",
      compressed: false,
      // Whether the compression was taken from the cache instead of being
      // done again — a second send of the same selection does not pay for
      // it twice.
      memoized: false,
      way: "",
      originalSize: 0,
      sentSize: 0,
      error: "",

    };
    this._lastPictureTrace = trace;

    if (!isPictureAnnotation(annotation)) {
      return "";
    }
    trace.isPicture = true;
    const alt = getString("zoteroSiYuan-image-alt", "框选");
    // Already resolved by `_buildContent` — looking it up again would be a
    // second item read for the same annotation.
    const key = annotationKey || (await this._resolveAnnotationKey(annotation));
    trace.key = key;
    if (!key) {
      trace.error = "the annotation has no key";
      Zotero.debug(
        "ZoteroSiYuan: the annotation has no key — the picture cannot be found",
      );
      return "";
    }

    // The cache file — the canonical copy.
    //
    // Only a string counts: an annotation model built elsewhere may carry a
    // promise (or anything else) in `imagePath`, and a truthy non-string
    // would skip the lookups below and then fail at `IOUtils.read` — the
    // picture would be lost without a word.
    let source = null;
    let path = typeof annotation.imagePath === "string"
      ? annotation.imagePath
      : "";
    if (path) {
      trace.cachePath = path;
      trace.cached = true;
    }
    if (!path) {
      // Most annotations live in "My Library", and their picture sits in a
      // folder that can be named without looking the item up at all.
      path = await findPicture(key, Zotero.Libraries.userLibraryID);
      trace.cachePath = path;
      trace.cached = !!path;
    }
    if (!path) {
      // A group library keeps its pictures in a folder of its own.
      const item = await this._getAnnotationItem({ id: key });
      if (item) {
        path = await annotationImagePath(item);
        trace.cachePath = path;
        trace.cached = !!path;
      }
    }
    if (path) {
      source = { path };
    }
    if (!source) {
      // The reader's own copy — the picture that came in with a sync.
      const dataURL = annotationImageDataURL(annotation);
      trace.dataURL = !!dataURL;
      if (dataURL) {
        source = { dataURL };
      }
    }
    if (!source) {
      trace.error = "no picture in the cache and none in the reader";
      Zotero.debug(
        "ZoteroSiYuan: the annotation has no picture to send — the cache file is missing",
      );
      return "";
    }

    const workspace = await this._resolveWorkspaceDir();
    trace.workspace = workspace;
    if (!workspace) {
      trace.error = "the SiYuan workspace is unknown";
      Zotero.debug(
        "ZoteroSiYuan: the SiYuan workspace is unknown — the picture cannot be placed",
      );
      return "";
    }

    try {
      // The picture of a selection is a screenshot of the page — several
      // times as big as it needs to be. It is compressed before it goes
      // into the workspace, and the original is kept when that does not
      // make it smaller.
      const compress = prefFlag("imageCompress", true);
      const quality = Number(getPref("imageQuality", "82")) / 100;
      const picture = await exportPicture(
        workspace,
        source,
        pictureName(key),
        { compress, quality },
      );
      const { asset, file } = picture;
      if (!asset) {
        trace.error = "the picture could not be placed";
        return "";
      }
      trace.exported = asset;
      trace.compressed = !!picture.compressed;
      trace.memoized = !!picture.memoized;
      trace.way = picture.way || "";
      trace.originalSize = picture.originalSize || 0;
      trace.sentSize = picture.size || 0;
      // Remember where the picture went: a send that never reaches SiYuan
      // has to take it back.
      this._pendingPicture = { asset, file };
      // A batch builds several notes before writing any of them — the one
      // pointer would only remember the last picture.
      if (Array.isArray(this._batchPictures)) {
        this._batchPictures.push(this._pendingPicture);
      }
      return pictureMarkdown(asset, alt);
    }
    catch (e) {
      // The note is still worth writing without the picture.
      trace.error = String(e && e.message ? e.message : e);
      Zotero.logError(`ZoteroSiYuan: could not place the picture: ${e}`);
      return "";
    }
  },

  /**
   * The annotation's last modified time.
   *
   * The reader hands the annotation over as JSON, and Zotero builds that
   * JSON without any date in it — so the item behind the annotation is the
   * only place the time exists. Asking for the item is a lookup, so it only
   * happens when the template actually shows the time.
   *
   * @param {Object} annotation - the reader's annotation model
   * @returns {Promise<String>} a Zotero timestamp, or ""
   */
  async _annotationDate(annotation) {
    if (annotation.dateModified) {
      return annotation.dateModified;
    }
    if (!this._templateUses("annotatorDate")) {
      return "";
    }
    const item = await this._getAnnotationItem(annotation);
    return (item && item.dateModified) || "";
  },

  /**
   * Does the template in use mention a variable?
   *
   * Parsing the template on every send would be waste, so the answer is
   * kept next to the template it belongs to — editing the template
   * invalidates the cache by itself.
   *
   * @param {String} name
   * @returns {Boolean}
   */
  _templateUses(name) {
    const template = this.getTemplate();
    if (!this._templateNames || this._templateNames.template !== template) {
      this._templateNames = {
        template,
        names: new Set(templateVariables(template)),
      };
    }
    return this._templateNames.names.has(name);
  },

  /**
   * What the plugin can see of the area selections in the library.
   *
   * The picture of a "框选" annotation lives in Zotero's cache. This walks
   * the library and reports what is really there — where the cache is,
   * which path the picture would have, and whether the file is on disk.
   * When a picture does not arrive, this is where the chain breaks.
   *
   * @returns {Promise<Object>} the report
   */
  async probePictures() {
    const report = {
      ok: false,
      cacheDir: "",
      workspace: "",
      annotations: [],
      error: "",

    };
    try {
      report.cacheDir = Zotero.DataDirectory.getSubdirectory("cache");
    }
    catch (e) {
      report.error = String(e && e.message ? e.message : e);
    }
    try {
      report.workspace = await this._resolveWorkspaceDir();
    }
    catch (e) {
      // The workspace is not needed to look at the cache.
    }
    try {
      const rows = await Zotero.DB.queryAsync(
        "SELECT itemID FROM itemAnnotations " +
          "WHERE itemID NOT IN (SELECT itemID FROM deletedItems) " +
          "ORDER BY itemID DESC LIMIT 200",
      );
      const ids = (rows || []).map((row) => row.itemID).filter(Boolean);
      // One call for the whole page: `Items.getAsync` takes a list, so the
      // data layer is asked once instead of two hundred times.
      const items = ids.length ? await Zotero.Items.getAsync(ids) : [];
      // And the disk is asked about all of the pictures at once — the files
      // do not depend on each other, so waiting for one before asking about
      // the next is time spent doing nothing.
      const checked = await Promise.all(
        (items || []).map(async (item) => {
          if (!item) {
            return null;
          }
          const type = String(item.annotationType || "").toLowerCase();
          if (type !== "image" && type !== "ink") {
            return null;
          }
          const path = cacheImagePath(item.libraryID, item.key);
          let exists = false;
          try {
            exists = path ? await IOUtils.exists(path) : false;
          }
          catch (e) {
            exists = false;
          }
          return {
            key: item.key,
            type,
            libraryID: item.libraryID,
            path,
            exists,
          };
        }),
      );
      report.annotations = checked.filter(Boolean);
      report.ok = true;
    }
    catch (e) {
      report.error = String(e && e.message ? e.message : e);
    }
    return report;
  },

  /**
   * Take back the picture of a send that never happened.
   *
   * A "框选" annotation brings its picture along, and the picture has to
   * be in the workspace before the note is written. When the write fails,
   * the picture would stay behind — and a workspace that fills up with
   * pictures no note refers to is litter.
   */
  async _dropPicture() {
    const picture = this._pendingPicture;
    this._pendingPicture = null;
    if (!picture) {
      return;
    }
    await removePicture(picture.file);
  },

  /**
   * Take back every picture a batch put into the workspace.
   *
   * A batch builds all of its notes before it writes them, so a failure
   * has several pictures to take back — not just the last one.
   */
  async _dropPictures() {
    const pictures = Array.isArray(this._batchPictures)
      ? this._batchPictures.slice()
      : [];
    this._batchPictures = null;
    const pending = this._pendingPicture;
    this._pendingPicture = null;
    if (pending) {
      pictures.push(pending);
    }
    const seen = new Set();
    for (const picture of pictures) {
      const file = picture && picture.file;
      if (file && !seen.has(file)) {
        seen.add(file);
        await removePicture(file);
      }
    }
  },

};
