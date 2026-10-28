/**
 * Zotero → SiYuan — the static checks for Guards against the bugs that came back once already.
 *
 * Part of `node tools/validate.mjs`: this file runs when it is imported, and
 * the entry point prints the summary. `check()` and `section()` come from
 * `harness.mjs`, together with the source readers.
 */

import {
  ROOT,
  allSource,
  selfTestSource,
  check,
  section,
} from "./harness.mjs";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/* --------------------- 14. the fixes must not come back ------------------ */

section("Regression guards");
{
  // --- the template engine must not leave a stray {{/if}} behind -------
  {
    const { renderTemplate } = await import(
      new URL("../../src/modules/template.js", import.meta.url).href
    );
    const nested = renderTemplate("{{#if a}}{{#if b}}X{{/if}}{{/if}}", {
      a: "",
      b: "yes",
    });
    check(
      "a nested conditional leaves no stray {{/if}}",
      nested.text === "" && !nested.text.includes("{{"),
      JSON.stringify(nested.text),
    );
    const nestedKept = renderTemplate("{{#if a}}{{#if b}}X{{/if}}{{/if}}", {
      a: "yes",
      b: "yes",
    });
    check(
      "a nested conditional keeps its body when it is filled",
      nestedKept.text === "X",
      JSON.stringify(nestedKept.text),
    );
    const single = renderTemplate("{{#if a}}X{{/if}}", { a: "yes" });
    check(
      "a single conditional still works",
      single.text === "X",
      JSON.stringify(single.text),
    );
    const unknown = renderTemplate("{{#if nope}}X{{/if}}", { a: "yes" });
    check(
      "an unknown variable in a conditional is reported",
      unknown.unknown.includes("nope"),
      JSON.stringify(unknown.unknown),
    );
  }

  // --- a variable without a value must not leave a line behind ----------
  {
    const { renderTemplate: render } = await import(
      new URL("../../src/modules/template.js", import.meta.url).href
    );
    const empty = render("{{a}}\n{{b}}\n{{c}}", { a: "", b: "", c: "C" });
    check(
      "an empty variable does not leave a line behind",
      empty.text === "C",
      JSON.stringify(empty.text),
    );
    const mixed = render("{{a}}\n{{b}}\n{{c}}", { a: "A", b: "", c: "C" });
    check(
      "only the empty variable's line goes",
      mixed.text === "A\nC",
      JSON.stringify(mixed.text),
    );
    const withText = render("作者：{{a}}\n{{b}}", { a: "", b: "B" });
    check(
      "a line with text of its own stays",
      withText.text === "作者：\nB",
      JSON.stringify(withText.text),
    );
    const skipped = render("{{#if a}}X{{/if}}\n{{b}}", { a: "", b: "B" });
    check(
      "a conditional that was not taken leaves no line behind",
      skipped.text === "B",
      JSON.stringify(skipped.text),
    );
    const blank = render("{{a}}\n\n{{b}}", { a: "", b: "B" });
    check(
      "a blank line of the template itself stays",
      blank.text === "\nB",
      JSON.stringify(blank.text),
    );
  }

  // --- a scan must not throw away what was added while it ran ----------
  {
    const { SiYuanIndex } = await import(
      new URL("../../src/modules/siyuan-index.js", import.meta.url).href
    );
    const link =
      "[t](zotero://open/library/items/ATTACH01?annotation=ABCD1234&page=3)";
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const cli = {
      runJSON: async () => {
        await gate;
        return [{ id: "old-block", markdown: link }];
      },
    };
    const index = new SiYuanIndex();
    const scanning = index.refresh(cli);
    // The annotation is sent while the scan is still running — the scan's
    // snapshot cannot know about it, so it has to survive the scan.
    index.add("ABCD1234", "newest-block");
    release();
    await scanning;
    check(
      "a scan keeps an annotation that was sent while it ran",
      index.get("ABCD1234") === "newest-block",
      index.get("ABCD1234"),
    );
    check(
      "the index can forget an annotation again",
      typeof index.remove === "function" &&
        (index.remove("ABCD1234"), index.get("ABCD1234") === ""),
    );
  }

  // --- the self test must not take the plugin over ---------------------
  {
    const source = selfTestSource();
    check(
      "the self test does not replace the plugin's own methods",
      !/addon\._(append|send|resolveNotebook|getParentItem)\s*=/.test(source),
      "a replaced method would swallow a real send that happens meanwhile",
    );
    const index = allSource;
    check(
      "the plugin offers a way to watch the next send",
      index.includes("watchNextSend") && index.includes("_takeSendHooks"),
    );
  }

  // --- the language must not be pinned to English -----------------------
  {
    const source = readFileSync(join(ROOT, "src", "utils", "locale.js"), "utf8");
    check(
      "the Fluent bundle is not pinned to en-US",
      !/locale\/en-US\/\$\{file\}/.test(source) &&
        source.includes("FALLBACK_LOCALE"),
      "the reader's own strings would stay English in every language",
    );
  }

  // --- a title with brackets must not break the link -------------------
  {
    const { escapeInline, toCalloutBody } = await import(
      new URL("../../src/modules/metadata.js", import.meta.url).href
    );
    const escaped = escapeInline("A [weird] (title)");
    check(
      "a square bracket in a title is escaped",
      escaped.includes("\\[") && escaped.includes("\\]"),
      escaped,
    );
    check(
      "an empty callout is empty, not a lone quote mark",
      // A ">" with nothing behind it takes up a line in the note without
      // saying anything.
      toCalloutBody("") === "" && toCalloutBody("   ") === "",
      JSON.stringify(toCalloutBody("")),
    );
    check(
      "a callout still quotes its text",
      toCalloutBody("hello") === "> hello",
      JSON.stringify(toCalloutBody("hello")),
    );
  }

  // --- the annotation's time must not be a variable that is always empty --
  {
    // Zotero builds the reader's annotation JSON without any date in it, so
    // `{{annotatorDate}}` read from that model was always empty — a variable
    // that is documented, offered in the pane, and never produces anything.
    // The item is the only source, and it is asked for only when a template
    // shows the value.
    check(
      "the annotation's time comes from the item, only when it is shown",
      /_annotationDate\(annotation, template = null\)/.test(allSource) &&
        /_templateUses\("annotatorDate", template\)/.test(allSource) &&
        /annotatorDate: readableStamp\(/.test(allSource),
    );
    check(
      "the time is shown in the user's clock, not in UTC",
      /Zotero\.Date\.sqlToDate\(text, true\)/.test(allSource),
    );
  }

  // --- a write whose answer was lost must never run again ---------------
  {
    const transport = readFileSync(
      join(ROOT, "src", "app", "transport.js"),
      "utf8",
    );
    const processSource = readFileSync(
      join(ROOT, "src", "modules", "siyuan-process.js"),
      "utf8",
    );
    const sendSource =
      readFileSync(join(ROOT, "src", "app", "send.js"), "utf8") +
      readFileSync(join(ROOT, "src", "app", "send-batch.js"), "utf8");
    check(
      "a started command that cannot be read is not run a second time",
      // `Subprocess.call` has to sit outside the try that falls back: once
      // the process exists, a broken answer means "it may have written",
      // and running it again would write the same note twice.
      /proc = await Subprocess\.call\(/.test(processSource) &&
        /markWriteUnknown\(e\)/.test(processSource) &&
        /runThroughZotero\(/.test(processSource),
    );
    check(
      "an unknown write result is not retried over HTTP",
      /if \(isWriteUnknown\(cliError\)\)/.test(transport) &&
        /writeState = "unknown"/.test(transport),
      "the fallback would append the same annotation again",
    );
    check(
      "an unknown write result keeps the picture it may refer to",
      /if \(!isWriteUnknown\(e\)\)/.test(sendSource),
    );
    check(
      "a batch holds its lock through a bubble that cannot be shown",
      // A reader that was closed makes `showToast` throw; if that happened
      // before the try, `_sending` would stay true and every later send
      // would only say "busy".
      /this\._sending = true;[\s\S]{0,700}?try \{[\s\S]{0,500}?progress = showToast\(/.test(
        sendSource,
      ),
    );
  }

  // --- a group library has its own deep link ----------------------------
  {
    const metadata = readFileSync(
      join(ROOT, "src", "modules", "metadata.js"),
      "utf8",
    );
    const indexSource = readFileSync(
      join(ROOT, "src", "modules", "siyuan-index.js"),
      "utf8",
    );
    check(
      "a group library link carries its group id",
      /groups\/\$\{id\}/.test(metadata),
      "without it Zotero looks the key up in the user's own library",
    );
    check(
      "the index reads a group library link too",
      indexSource.includes("groups\\/"),
    );
  }

  // --- the index must not be frozen at the first look -------------------
  {
    const marks = readFileSync(
      join(ROOT, "src", "app", "reader-marks.js"),
      "utf8",
    );
    const httpSource = readFileSync(
      join(ROOT, "src", "modules", "siyuan-http.js"),
      "utf8",
    );
    check(
      "an indexed PDF is looked at again later",
      /INDEX_TTL_MS/.test(marks) &&
        /_indexedAttachments\.get\(itemID\)/.test(marks),
      "otherwise a note added in SiYuan never shows up",
    );
    check(
      "a rescan that failed is not reported as zero",
      !/could not build the index[\s\S]{0,80}?return 0;/.test(marks),
      "0 looks exactly like an empty workspace",
    );
    check(
      "the index can read the workspace without the CLI",
      /_indexTransport\(\)/.test(marks) &&
        /"\/api\/query\/sql"/.test(httpSource),
      "a plugin that can only send over HTTP would lose every marker",
    );
  }
}
