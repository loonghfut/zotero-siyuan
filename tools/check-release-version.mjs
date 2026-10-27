/**
 * Check that the tag being published is the version of the sources.
 *
 * The tag is what the world sees: the release is named after it, and the
 * download link of the update manifest is built from it. A tag that says
 * `v0.2.96` while the manifest says `0.2.95` publishes an artifact that
 * calls itself something else — and the plugin would never be able to
 * update itself to it.
 *
 * Usage: node tools/check-release-version.mjs v0.2.96
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const tag = (process.argv[2] || process.env.TAG || "").trim();

if (!tag) {
	console.error("no tag was given");
	process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const manifest = JSON.parse(
	readFileSync(join(ROOT, "addon", "manifest.json"), "utf8"),
);
const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));

const problems = [];
if (tag !== `v${pkg.version}`) {
	problems.push(`the tag says "${tag}", the version says "v${pkg.version}"`);
}
if (manifest.version !== pkg.version) {
	problems.push(
		`the manifest says ${manifest.version}, package.json says ${pkg.version}`,
	);
}

/*
 * The lock file names the version as well. `npm ci` compares it with
 * package.json and refuses to install when the two differ — so a lock
 * file that was left behind does not only look untidy, it breaks the
 * build of the release itself.
 */
if (lock.version !== pkg.version) {
	problems.push(
		`package-lock.json says ${lock.version}, package.json says ${pkg.version}`,
	);
}
if (lock.packages && lock.packages[""] &&
	lock.packages[""].version !== pkg.version) {
	problems.push(
		`package-lock.json's root package says ` +
			`${lock.packages[""].version}, package.json says ${pkg.version}`,
	);
}

if (problems.length) {
	for (const problem of problems) {
		console.error(problem);
	}
	console.error("the release was not published");
	process.exit(1);
}

console.log(`${tag} → ${pkg.version}`);
