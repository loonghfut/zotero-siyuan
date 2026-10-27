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
 *
 * The workspace may also come from the `SIYUAN_WORKSPACE` environment
 * variable, or from SiYuan itself: `siyuan workspace info` answers with
 * the workspace that is open right now. There is no built-in path — one
 * that is right on a single machine is wrong on every other one.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
function option(name, fallback = "") {
	const at = args.indexOf(`--${name}`);
	return at === -1 ? fallback : args[at + 1];
}

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

// The workspace the commands work on. It is filled in below, once the
// three sources have been asked — but `cli()` needs it, so the name has to
// exist before the first call.
let workspace = "";

/**
 * Run the siyuan CLI.
 *
 * @param {String[]} argv - the command and its arguments
 * @param {Boolean} [withWorkspace] - append `-w <workspace>`; off for the
 *   commands that ask *about* the workspace
 * @returns {String} what the command printed
 */
function cli(argv, withWorkspace = true) {
	const executable = findCLI();
	if (!executable) {
		throw new Error("the siyuan CLI was not found");
	}
	const full =
		withWorkspace && workspace ? argv.concat(["-w", workspace]) : argv;
	return execFileSync(executable, full, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

/* -------------------------------------------------------- the workspace */

/**
 * The workspace to work in.
 *
 * Three sources, in this order:
 *
 *   1. `--workspace` on the command line — the explicit one wins
 *   2. the `SIYUAN_WORKSPACE` environment variable
 *   3. SiYuan itself: `siyuan workspace info` answers with the workspace
 *      that is open right now
 *
 * A path that is built into the script is right on exactly one machine and
 * wrong on every other one — and a wrong one only shows up much later, as
 * "the daily note was not found".
 *
 * @returns {String} the workspace directory, or "" when there is none
 */
function resolveWorkspace() {
	const explicit = String(option("workspace", "") || "").trim();
	if (explicit) {
		return explicit;
	}
	const fromEnv = String(process.env.SIYUAN_WORKSPACE || "").trim();
	if (fromEnv) {
		return fromEnv;
	}
	// SiYuan knows which workspace it has open — that is the one the user
	// is looking at, and asking it beats guessing a path.
	try {
		const data = JSON.parse(cli(["workspace", "info", "--format", "json"], false));
		return String((data && data.path) || "").trim();
	}
	catch (e) {
		return "";
	}
}

workspace = resolveWorkspace();

if (!workspace) {
	console.error(
		"No SiYuan workspace.\n" +
			"Give one on the command line, or in the environment:\n" +
			'  node tools/siyuan-cleanup.mjs --workspace "D:\\SiYuan\\workspace"\n' +
			"  set SIYUAN_WORKSPACE=D:\\SiYuan\\workspace",
	);
	process.exit(1);
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
