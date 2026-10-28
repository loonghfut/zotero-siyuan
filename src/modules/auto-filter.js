/**
 * Zotero → SiYuan — what an automatic send is allowed to take.
 *
 * Automatic sending is off by default, and when it is on it still has to
 * be quiet: only the annotations that match every filter the user set are
 * sent. An empty filter means "no restriction" for that dimension — a user
 * who only wants red highlights says so with one colour and nothing else.
 *
 * Everything here is plain data: the values come from a Zotero annotation
 * item or the reader's model, and the filter is a comma-separated
 * preference.
 */

/** The colours Zotero offers in the reader. */
export const AUTO_SEND_COLORS = [
  "#ffd400",
  "#ff6666",
  "#5fb236",
  "#2ea8e5",
  "#a28ae5",
  "#e56eee",
  "#f19837",
  "#aaaaaa",
];

/** The annotation kinds Zotero creates. */
export const AUTO_SEND_TYPES = [
  "highlight",
  "underline",
  "note",
  "text",
  "image",
];

/**
 * A comma-separated preference as a list.
 *
 * Values are lowercased because colours, item types and annotation types
 * are case-insensitive in practice; tags are compared lowercase too.
 *
 * @param {String} value
 * @returns {String[]}
 */
export function splitFilter(value) {
  const seen = new Set();
  const list = [];
  for (const part of String(value == null ? "" : value).split(/[,，;；\n]+/)) {
    const item = part.trim().toLowerCase();
    if (item && !seen.has(item)) {
      seen.add(item);
      list.push(item);
    }
  }
  return list;
}

/** The tag names of an annotation or item, as lowercase strings. */
export function filterTags(tags) {
  return (Array.isArray(tags) ? tags : [])
    .map((tag) =>
      typeof tag === "string" ? tag : (tag && (tag.tag || tag.name)) || ""
    )
    .map((tag) => String(tag).trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Does an annotation pass the filters?
 *
 * @param {Object} annotation - { color, tags, type }
 * @param {String} itemType - the parent item's Zotero type, if known
 * @param {Object} filters - { colors, tags, types, itemTypes } as lists
 * @returns {Boolean}
 */
export function matchesAutoFilters(annotation, itemType, filters = {}) {
  const values = {
    colors: splitFilter(filters.colors),
    tags: splitFilter(filters.tags),
    types: splitFilter(filters.types),
    itemTypes: splitFilter(filters.itemTypes),
  };
  const color = String((annotation && annotation.color) || "").toLowerCase();
  const type = String((annotation && annotation.type) || "").toLowerCase();
  const tags = filterTags(annotation && annotation.tags);
  const kind = String(itemType || "").toLowerCase();

  if (values.colors.length && !values.colors.includes(color)) {
    return false;
  }
  if (values.types.length && !values.types.includes(type)) {
    return false;
  }
  if (values.itemTypes.length && !values.itemTypes.includes(kind)) {
    return false;
  }
  if (
    values.tags.length &&
    !values.tags.some((wanted) => tags.includes(wanted))
  ) {
    return false;
  }
  return true;
}
