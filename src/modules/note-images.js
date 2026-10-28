/**
 * Zotero → SiYuan — the pictures a child note carries.
 *
 * Zotero keeps a note's pictures outside it: every `<img>` names an
 * attachment of its own (`data-attachment-key`), and an older note may keep
 * the picture in the HTML as a data URL. Neither is an address a Markdown
 * reader can open, so the bytes have to be put into the workspace first —
 * that part is in `app/item-pictures.js`. What is here is only the reading
 * of the note: which pictures it has, and how to point them elsewhere.
 *
 * Nothing here touches Zotero or a file system, so the checks can run it.
 */

import { parseAttributes } from "./note-html.js";

/** An `<img>` tag and its attributes, as one match. */
const IMG_TAG = /<img\b((?:"[^"]*"|'[^']*'|[^>"'])*?)\/?>/gi;

/** The `src` of an opening tag — quoted or not, but never `data-src`. */
const SRC_ATTR = /(^|\s)src\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)/i;

/**
 * The attachment a picture lives in, when the note only names it.
 *
 * @param {Object} attrs
 * @returns {String} the key, or ""
 */
function attachmentKey(attrs) {
  const own = String(attrs["data-attachment-key"] || "").trim();
  if (own) {
    return own;
  }
  const match = String(attrs.src || "").trim()
    .match(/^zotero:\/\/attachment\/([A-Za-z0-9]+)/i);
  return match ? match[1] : "";
}

/**
 * The picture an `<img>` refers to, when it is one that has to be moved.
 *
 * A picture with an ordinary address — `https://…` — is left alone: SiYuan
 * can load it itself. What has no such address is an attachment of the
 * library or a picture written into the HTML.
 *
 * @param {Object} attrs
 * @returns {Object|null} { id, key, dataURL }
 */
function imageRef(attrs) {
  const key = attachmentKey(attrs);
  if (key) {
    return { id: `key:${key}`, key, dataURL: "" };
  }
  const src = String(attrs.src || "").trim();
  if (/^data:image\//i.test(src)) {
    return { id: `data:${src}`, key: "", dataURL: src };
  }
  return null;
}

/**
 * The pictures of a note that have to be carried over.
 *
 * Each one is returned once — a note may show the same picture twice, and
 * it is the same bytes either way. The `id` does not change between two
 * reads of the note, so a sync that runs again replaces the address
 * instead of adding another copy.
 *
 * @param {String} html
 * @returns {Object[]} { id, key, dataURL }
 */
export function noteImageRefs(html) {
  const refs = [];
  const seen = new Set();
  for (const match of String(html || "").matchAll(IMG_TAG)) {
    const ref = imageRef(parseAttributes(match[1]));
    if (ref && !seen.has(ref.id)) {
      seen.add(ref.id);
      refs.push(ref);
    }
  }
  return refs;
}

/**
 * Point the pictures of a note at where they were put.
 *
 * The rest of the tag is left as it was — the alternative text and any
 * width the editor wrote down still describe the same picture.
 *
 * @param {String} html
 * @param {Map<String,String>} assets - the reference id → `assets/…`
 * @returns {String}
 */
export function rewriteNoteImages(html, assets) {
  const text = String(html || "");
  if (!assets || typeof assets.get !== "function" || !assets.size) {
    return text;
  }
  return text.replace(IMG_TAG, (tag, body) => {
    const ref = imageRef(parseAttributes(body));
    const asset = ref ? assets.get(ref.id) : "";
    if (!asset) {
      return tag;
    }
    if (SRC_ATTR.test(body)) {
      return tag.replace(SRC_ATTR, `$1src="${asset}"`);
    }
    const close = /\/>$/.test(tag) ? "/>" : ">";
    // Whatever the last attribute was, the new one needs a space of its own
    // unless the tag already ends in one.
    const space = /\s$/.test(body) ? "" : " ";
    return `<img${body}${space}src="${asset}"${close}`;
  });
}
