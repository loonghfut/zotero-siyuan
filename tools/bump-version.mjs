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

/*
 * The bump can be switched off.
 *
 * A local build wants a new version every time — that is what keeps
 * Firefox from running yesterday's code. The CI build does not: it
 * verifies the *committed* sources, and a build that rewrote the version
 * would leave the working tree dirty and the artifact claiming to be a
 * release that never happened. So the CI build asks for the version to
 * stay where it is.
 */
const skip = process.argv.includes("--no-bump")
	|| process.env.SKIP_VERSION_BUMP === "1";

if (skip) {
	if (manifest.version !== pkg.version) {
		console.error(
			`the manifest says ${manifest.version}, package.json says ` +
				`${pkg.version} — they have to agree before a build`,
		);
		process.exit(1);
	}
	const written = /export const VERSION = "([^"]+)";/.exec(
		readFileSync(VERSION_FILE, "utf8"),
	);
	if (!written || written[1] !== pkg.version) {
		console.error(
			`src/version.js says ${written ? written[1] : "nothing"}, ` +
				`package.json says ${pkg.version} — they have to agree ` +
				"before a build",
		);
		process.exit(1);
	}
	console.log(`version → ${pkg.version} (not moved)`);
	process.exit(0);
}

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
