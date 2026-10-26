/**
 * Zotero → SiYuan — the static checks for The preferences pane: conditionals and picture settings.
 *
 * Part of `node tools/validate.mjs`: this file runs when it is imported, and
 * the entry point prints the summary. `check()` and `section()` come from
 * `harness.mjs`, together with the source readers.
 */

import {
  ROOT,
  allSource,
  paneSource,
  selfTestSource,
  check,
  section,
} from "./harness.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ------------- 8b. the conditionals in the preferences pane ------------- */

section("Conditional blocks in the pane");
{
  // Writing `{{#if …}}…{{/if}}` by hand is the part of the template that
  // people get wrong — so the pane has to offer it as a button.
  const xhtml = readFileSync(
    join(ROOT, "addon", "content", "preferences.xhtml"),
    "utf8",
  );
  const pane = paneSource();
  const index = allSource;

  for (const id of [
    "conditional-variable",
    "conditional-if",
    "conditional-else",
    "conditional-end",
  ]) {
    check(
      `the pane offers "${id}"`,
      xhtml.includes(`zoteroSiYuan-${id}`),
    );
  }
  check(
    "the pane inserts a block, an else and an end",
    pane.includes("this.insertConditional(") &&
      pane.includes('this.insertConditionalTag("{{else}}")') &&
      pane.includes('this.insertConditionalTag("{{/if}}")'),
  );
  check(
    "the pane fills the list of the variables a conditional may test",
    pane.includes("_renderConditionalVariables") &&
      pane.includes("this._variables[i].name"),
  );
  check(
    "the plugin offers the conditional insertion",
    index.includes("insertConditional(text, name, start, end)") &&
      index.includes("insertConditionalTag(text, tag, start, end)"),
  );

  // The heart of the feature: the selected text has to survive the click
  // on the button — the button takes the focus away from the editor.
  const conditionalMethod = pane.slice(
    pane.indexOf("insertConditional: function"),
    pane.indexOf("insertConditionalTag: function"),
  );
  const trackMethod = pane.slice(
    pane.indexOf("_trackCaret: function"),
    pane.indexOf("_selectionRange: function"),
  );
  check(
    "the pane keeps the selection while the button is pressed",
    // The range has to come from the remembered selection — not from a
    // fixed place, and not from the editor's own focus.
    /var range = this\._selectionRange\(area\);/.test(conditionalMethod) &&
      /insertConditional\(\s*area\.value,\s*name,\s*range\.start,\s*range\.end/s.test(
        conditionalMethod,
      ),
  );
  check(
    "the remembered selection reaches the editor",
    // The range is only remembered when the caret moves — the arrow keys
    // and a drag change it without an input event. Both ends of the
    // selection have to be remembered, or the selection is lost.
    trackMethod.includes("this._caret = target.selectionStart;") &&
      trackMethod.includes("this._caretEnd = target.selectionEnd;"),
  );
  check(
    "the pane watches every way the selection changes",
    // The arrow keys and a drag change the selection without an input
    // event — and the caret has to be remembered all the same.
    pane.includes('addEventListener("select"') &&
      pane.includes('addEventListener("keyup"') &&
      pane.includes('addEventListener("focusin"'),
  );
}

/* ------------- 8c. the picture settings in the preferences pane ---------- */

section("Picture settings in the pane");
{
  // The picture of an area selection is a screenshot of the page, and it
  // is several times as big as it needs to be. The user has to be able to
  // say whether it is compressed — and how well.
  const xhtml = readFileSync(
    join(ROOT, "addon", "content", "preferences.xhtml"),
    "utf8",
  );
  const pane = paneSource();
  const prefs = readFileSync(join(ROOT, "addon", "prefs.js"), "utf8");

  check(
    "the plugin has a setting for the compression",
    prefs.includes('pref("imageCompress"') &&
      prefs.includes('pref("imageQuality"'),
  );
  check(
    "the pane offers the compression and its quality",
    xhtml.includes("zotero-prefpane-zoteroSiYuan-image-compress") &&
      xhtml.includes("zotero-prefpane-zoteroSiYuan-image-quality"),
  );
  check(
    "the quality can be set to any value the user wants",
    // Not three fixed choices — the user picks the number. The slider is an
    // HTML range input: the XUL <slider> no longer exists in the Firefox
    // Zotero is built on, and a missing control is worse than a plain one.
    xhtml.includes("zotero-prefpane-zoteroSiYuan-image-quality-range") &&
      /<html:input\b[\s\S]{0,400}zotero-prefpane-zoteroSiYuan-image-quality-range[\s\S]{0,200}type="range"/.test(
        xhtml,
      ) &&
      /<html:input\b[\s\S]{0,400}zotero-prefpane-zoteroSiYuan-image-quality"[\s\S]{0,200}type="number"/.test(
        xhtml,
      ) &&
      pane.includes("_setQuality") &&
      pane.includes("IMAGE_QUALITY_MIN") &&
      pane.includes("IMAGE_QUALITY_MAX"),
  );
  check(
    "the slider is listened to with the event an HTML input sends",
    pane.includes('addEventListener("input"') &&
      pane.includes("IMAGE_QUALITY_RANGE_ID"),
  );
  check(
    "a quality outside the bounds is brought back into them",
    // A number that is out of range would end up as a JPEG that no
    // encoder can make.
    /Math\.min\(\s*this\.IMAGE_QUALITY_MAX,[\s\S]{0,120}Math\.max\(\s*this\.IMAGE_QUALITY_MIN/.test(
      pane,
    ),
  );
  check(
    "the pane stores what the user chooses",
    pane.includes("_saveImageSetting") &&
      pane.includes("_restoreImageSettings") &&
      /setPref\(\s*key,\s*value\s*\)/.test(
        allSource,
      ),
  );
  check(
    "the compression can be turned off",
    // Without a way out, a user who wants the original picture has none.
    /prefFlag\("imageCompress",\s*true\)/.test(
      allSource,
    ),
  );
  check(
    "the self test says which version is running",
    // After replacing the XPI, Firefox can keep the old script for one
    // more start — and nothing else says so.
    readFileSync(join(ROOT, "addon", "bootstrap.js"), "utf8").includes(
      "const ctx = { rootURI, version };",
    ) &&
      selfTestSource().includes("pluginVersion:")
  );
}
