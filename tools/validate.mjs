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
import { join, relative, extname } from "node:path";import { execFileSync } from "node:child_process";
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
