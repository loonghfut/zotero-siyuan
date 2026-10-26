/**
 * Remove blocks from a SiYuan daily note — used to clean up what the
 * plugin's self test leaves behind.
 *
 * The blocks are deleted through the siyuan CLI rather than the HTTP API:
 * the kernel counts *failed* authentications and locks itself out after too
 * many of them, and the CLI authenticates without that risk.
 *
 * Usage:
 *   node tools/siyuan-cleanup.mjs --workspace D:\SiYuan\workspace --ids 2026...,2026...
 *   node tools/siyuan-cleanup.mjs --workspace D:\SiYuan\workspace --marker ZoteroSiYuanSelfTest
 *   node tools/siyuan-cleanup.mjs --workspace D:\SiYuan\workspace --list
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
function option(name, fallback = "") {
	const at = args.indexOf(`--${name}`);
	return at === -1 ? fallback : args[at + 1];
}

const workspace = option("workspace", "D:\\siyi");
const ids = option("ids")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
const marker = option("marker", "");
const listOnly = args.includes("--list") || (!ids.length && !marker);

/* ----------------------------------------------------------- the CLI path */

const CLI_CANDIDATES = [
	join(process.env.LOCALAPPDATA || "", "Programs", "SiYuan", "resources", "kernel", "siyuan.exe"),
	"C:\\Program Files\\SiYuan\\resources\\kernel\\siyuan.exe",
];

function findCLI() {
	for (const candidate of CLI_CANDIDATES) {
		if (candidate && existsSync(candidate)) {
			return candidate;
		}
	}
	return "";
}

function cli(args) {
	const executable = findCLI();
	if (!executable) {
		throw new Error("the siyuan CLI was not found");
	}
	return execFileSync(executable, args.concat(["-w", workspace]), {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

/* ------------------------------------------------- locate today's note file */

function walk(dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else if (entry.name.endsWith(".sy")) out.push(full);
	}
	return out;
}

function readNote(file) {
	try {
		const doc = JSON.parse(readFileSync(file, "utf8"));
		return doc && doc.Properties ? doc : null;
	}
	catch (e) {
		return null;
	}
}

function noteText(node, parts = []) {
	if (node.Type === "NodeText") {
		parts.push(node.Data || "");
	}
	if (node.CalloutTitle) {
		parts.push(node.CalloutTitle);
	}
	for (const child of node.Children || []) {
		noteText(child, parts);
	}
	return parts.join("\n");
}

const dataDir = join(workspace, "data");
const files = walk(dataDir);
const today = new Date();
const stamp = [
	today.getFullYear(),
	String(today.getMonth() + 1).padStart(2, "0"),
	String(today.getDate()).padStart(2, "0"),
].join("");

let noteFile = "";
let note = null;
for (const file of files) {
	const doc = readNote(file);
	if (doc && doc.Properties[`custom-dailynote-${stamp}`]) {
		noteFile = file;
		note = doc;
		break;
	}
}

if (!note) {
	console.error(`No daily note for ${stamp} under ${dataDir}`);
	process.exit(1);
}

console.log(`daily note: ${noteFile}`);

/* ------------------------------------------------------------ pick the blocks */

const children = note.Children || [];
const targets = [];

if (ids.length) {
	for (const child of children) {
		if (ids.includes(child.ID)) {
			targets.push(child);
		}
	}
}
else if (marker) {
	for (const child of children) {
		if (noteText(child).includes(marker)) {
			targets.push(child);
		}
	}
}
if (listOnly) {
	console.log(`\n${children.length} top-level blocks:`);
	for (const child of children) {
		const text = noteText(child).replace(/\s+/g, " ").trim();
		console.log(`  ${child.ID}  ${child.Type}  ${text.slice(0, 90)}`);
	}
	process.exit(0);
}

if (!targets.length) {
	console.log("nothing to delete");
	process.exit(0);
}

/* ------------------------------------------------------------------- delete */

for (const node of targets) {
	const text = noteText(node).replace(/\s+/g, " ").trim();
	cli(["block", "delete", "--id", node.ID]);
	console.log(`deleted ${node.ID}  ${node.Type}  ${text.slice(0, 70)}`);
}

console.log(`\n${targets.length} block(s) deleted`);
