/**
 * Zotero → SiYuan — the static checks for The send template and its editor.
 *
 * Part of `node tools/validate.mjs`: this file runs when it is imported, and
 * the entry point prints the summary. `check()` and `section()` come from
 * `harness.mjs`, together with the source readers.
 */

import {
  check,
  section,
} from "./harness.mjs";
import { join } from "node:path";

/* --------------------- 7. the template engine still renders ---------------- */

section("Send template");
{
  const { DEFAULT_TEMPLATE, TEMPLATE_VARIABLES, renderTemplate } = await import(
    new URL("../../src/modules/template.js", import.meta.url).href
  );
  const { collectMetadata } = await import(
    new URL("../../src/modules/metadata.js", import.meta.url).href
  );

  check(
    "every template variable is a plain identifier",
    TEMPLATE_VARIABLES.every((v) => /^[A-Za-z][A-Za-z0-9]*$/.test(v.name)),
  );

  const names = new Set(TEMPLATE_VARIABLES.map((v) => v.name));
  const used = new Set();
  for (const match of DEFAULT_TEMPLATE.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g)) {
    used.add(match[1]);
  }
  for (const match of DEFAULT_TEMPLATE.matchAll(/\{\{#if\s+([A-Za-z][A-Za-z0-9]*)\s*\}\}/g)) {
    used.add(match[1]);
  }
  const unknown = [...used].filter((name) => !names.has(name));
  check(
    "the default template only uses known variables",
    unknown.length === 0,
    unknown.join(", "),
  );

  // Render it with a made-up annotation, exactly like the plugin does.
  const sample = collectMetadata({
    annotation: {
      id: "ANNO0001",
      type: "highlight",
      text: "The highlighted text.",
      comment: "The comment.",
      pageLabel: "3",
      authorName: "steve",
      position: { pageIndex: 2 },
    },
    parentItem: {
      key: "ABCD1234",
      itemTypeID: 1,
      getField: (field) =>
        ({
          title: "A Paper",
          date: "2017",
          publicationTitle: "A Journal",
        })[field] || "",
      getCreators: () => [{ firstName: "A", lastName: "B", fieldMode: 0 }],
      getTags: () => [],
    },
    attachment: { key: "ATTACH01" },
    annotationKey: "ANNO0001",
    extra: { date: "2026-10-25", time: "18:54", timestamp: "2026-10-25 18:54:33" },
  });
  const rendered = renderTemplate(DEFAULT_TEMPLATE, sample);
  check(
    "the default template renders without unknown variables",
    rendered.unknown.length === 0,
    rendered.unknown.join(", "),
  );
  check(
    "the default template renders a quote callout",
    /> \[!quote\]/.test(rendered.text),
    rendered.text.slice(0, 120),
  );
  check(
    "the default template renders the comment callout",
    /> \[!note\]/.test(rendered.text),
  );
  check(
    "the default template links back to Zotero",
    /zotero:\/\/open\/library\/items\/ATTACH01\?annotation=ANNO0001&page=3/.test(
      rendered.text,
    ),
    rendered.text.slice(-160),
  );

  // A group library has a second URL shape. Writing the personal one for a
  // group item does not fail loudly — Zotero looks the key up in the user's
  // own library, finds nothing, and the link simply does nothing.
  const inGroup = collectMetadata({
    annotation: {
      id: "ANNO0001",
      type: "highlight",
      text: "The highlighted text.",
      pageLabel: "3",
      position: { pageIndex: 2 },
    },
    parentItem: {
      key: "ABCD1234",
      libraryID: 42,
      itemTypeID: 1,
      getField: () => "A Paper",
      getCreators: () => [],
      getTags: () => [],
    },
    attachment: { key: "ATTACH01", libraryID: 42 },
    annotationKey: "ANNO0001",
  });
  check(
    "a group library annotation links into its group",
    inGroup.zoteroAnnotationLink ===
      "zotero://open/groups/42/items/ATTACH01?annotation=ANNO0001&page=3",
    inGroup.zoteroAnnotationLink,
  );

  // A PDF nobody attached to an item is a normal way to use the reader —
  // and it used to produce a note without a title and without the link the
  // plugin needs to find it again.
  const standalone = collectMetadata({
    annotation: { id: "ANNO0001", type: "highlight", text: "x" },
    parentItem: null,
    attachment: {
      key: "ATTACH01",
      libraryID: 1,
      getField: (name) => (name === "title" ? "Full Text PDF" : ""),
      getTags: () => [],
    },
    annotationKey: "ANNO0001",
  });
  check(
    "a PDF without a parent still says where it came from",
    standalone.title === "Full Text PDF" &&
      standalone.zoteroAnnotationLink.includes("items/ATTACH01") &&
      /来源|Source/.test(standalone.metadata),
    JSON.stringify(standalone.metadata),
  );

  // Without a comment the empty callout must disappear.
  const withoutComment = renderTemplate(DEFAULT_TEMPLATE, {
    ...sample,
    comment: "",
    commentCallout: "",
  });
  check(
    "an annotation without a comment leaves no empty callout",
    !/\[!note\]/.test(withoutComment.text),
    withoutComment.text.slice(0, 160),
  );

  // --- the other branch of a conditional ---------------------------------
  const branch = "{{#if comment}}分支一\n{{comment}}\n{{else}}分支二\n{{/if}}";
  check(
    "the branch of a filled variable is taken",
    renderTemplate(branch, { comment: "我的批注" }).text ===
      "分支一\n我的批注\n",
    renderTemplate(branch, { comment: "我的批注" }).text,
  );
  check(
    "the other branch of an empty variable is taken",
    renderTemplate(branch, { comment: "" }).text === "分支二\n",
    renderTemplate(branch, { comment: "" }).text,
  );
  check(
    "the branch that is not taken leaves nothing behind",
    // The lines of the branch that was not taken must go with it — an
    // empty line is a place in the note that nothing fills.
    !/分支一/.test(renderTemplate(branch, { comment: "" }).text),
    renderTemplate(branch, { comment: "" }).text,
  );

  // The else of a nested conditional belongs to the inner block.
  const nested =
    "{{#if a}}A\n{{#if b}}B\n{{else}}B-else\n{{/if}}\n{{else}}A-else\n{{/if}}";
  check(
    "an else belongs to the conditional it is written in",
    renderTemplate(nested, { a: "1", b: "" }).text === "A\nB-else\n\n",
    renderTemplate(nested, { a: "1", b: "" }).text,
  );
  check(
    "the outer else is taken when the outer variable is empty",
    renderTemplate(nested, { a: "", b: "2" }).text === "A-else\n",
    renderTemplate(nested, { a: "", b: "2" }).text,
  );

  // The else marker looks like a variable — it must not be looked up as one.
  const { templateVariables, validateTemplate } = await import(
    new URL("../../src/modules/template.js", import.meta.url).href
  );
  check(
    "the else marker is not a variable",
    !templateVariables("{{#if a}}x{{else}}y{{/if}}").includes("else"),
    templateVariables("{{#if a}}x{{else}}y{{/if}}").join(", "),
  );
  check(
    "an else without a conditional is found",
    validateTemplate("{{else}}").problems.some((p) =>
      p.includes("{{else}}"),
    ),
    validateTemplate("{{else}}").problems.join(" / "),
  );
  check(
    "a second else in the same block is found",
    validateTemplate("{{#if a}}x{{else}}y{{else}}z{{/if}}").problems.some((p) =>
      p.includes("more than one"),
    ),
    validateTemplate("{{#if a}}x{{else}}y{{else}}z{{/if}}").problems.join(" / "),
  );
  check(
    "a template with an else has no unknown variables",
    validateTemplate("{{#if comment}}x{{else}}y{{/if}}").unknown.length === 0,
    validateTemplate("{{#if comment}}x{{else}}y{{/if}}").unknown.join(", "),
  );
}

/* --------------------- 8. inserting a variable at the caret -------------- */

section("Template editing");
{
  const { insertToken, variableToken } = await import(
    new URL("../../src/modules/template-edit.js", import.meta.url).href
  );

  check(
    "a variable token is wrapped in braces",
    variableToken("quote") === "{{quote}}",
    variableToken("quote"),
  );

  const atEnd = insertToken("abc", "{{title}}", 3, 3);
  check(
    "inserting at the end appends the token",
    atEnd.value === "abc{{title}}",
    atEnd.value,
  );
  check(
    "the caret ends up after the inserted token",
    atEnd.caret === "abc{{title}}".length,
    String(atEnd.caret),
  );

  const inTheMiddle = insertToken("abcd", "{{x}}", 2, 2);
  check(
    "inserting in the middle keeps the rest of the text",
    inTheMiddle.value === "ab{{x}}cd",
    inTheMiddle.value,
  );

  const replacing = insertToken("abcd", "{{x}}", 1, 3);
  check(
    "inserting over a selection replaces it",
    replacing.value === "a{{x}}d",
    replacing.value,
  );

  const clamped = insertToken("ab", "{{x}}", 99, 99);
  check(
    "an out-of-range position is clamped",
    clamped.value === "ab{{x}}",
    clamped.value,
  );

  const noPosition = insertToken("ab", "{{x}}");
  check(
    "without a position the token is appended",
    noPosition.value === "ab{{x}}",
    noPosition.value,
  );

  const empty = insertToken("", "{{x}}", 0, 0);
  check(
    "inserting into an empty template works",
    empty.value === "{{x}}",
    empty.value,
  );

  // --- the conditional, put in by hand -----------------------------------
  const {
    insertConditional,
    insertConditionalTag,
    conditionalToken,
  } = await import(
    new URL("../../src/modules/template-edit.js", import.meta.url).href
  );

  check(
    "a conditional token names the variable",
    conditionalToken("comment") === "{{#if comment}}",
    conditionalToken("comment"),
  );

  // The heart of it: a selection is wrapped, and the text inside it is
  // left exactly as it was.
  const template = "> [!quote] 摘录\n{{commentCallout}}\n\n[{{title}}]({{link}})";
  const start = template.indexOf("{{commentCallout}}");
  const end = start + "{{commentCallout}}".length;
  const wrapped = insertConditional(template, "comment", start, end);
  check(
    "a conditional wraps the selection",
    wrapped.value ===
      "> [!quote] 摘录\n{{#if comment}}\n{{commentCallout}}\n{{/if}}\n\n[{{title}}]({{link}})",
    wrapped.value,
  );
  check(
    "the text inside the block is not changed",
    wrapped.value.includes("\n{{commentCallout}}\n{{/if}}"),
    wrapped.value,
  );
  check(
    "the caret lands inside the block",
    wrapped.caret > start && wrapped.caret < start + wrapped.value.length - start,
    String(wrapped.caret),
  );

  // Without a selection an empty block is made.
  const blank = insertConditional("", "comment", 0, 0);
  check(
    "an empty conditional is made without a selection",
    blank.value === "{{#if comment}}\n\n{{/if}}",
    blank.value,
  );
  check(
    "the caret lands between the two tags",
    // Right after the line break that follows the opening tag — the empty
    // line the body is written on.
    blank.caret === blank.value.indexOf("\n") + 1,
    String(blank.caret),
  );

  // The tags stand on lines of their own.
  check(
    "an else tag gets a line of its own",
    insertConditionalTag("a\nb", "{{else}}", 2, 2).value === "a\n{{else}}\nb",
    insertConditionalTag("a\nb", "{{else}}", 2, 2).value,
  );
  check(
    "an end tag gets a line of its own",
    insertConditionalTag("a\nb", "{{/if}}", 2, 2).value === "a\n{{/if}}\nb",
    insertConditionalTag("a\nb", "{{/if}}", 2, 2).value,
  );
  check(
    "the indentation of the line is kept",
    insertConditionalTag("a\n  b", "{{else}}", 4, 4).value ===
      "a\n  {{else}}\nb",
    insertConditionalTag("a\n  b", "{{else}}", 4, 4).value,
  );
}
