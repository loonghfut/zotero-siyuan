/**
 * Bump the version before every build.
 *
 * Firefox caches an installed extension's manifest by id *and version*, so
 * replacing the `.xpi` in a profile with the same version can leave the
 * previous build running. Bumping the patch level on every build removes
 * that footgun entirely.
 *
 * The manifest and `package.json` are kept in step — `npm run check`
 * compares them.
 *
 * The version is also written into the code, so the plugin can say which
 * build is really running. The addon manager keeps its *own* copy of the
 * version, and that copy can be a version behind the code: the script is
 * read fresh, the cached manifest is not.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST = join(ROOT, "addon", "manifest.json");
const PACKAGE = join(ROOT, "package.json");
const VERSION_FILE = join(ROOT, "src", "version.js");

function bump(version) {
	const parts = String(version || "0.0.0").split(".");
	while (parts.length < 3) {
		parts.push("0");
	}
	const [major, minor, patch] = parts.map((n) => Number(n) || 0);
	return `${major}.${minor}.${patch + 1}`;
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const pkg = JSON.parse(readFileSync(PACKAGE, "utf8"));

// Whichever of the two is ahead decides the next number.
const next = bump(
	manifest.version === pkg.version ? manifest.version : pkg.version,
);

manifest.version = next;
pkg.version = next;

writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
writeFileSync(PACKAGE, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

// The version goes into the code as well, so that the running plugin can
// say which build it is — the addon's own cache cannot be trusted for it.
writeFileSync(
	VERSION_FILE,
	`/**
 * The version of this build.
 *
 * Written by \`tools/bump-version.mjs\` on every build, so it always says
 * the same thing as the manifest. The addon manager keeps its own copy of
 * the version, and that copy can be a version behind the code that is
 * really running.
 */
export const VERSION = ${JSON.stringify(next)};
`,
	"utf8",
);

console.log(`version → ${next}`);
