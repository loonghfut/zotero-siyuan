/**
 * Zotero → SiYuan — the templates the user saved.
 *
 * The pane edits two templates — the common one and the one used when a
 * note becomes a document of its own ("one document per item"). Each is
 * kept in a preference of its own. This is the shelf beside them: the
 * shapes the user worked out once and wants to come back to — one for a
 * quick excerpt, one for a reading note, one with the abstract in it.
 *
 * Zotero preferences are strings, so the shelf is a JSON array in one of
 * them. Everything here is a plain function on plain data: the shelf is
 * read, changed and written back without touching Zotero, which is what
 * makes it testable outside the client.
 *
 * A preference is also something a user can edit by hand in the config
 * editor. Nothing here trusts it: a shelf that does not parse is an empty
 * shelf, not a broken pane.
 */

/**
 * The preference the shelf lives in.
 */
export const TEMPLATES_PREF = "templates";

/**
 * How many templates one shelf holds.
 *
 * The list is a dropdown, and a dropdown of hundreds of entries is not a
 * way to find a template. Fifty is far more than anyone keeps — and it
 * keeps the preference small enough to read and write on every keystroke.
 */
export const MAX_SAVED_TEMPLATES = 50;

/**
 * How long a name may be. A name is shown in a dropdown one column wide.
 */
export const MAX_NAME_LENGTH = 60;

/** Why a template could not be saved. */
export const SAVE_ERRORS = {
  empty: "empty",
  name: "name",
  limit: "limit",
};

/**
 * The destination settings a template may carry.
 *
 * A template is not only how a note looks — it is also often meant for a
 * particular place ("one document per paper", "my reading log"). Saving
 * those settings with it means loading the template restores both.
 */
export const DESTINATION_FIELDS = [
  "destination",
  "targetDocument",
  "itemDocName",
  "itemDocPath",
];

/** The destination values of an entry, without the empty ones. */
function destinationOf(entry) {
  const values = {};
  if (!entry || typeof entry !== "object") {
    return values;
  }
  for (const name of DESTINATION_FIELDS) {
    const raw = entry[name];
    if (typeof raw !== "string") {
      continue;
    }
    const value = raw.trim();
    if (!value) {
      continue;
    }
    if (name === "destination" && !["daily", "document", "item"].includes(value)) {
      continue;
    }
    values[name] = value;
  }
  return values;
}

/**
 * The editor slots a template can belong to.
 *
 * The pane edits the common template, the one used when a note becomes a
 * document of its own, and the three sections of a literature note. A saved
 * template has to come back to the slot it was saved from; "note" is the
 * default, so only the others are written down.
 */
export const TEMPLATE_SLOTS = ["note", "item", "info", "abstract", "notes"];

function slotOf(entry) {
  const slot = String((entry && entry.slot) || "");
  return TEMPLATE_SLOTS.includes(slot) && slot !== "note" ? { slot } : {};
}

/**
 * An id for a template.
 *
 * It only has to be different from every other id on the shelf — nobody
 * types it. The clock is in it so two ids made in the same run still
 * differ, and the random part so two made in the same millisecond do.
 *
 * @param {Array|Set} [taken] - the ids (or entries) already in use
 * @returns {String}
 */
export function newTemplateId(taken) {
  const used = new Set();
  const list = taken instanceof Set ? [...taken] : taken || [];
  for (const entry of list) {
    const id = typeof entry === "string" ? entry : entry && entry.id;
    if (id) {
      used.add(String(id));
    }
  }
  let id = "";
  do {
    id =
      "t" +
      Date.now().toString(36) +
      Math.random().toString(36).slice(2, 7);
  } while (used.has(id));
  return id;
}

/**
 * A name as it can be shown: one line, no leading or trailing space, and
 * not longer than the dropdown is wide.
 *
 * @param {String} name
 * @param {String} [fallback] - used when there is no name at all
 * @returns {String}
 */
export function cleanTemplateName(name, fallback = "") {
  const text = String(name == null ? "" : name).replace(/[\r\n\t]+/g, " ").trim();
  if (!text) {
    return String(fallback == null ? "" : fallback).trim();
  }
  return text.length > MAX_NAME_LENGTH ? text.slice(0, MAX_NAME_LENGTH) : text;
}

/**
 * A name for a template that has none: its first line.
 *
 * A shelf that was edited by hand can hold an entry without a name, and a
 * dropdown row that says nothing is worse than one that says what the
 * template starts with.
 *
 * @param {String} template
 * @returns {String}
 */
export function nameFromTemplate(template) {
  const lines = String(template == null ? "" : template).split("\n");
  for (const line of lines) {
    const text = line.trim();
    if (text) {
      return text.slice(0, MAX_NAME_LENGTH);
    }
  }
  return "";
}

/**
 * Read the shelf.
 *
 * Anything that is not a shelf is read as an empty one: a preference that
 * was never written, one that was cleared, or one somebody wrote a single
 * template into by hand. An entry without a template is left out as well —
 * there is nothing to load from it.
 *
 * @param {String} raw - the preference
 * @returns {Array<{id: String, name: String, template: String,
 *   slot?: String, destination?: String, targetDocument?: String,
 *   itemDocName?: String, itemDocPath?: String}>}
 */
export function parseSavedTemplates(raw) {
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
    const template = typeof entry.template === "string" ? entry.template : "";
    if (!template.trim()) {
      continue;
    }
    let id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id || seen.has(id)) {
      // Two entries with the same id: only one of them can be picked in a
      // dropdown, so the second one gets an id of its own instead of
      // disappearing.
      id = newTemplateId(seen);
    }
    seen.add(id);
    const name =
      cleanTemplateName(entry.name, nameFromTemplate(template)) || id;
    list.push({ id, name, template, ...slotOf(entry), ...destinationOf(entry) });
    if (list.length >= MAX_SAVED_TEMPLATES) {
      break;
    }
  }
  return list;
}

/**
 * Write the shelf.
 *
 * Only what belongs on it is written — an id, a name and the template — so
 * the preference stays small enough to read at a glance in the config
 * editor.
 *
 * @param {Array} list
 * @returns {String}
 */
export function serializeSavedTemplates(list) {
  const entries = (Array.isArray(list) ? list : []).map((entry) => ({
    id: String((entry && entry.id) || ""),
    name: String((entry && entry.name) || ""),
    template: String((entry && entry.template) || ""),
    ...slotOf(entry),
    ...destinationOf(entry),
  }));
  return JSON.stringify(entries);
}

/**
 * The template with this id.
 * @param {Array} list
 * @param {String} id
 * @returns {{id: String, name: String, template: String}|null}
 */
export function findSavedTemplate(list, id) {
  const wanted = String(id || "");
  if (!wanted) {
    return null;
  }
  for (const entry of Array.isArray(list) ? list : []) {
    if (entry && String(entry.id) === wanted) {
      return entry;
    }
  }
  return null;
}

/**
 * The template that is called this.
 * @param {Array} list
 * @param {String} name
 * @returns {{id: String, name: String, template: String}|null}
 */
export function savedTemplateByName(list, name) {
  const wanted = cleanTemplateName(name).toLowerCase();
  if (!wanted) {
    return null;
  }
  for (const entry of Array.isArray(list) ? list : []) {
    if (entry && cleanTemplateName(entry.name).toLowerCase() === wanted) {
      return entry;
    }
  }
  return null;
}

/**
 * Put a template on the shelf.
 *
 * The template is the one being edited in the pane. Where it goes follows
 * from what the user typed:
 *
 *   an id is given              — that template is replaced by this one
 *   no id, but a name that is   — that template is replaced too: saving
 *     already on the shelf        under an old name updates it
 *   anything else               — a new template, under the name given
 *
 * So "give it a name and save" makes a new one, and "pick one and save"
 * keeps the shelf tidy instead of filling it with copies.
 *
 * @param {Array} list
 * @param {{id?: String, name?: String, template?: String}} entry
 * @returns {{list: Array, entry: Object|null, created: Boolean, error: String}}
 */
export function saveTemplate(list, entry = {}) {
  const current = Array.isArray(list) ? list.slice() : [];
  const template = String(entry.template == null ? "" : entry.template);
  if (!template.trim()) {
    return { list: current, entry: null, created: false, error: SAVE_ERRORS.empty };
  }
  const id = String(entry.id == null ? "" : entry.id).trim();
  const name = cleanTemplateName(entry.name);

  const byId = findSavedTemplate(current, id);
  if (byId) {
    const updated = {
      id: byId.id,
      name: name || byId.name,
      template,
      ...slotOf(entry),
      ...destinationOf(entry),
    };
    return {
      list: current.map((item) => (item && item.id === byId.id ? updated : item)),
      entry: updated,
      created: false,
      error: "",
    };
  }

  const byName = savedTemplateByName(current, name);
  if (byName) {
    const updated = {
      id: byName.id,
      name: byName.name,
      template,
      ...slotOf(entry),
      ...destinationOf(entry),
    };
    return {
      list: current.map((item) => (item && item.id === byName.id ? updated : item)),
      entry: updated,
      created: false,
      error: "",
    };
  }

  if (!name) {
    return { list: current, entry: null, created: false, error: SAVE_ERRORS.name };
  }
  if (current.length >= MAX_SAVED_TEMPLATES) {
    return { list: current, entry: null, created: false, error: SAVE_ERRORS.limit };
  }
  const created = {
    id: newTemplateId(current),
    name,
    template,
    ...slotOf(entry),
    ...destinationOf(entry),
  };
  return {
    list: current.concat([created]),
    entry: created,
    created: true,
    error: "",
  };
}

/**
 * Take a template off the shelf.
 *
 * @param {Array} list
 * @param {String} id
 * @returns {{list: Array, removed: Object|null}}
 */
export function deleteSavedTemplate(list, id) {
  const current = Array.isArray(list) ? list.slice() : [];
  const removed = findSavedTemplate(current, id);
  if (!removed) {
    return { list: current, removed: null };
  }
  return {
    list: current.filter((entry) => !(entry && entry.id === removed.id)),
    removed,
  };
}
