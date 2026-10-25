/**
 * Zotero → SiYuan — SiYuan CLI client.
 *
 * Talks to SiYuan through its own command line interface (SiYuan 3.7+ ships
 * `siyuan` next to the kernel; on Windows it is
 * `…\SiYuan\resources\kernel\siyuan.exe`).
 *
 * The CLI works directly on the workspace, so no API token, host or port is
 * needed, and it resolves the daily-note path from SiYuan's own settings.
 *
 * Commands used:
 *
 *   siyuan workspace list   --format json
 *   siyuan workspace info   --format json
 *   siyuan notebook list    -w <workspace> --format json
 *   siyuan dailynote append --notebook <id> --file <path> -w <workspace> --format json
 *
 * Loaded into the plugin scope with Services.scriptloader.loadSubScript.
 */

"use strict";

var SiYuanCLI = class {
	constructor(options) {
		this.executable = options.executable || '';   // explicit path, '' = auto-detect
		this.workspace = options.workspace || '';     // '' = whatever the CLI defaults to
	}

	/* ----------------------------------------------------------- process */

	/**
	 * Run the siyuan CLI.
	 * @param {String[]} args
	 * @returns {Object} { code, output }
	 */
	async run(args) {
		var command = await this.resolveExecutable();
		var argv = args.slice();

		if (this.workspace) {
			argv.push('-w', this.workspace);
		}

		Zotero.debug('ZoteroSiYuan: running ' + command + ' ' + argv.join(' '));

		var merged;
		var code = 0;
		try {
			var { Subprocess } = ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs');
			// stderr: "stdout" merges the error output into stdout, so a failing
			// command still tells us what went wrong.
			var proc = await Subprocess.call({
				command: command,
				arguments: argv,
				stderr: 'stdout'
			});
			merged = '';
			var chunk;
			while ((chunk = await proc.stdout.readString())) {
				merged += chunk;
			}
			code = await proc.wait();
		}
		catch (e) {
			// The Subprocess module is not reachable from this scope — fall back
			// to Zotero's own helper (stdout only).
			if (e && e.errorCode) {
				throw new Error('Could not run the SiYuan CLI at "' + command + '": ' + e.message);
			}
			try {
				merged = await Zotero.Utilities.Internal.subprocess(command, argv);
			}
			catch (e2) {
				throw new Error('Could not run the SiYuan CLI at "' + command + '": ' + e2.message);
			}
			code = merged ? 0 : 1;
		}

		return { code: code, output: merged };
	}

	/**
	 * Run the CLI and parse its JSON output.
	 * @throws {Error} when the command fails
	 */
	async runJSON(args) {
		var result = await this.run(args.concat(['--format', 'json']));
		var output = (result.output || '').trim();

		if (result.code !== 0) {
			throw new Error(this._describeFailure(output, args, result.code));
		}

		if (!output) {
			throw new Error('The siyuan CLI returned no output for: siyuan ' + args.join(' '));
		}

		try {
			return JSON.parse(output);
		}
		catch (e) {
			throw new Error('Could not parse the siyuan CLI output: ' + output.slice(0, 300));
		}
	}

	_describeFailure(output, args, code) {
		var text = (output || '').trim();
		// The CLI prints "Error: …" first, then the usage block.
		var lines = text.split('\n');
		var message = '';
		for (var line of lines) {
			if (/^Error:/.test(line)) {
				message = line.replace(/^Error:\s*/, '');
				break;
			}
		}
		if (!message) {
			message = lines.filter(function (l) { return l && !/^\s{2,}/.test(l); }).slice(0, 2).join(' ');
		}
		if (!message) {
			message = 'exit code ' + code;
		}
		return 'siyuan ' + args.join(' ') + ' failed: ' + message;
	}

	/* -------------------------------------------------------- executable */

	/** Locate the siyuan CLI. */
	async resolveExecutable() {
		if (this.executable) {
			return this.executable;
		}

		// On PATH?
		try {
			var { Subprocess } = ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs');
			for (var name of ['siyuan', 'siyuan.exe']) {
				try {
					var found = await Subprocess.pathSearch(name);
					if (found) {
						this.executable = found;
						return found;
					}
				}
				catch (e) {
					// try the next name
				}
			}
		}
		catch (e) {
			// Subprocess module unavailable; fall back to the known install paths.
		}

		// Common install locations.
		var candidates = [];
		try {
			var home = Services.dirsvc.get('Home').path;
			if (Zotero.isWin) {
				// `Ci` is not exposed in the plugin sandbox — ask for the path only.
				var localAppData = Services.dirsvc.get('AppData').path;
				candidates.push(localAppData + '\\Programs\\SiYuan\\resources\\kernel\\siyuan.exe');
				candidates.push(localAppData + '\\SiYuan\\resources\\kernel\\siyuan.exe');
				candidates.push('C:\\Program Files\\SiYuan\\resources\\kernel\\siyuan.exe');
			}
			else if (Zotero.isMac) {
				candidates.push('/Applications/SiYuan.app/Contents/Resources/kernel/siyuan');
			}
			else {
				candidates.push('/usr/lib/siyuan/resources/kernel/siyuan');
				candidates.push('/opt/siyuan/resources/kernel/siyuan');
			}
		}
		catch (e) {
			// ignore
		}

		for (var candidate of candidates) {
			try {
				if (await IOUtils.exists(candidate)) {
					this.executable = candidate;
					return candidate;
				}
			}
			catch (e) {
				// try the next candidate
			}
		}

		throw new Error('Could not find the siyuan CLI. Install SiYuan 3.7 or newer, or set its path in the plugin preferences.');
	}

	/* --------------------------------------------------------- commands */

	async listWorkspaces() {
		var data = await this.runJSON(['workspace', 'list']);
		return Array.isArray(data) ? data : [];
	}

	async currentWorkspace() {
		var data = await this.runJSON(['workspace', 'info']);
		return (data && data.path) || '';
	}

	async listNotebooks() {
		var data = await this.runJSON(['notebook', 'list']);
		return Array.isArray(data) ? data : [];
	}

	/**
	 * Resolve the notebook that should receive the daily note.
	 * @param {String} wanted - notebook name or id from the preferences; empty = first usable one
	 */
	async resolveNotebook(wanted) {
		var notebooks = await this.listNotebooks();
		if (!notebooks.length) {
			throw new Error('The selected SiYuan workspace has no notebooks.');
		}
		if (wanted) {
			var lower = String(wanted).trim().toLowerCase();
			for (var notebook of notebooks) {
				if (notebook.id === wanted || String(notebook.name).trim().toLowerCase() === lower) {
					return notebook;
				}
			}
			throw new Error('No SiYuan notebook named "' + wanted + '". Available: '
				+ notebooks.map(function (n) { return n.name; }).join(', '));
		}
		for (var candidate of notebooks) {
			if (!candidate.closed) {
				return candidate;
			}
		}
		return notebooks[0];
	}

	/**
	 * Append Markdown to today's daily note, creating it if needed.
	 * @param {String} notebookID
	 * @param {String} markdown
	 * @returns {Object} the CLI's JSON result
	 */
	async appendToDailyNote(notebookID, markdown) {
		// The content goes through a temporary file: it contains newlines and
		// Markdown punctuation that would be awkward as a command line argument.
		var path = this._tempPath();
		await Zotero.File.putContentsAsync(path, markdown);
		try {
			return await this.runJSON([
				'dailynote', 'append',
				'--notebook', notebookID,
				'--file', path
			]);
		}
		finally {
			try {
				await IOUtils.remove(path, { ignoreAbsent: true });
			}
			catch (e) {
				// ignore
			}
		}
	}

	_tempPath() {
		var dir = Zotero.getTempDirectory();
		var name = 'zotero-siyuan-' + Date.now() + '-' + Math.floor(Math.random() * 100000) + '.md';
		return PathUtils.join(dir, name);
	}

	/**
	 * Check that the CLI works and report what it sees. Used by the
	 * preferences pane.
	 */
	async diagnose() {
		var report = { ok: false, executable: '', workspace: '', notebooks: [], error: '' };
		try {
			report.executable = await this.resolveExecutable();
			report.workspace = this.workspace || (await this.currentWorkspace());
			report.notebooks = await this.listNotebooks();
			report.ok = true;
		}
		catch (e) {
			report.error = e.message;
		}
		return report;
	}
};
