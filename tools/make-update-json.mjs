/**
 * Write the update manifest that Zotero polls for new versions.
 *
 * The plugin's own manifest points at `releases/latest/download/update.json`,
 * so the file has to sit next to the XPI of the newest release — which is
 * exactly what the release workflow uploads.
 *
 * The shape is the one Zotero expects:
 *
 *   { "addons": { "<id>": { "updates": [ { version, update_link, … } ] } } }
 *
 * Usage: node tools/make-update-json.mjs [--out update.json]
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const out = join(
	ROOT,
	outAt === -1 ? "update.json" : args[outAt + 1] || "update.json",
);

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const manifest = JSON.parse(
	readFileSync(join(ROOT, "addon", "manifest.json"), "utf8"),
);

const xpi = join(ROOT, "zotero-siyuan.xpi");
if (!existsSync(xpi)) {
	console.error(`no ${xpi} — run the build first`);
	process.exit(1);
}

const repository = String(pkg.repository?.url || "")
	.replace(/^git\+/, "")
	.replace(/\.git$/, "");
if (!repository) {
	console.error("package.json has no repository url");
	process.exit(1);
}

const version = pkg.version;
const xpiName = `${pkg.name}.xpi`;
const hash = createHash("sha512").update(readFileSync(xpi)).digest("hex");
const zotero = manifest.applications?.zotero || {};

const data = {
	addons: {
		[pkg.config.addonID]: {
			updates: [
				{
					version,
					update_link: `${repository}/releases/download/v${version}/${xpiName}`,
					update_hash: `sha512:${hash}`,
					applications: {
						zotero: {
							strict_min_version: zotero.strict_min_version,
							strict_max_version: zotero.strict_max_version,
						},
					},
				},
			],
		},
	},
};

writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`, "utf8");
console.log(`update.json → ${out} (${version})`);
