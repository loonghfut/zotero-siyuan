/**
 * Validation suite for the Zotero → SiYuan plugin.
 *
 * Checks, without needing Zotero or SiYuan to be running:
 *   1. every JavaScript file parses
 *   2. manifest.json is valid JSON with the required keys
 *   3. every Fluent message id used in code exists in both locales
 *   4. the markdown formatter produces the expected structure
 *   5. the SiYuan CLI client issues the expected command sequence
 *
 * Usage: node tools/validate.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;
let checks = 0;

function check(name, condition, detail) {
	checks++;
	if (condition) {
		console.log('  [OK]   ' + name);
	}
	else {
		failures++;
		console.log('  [FAIL] ' + name + (detail ? ' — ' + detail : ''));
	}
}

function section(title) {
	console.log('\n=== ' + title + ' ===');
}

function read(rel) {
	return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/* ---------------------------- 1. syntax ---------------------------- */

section('JavaScript syntax');
const jsFiles = [];
(function walk(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === 'node_modules' || entry.name === '.git') continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full);
		else if (entry.name.endsWith('.js')) jsFiles.push(path.relative(ROOT, full));
	}
})(ROOT);

for (const file of jsFiles) {
	try {
		execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'pipe' });
		check(file, true);
	}
	catch (e) {
		check(file, false, String(e.stderr || e).split('\n').slice(0, 3).join(' '));
	}
}

/* --------------------------- 2. manifest -------------------------- */

section('manifest.json');
let manifest = null;
try {
	manifest = JSON.parse(read('manifest.json'));
	check('parses as JSON', true);
}
catch (e) {
	check('parses as JSON', false, e.message);
}
if (manifest) {
	const zotero = (manifest.applications || {}).zotero || {};
	check('manifest_version is 2', manifest.manifest_version === 2);
	check('has applications.zotero.id', typeof zotero.id === 'string' && zotero.id.includes('@'), zotero.id);
	check('has strict_min_version', typeof zotero.strict_min_version === 'string', zotero.strict_min_version);
	check('has strict_max_version', /^10\.0\.\*$/.test(zotero.strict_max_version || ''), zotero.strict_max_version);
	check('no update_url while unpublished', !zotero.update_url);
	for (const [size, rel] of Object.entries(manifest.icons || {})) {
		check('icon ' + size + ' exists', fs.existsSync(path.join(ROOT, rel)), rel);
	}
}

/* ------------------------- 3. Fluent coverage ---------------------- */

section('Fluent messages');
function ftlIds(file) {
	const ids = new Set();
	for (const line of file.split('\n')) {
		const m = line.match(/^([a-zA-Z][\w-]*)\s*=/);
		if (m) ids.add(m[1]);
	}
	return ids;
}
const en = ftlIds(read('locale/en-US/zotero-siyuan.ftl'));
const zh = ftlIds(read('locale/zh-CN/zotero-siyuan.ftl'));
check('en-US and zh-CN have the same ids', en.size === zh.size
	&& [...en].every(id => zh.has(id)),
	'en=' + en.size + ' zh=' + zh.size);

const usedIds = new Set();
for (const m of read('content/main.js').matchAll(/_getString\('([^']+)'/g)) usedIds.add(m[1]);
for (const m of read('content/preferences.js').matchAll(/_lookup\('([^']+)'\)/g)) usedIds.add(m[1]);
for (const m of read('content/preferences.xhtml').matchAll(/data-l10n-id="([^"]+)"/g)) usedIds.add(m[1]);
for (const id of usedIds) {
	check('message "' + id + '" exists in both locales', en.has(id) && zh.has(id));
}
check('no unused messages', [...en].every(id => usedIds.has(id)),
	'unused: ' + [...en].filter(id => !usedIds.has(id)).join(', '));

/* ----------------------- 4. markdown formatter --------------------- */

section('Markdown formatter');
const writtenFiles = new Map();
const writtenHistory = new Map();
const cliCalls = [];
// Responds to a CLI invocation: (argv) => { code, output }
let cliResponder = () => ({ code: 0, output: '{}' });

const fakeSubprocess = {
	async pathSearch(name) {
		return '/fake/bin/' + name;
	},
	async call(options) {
		cliCalls.push({ command: options.command, argv: options.arguments.slice() });
		const reply = cliResponder(options.arguments.slice()) || { code: 0, output: '' };
		let sent = false;
		return {
			stdout: {
				async readString() {
					if (sent) return null;
					sent = true;
					return reply.output;
				}
			},
			async wait() {
				return reply.code;
			}
		};
	}
};

const sandbox = {
	Zotero: {
		debug() {},
		logError() {},
		getTempDirectory: () => '/tmp',
		File: {
			async putContentsAsync(p, content) {
				writtenFiles.set(p, content);
				writtenHistory.set(p, content);
			}
		}
	},
	ChromeUtils: {
		importESModule(uri) {
			if (uri.includes('Subprocess')) {
				return { Subprocess: fakeSubprocess };
			}
			throw new Error('unexpected module ' + uri);
		}
	},
	IOUtils: {
		async exists(p) { return false; },
		async remove(p) { writtenFiles.delete(p); }
	},
	PathUtils: { join: (...parts) => parts.join('/') },
	console, JSON, Promise, Error, String, Array, Object, RegExp, Date, Math
};
vm.createContext(sandbox);
vm.runInContext(read('content/format.js'), sandbox, { filename: 'format.js' });

const fakeItem = {
	key: 'ABCD1234',
	getField(field) {
		return {
			title: 'Attention Is All You Need',
			date: '2017',
			publicationTitle: 'Advances in Neural Information Processing Systems'
		}[field] || '';
	},
	getCreators() {
		return [
			{ firstName: 'Ashish', lastName: 'Vaswani', fieldMode: 0, creatorTypeID: 1 },
			{ firstName: 'Noam', lastName: 'Shazeer', fieldMode: 0, creatorTypeID: 1 }
		];
	}
};

const markdown = sandbox.ZS_FORMAT.buildMarkdown({
	annotation: {
		id: 'ANNO0001',
		type: 'highlight',
		text: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.',
		comment: 'This is the core idea of the paper.',
		pageLabel: '3',
		authorName: 'steve'
	},
	parentItem: fakeItem,
	strings: {
		quoteTitle: 'Quote', commentTitle: 'Comment',
		authorLabel: 'Author', yearLabel: 'Year', publicationLabel: 'Publication',
		pageLabel: 'Page', annotatorLabel: 'Annotated by', sourceLabel: 'Source',
		emptyAnnotation: '(empty annotation)'
	}
});

check('contains a quote callout', markdown.includes('> [!quote]'), markdown.split('\n')[0]);
check('contains the highlighted text', markdown.includes('dominant sequence transduction models'));
check('contains the comment callout', markdown.includes('> [!note] Comment'));
check('contains the comment text', markdown.includes('core idea of the paper'));
check('contains the author', markdown.includes('Ashish Vaswani'));
check('contains the year', markdown.includes('2017'));
check('contains the page label', markdown.includes('Page：3') || markdown.includes('Page: 3'));
check('contains the Zotero deep link',
	markdown.includes('zotero://select/library/items/ABCD1234'));
check('callout lines are prefixed', markdown.split('\n').filter(l => l.startsWith('> The dominant')).length === 1);

const emptyMarkdown = sandbox.ZS_FORMAT.buildMarkdown({
	annotation: { type: 'note', text: '', comment: '' },
	parentItem: null,
	strings: { emptyAnnotation: '(empty annotation)', commentTitle: 'Comment' }
});
check('handles an empty annotation', emptyMarkdown.includes('(empty annotation)'));

/* ---------------------- 5. SiYuan CLI flow ------------------------ */

section('SiYuan CLI flow');
vm.runInContext(read('content/siyuan.js'), sandbox, { filename: 'siyuan.js' });

(async () => {
	const cli = new sandbox.SiYuanCLI({ executable: '', workspace: '' });

	// --- executable discovery -------------------------------------
	const exe = await cli.resolveExecutable();
	check('finds the siyuan CLI on PATH', exe === '/fake/bin/siyuan', exe);

	// --- workspace list ------------------------------------------
	cliResponder = (argv) => {
		if (argv[0] === 'workspace' && argv[1] === 'list') {
			return { code: 0, output: JSON.stringify([{ name: 'SiYuan', path: 'D:\\siyi' }]) };
		}
		if (argv[0] === 'notebook' && argv[1] === 'list') {
			return {
				code: 0,
				output: JSON.stringify([
					{ id: 'nb-1', name: '我的笔记本', closed: false },
					{ id: 'nb-2', name: 'Other', closed: false }
				])
			};
		}
		if (argv[0] === 'dailynote' && argv[1] === 'append') {
			return { code: 0, output: JSON.stringify({ id: '20261025000000-abc1234' }) };
		}
		return { code: 1, output: 'Error: unexpected command ' + argv.join(' ') };
	};
	cliCalls.length = 0;

	const workspaces = await cli.listWorkspaces();
	check('parses the workspace list', workspaces.length === 1 && workspaces[0].name === 'SiYuan');
	check('used the workspace list command',
		cliCalls[cliCalls.length - 1].argv[0] === 'workspace'
		&& cliCalls[cliCalls.length - 1].argv[1] === 'list');
	check('requested JSON output', cliCalls[cliCalls.length - 1].argv.includes('--format'));

	// --- notebook list --------------------------------------------
	const notebooks = await cli.listNotebooks();
	check('parses the notebook list', notebooks.length === 2);

	const byName = await cli.resolveNotebook('我的笔记本');
	check('resolves a notebook by name', byName.id === 'nb-1', byName.id);
	const byId = await cli.resolveNotebook('nb-2');
	check('resolves a notebook by id', byId.id === 'nb-2', byId.id);
	const first = await cli.resolveNotebook('');
	check('defaults to the first notebook', first.id === 'nb-1', first.id);

	let threw = false;
	try {
		await cli.resolveNotebook('Nope');
	}
	catch (e) {
		threw = /No SiYuan notebook named/.test(e.message);
	}
	check('reports an unknown notebook', threw);

	// --- append to the daily note ----------------------------------
	cliCalls.length = 0;
	const result = await cli.appendToDailyNote('nb-1', '> [!quote] 摘录\n> 内容');
	const call = cliCalls[cliCalls.length - 1];
	check('calls dailynote append', call.argv[0] === 'dailynote' && call.argv[1] === 'append',
		call.argv.join(' '));
	check('passes the notebook id', call.argv.includes('--notebook') && call.argv.includes('nb-1'));
	check('passes the content through a file', call.argv.includes('--file'));
	const contentFile = call.argv[call.argv.indexOf('--file') + 1];
	check('wrote the markdown to that file',
		writtenHistory.has(contentFile) && writtenHistory.get(contentFile).includes('摘录'),
		writtenHistory.has(contentFile) ? 'file written' : 'file never written');
	check('removed the temporary file', !writtenFiles.has(contentFile));
	check('parsed the CLI result', result && result.id === '20261025000000-abc1234');

	// --- workspace override ---------------------------------------
	cliCalls.length = 0;
	const cli2 = new sandbox.SiYuanCLI({ executable: '/opt/siyuan', workspace: 'D:\\siyi' });
	await cli2.appendToDailyNote('nb-1', 'x');
	const call2 = cliCalls[cliCalls.length - 1];
	check('passes the workspace override',
		call2.argv.includes('-w') && call2.argv.includes('D:\\siyi'), call2.argv.join(' '));
	check('uses the explicit executable', call2.command === '/opt/siyuan', call2.command);

	// --- error handling --------------------------------------------
	cliCalls.length = 0;
	cliResponder = (argv) => {
		if (argv[0] === 'dailynote') {
			return {
				code: 1,
				output: 'Error: directory not found: D:\\nope\nUsage:\n  siyuan dailynote append ...'
			};
		}
		return { code: 0, output: '{}' };
	};
	let errorMessage = '';
	try {
		await cli.appendToDailyNote('nb-1', 'x');
	}
	catch (e) {
		errorMessage = e.message;
	}
	check('surfaces the CLI error message',
		/directory not found: D:\\nope/.test(errorMessage), errorMessage);

	// --- diagnose ---------------------------------------------------
	cliResponder = (argv) => {
		if (argv[0] === 'notebook') {
			return { code: 0, output: JSON.stringify([{ id: 'nb-1', name: '我的笔记本', closed: false }]) };
		}
		if (argv[0] === 'workspace' && argv[1] === 'info') {
			return { code: 0, output: JSON.stringify({ path: 'D:\\siyi', valid: true }) };
		}
		return { code: 0, output: '{}' };
	};
	const report = await cli.diagnose();
	check('diagnose reports ok', report.ok === true, report.error);
	check('diagnose lists the notebooks', report.notebooks.length === 1);
	check('diagnose reports the executable', report.executable === '/fake/bin/siyuan');
	check('diagnose reports the workspace', report.workspace === 'D:\\siyi', report.workspace);

	console.log('\n' + (failures ? 'FAILED' : 'PASSED') + ': ' + (checks - failures) + '/' + checks + ' checks passed');
	process.exit(failures ? 1 : 0);
})().catch(e => {
	console.error('\nValidation crashed: ' + e.stack);
	process.exit(1);
});
