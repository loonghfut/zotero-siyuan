/**
 * Zotero → SiYuan — the static checks for The picture of an area selection.
 *
 * Part of `node tools/validate.mjs`: this file runs when it is imported, and
 * the entry point prints the summary. `check()` and `section()` come from
 * `harness.mjs`, together with the source readers.
 */

import {
  ROOT,
  allSource,
  selfTestSource,
  pictureParts,
  pictureSource,
  check,
  section,
} from "./harness.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/* ----------------- 13. the picture of an area selection ------------------ */

section("Area-selection pictures");
{
  // A "框选" annotation has no text: what the user selected is a picture.
  // Without that picture the note is empty, so the picture has to travel
  // with it into the workspace.
  const imageFile = join(ROOT, "src", "modules", "siyuan-image.js");
  check("the picture module exists", existsSync(imageFile));
  // The picture is a package of its own — where a picture is found, what
  // its bytes are, and what happens to them in the workspace. A check that
  // asks about the code has to read all of it, not only the file that
  // re-exports it.
  const parts = pictureParts();
  const pictureSourceText = pictureSource();
  check(
    "the picture is split by concern",
    parts.every((file) => existsSync(file)) &&
      // And the face the rest of the plugin sees is a re-export, so moving
      // a function between the parts is not a change to any caller.
      /export \{[\s\S]*?\} from "\.\/picture\/assets\.js"/.test(
        readFileSync(imageFile, "utf8"),
      ),
    parts
      .filter((file) => !existsSync(file))
      .map((file) => file.slice(ROOT.length))
      .join(", ") || `${parts.length} parts`,
  );
  const index = allSource;

  check(
    "the plugin imports the picture module",
    // The path depends on where the importer sits: `src/` reaches modules
    // directly, `src/app/` goes one level up.
    /from\s+"(?:\.\.\/)?\.?\/?modules\/siyuan-image\.js"/.test(index),
  );
  check(
    "the note is built with the picture",
    /_buildContent\([^)]*\)\s*\{[\s\S]*?await this\._preparePicture\(/.test(index),
  );
  check(
    "the batch path carries the picture along",
    // `_annotationFromItem` holds the item, and the item knows which
    // library it belongs to — that is what the cache path is built from.
    // Without it a group library would lose every picture. The lookup is
    // asynchronous, so it has to be awaited: a promise put into
    // `imagePath` is always truthy and the picture is lost.
    /_annotationFromItem\(item\)\s*\{[\s\S]*?imagePath = \(await annotationImagePath\(item\)\)/
      .test(index),
  );
  check(
    "the picture's alt text is localized",
    index.includes('getString("zoteroSiYuan-image-alt"'),
  );
  check(
    "the picture module stays inside the sandbox",
    // `OS` is not on the plugin's whitelist — only `IOUtils` is.
    !/\bOS\.(File|Path)\b/.test(pictureSourceText),
  );
  check(
    "the workspace is looked up in the preference, the CLI and the API",
    /_resolveWorkspaceDir\(\)\s*\{[\s\S]*?getPref\("workspace"[\s\S]*?currentWorkspace\(\)[\s\S]*?_httpClient\(\)/
      .test(index),
  );
  check(
    "the HTTP fallback client is discovered once, not per send",
    /_httpClient\(\)\s*\{[\s\S]*?SiYuanHTTP\.discover\(/.test(index) &&
      index.includes("this._httpKey !== key"),
  );
  check(
    "a send that fails takes its picture back",
    // The picture is in the workspace before the note is written — a write
    // that fails must not leave it behind.
    /catch\s*\(e\)\s*\{[\s\S]*?await this\._dropPicture\(\)/.test(index) &&
      index.includes("_pendingPicture"),
  );
  {
    const selfTest = selfTestSource();
    check(
      "the self test takes back the pictures it wrote",
      // A dry run writes no note, so the picture it left behind would be
      // litter in the user's workspace.
      selfTest.includes("notePictures") &&
        selfTest.includes("removeExportedPictures") &&
        /IOUtils\.remove\(/.test(selfTest),
    );
    check(
      "the self test looks at the assets folder before and after",
      // A picture that a failed render left behind is named by nobody:
      // only the difference between the folder before and after the run
      // finds it.
      /picturesBefore = await .*picturesInWorkspace\(\)/.test(selfTest) &&
        selfTest.includes("removeStrayPictures(picturesBefore") &&
        selfTest.includes("strayPictureNames("),
    );
    check(
      "a picture that a note refers to is kept",
      // The kernel knows every picture a note links to — that is what
      // tells a stray picture from one that belongs to a note the user
      // sent while the self test was running. The answer of the kernel
      // has to reach the decision, not merely be fetched.
      /const registered = await registeredPictures\(\);/.test(selfTest) &&
        /const referenced = new Set\(\[\.\.\.registered/.test(selfTest) &&
        selfTest.includes("FROM assets WHERE path LIKE '%zotero-siyuan-%'"),
    );
  }

  // --- the picture itself ------------------------------------------------
  const {
    isPictureAnnotation,
    pictureMarkdown,
    pictureName,
    assetsDir,
    exportPicture,
    pictureAssetNames,
    pictureFile,
    removePicture,
    strayPictureNames,
    compressImage,
    compressionPays,
    base64Of,
    memoizedPictures,
    forgetPictures,
  } = await import(
    new URL("../../src/modules/siyuan-image.js", import.meta.url).href
  );

  check(
    "an area selection is recognized as a picture",
    isPictureAnnotation({ type: "image" }) &&
      isPictureAnnotation({ type: "ink" }) &&
      !isPictureAnnotation({ type: "highlight" }) &&
      !isPictureAnnotation({ type: "note" }) &&
      !isPictureAnnotation({}),
  );
  check(
    "the picture's markdown points into the workspace's assets",
    pictureMarkdown("assets/a.png", "框选") === "![框选](assets/a.png)" &&
      pictureMarkdown("", "框选") === "",
  );
  check(
    "the file name carries the annotation's key and a timestamp",
    /^zotero-siyuan-ABCD1234-\d{14}$/.test(pictureName("ABCD1234")),
    pictureName("ABCD1234"),
  );

  // --- which pictures may go ---------------------------------------------
  {
    const before = new Set(["zotero-siyuan-OLD-1.png"]);
    const after = new Set([
      "zotero-siyuan-OLD-1.png",
      "zotero-siyuan-NEW-2.png",
      "zotero-siyuan-NEW-3.png",
    ]);
    const referenced = new Set(["zotero-siyuan-NEW-3.png"]);
    check(
      "a picture that was already there is not stray",
      !strayPictureNames(before, after, referenced).includes(
        "zotero-siyuan-OLD-1.png",
      ),
    );
    check(
      "a picture that a note refers to is not stray",
      !strayPictureNames(before, after, referenced).includes(
        "zotero-siyuan-NEW-3.png",
      ),
    );
    check(
      "a picture that nobody refers to is stray",
      strayPictureNames(before, after, referenced).join() ===
        "zotero-siyuan-NEW-2.png",
      strayPictureNames(before, after, referenced).join(),
    );
    check(
      "without a reading from before, nothing is taken back",
      // The folder could not be read at the start — then every picture
      // would look new, and the user's own pictures would go.
      strayPictureNames(null, after, referenced).length === 0 &&
        strayPictureNames(before, null, referenced).length === 0,
    );
    check(
      "without a reading of the notes, nothing is taken back",
      // The kernel did not answer — then it is not known which picture
      // belongs to a note.
      strayPictureNames(before, after, null).length === 0,
    );
  }


  // --- the note carries the picture --------------------------------------
  const { collectMetadata } = await import(
    new URL("../../src/modules/metadata.js", import.meta.url).href
  );
  const vars = collectMetadata({
    annotation: { type: "image", text: "" },
    image: "![框选](assets/a.png)",
  });
  check(
    "a picture-only annotation does not repeat the picture",
    // The quote is empty — the picture is not copied into it, or a
    // template that asks for both would show the picture twice.
    vars.quoteCallout === "",
    vars.quoteCallout,
  );
  check(
    "the picture is available as a variable of its own",
    vars.image === "![框选](assets/a.png)" &&
      vars.imageCallout === "> ![框选](assets/a.png)",
    `${vars.image} / ${vars.imageCallout}`,
  );

  const { renderTemplate, TEMPLATE_VARIABLES, DEFAULT_TEMPLATE, appendPicture, validateTemplate } =
    await import(new URL("../../src/modules/template.js", import.meta.url).href);
  const rendered = renderTemplate("{{image}}\n{{imageCallout}}", vars);
  check(
    "the template can put the picture in",
    rendered.text === "![框选](assets/a.png)\n> ![框选](assets/a.png)",
    JSON.stringify(rendered.text),
  );
  check(
    "the picture is listed among the template's variables",
    TEMPLATE_VARIABLES.some((v) => v.name === "image") &&
      TEMPLATE_VARIABLES.some((v) => v.name === "imageCallout"),
  );
  const byDefault = renderTemplate(DEFAULT_TEMPLATE, vars);
  check(
    "the default template carries the picture",
    byDefault.text.includes("![框选](assets/a.png)") &&
      !byDefault.text.includes("{{"),
    JSON.stringify(byDefault.text),
  );
  check(
    "the default template shows the picture once, not twice",
    byDefault.text.split("![框选](assets/a.png)").length - 1 === 1,
    JSON.stringify(byDefault.text),
  );

  // --- a template that never heard of the picture ------------------------
  {
    check(
      "a picture is put into the note even without a variable for it",
      // A template written before the picture existed must not lose the
      // selection.
      appendPicture("> [!quote] 摘录\n", "![框选](assets/a.png)").includes(
        "![框选](assets/a.png)",
      ),
    );
    check(
      "a picture is not put into the note twice",
      appendPicture(
        "> ![框选](assets/a.png)\n",
        "![框选](assets/a.png)",
      ).split("![框选](assets/a.png)").length - 1 === 1,
    );
    check(
      "a note without a picture is left alone",
      appendPicture("> [!quote] 摘录\n", "") === "> [!quote] 摘录\n",
    );
    const source = allSource;
    check(
      "the note really goes through that",
      source.includes("appendPicture(text, image)"),
    );
  }

  // --- the template editor ------------------------------------------------
  {
    const { insertVariable } = await import(
      new URL("../../src/modules/template-edit.js", import.meta.url).href
    );
    const alone = insertVariable("> [!quote]\n", "{{quoteCallout}}", 11, 11);
    check(
      "a variable lands at the cursor",
      alone.value === "> [!quote]\n{{quoteCallout}}" &&
        alone.caret === 27,
      JSON.stringify(alone),
    );
    const inTheMiddle = insertVariable(
      "abc",
      "{{quoteCallout}}",
      2,
      2,
    );
    check(
      "a callout starts a line of its own",
      inTheMiddle.value === "ab\n{{quoteCallout}}c",
      JSON.stringify(inTheMiddle.value),
    );
    const indented = insertVariable(
      "  {{title}} abc",
      "{{quoteCallout}}",
      12,
      12,
    );
    check(
      "the indentation of the line is kept",
      indented.value === "  {{title}} \n  {{quoteCallout}}abc",
      JSON.stringify(indented.value),
    );
    const plain = insertVariable("abc", "{{title}}", 3, 3);
    check(
      "a plain variable does not break the line",
      plain.value === "abc{{title}}",
      JSON.stringify(plain.value),
    );

    const problems = validateTemplate("{{nope}} {{#if comment}}x");
    check(
      "an unknown variable is found",
      problems.unknown.includes("nope"),
      JSON.stringify(problems.unknown),
    );
    check(
      "an unclosed conditional is found",
      problems.unbalanced === 1 && problems.problems.length > 0,
      JSON.stringify(problems.problems),
    );
    const good = validateTemplate(DEFAULT_TEMPLATE);
    check(
      "a sound template has no problems",
      good.problems.length === 0 && good.unbalanced === 0,
      JSON.stringify(good.problems),
    );
  }
}
