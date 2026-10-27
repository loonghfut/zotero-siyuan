/**
 * Zotero → SiYuan — the static checks for The templates the user saved.
 *
 * Part of `node tools/validate.mjs`: this file runs when it is imported, and
 * the entry point prints the summary. `check()` and `section()` come from
 * `harness.mjs`, together with the source readers.
 */

import {
  ROOT,
  allSource,
  paneSource,
  check,
  section,
} from "./harness.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ------------------ 7b. the shelf the user's templates live on ---------- */

section("Templates the user saved");
{
  const store = await import(
    new URL("../../src/modules/template-store.js", import.meta.url).href
  );

  // A preference is a string, and it is also something a user can edit by
  // hand in the config editor — none of that may break the pane.
  check("an empty shelf is empty", store.parseSavedTemplates("").length === 0);
  check(
    "a shelf that does not parse is empty",
    store.parseSavedTemplates("{not json").length === 0,
  );
  check(
    "a shelf that is not a list is empty",
    store.parseSavedTemplates('{"template": "{{title}}"}').length === 0,
  );

  const messy = store.parseSavedTemplates(
    JSON.stringify([
      { id: "a", name: "第一份", template: "{{title}}" },
      // The same id twice: only one of them could ever be picked in a
      // dropdown, so the second one gets an id of its own.
      { id: "a", name: "第二份", template: "{{quote}}" },
      // No id at all, and no name — the first line stands in for it.
      { template: "> [!quote]" },
      // Nothing to load from an entry without a template.
      { id: "c", name: "空", template: "   " },
      null,
    ]),
  );
  check(
    "an entry without a template is left out",
    messy.length === 3,
    JSON.stringify(messy.map((e) => e.id)),
  );
  check("the first id is kept", messy[0].id === "a");
  check("a second entry with the same id gets its own", messy[1].id !== "a");
  check(
    "an entry without a name is named after its first line",
    messy[2].name === "> [!quote]",
    messy[2].name,
  );

  const many = [];
  for (let i = 0; i < store.MAX_SAVED_TEMPLATES + 10; i++) {
    many.push({ id: "id" + i, name: "模板 " + i, template: "{{title}}" });
  }
  check(
    "a shelf holds no more than its limit",
    store.parseSavedTemplates(JSON.stringify(many)).length ===
      store.MAX_SAVED_TEMPLATES,
  );

  const roundTrip = store.parseSavedTemplates(
    store.serializeSavedTemplates(messy),
  );
  check(
    "a shelf survives being written and read back",
    JSON.stringify(roundTrip) === JSON.stringify(messy),
    JSON.stringify(roundTrip),
  );

  check(
    "an id is not one that is taken",
    store.newTemplateId([{ id: "taken" }]) !== "taken" &&
      store.newTemplateId(new Set(["taken"])) !== "taken",
  );
  check(
    "two ids made one after the other differ",
    store.newTemplateId([]) !== store.newTemplateId([]),
  );

  check(
    "a name is one line",
    store.cleanTemplateName("  摘录\n批注  ") === "摘录 批注",
    store.cleanTemplateName("  摘录\n批注  "),
  );
  check(
    "a name is cut to what the dropdown can show",
    store.cleanTemplateName("x".repeat(200)).length === store.MAX_NAME_LENGTH,
  );
  check(
    "a name that is not there falls back",
    store.cleanTemplateName("  ", "备选") === "备选",
  );
  check(
    "the first line stands in for a name",
    store.nameFromTemplate("\n\n> [!quote] 摘录") === "> [!quote] 摘录",
    store.nameFromTemplate("\n\n> [!quote] 摘录"),
  );

  // --- saving ----------------------------------------------------------
  const first = store.saveTemplate([], { name: "摘录", template: "{{title}}" });
  check("a new template is added", first.created && first.list.length === 1);
  check("it is named what the user called it", first.entry.name === "摘录");

  const updated = store.saveTemplate(first.list, {
    name: "摘录",
    template: "{{title}}\n{{metadata}}",
  });
  check(
    "saving under a name that is taken updates that template",
    !updated.created &&
      updated.list.length === 1 &&
      updated.list[0].template.includes("{{metadata}}"),
    JSON.stringify(updated.list),
  );

  const byId = store.saveTemplate(updated.list, {
    id: first.entry.id,
    name: "",
    template: "{{quote}}",
  });
  check(
    "saving with an id updates that template",
    !byId.created && byId.list.length === 1 && byId.list[0].id === first.entry.id,
  );
  check(
    "and it keeps the name it had",
    byId.list[0].name === "摘录",
    byId.list[0].name,
  );

  const renamed = store.saveTemplate(byId.list, {
    id: first.entry.id,
    name: "只要摘录",
    template: "{{quote}}",
  });
  check("a name given with an id renames it", renamed.list[0].name === "只要摘录");

  check(
    "an empty template is not saved",
    store.saveTemplate([], { name: "空", template: "  \n " }).error === "empty",
  );
  check(
    "a template without a name is not saved",
    store.saveTemplate([], { template: "{{title}}" }).error === "name",
  );
  check(
    "the shelf does not grow past its limit",
    store.saveTemplate(store.parseSavedTemplates(JSON.stringify(many)), {
      name: "再一份",
      template: "{{title}}",
    }).error === "limit",
  );

  // --- deleting --------------------------------------------------------
  const gone = store.deleteSavedTemplate(renamed.list, first.entry.id);
  check(
    "a template can be taken off the shelf",
    !!gone.removed && gone.list.length === 0,
  );
  check(
    "taking off one that is not there changes nothing",
    store.deleteSavedTemplate(renamed.list, "nope").removed === null &&
      store.deleteSavedTemplate(renamed.list, "nope").list.length === 1,
  );

  check(
    "a template is found by its name, however it is spelled",
    !!store.savedTemplateByName([{ id: "1", name: "Alpha" }], " alpha "),
  );
  check(
    "an empty name finds no template",
    store.savedTemplateByName([{ id: "1", name: "Alpha" }], "  ") === null,
  );
}

/* ------------------ 7c. the shelf in the preferences pane -------------- */

section("The shelf in the pane");
{
  const xhtml = readFileSync(
    join(ROOT, "addon", "content", "preferences.xhtml"),
    "utf8",
  );
  const pane = paneSource();
  const prefs = readFileSync(join(ROOT, "addon", "prefs.js"), "utf8");

  check("the plugin has a preference for the shelf", prefs.includes('pref("templates"'));

  for (const id of [
    "template-saved",
    "template-save-name",
    "template-save",
    "template-load",
    "template-delete",
  ]) {
    check(
      `the pane offers "${id}"`,
      xhtml.includes(`id="zotero-prefpane-zoteroSiYuan-${id}"`),
    );
  }

  check(
    "the pane draws the shelf when it opens",
    pane.includes("_renderSavedTemplates"),
  );
  check(
    "the three buttons are wired to their job",
    pane.includes("target.id === this.SAVE_ID") &&
      pane.includes("this.saveMyTemplate()") &&
      pane.includes("target.id === this.LOAD_ID") &&
      pane.includes("this.applySavedTemplate()") &&
      pane.includes("target.id === this.DELETE_ID") &&
      pane.includes("this.deleteSavedTemplate()"),
  );
  check(
    "picking a template puts its name in the box",
    pane.includes("_savedTemplatePicked") &&
      /addEventListener\("change"[\s\S]{0,600}this\.SAVED_ID/.test(pane),
  );
  check(
    "an empty shelf greys out apply and delete",
    // A button that silently does nothing when it is pressed is worse
    // than one that says it cannot be pressed.
    pane.includes("_enableSavedButtons") && pane.includes("button.disabled"),
  );

  // Loading a template has to make it the one in use — and the pane only
  // stores what the editor holds when the editor says it changed.
  const loadMethod = pane.slice(
    pane.indexOf("applySavedTemplate: function"),
    pane.indexOf("deleteSavedTemplate: function"),
  );
  check(
    "loading a template makes it the one in use",
    loadMethod.includes("area.value = entry.template;") &&
      loadMethod.includes("this.onTemplateInput();"),
  );

  // Deleting is forever: the first press only asks.
  const deleteMethod = pane.slice(
    pane.indexOf("deleteSavedTemplate: function"),
    pane.indexOf("_schedulePreview: function"),
  );
  check(
    "deleting takes two presses",
    deleteMethod.includes("this._deleteArm !== id") &&
      deleteMethod.includes("this._deleteArm = id"),
  );
  check(
    "picking another template takes back the armed delete",
    pane.includes("this._deleteArm = null"),
  );

  check(
    "the plugin keeps the shelf",
    allSource.includes("getSavedTemplates()") &&
      allSource.includes("saveSavedTemplate(entry") &&
      allSource.includes("deleteSavedTemplate(id)"),
  );
}

/* ------------------ 7d. the shelf, through the plugin's API ------------ */

section("The shelf, through the plugin");
{
  // The preferences pane cannot read the preference itself — it goes
  // through the plugin. So the plugin's own surface is driven here, with
  // only `Zotero.Prefs` standing in for Zotero.
  const previous = globalThis.Zotero;
  const stored = new Map();
  globalThis.Zotero = {
    Prefs: {
      get: (key) => (stored.has(key) ? stored.get(key) : undefined),
      set: (key, value) => {
        stored.set(key, value);
        return value;
      },
      clear: (key) => {
        stored.delete(key);
      },
    },
  };
  try {
    const api = (
      await import(
        new URL("../../src/app/preferences-api.js", import.meta.url).href
      )
    ).default;

    check("the shelf starts empty", api.getSavedTemplates().length === 0);

    const saved = api.saveSavedTemplate({
      name: "摘录",
      template: "> {{quoteCallout}}",
    });
    check(
      "a template is saved",
      saved.ok && saved.created && saved.entry.name === "摘录",
      JSON.stringify(saved),
    );
    check("it is on the shelf afterwards", api.getSavedTemplates().length === 1);
    check(
      "it is kept in the plugin's own preference",
      [...stored.keys()].some((key) => key.endsWith(".templates")),
      [...stored.keys()].join(", "),
    );

    const again = api.saveSavedTemplate({
      name: "摘录",
      template: "> {{quoteCallout}}\n\n{{metadata}}",
    });
    check(
      "saving under the same name updates it instead of adding one",
      again.ok &&
        !again.created &&
        api.getSavedTemplates().length === 1 &&
        api.getSavedTemplates()[0].template.includes("{{metadata}}"),
    );

    const byId = api.saveSavedTemplate({
      id: saved.entry.id,
      name: "",
      template: "> {{quote}}",
    });
    check(
      "saving with an id updates that one and keeps its name",
      byId.ok &&
        !byId.created &&
        api.getSavedTemplates().length === 1 &&
        api.getSavedTemplates()[0].name === "摘录",
    );

    check(
      "an empty template is refused",
      api.saveSavedTemplate({ name: "空", template: " " }).error === "empty",
    );
    check(
      "a nameless template is refused",
      api.saveSavedTemplate({ template: "> x" }).error === "name",
    );

    const gone = api.deleteSavedTemplate(saved.entry.id);
    check(
      "a template is deleted",
      gone.ok && !!gone.removed && api.getSavedTemplates().length === 0,
    );
    check(
      "deleting one that is gone changes nothing",
      api.deleteSavedTemplate("nope").ok === false,
    );

    // A preference somebody broke by hand: the pane still has to open.
    stored.set(
      [...stored.keys()].find((key) => key.endsWith(".templates")),
      "not json at all",
    );
    check(
      "a shelf that was broken by hand reads as empty",
      api.getSavedTemplates().length === 0,
    );
  }
  finally {
    if (previous === undefined) {
      delete globalThis.Zotero;
    }
    else {
      globalThis.Zotero = previous;
    }
  }
}
