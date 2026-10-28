/**
 * Zotero → SiYuan — the queue of annotations whose automatic send failed.
 *
 * An automatic send runs without a user watching it, so a SiYuan that is
 * not running must not lose the annotation. The queue keeps its key in a
 * Zotero preference and is retried when a later send proves the connection
 * is back, or on the next start.
 *
 * The queue holds keys, not content: the annotation is still in the
 * library, and rendering it again is what a retry should do — a stale copy
 * of the note would be worse than a slightly later one.
 */

export const PENDING_QUEUE_PREF = "pendingQueue";

/**
 * How many entries the queue holds.
 *
 * A queue nobody ever drains must not grow without a bound; beyond this
 * the oldest entries are dropped and the user is told.
 */
export const MAX_PENDING = 200;

/**
 * Read the queue.
 *
 * @param {String} raw
 * @returns {Array<{key: String, attempts: Number, at: Number}>}
 */
export function parsePendingQueue(raw) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw == null ? "" : raw));
  }
  catch (e) {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const seen = new Set();
  const list = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const key = String(entry.key || "").trim();
    if (!/^[A-Za-z0-9]+$/.test(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    list.push({
      key,
      attempts: Math.max(0, Number(entry.attempts) || 0),
      at: Number(entry.at) || 0,
    });
  }
  return list;
}

/**
 * Write the queue, newest first.
 *
 * @param {Array} list
 * @returns {String}
 */
export function serializePendingQueue(list) {
  const entries = (Array.isArray(list) ? list : [])
    .filter((entry) => entry && /^[A-Za-z0-9]+$/.test(String(entry.key || "")))
    .slice()
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
    .slice(0, MAX_PENDING)
    .map((entry) => ({
      key: String(entry.key),
      attempts: Math.max(0, Number(entry.attempts) || 0),
      at: Number(entry.at) || 0,
    }));
  return JSON.stringify(entries);
}

/**
 * Add an annotation to the queue.
 *
 * @param {Array} list
 * @param {String} key
 * @param {Number} [now]
 * @returns {{list: Array, added: Boolean}}
 */
export function addPending(list, key, now = Date.now()) {
  const wanted = String(key || "").trim();
  if (!/^[A-Za-z0-9]+$/.test(wanted)) {
    return { list: Array.isArray(list) ? list.slice() : [], added: false };
  }
  const current = Array.isArray(list) ? list.slice() : [];
  const at = current.findIndex((entry) => entry && entry.key === wanted);
  if (at !== -1) {
    current[at] = { ...current[at], key: wanted };
    return { list: current, added: false };
  }
  return {
    list: [{ key: wanted, attempts: 0, at: now }].concat(current)
      .slice(0, MAX_PENDING),
    added: true,
  };
}

/**
 * Take an annotation out of the queue.
 *
 * @param {Array} list
 * @param {String} key
 * @returns {Array}
 */
export function removePending(list, key) {
  const wanted = String(key || "");
  return (Array.isArray(list) ? list : []).filter(
    (entry) => !entry || entry.key !== wanted,
  );
}

/**
 * Count one failed attempt.
 *
 * @param {Array} list
 * @param {String} key
 * @returns {Array}
 */
export function failPending(list, key) {
  const wanted = String(key || "");
  return (Array.isArray(list) ? list : []).map((entry) =>
    entry && entry.key === wanted
      ? { ...entry, attempts: (Number(entry.attempts) || 0) + 1 }
      : entry
  );
}
