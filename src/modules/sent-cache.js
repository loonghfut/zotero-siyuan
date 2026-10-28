/**
 * Zotero → SiYuan — the local copy of the "already sent" mapping.
 *
 * SiYuan is the source of truth: the block ids are recovered from the
 * workspace itself, and that is the only place the mapping really exists.
 * But when SiYuan is not running, a reader would show no marker at all and
 * every annotation would look unsent — so the last answer is kept in a
 * Zotero preference as a cache. It is used only until the workspace can be
 * read again; a scan replaces it.
 *
 * The cache belongs to one workspace. Pointing the plugin at another one
 * must not bring the markers of the old one along, so the preference also
 * remembers which workspace it describes.
 */

import { isBlockID } from "./siyuan-sql.js";

export const SENT_CACHE_PREF = "sentCache";

/**
 * How many annotations the cache holds.
 *
 * The preference is read and written as a JSON string, so it has to stay
 * small enough that reading it at startup is not a cost of its own.
 */
export const MAX_SENT_CACHE = 2000;

/** A name for the workspace the cache belongs to. */
export function sentCacheKey(cliPath, workspace) {
  return `${String(cliPath || "").trim()}|${String(workspace || "").trim()}`;
}

/**
 * Read the cache.
 *
 * A preference can be edited by hand, so anything that is not the shape
 * below reads as an empty cache. An entry without a usable key or block id
 * is left out — it could only produce a marker that leads nowhere.
 *
 * @param {String} raw
 * @returns {{key: String, entries: Array<{annotationKey: String,
 *   blockID: String, documentID: String, at: Number}>}}
 */
export function parseSentCache(raw) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw == null ? "" : raw));
  }
  catch (e) {
    return { key: "", entries: [] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { key: "", entries: [] };
  }
  const key = typeof parsed.key === "string" ? parsed.key : "";
  const list = Array.isArray(parsed.entries) ? parsed.entries : [];
  const seen = new Set();
  const entries = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const annotationKey = String(entry.annotationKey || "").trim();
    const blockID = String(entry.blockID || "").trim();
    if (!/^[A-Za-z0-9]+$/.test(annotationKey) || !isBlockID(blockID)) {
      continue;
    }
    if (seen.has(annotationKey)) {
      continue;
    }
    seen.add(annotationKey);
    entries.push({
      annotationKey,
      blockID,
      documentID: isBlockID(entry.documentID)
        ? String(entry.documentID).trim()
        : "",
      at: Number(entry.at) || 0,
    });
    if (entries.length >= MAX_SENT_CACHE) {
      break;
    }
  }
  return { key, entries };
}

/**
 * Write the cache, newest first, and keep it within its limit.
 *
 * @param {String} key - the workspace this cache describes
 * @param {Array} entries
 * @returns {String}
 */
export function serializeSentCache(key, entries) {
  const list = (Array.isArray(entries) ? entries : [])
    .filter((entry) =>
      entry &&
      /^[A-Za-z0-9]+$/.test(String(entry.annotationKey || "")) &&
      isBlockID(entry.blockID)
    )
    .slice()
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
    .slice(0, MAX_SENT_CACHE)
    .map((entry) => ({
      annotationKey: String(entry.annotationKey),
      blockID: String(entry.blockID),
      documentID: isBlockID(entry.documentID) ? String(entry.documentID) : "",
      at: Number(entry.at) || 0,
    }));
  return JSON.stringify({ key: String(key || ""), entries: list });
}

/**
 * The entries of an index, ready for the cache.
 *
 * @param {Map} blocks - annotation key → block id
 * @param {Map} details - annotation key → { documentID }
 * @param {Number} [now]
 * @returns {Array}
 */
export function sentCacheEntries(blocks, details, now = Date.now()) {
  const entries = [];
  for (const [annotationKey, blockID] of blocks || []) {
    const detail = (details && details.get(annotationKey)) || {};
    entries.push({
      annotationKey,
      blockID,
      documentID: detail.documentID || "",
      at: now,
    });
  }
  return entries;
}
