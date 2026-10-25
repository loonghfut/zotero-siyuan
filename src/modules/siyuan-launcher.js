/**
 * Zotero → SiYuan — opening a block in the SiYuan desktop app.
 *
 * The obvious way to open `siyuan://blocks/<id>` is `Zotero.launchURL()`,
 * but that goes through the browser's external-protocol service, which
 * **asks for confirmation** before handing the URL to another program.
 *
 * Since the target is the user's own note application and the URL is built
 * by the plugin itself, the launcher here starts SiYuan directly instead:
 * the handler that Windows has registered for `siyuan://` is looked up and
 * started with the URL as its argument. No prompt, and the already-running
 * SiYuan window just comes to the front and jumps to the block.
 *
 * Everything falls back to `Zotero.launchURL()` when the handler cannot be
 * found, so the feature still works — with a prompt — anywhere else.
 */

const SIYUAN_SCHEME = "siyuan";

/**
 * The command Windows has registered for a URL scheme.
 *
 * @param {String} scheme - e.g. "siyuan"
 * @returns {String} the command line, or "" when there is none
 */
export function protocolHandlerCommand(scheme = SIYUAN_SCHEME) {
	if (!Zotero.isWin) {
		return "";
	}
	try {
		const registry = Components.classes[
			"@mozilla.org/windows/registry-service;1"
		];
		if (!registry) {
			return "";
		}
		const factory = registry.getService(
			Components.interfaces.nsIWindowsRegFactory,
		);
		const key = factory.openKeyToRead(
			`HKEY_CURRENT_USER\\Software\\Classes\\${scheme}\\shell\\open\\command`,
		);
		if (!key) {
			return "";
		}
		const command = key.readString() || "";
		key.close();
		return command;
	}
	catch (e) {
		Zotero.debug(
			`ZoteroSiYuan: could not read the ${scheme}: handler (${e})`,
		);
		return "";
	}
}

/**
 * The executable inside a registered command line.
 *
 * A Windows handler usually looks like
 * `"C:\\Program Files\\SiYuan\\SiYuan.exe" "%1"`.
 *
 * @param {String} command
 * @returns {String} the executable path, or ""
 */
export function parseHandlerExecutable(command) {
	const text = String(command || "").trim();
	if (!text) {
		return "";
	}
	const quoted = text.match(/"([^"]+\.exe)"/i);
	if (quoted) {
		return quoted[1];
	}
	// Unquoted: the executable is everything up to the first argument.
	const space = text.indexOf(" ");
	return space === -1 ? text : text.slice(0, space);
}

/**
 * Ask `reg.exe` for the handler.
 *
 * The output is localized, but the quoted executable path in it is not — so
 * only that part is read.
 *
 * @param {String} scheme
 * @returns {Promise<String>} the command line
 */
async function readHandlerWithRegExe(scheme) {
	const reg = await absolutePathOf("reg.exe");
	if (!reg) {
		return "";
	}
	try {
		const { Subprocess } = ChromeUtils.importESModule(
			"resource://gre/modules/Subprocess.sys.mjs",
		);
		const proc = await Subprocess.call({
			command: reg,
			arguments: [
				"query",
				`HKCU\\Software\\Classes\\${scheme}\\shell\\open\\command`,
				"/ve",
			],
			stderr: "stdout",
		});
		let out = "";
		let chunk;
		while ((chunk = await proc.stdout.readString())) {
			out += chunk;
		}
		await proc.wait();
		return out;
	}
	catch (e) {
		return "";
	}
}

/**
 * The absolute path of a program on PATH.
 *
 * Gecko's `Subprocess` insists on an absolute path — a bare name is
 * rejected as "not an executable".
 *
 * @param {String} name
 * @returns {Promise<String>}
 */
async function absolutePathOf(name) {
	try {
		const { Subprocess } = ChromeUtils.importESModule(
			"resource://gre/modules/Subprocess.sys.mjs",
		);
		return (await Subprocess.pathSearch(name)) || "";
	}
	catch (e) {
		return "";
	}
}

/**
 * Where SiYuan is installed, when it follows the default layout.
 * @returns {String}
 */
function defaultInstallPath() {
	try {
		const local = Services.env.get("LOCALAPPDATA");
		if (local) {
			return `${local}\\Programs\\SiYuan\\SiYuan.exe`;
		}
	}
	catch (e) {
		// ignore
	}
	return "";
}

/**
 * The program Windows would use for a `siyuan://` link.
 *
 * @param {String} scheme
 * @returns {Promise<String>} the executable path, or ""
 */
export async function findHandlerExecutable(scheme = SIYUAN_SCHEME) {
	if (!Zotero.isWin) {
		return "";
	}

	const fromRegistry = parseHandlerExecutable(protocolHandlerCommand(scheme));
	if (fromRegistry) {
		return fromRegistry;
	}

	// The registry service is not reachable from every scope, so ask
	// reg.exe as well.
	const output = await readHandlerWithRegExe(scheme);
	const match = output.match(/"([^"]+\.exe)"/i);
	if (match) {
		return match[1];
	}

	// Last resort: the default installation layout.
	const fallback = defaultInstallPath();
	return fallback && IOUtils.exists(fallback) ? fallback : "";
}

/**
 * Open a URL with the program's Windows handler, without a prompt.
 *
 * @param {String} url - e.g. "siyuan://blocks/20260101000000-abcdefg"
 * @returns {Promise<Boolean>} whether it was started
 */
export async function launchExternally(url) {
	const executable = await findHandlerExecutable();
	if (!executable) {
		return false;
	}
	try {
		const { Subprocess } = ChromeUtils.importESModule(
			"resource://gre/modules/Subprocess.sys.mjs",
		);
		const proc = await Subprocess.call({
			command: executable,
			arguments: [url],
		});
		// The handler hands the URL to the running instance and exits; do
		// not wait for it, and do not let it keep the plugin busy.
		try {
			proc.wait();
		}
		catch (e) {
			// ignore
		}
		return true;
	}
	catch (e) {
		Zotero.debug(`ZoteroSiYuan: could not start ${executable}: ${e}`);
		return false;
	}
}

/**
 * Stop the browser from asking before it hands a `siyuan:` URL over.
 *
 * This only affects the fallback path; it is a user-level preference, the
 * same one the confirmation dialog's "remember my choice" box writes.
 */
export function suppressProtocolWarning(scheme = SIYUAN_SCHEME) {
	try {
		Zotero.Prefs.set(
			`network.protocol-handler.warn-external.${scheme}`,
			false,
			true,
		);
		return true;
	}
	catch (e) {
		return false;
	}
}
