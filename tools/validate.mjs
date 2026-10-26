/**
 * Static checks for the Zotero → SiYuan plugin.
 *
 * These catch the failures that a successful build does not reveal:
 *   - a method handed to an event listener without being bound
 *   - a Fluent id used in code that no locale defines
 *   - a packaged XPI that is missing a file the client needs
 *
 * Usage: node tools/validate.mjs
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NAMESPACE = "zoteroSiYuan";

let failures = 0;
let checks = 0;

function check(name, ok, detail) {
  checks++;
  if (ok) {
    console.log(`  [OK]   ${name}`);
  } else {
    failures++;
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".scaffold") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(ROOT);

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

/* ----------------------- 3. Fluent ids resolve -------------------------- */

section("Fluent messages");
function ftlIds(file) {
  const ids = new Set();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([a-zA-Z][\w-]*)\s*=/);
    if (m) ids.add(m[1]);
  }
  return ids;
}
const localeFiles = {
  "en-US": join(ROOT, "addon", "locale", "en-US", "addon.ftl"),
  "zh-CN": join(ROOT, "addon", "locale", "zh-CN", "addon.ftl"),
};
const localeIds = {};
for (const [loc, file] of Object.entries(localeFiles)) {
  check(`${loc}/addon.ftl exists`, existsSync(file));
  if (existsSync(file)) localeIds[loc] = ftlIds(file);
}
if (localeIds["en-US"] && localeIds["zh-CN"]) {
  const en = localeIds["en-US"];
  const zh = localeIds["zh-CN"];
  check(
    "en-US and zh-CN define the same message ids",
    en.size === zh.size && [...en].every((id) => zh.has(id)),
    `en=${en.size} zh=${zh.size}`,
  );
  const used = new Set();
  for (const file of files.filter((f) => extname(f) === ".js" && f.includes("src"))) {
    for (const m of readFileSync(file, "utf8").matchAll(/getString\(\s*"([^"]+)"/g)) {
      used.add(m[1]);
    }
  }
  for (const id of used) {
    const bare = id.startsWith(`${NAMESPACE}-`) ? id.slice(NAMESPACE.length + 1) : id;
    check(
      `message "${id}" is defined in both locales`,
      en.has(bare) && zh.has(bare),
    );
  }
}

/* ---- 3b. the Fluent files must really parse ------------------------- */

section("Fluent syntax");
{
  // A regular expression is not enough here: Fluent reads `{` as the start
  // of a placeable, so a message whose text contains `{{variable}}` is not
  // a message at all — it is junk, and it never reaches the interface. The
  // real parser is the only thing that notices.
  const { parse } = await import("@fluent/syntax");
  for (const loc of ["en-US", "zh-CN"]) {    for (const name of ["addon.ftl", "preferences.ftl"]) {
      const file = join(ROOT, "addon", "locale", loc, name);
      if (!existsSync(file)) {
        continue;
      }
      const resource = parse(readFileSync(file, "utf8"));
      const junk = resource.body
        .filter((entry) => entry.type === "Junk")
        .map((entry) => {
          const content = entry.content;
          return typeof content === "string"
            ? content.split("\n")[0]
            : JSON.stringify(content).slice(0, 80);
        });
      check(
        `${loc}/${name} parses without junk`,
        junk.length === 0,
        junk.join(" | "),
      );
    }
  }

  // Every id the preferences pane asks for has to exist — and the ids have
  // to be the ones the interface really asks for.
  const xhtml = readFileSync(
    join(ROOT, "addon", "content", "preferences.xhtml"),
    "utf8",
  );
  const asked = [...xhtml.matchAll(/data-l10n-id="([^"]+)"/g)].map(
    (m) => m[1],
  );
  const defined = new Set();
  for (const loc of ["en-US", "zh-CN"]) {
    const file = join(ROOT, "addon", "locale", loc, "preferences.ftl");
    if (!existsSync(file)) {
      continue;
    }
    for (const entry of parse(readFileSync(file, "utf8")).body) {
      if (entry.type === "Message") {
        defined.add(entry.id.name);
      }
    }
  }
  for (const id of asked) {
    check(
      `the preferences pane's "${id}" is a real message`,
      defined.has(id),
    );
  }
}

/* ------------------ 5. the CLI search paths are correct ---------------- */

section("siyuan CLI search paths");
const { buildCandidatePaths } = await import(
  new URL("../src/modules/siyuan.js", import.meta.url).href
);
const home = process.env.USERPROFILE || process.env.HOME || "";
const localAppData = process.env.LOCALAPPDATA || "";
const roamingAppData = process.env.APPDATA || "";
const isWin = process.platform === "win32";
const candidates = buildCandidatePaths({
  home,
  localAppData,
  roamingAppData,
  isWin,
  isMac: process.platform === "darwin",
});

check(
  "the LocalAppData candidate is present",
  localAppData
    ? candidates.includes(
        `${localAppData}\\Programs\\SiYuan\\resources\\kernel\\siyuan.exe`,
      )
    : true,
  "n/a on this platform",
);
check(
  "the Roaming AppData candidate is not mistaken for the local one",
  !localAppData ||
    !candidates.includes(
      `${roamingAppData}\\Programs\\SiYuan\\resources\\kernel\\siyuan.exe`,
    ) ||
    !candidates.includes(
      `${localAppData}\\Programs\\SiYuan\\resources\\kernel\\siyuan.exe`,
    ),
);

// The plugin must find the CLI even when only the home directory is known:
// `Services.dirsvc` is not reachable in every scope a plugin runs in.
{
  const fromHome = buildCandidatePaths({ home, isWin: true });
  check(
    "a candidate can be derived from the home directory alone",
    fromHome.includes(
      `${home}\\AppData\\Local\\Programs\\SiYuan\\resources\\kernel\\siyuan.exe`,
    ),
    fromHome.join(" | "),
  );
}

// If SiYuan is installed on this machine, the real binary must be reachable.
const realCli = isWin
  ? `${localAppData}\\Programs\\SiYuan\\resources\\kernel\\siyuan.exe`
  : "/Applications/SiYuan.app/Contents/Resources/kernel/siyuan";
if (existsSync(realCli)) {
  check(
    `the installed siyuan.exe is among the candidates (${realCli})`,
    candidates.includes(realCli),
    "auto-detection would miss it",
  );
}
else {
  console.log(`  [SKIP] siyuan is not installed at ${realCli}`);
}

/* ------------------ 6. the HTTP fallback can find a workspace ------------ */

section("SiYuan HTTP fallback discovery");
{
  // The kernel counts *failed* authentications and locks itself out after
  // too many of them, so this must try the configured workspace first and
  // stop after a couple of tries — exactly like the plugin does.
  const preferred = process.env.SIYUAN_WORKSPACE || "D:\\siyi";
  const appDirs = [
    join(home, ".config", "siyuan"),
    join(home, "Library", "Application Support", "siyuan"),
    join(home, "AppData", "Roaming", "siyuan"),
  ];
  const workspaces = [];
  for (const appDir of appDirs) {
    const listPath = join(appDir, "workspace.json");
    if (!existsSync(listPath)) continue;
    let list = [];
    try {
      list = JSON.parse(readFileSync(listPath, "utf8"));
    }
    catch (e) {
      continue;
    }
    for (const entry of list) {
      const dir = typeof entry === "string" ? entry : entry.path;
      if (dir && !workspaces.includes(dir)) workspaces.push(dir);
    }
  }
  workspaces.sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : 0));

  let found = null;
  const errors = [];
  let attempts = 0;
  for (const dir of workspaces) {
    const confPath = join(dir, "conf", "conf.json");
    if (!existsSync(confPath)) continue;
    let conf;
    try {
      conf = JSON.parse(readFileSync(confPath, "utf8"));
    }
    catch (e) {
      continue;
    }
    if (!conf.api || !conf.api.token) continue;
    if (++attempts > 3) break;
    const port = conf.api.port || 6806;
    // The plugin verifies the token by authenticating; so does this test.
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/notebook/lsNotebooks`,
        {
          method: "POST",
          headers: {
            Authorization: `Token ${conf.api.token}`,
            "Content-Type": "application/json",
          },
          body: "{}",
        },
      );
      const body = await response.json();
      if (body.code === 0) {
        found = {
          dir,
          token: conf.api.token,
          port,
          notebooks: (body.data.notebooks || []).map((n) => n.name),
        };
        break;
      }
      errors.push(`${dir}: ${body.msg}`);
    }
    catch (e) {
      // kernel not running for this workspace — try the next one
      errors.push(`${dir}: ${e.message}`);
    }
  }
  const rateLimited = errors.some((e) =>
    /429|too many|认证失败次数过多|rate-limit/i.test(e),
  );
  if (found) {
    check(
      "a workspace with a working API token can be discovered",
      true,
    );
    console.log(
      `         → ${found.dir} (port ${found.port}, notebooks: ${found.notebooks.join(", ")})`,
    );
  }
  else if (rateLimited) {
    // The kernel locks itself out after too many *failed* authentications.
    // That is a state of the machine, not a defect of the plugin — and it
    // cannot be judged from here, so it is reported rather than failed.
    console.log(
      "  [SKIP] the SiYuan kernel is rate-limiting authentication attempts;" +
        " the discovery check cannot be judged right now",
    );
  }
  else {
    check(
      "a workspace with a working API token can be discovered",
      false,
      errors.length ? errors.join(" | ") : "no workspace authenticated",
    );
  }
}

/* --------------------- 7. the template engine still renders ---------------- */

section("Send template");
{
  const { DEFAULT_TEMPLATE, TEMPLATE_VARIABLES, renderTemplate } = await import(
    new URL("../src/modules/template.js", import.meta.url).href
  );
  const { collectMetadata } = await import(
    new URL("../src/modules/metadata.js", import.meta.url).href
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
}

/* --------------------- 8. inserting a variable at the caret -------------- */

section("Template editing");
{
  const { insertToken, variableToken } = await import(
    new URL("../src/modules/template-edit.js", import.meta.url).href
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
}

/* --------------------- 9. the index of sent annotations ------------------ */

section("Sent-annotation index");
{
  const {
    SiYuanIndex,
    parseAnnotationKey,
    annotationDeepLink,
    ZOTERO_LINK_PREFIX,
  } = await import(
    new URL("../src/modules/siyuan-index.js", import.meta.url).href
  );

  check(
    "the annotation key is read out of a deep link",
    parseAnnotationKey(
      "作者：X  来源：[论文](zotero://open/library/items/ATTACH01?annotation=ABCD1234&page=3)",
    ) === "ABCD1234",
    parseAnnotationKey(
      "来源：[论文](zotero://open/library/items/ATTACH01?annotation=ABCD1234&page=3)",
    ),
  );
  check(
    "a block without a deep link has no annotation key",
    parseAnnotationKey("作者：X  年份：2025") === "",
  );
  check(
    "a deep link without an annotation has no annotation key",
    parseAnnotationKey(`[x](${ZOTERO_LINK_PREFIX}ATTACH01)`) === "",
  );
  check(
    "the deep link points at the annotation",
    annotationDeepLink("ATTACH01", "ABCD1234", 3) ===
      "zotero://open/library/items/ATTACH01?annotation=ABCD1234&page=3",
    annotationDeepLink("ATTACH01", "ABCD1234", 3),
  );
  check(
    "a deep link without a page has no page",
    !/page=/.test(annotationDeepLink("ATTACH01", "ABCD1234", 0)),
  );

  const index = new SiYuanIndex();
  index.add("ABCD1234", "20260101000000-abcdefg");
  check("the index finds a block by annotation key", index.get("ABCD1234") === "20260101000000-abcdefg");
  check("the index knows nothing about an unknown annotation", index.get("NOPE") === "");
  check("the index ignores an empty key", index.get("") === "");
}

/* --------------------- 10. opening SiYuan without a prompt -------------- */

section("SiYuan launcher");
{
  const { parseHandlerExecutable } = await import(
    new URL("../src/modules/siyuan-launcher.js", import.meta.url).href
  );

  check(
    "a quoted handler yields the executable",
    parseHandlerExecutable(
      '"C:\\Program Files\\SiYuan\\SiYuan.exe" "%1"',
    ) === "C:\\Program Files\\SiYuan\\SiYuan.exe",
    parseHandlerExecutable('"C:\\Program Files\\SiYuan\\SiYuan.exe" "%1"'),
  );
  check(
    "an unquoted handler yields the executable",
    parseHandlerExecutable("C:\\SiYuan\\SiYuan.exe %1") ===
      "C:\\SiYuan\\SiYuan.exe",
    parseHandlerExecutable("C:\\SiYuan\\SiYuan.exe %1"),
  );
  check(
    "a single executable is handled",
    parseHandlerExecutable("C:\\SiYuan\\SiYuan.exe") ===
      "C:\\SiYuan\\SiYuan.exe",
  );
  check(
    "an empty handler yields nothing",
    parseHandlerExecutable("") === "" && parseHandlerExecutable(null) === "",
  );
}

/* --------------------- 11. the chrome package and its icon --------------- */

section("Chrome package");
{
  const {
    SIYUAN_ICON_SHAPES,
    SIYUAN_ICON_VIEWBOX,
    SVG_NS,
  } = await import(new URL("../src/modules/icons.js", import.meta.url).href);

  check(
    "the logo is inline SVG",
    SVG_NS === "http://www.w3.org/2000/svg" &&
      SIYUAN_ICON_SHAPES.length === 4,
    `${SIYUAN_ICON_SHAPES.length} shapes`,
  );
  check(
    "every shape of the logo has points and a colour",
    SIYUAN_ICON_SHAPES.every(
      (s) => typeof s.points === "string" && /^#[0-9A-F]{6}$/i.test(s.fill),
    ),
  );
  check(
    "the logo uses SiYuan's own colours",
    SIYUAN_ICON_SHAPES.some((s) => s.fill.toLowerCase() === "#da3939") &&
      SIYUAN_ICON_SHAPES.some((s) => s.fill.toLowerCase() === "#3b3e43"),
  );
  check(
    "the logo has a viewBox",
    /^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/.test(SIYUAN_ICON_VIEWBOX),
    SIYUAN_ICON_VIEWBOX,
  );
  check(
    "the logo is not referenced by URL",
    // A chrome:// URL for a plugin-registered package is unreadable in the
    // reader's content process, so the logo has to be inline.
    !readFileSync(join(ROOT, "src", "index.js"), "utf8").includes(
      "chrome://${CHROME_PACKAGE}",
    ),
  );
}

/* --------------------- 12. the reader's sidebar contract ------------------ */

section("Reader sidebar contract");
{
  // The reader puts every append() call into a box of its own, so the
  // button and the marker have to be appended together — otherwise they end
  // up in two boxes, neither of them can see the other, and the sidebar
  // shows two markers.
  const source = readFileSync(join(ROOT, "src", "index.js"), "utf8");
  const renderHandler = source.match(
    /_onRenderSidebarAnnotationHeader\(event\)\s*\{([\s\S]*?)\r?\n  \}\r?\n/,
  );
  const body = renderHandler ? renderHandler[1] : "";
  const appendCalls = (body.match(/event\.append\(/g) || []).length;
  check(
    "the button and the marker are appended in one call",
    appendCalls === 1 && body.includes("event.append(...nodes)"),
    `${appendCalls} append() calls`,
  );
  check(
    "the marker is only removed when it was put in by hand",
    source.includes('querySelectorAll("[data-zsi-manual]")'),
  );
  check(
    "the lookup for an existing marker covers the whole document",
    source.includes("_existingMarker") &&
      source.includes('.zotero-siyuan-sent-link'),
  );
  check(
    "the context menu does not use an undefined document",
    // `doc` has to come from the reader, not from the event.
    source.includes("const doc = this._readerDoc(reader);"),
  );
  check(
    "the reader's document is remembered while the sidebar renders",
    source.includes("this._readerDocs.set(event.reader, doc)"),
  );
  check(
    "a reader that was drawn before the plugin gets the button",
    source.includes("_patchReaderSidebars") && source.includes("_annotationKeyOf"),
  );
  check(
    "only the box of an annotation is patched, not the toolbar's",
    // The reader has boxes of its own — the toolbar, for one. Only the
    // preview of an annotation carries its key.
    /_annotationKeyOf\(box\)\s*\{[\s\S]*?closest\("\.preview"\)/.test(source),
  );
  check(
    "the button is built in one place, for both ways in",
    source.includes("_createButton(doc, annotation, event.reader)") &&
      source.includes("_createButton(doc, this._annotationFromItem(item), reader)"),
  );
}

/* ----------------- 13. the picture of an area selection ------------------ */

section("Area-selection pictures");
{
  // A "框选" annotation has no text: what the user selected is a picture.
  // Without that picture the note is empty, so the picture has to travel
  // with it into the workspace.
  const imageFile = join(ROOT, "src", "modules", "siyuan-image.js");
  check("the picture module exists", existsSync(imageFile));
  const index = readFileSync(join(ROOT, "src", "index.js"), "utf8");

  check(
    "the plugin imports the picture module",
    index.includes('from "./modules/siyuan-image.js"'),
  );
  check(
    "the note is built with the picture",
    /_buildContent\([^)]*\)\s*\{[\s\S]*?await this\._preparePicture\(/.test(index),
  );
  check(
    "the batch path carries the picture along",
    // `_annotationFromItem` holds the item, and the item knows which
    // library it belongs to — that is what the cache path is built from.
    // Without it a group library would lose every picture.
    /_annotationFromItem\(item\)\s*\{[\s\S]*?imagePath:\s*annotationImagePath\(item\)/
      .test(index),
  );
  check(
    "the picture's alt text is localized",
    index.includes('getString("zoteroSiYuan-image-alt"'),
  );
  check(
    "the picture module stays inside the sandbox",
    // `OS` is not on the plugin's whitelist — only `IOUtils` is.
    !/\bOS\.(File|Path)\b/.test(
      existsSync(imageFile) ? readFileSync(imageFile, "utf8") : "",
    ),
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
    const selfTest = readFileSync(
      join(ROOT, "src", "modules", "selftest.js"),
      "utf8",
    );
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
      selfTest.includes("picturesBefore = await picturesInWorkspace()") &&
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
  } = await import(
    new URL("../src/modules/siyuan-image.js", import.meta.url).href
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

  // --- the picture really lands in the workspace -------------------------
  // Outside Zotero there is no `IOUtils`, so a small stand-in is put in
  // its place — it only has to behave like the real one.
  const disk = new Map();
  const dirs = new Set();
  const hadPathUtils = "PathUtils" in globalThis;
  const hadIOUtils = "IOUtils" in globalThis;
  const oldPathUtils = globalThis.PathUtils;
  const oldIOUtils = globalThis.IOUtils;
  globalThis.PathUtils = {
    join: (...parts) => {
      // `PathUtils.join` goes through nsIFile, and nsIFile does not take
      // a component that holds a separator — "assets/name.png" is not a
      // name, and appending it fails.
      for (const part of parts.slice(1)) {
        if (/[\\/]/.test(part)) {
          throw new Error(
            "Could not append to path: NS_ERROR_FILE_UNRECOGNIZED_PATH",
          );
        }
      }
      return parts.join("/").replace(/\/{2,}/g, "/");
    },
  };
  globalThis.IOUtils = {
    exists: async (path) => disk.has(path),
    // The real `makeDirectory` throws when the directory is already
    // there, unless `ignoreExisting` says otherwise. The assets folder
    // usually is — and the picture then never arrives.
    makeDirectory: async (path, options = {}) => {
      if (dirs.has(path) && !options.ignoreExisting) {
        throw new Error(`the directory already exists: ${path}`);
      }
      dirs.add(path);
    },
    newFile: undefined,
    read: async (path) => disk.get(path),
    // The real `IOUtils.write` takes the path itself — there is no
    // `IOUtils.newFile`, and the stand-in must not invent one.
    write: async (path, data) => {
      if (typeof path !== "string") {
        throw new TypeError("IOUtils.write takes a path");
      }
      disk.set(path, data);
    },
    remove: async (path) => {
      disk.delete(path);
    },
  };
  try {
    check(
      "the assets folder is the workspace's own",
      assetsDir("D:/siyi").endsWith("data/assets"),
      assetsDir("D:/siyi"),
    );

    // The assets folder is normally already there — and the real
    // `makeDirectory` treats that as an error unless it is told not to.
    // (Zotero's own `osfile.mjs` has to say so explicitly, too.)
    {
      dirs.add("D:/siyu2/data/assets");
      let failed = "";
      try {
        await exportPicture(
          "D:/siyu2",
          { path: "C:/zotero/cache/library/ABCD1234.png" },
          "zotero-siyuan-ABCD1234-20261026130000",
        );
      }
      catch (e) {
        failed = String(e && e.message ? e.message : e);
      }
      check(
        "the picture lands in a folder that is already there",
        failed === "",
        failed,
      );
    }

    // A stand-in for the file API must not be more forgiving than the
    // real one: `IOUtils.newFile` does not exist, and a picture that
    // calls it never arrives.
    check(
      "the plugin only uses file APIs that really exist",
      !/IOUtils\.newFile\s*\(/.test(
        existsSync(imageFile) ? readFileSync(imageFile, "utf8") : "",
      ),
      "IOUtils.newFile is not an API — IOUtils.write takes the path",
    );

    const bytes = new Uint8Array([1, 2, 3, 4]);
    disk.set("C:/zotero/cache/library/ABCD1234.png", bytes);
    let copied = { asset: "", file: "" };
    let copyError = "";
    try {
      copied = await exportPicture(
        "D:/siyi",
        { path: "C:/zotero/cache/library/ABCD1234.png" },
        "zotero-siyuan-ABCD1234-20261026130000",
      );
    }
    catch (e) {
      copyError = String(e && e.message ? e.message : e);
    }
    check(
      "the picture is copied into the workspace's assets",
      copyError === "" &&
        copied.asset === "assets/zotero-siyuan-ABCD1234-20261026130000.png" &&
        copied.file ===
          "D:/siyi/data/assets/zotero-siyuan-ABCD1234-20261026130000.png" &&
        disk.get("D:/siyi/data/assets/zotero-siyuan-ABCD1234-20261026130000.png") ===
          bytes,
      copyError || copied.asset,
    );

    const dataURL = `data:image/png;base64,${Buffer.from("PNG").toString("base64")}`;
    let written = { asset: "", file: "" };
    let writeError = "";
    try {
      written = await exportPicture(
        "D:/siyi",
        { dataURL },
        "zotero-siyuan-ABCD1234-20261026130000",
      );
    }
    catch (e) {
      writeError = String(e && e.message ? e.message : e);
    }
    const writtenBytes = disk.get(
      "D:/siyi/data/assets/zotero-siyuan-ABCD1234-20261026130000.png",
    );
    check(
      "a picture that only exists as a data URL is written out",
      writeError === "" &&
        written.asset === "assets/zotero-siyuan-ABCD1234-20261026130000.png" &&
        writtenBytes &&
        writtenBytes.length === 3 &&
        String.fromCharCode(...writtenBytes) === "PNG",
      writeError || String(writtenBytes && writtenBytes.length),
    );

    check(
      "there is no picture, there is no path",
      (await exportPicture("D:/siyi", null, "x")).asset === "",
    );

    // --- a picture that nobody refers to is litter ----------------------
    {
      let path = "";
      let error = "";
      try {
        path = pictureFile("D:/siyi", "assets/a.png");
      }
      catch (e) {
        error = String(e && e.message ? e.message : e);
      }
      check(
        "the picture's real path is inside the workspace's assets",
        error === "" && path === "D:/siyi/data/assets/a.png",
        error || path,
      );
    }
    check(
      "the pictures a Markdown refers to are found",
      pictureAssetNames(
        "> ![框选](assets/zotero-siyuan-ABCD1234-20261026130000.png)",
      ).join(",") === "zotero-siyuan-ABCD1234-20261026130000.png" &&
        pictureAssetNames("nothing here").length === 0,
      pictureAssetNames("![a](assets/x.png) and ![b](assets/y.png)").join(","),
    );
    await removePicture("D:/siyi/data/assets/zotero-siyuan-ABCD1234-20261026130000.png");
    check(
      "a picture can be taken back out of the workspace",
      !disk.has("D:/siyi/data/assets/zotero-siyuan-ABCD1234-20261026130000.png"),
    );
  }
  finally {
    if (hadPathUtils) {
      globalThis.PathUtils = oldPathUtils;
    }
    else {
      delete globalThis.PathUtils;
    }
    if (hadIOUtils) {
      globalThis.IOUtils = oldIOUtils;
    }
    else {
      delete globalThis.IOUtils;
    }
  }

  // --- the note carries the picture --------------------------------------
  const { collectMetadata } = await import(
    new URL("../src/modules/metadata.js", import.meta.url).href
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
    await import(new URL("../src/modules/template.js", import.meta.url).href);
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
    const source = readFileSync(join(ROOT, "src", "index.js"), "utf8");
    check(
      "the note really goes through that",
      source.includes("appendPicture(text, image)"),
    );
  }

  // --- the template editor ------------------------------------------------
  {
    const { insertVariable } = await import(
      new URL("../src/modules/template-edit.js", import.meta.url).href
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

/* --------------------- 14. the fixes must not come back ------------------ */

section("Regression guards");
{
  // --- the template engine must not leave a stray {{/if}} behind -------
  {
    const { renderTemplate } = await import(
      new URL("../src/modules/template.js", import.meta.url).href
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
      new URL("../src/modules/template.js", import.meta.url).href
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
      new URL("../src/modules/siyuan-index.js", import.meta.url).href
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
    const source = readFileSync(
      join(ROOT, "src", "modules", "selftest.js"),
      "utf8",
    );
    check(
      "the self test does not replace the plugin's own methods",
      !/addon\._(append|send|resolveNotebook|getParentItem)\s*=/.test(source),
      "a replaced method would swallow a real send that happens meanwhile",
    );
    const index = readFileSync(join(ROOT, "src", "index.js"), "utf8");
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
      new URL("../src/modules/metadata.js", import.meta.url).href
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
}

/* --------------------------- 4. packaged XPI ---------------------------- */

section("Packaged XPI");
const xpi = join(ROOT, "zotero-siyuan.xpi");
if (!existsSync(xpi)) {
  check("zotero-siyuan.xpi exists (run `npm run build`)", false);
} else {
  const raw = readFileSync(xpi);
  check("zotero-siyuan.xpi is a ZIP archive", raw[0] === 0x50 && raw[1] === 0x4b);
  const text = raw.toString("latin1");
  for (const needed of [
    "manifest.json",
    "bootstrap.js",
    "prefs.js",
    `content/scripts/${NAMESPACE}.js`,
    `locale/en-US/${NAMESPACE}-addon.ftl`,
    `locale/zh-CN/${NAMESPACE}-addon.ftl`,
  ]) {
    check(`XPI contains ${needed}`, text.includes(needed));
  }
  // The local header names are enough to read manifest.json / prefs.js back.
  const readFromArchive = (name) => {
    const marker = Buffer.from(name, "utf8");
    let at = 0;
    while ((at = raw.indexOf(marker, at)) !== -1) {
      const localHeader = at - 30;
      if (localHeader >= 0 && raw.readUInt32LE(localHeader) === 0x04034b50) {
        const method = raw.readUInt16LE(localHeader + 8);
        const compSize = raw.readUInt32LE(localHeader + 18);
        const start = at + marker.length;
        const data = raw.subarray(start, start + compSize);
        if (method === 0) return data.toString("utf8");
        return zlibInflateRaw(data).toString("utf8");
      }
      at += marker.length;
    }
    return null;
  };
  const manifestText = readFromArchive("manifest.json");
  if (manifestText) {
    let manifest = null;
    try {
      manifest = JSON.parse(manifestText);
    }
    catch (e) {
      /* reported below */
    }
    if (!manifest) {
      check("manifest.json is valid JSON", false);
    } else {
      const z = (manifest.applications || {}).zotero || {};
      check("manifest has applications.zotero.id", typeof z.id === "string" && z.id.includes("@"), z.id);
      check("manifest has strict_min_version", typeof z.strict_min_version === "string", z.strict_min_version);
      check("manifest has strict_max_version", typeof z.strict_max_version === "string", z.strict_max_version);
      check("manifest_version is 2", manifest.manifest_version === 2);
      // Firefox caches an installed extension by its id *and version*: replace
      // the .xpi in the profile with the same version and the old code keeps
      // running. So the version has to move with every build.
      const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
      check(
        "the manifest version matches package.json",
        manifest.version === pkg.version,
        `manifest ${manifest.version} vs package ${pkg.version}`,
      );
    }
  } else {
    check("manifest.json readable from the XPI", false);
  }
  const prefsText = readFromArchive("prefs.js");
  if (prefsText) {
    const bad = prefsText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//") && !l.startsWith("#") && !/^pref\("/.test(l));
    check(
      "prefs.js only contains double-quoted pref(...) lines",
      bad.length === 0,
      bad.join(" | "),
    );
  } else {
    check("prefs.js readable from the XPI", false);
  }
}

// Minimal raw-deflate inflater (the archive stores deflate streams).
function zlibInflateRaw(buf) {
  return zlib.inflateRawSync(buf);
}

console.log(
  `\n${failures ? "FAILED" : "PASSED"}: ${checks - failures}/${checks} checks passed`,
);
process.exit(failures ? 1 : 0);
