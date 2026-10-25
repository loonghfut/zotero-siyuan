/**
 * Copy the freshly built XPI to the project root.
 *
 * The scaffold packs into `.scaffold/build/`; the root copy is what gets
 * installed and what `npm run check` inspects. Keeping the two in sync in
 * one step avoids validating yesterday's build.
 */
import { copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUILD_DIR = join(ROOT, ".scaffold", "build");
const TARGET = join(ROOT, "zotero-siyuan.xpi");

if (!existsSync(BUILD_DIR)) {
	console.error(`No build output in ${BUILD_DIR} — run the build first.`);
	process.exit(1);
}

const candidates = readdirSync(BUILD_DIR)
	.filter((name) => name.endsWith(".xpi"))
	.map((name) => join(BUILD_DIR, name))
	.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

if (!candidates.length) {
	console.error(`No .xpi in ${BUILD_DIR} — run the build first.`);
	process.exit(1);
}

const source = candidates[0];
copyFileSync(source, TARGET);
console.log(`synced ${source} → ${TARGET}`);
