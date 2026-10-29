/**
 * Zotero → SiYuan — diagnostics.
 *
 * Collects the environment facts that explain a failure: which paths the
 * plugin looks at, whether the CLI can be launched, what the SiYuan kernel
 * answers. The result is written to a JSON report in the temp directory so
 * it can be inspected without a GUI round-trip.
 *
 * Every probe is independent and guarded: one failing probe must never stop
 * the report from being written — the report *is* the point.
 *
 * The end-to-end self test lives in `selftest.js`.
 */

import { tempFilePath, homeDir } from "../utils/paths.js";
import { responseText } from "../utils/http.js";
import { buildCandidatePaths } from "./siyuan-process.js";

const REPORT_FILE = "zotero-siyuan-diagnostics.json";

function reportPath() {
	return tempFilePath(REPORT_FILE);
}

/**
 * Run one probe. A failing probe becomes an entry, never an exception.
 * @param {String} name
 * @param {Function} fn
 */
async function step(name, fn) {
	const entry = { name };
	const started = Date.now();
	try {
		entry.ok = true;
		entry.value = await fn();
	}
	catch (e) {
		entry.ok = false;
		entry.error = e && e.message ? e.message : String(e);
	}
	entry.ms = Date.now() - started;
	return entry;
}

async function writeReport(report) {
	const path = reportPath();
	try {
		await Zotero.File.putContentsAsync(path, JSON.stringify(report, null, 2));
	}
	catch (e) {
		Zotero.debug(`ZoteroSiYuan: could not write the report: ${e}`);
	}
	return path;
}

/** The platform, without depending on an API that may not exist. */
function osPlatform() {
	try {
		if (typeof Zotero.getOSPlatform === "function") {
			return Zotero.getOSPlatform();
		}
	}
	catch (e) {
		// fall through
	}
	if (Zotero.isWin) {
		return "win";
	}
	if (Zotero.isMac) {
		return "mac";
	}
	return "linux";
}

/**
 * Collect diagnostics about the environment. Used when something fails, to
 * work out why.
 */
export async function runDiagnostics({ executable = "" } = {}) {
	const report = {
		at: new Date().toISOString(),
		zoteroVersion: Zotero.version,
		steps: [],
	};

	// Nothing may escape before the report is written.
	try {
		await collectDiagnostics(report, executable);
	}
	catch (e) {
		report.fatal = e && e.message ? e.message : String(e);
	}

	report.path = await writeReport(report);
	Zotero.debug(`ZoteroSiYuan: diagnostics written to ${report.path}`);
	return report;
}

async function collectDiagnostics(report, executable) {
	report.platform = osPlatform();
	report.isWin = !!Zotero.isWin;
	report.isMac = !!Zotero.isMac;

	/* --- 1. what the plugin can see of the system ---------------------- */

	report.steps.push(
		await step("the globals the plugin relies on", () => ({
			Services: typeof Services,
			ServicesDirSvc:
				typeof Services !== "undefined" && Services
					? typeof Services.dirsvc
					: "n/a",
			ServicesEnv:
				typeof Services !== "undefined" && Services
					? typeof Services.env
					: "n/a",
			PathUtils: typeof PathUtils,
			ChromeUtils: typeof ChromeUtils,
			IOUtils: typeof IOUtils,
			Zotero: typeof Zotero,
			ZoteroIsWin: typeof Zotero.isWin,
			ZoteroGetOSPlatform: typeof Zotero.getOSPlatform,
			ZoteroMainWindow: (() => {
				try {
					return !!Zotero.getMainWindow();
				}
				catch (e) {
					return `error: ${e.message}`;
				}
			})(),
		})),
	);

	report.steps.push(
		await step("Services.dirsvc.get('Home')", () => {
			const file = Services.dirsvc.get("Home");
			return { type: typeof file, path: file && file.path };
		}),
	);

	report.steps.push(
		await step("Services.dirsvc.get('LocalAppData')", () => {
			const file = Services.dirsvc.get("LocalAppData");
			return { type: typeof file, path: file && file.path };
		}),
	);

	report.steps.push(
		await step("PathUtils.homeDir / tempDir", () => ({
			homeDir: PathUtils.homeDir,
			tempDir: PathUtils.tempDir,
		})),
	);

	report.steps.push(
		await step("the environment variables", () => ({
			LOCALAPPDATA: Services.env.get("LOCALAPPDATA"),
			APPDATA: Services.env.get("APPDATA"),
			USERPROFILE: Services.env.get("USERPROFILE"),
			ProgramFiles: Services.env.get("ProgramFiles"),
			ProgramW6432: Services.env.get("ProgramW6432"),
		})),
	);

	/* --- 2. where the CLI could be ------------------------------------- */

	const localAppData = (() => {
		try {
			return Services.env.get("LOCALAPPDATA") || "";
		}
		catch (e) {
			return "";
		}
	})();
	const programFiles = (() => {
		try {
			return Services.env.get("ProgramFiles") || "";
		}
		catch (e) {
			return "";
		}
	})();
	const roamingAppData = (() => {
		try {
			return Services.env.get("APPDATA") || "";
		}
		catch (e) {
			return "";
		}
	})();

	// The same list the CLI lookup uses, so the report explains exactly
	// what a send would have tried.
	const candidates = [];
	if (executable) {
		candidates.push(
			Zotero.isWin ? executable.replace(/\//g, "\\") : executable,
		);
	}
	for (const candidate of buildCandidatePaths({
		home: homeDir(),
		localAppData,
		roamingAppData,
		programFiles,
		isWin: Zotero.isWin,
		isMac: Zotero.isMac,
	})) {
		if (!candidates.includes(candidate)) {
			candidates.push(candidate);
		}
	}
	report.candidates = candidates;

	// The first candidate that is really there is the one worth launching;
	// on a machine without SiYuan the first one is still better than none.
	let primary = candidates[0] || "";
	for (const candidate of candidates) {
		try {
			await IOUtils.stat(candidate);
			primary = candidate;
			break;
		}
		catch (e) {
			// not there — keep looking
		}
	}

	report.steps.push(
		await step("PathUtils.isAbsolute(candidate)", () => ({
			candidate: primary,
			isAbsolute: PathUtils.isAbsolute(primary),
			hasNormalize: typeof PathUtils.normalize === "function",
			hasJoin: typeof PathUtils.join === "function",
		})),
	);

	report.steps.push(
		await step("IOUtils.stat(candidate)", async () => {
			const stat = await IOUtils.stat(primary);
			return {
				candidate: primary,
				type: stat.type,
				size: stat.size,
			};
		}),
	);

	/* --- 3. can a process be started at all? ---------------------------- */

	report.steps.push(
		await step("import the Subprocess module", () => {
			const { Subprocess } = ChromeUtils.importESModule(
				"resource://gre/modules/Subprocess.sys.mjs",
			);
			return {
				imported: !!Subprocess,
				hasCall: typeof Subprocess.call === "function",
				hasPathSearch: typeof Subprocess.pathSearch === "function",
			};
		}),
	);

	report.steps.push(
		await step("Subprocess.pathSearch", async () => {
			const { Subprocess } = ChromeUtils.importESModule(
				"resource://gre/modules/Subprocess.sys.mjs",
			);
			// The CLI is `SiYuan-Kernel`; `siyuan` only exists when the
			// installer or the user made a link. Both are asked for, so a
			// report shows which one is reachable.
			const names = Zotero.isWin
				? ["siyuan", "siyuan.exe", "SiYuan-Kernel.exe"]
				: ["siyuan", "SiYuan-Kernel"];
			const found = {};
			for (const name of names) {
				try {
					found[name] = (await Subprocess.pathSearch(name)) || "";
				}
				catch (e) {
					found[name] = `error: ${e.message}`;
				}
			}
			return found;
		}),
	);

	report.steps.push(
		await step(`Subprocess.call ${primary} --version`, async () => {
			const { Subprocess } = ChromeUtils.importESModule(
				"resource://gre/modules/Subprocess.sys.mjs",
			);
			const proc = await Subprocess.call({
				command: primary,
				arguments: ["--version"],
				stderr: "stdout",
			});
			let out = "";
			let chunk;
			while ((chunk = await proc.stdout.readString())) {
				out += chunk;
			}
			const code = await proc.wait();
			// Gecko's `wait()` resolves with an *object* — `{ exitCode }` —
			// and not with the number itself.
			const exitCode =
				code && typeof code.exitCode === "number" ? code.exitCode : code;
			return { output: out.trim(), exitCode };
		}),
	);

	report.steps.push(
		await step("Zotero.Utilities.Internal.subprocess", async () => {
			const out = await Zotero.Utilities.Internal.subprocess(primary, [
				"--version",
			]);
			return { output: String(out).trim() };
		}),
	);

	report.steps.push(
		await step("nsIProcess factory available", () => {
			const proc = Components.classes[
				"@mozilla.org/process/process-factory;1"
			].createInstance(Components.interfaces.nsIProcess);
			return { hasProcess: !!proc };
		}),
	);

	/* --- 4. the kernel --------------------------------------------------- */

	report.steps.push(
		await step(
			"HTTP POST http://127.0.0.1:6806/api/system/version",
			async () => {
				const response = await Zotero.HTTP.request(
					"POST",
					"http://127.0.0.1:6806/api/system/version",
					{
						body: "{}",
						headers: { "Content-Type": "application/json" },
						timeout: 8000,
					},
				);
				return { text: (await responseText(response)).trim() };
			},
		),
	);
}
