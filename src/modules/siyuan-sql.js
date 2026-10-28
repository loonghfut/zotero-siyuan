/**
 * Zotero → SiYuan — the small values the CLI and its documents share.
 *
 * A block id, a SiYuan timestamp, and the quoting a SQL statement needs —
 * used by both the command client and the document operations, so they live
 * in one place instead of one importing the other.
 */

/**
 * A SiYuan timestamp: `YYYYMMDDHHMMSS`, in local time.
 * @param {Date} [date]
 * @returns {String}
 */
export function siyuanTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** Whether a value looks like a SiYuan block or document id. */
export function isBlockID(value) {
  return /^\d{14}-[0-9a-z]{7}$/i.test(String(value == null ? "" : value).trim());
}

/** A value that can be put between single quotes in a SQL statement. */
export function sqlString(value) {
  return String(value == null ? "" : value).replace(/'/g, "''");
}

/** A document or block id, or an error. */
export function sqlID(value) {
  const text = String(value == null ? "" : value).trim();
  if (!/^[0-9A-Za-z-]+$/.test(text)) {
    throw new Error(`"${text}" is not a block id`);
  }
  return text;
}

/** The document id in what `siyuan document create` answered. */
export function documentIDOf(output) {
  const text = String(output == null ? "" : output).trim();
  if (!text) {
    return "";
  }
  if (text.startsWith("{")) {
    try {
      const data = JSON.parse(text);
      for (const value of [data.id, data.ID, data.documentID]) {
        if (isBlockID(value)) {
          return String(value).trim();
        }
      }
    }
    catch (e) {
      // The answer is not JSON — the bare id below is the normal shape.
    }
  }
  const match = text.match(/\d{14}-[0-9a-z]{7}/i);
  return match ? match[0] : "";
}
