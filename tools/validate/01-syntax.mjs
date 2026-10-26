/**
 * Zotero → SiYuan — the static checks for Syntax and callback binding.
 *
 * Part of `node tools/validate.mjs`: this file runs when it is imported, and
 * the entry point prints the summary. `check()` and `section()` come from
 * `harness.mjs`, together with the source readers.
 */

import {
  ROOT,
  SRC_DIR,
  files,
  check,
  section,
} from "./harness.mjs";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

/* ------------------------------ 1. syntax ------------------------------ */

section("JavaScript syntax");
for (const file of files.filter((f) => extname(f) === ".js")) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    check(relative(ROOT, file), true);
  } catch (e) {
    check(relative(ROOT, file), false, String(e.stderr || e).split("\n")[0]);
  }
}

/* --------------------- 2. no unbound method callbacks -------------------- */

section("Callback binding");
for (const file of files.filter((f) => extname(f) === ".js" && f.includes("src"))) {
  const text = readFileSync(file, "utf8");
  // A handler of the form `this.someMethod` (not `this.someMethod.bind(this)`)
  // loses its receiver when the host calls it: Zotero dispatches the reader
  // event with its own `this`, so `this._send` would be undefined.
  const pattern =
    /(?:registerEventListener|addEventListener)\(\s*(?:"[^"]*"|[A-Za-z_$][\w$]*)\s*,\s*this\.(\w+)\s*[,)]/g;
  const suspects = new Set();
  for (const m of text.matchAll(pattern)) suspects.add(m[1]);

  for (const suspect of suspects) {
    const escaped = suspect.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const bound = new RegExp(
      `${escaped}\\s*=\\s*this\\.${escaped}\\.bind\\(this\\)`,
    );
    check(
      `${relative(ROOT, file)}: "${suspect}" is bound before being passed as a callback`,
      bound.test(text),
      "Zotero calls the handler with its own `this`; bind it in the constructor",
    );
  }
  if (suspects.size === 0) {
    check(`${relative(ROOT, file)}: no unbound method callbacks`, true);
  }
}

/* ------------------- 3. an asynchronous call is awaited ------------------ */

section("Async calls are awaited");
{
  // A promise is always truthy, so a check written as
  // `if (IOUtils.exists(path)) …` is always true — it checks nothing, and
  // the code around it quietly takes the wrong branch. This found two real
  // ones: a locale that was never really looked for, and a launcher that
  // tried to start a file that was not there. A third one, the picture path
  // of an annotation, was found by reading the code.
  const ASYNC_CALLS = [
    "IOUtils.exists",
    "IOUtils.read",
    "IOUtils.write",
    "IOUtils.remove",
    "IOUtils.makeDirectory",
    "IOUtils.stat",
    "Zotero.Items.getAsync",
    "Zotero.Items.getByLibraryAndKeyAsync",
    "Zotero.File.getContentsAsync",
    "Zotero.File.putContentsAsync",
    "Zotero.DB.queryAsync",
    "Zotero.DB.columnQueryAsync",
  ];
  // Comments talk about these calls as well, and so do the names of the
  // diagnostic steps ("IOUtils.stat(candidate)") — neither is a call.
  const stripComments = (text) =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1 ")
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

  const offenders = [];
  for (const file of files.filter(
    (f) => extname(f) === ".js" && f.startsWith(SRC_DIR),
  )) {
    const text = stripComments(readFileSync(file, "utf8"));
    for (const name of ASYNC_CALLS) {
      let at = text.indexOf(`${name}(`);
      while (at !== -1) {
        const before = text.slice(Math.max(0, at - 24), at);
        if (!/await\s+$/.test(before)) {
          const line = text.slice(0, at).split("\n").length;
          offenders.push(`${relative(ROOT, file)}:${line} ${name}()`);
        }
        at = text.indexOf(`${name}(`, at + name.length);
      }
    }
  }
  check(
    "every asynchronous call in the plugin is awaited",
    offenders.length === 0,
    offenders.join(", "),
  );
}

/* ------------------ 4. one bubble stack, not one per bubble -------------- */

section("Notification bubbles");
{
  // Two messages at the same moment used to be drawn at exactly the same
  // place — the newer one covered the older one completely. They share one
  // fixed stack now, and it goes away with its last bubble.
  const toast = readFileSync(
    join(ROOT, "src", "modules", "toast.js"),
    "utf8",
  );
  check(
    "bubbles are stacked instead of overlapping",
    toast.includes("function stackFor(doc)") &&
      toast.includes("const stack = stackFor(targetDoc)") &&
      /position:fixed;bottom:24px;right:24px/.test(toast) &&
      !/position:fixed;bottom:24px;right:24px[^"]*"[\s\S]{0,40}max-width/.test(
        toast,
      ),
  );
  check(
    "the stack belongs to the document the bubble is shown in",
    // One stack per document, not one for the plugin: a bubble can be
    // shown in the reader and in the main window at once, and a reader
    // document is replaced whenever a PDF is reopened.
    toast.includes("const stacks = new WeakMap()") &&
      /function stackFor\(doc\)[\s\S]*?stacks\.get\(doc\)[\s\S]*?stacks\.set\(doc, fresh\)/
        .test(toast),
  );
  check(
    "a bubble goes to the document the user is looking at",
    // The reader is where a send starts, so the answer has to appear
    // there — the main window's items list is behind it.
    /export function toastTarget\(doc = null\)[\s\S]*?if \(doc && doc\.documentElement/.test(
      toast,
    ) &&
      /export function showToast\(\{[\s\S]*?doc = null,/.test(toast) &&
      /const target = toastTarget\(doc\)/.test(toast),
  );
  check(
    "the stack is taken away with its last bubble",
    toast.includes("dropStack") &&
      toast.includes("if (stack.childElementCount)"),
  );
}
