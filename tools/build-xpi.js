/**
 * Packages the plugin as an XPI (a ZIP archive with manifest.json at the root).
 *
 * Usage: node tools/build-xpi.js [output.xpi]
 *
 * The `tools/` directory and dot-files are excluded from the archive.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = process.argv[2] || path.join(ROOT, 'zotero-siyuan.xpi');

const EXCLUDE_DIRS = new Set(['tools', 'node_modules', '.git', '.vscode']);
const EXCLUDE_FILES = new Set(['README.md', 'zotero-siyuan.xpi', '.gitignore', '.DS_Store']);

/* ------------------------------- ZIP writer ------------------------------- */

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c;
	}
	return table;
})();

function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) {
		c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}

function collect(dir, prefix, files) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name.startsWith('.') && entry.isFile()) continue;
		const full = path.join(dir, entry.name);
		const rel = prefix ? prefix + '/' + entry.name : entry.name;
		if (entry.isDirectory()) {
			if (EXCLUDE_DIRS.has(entry.name)) continue;
			collect(full, rel, files);
		}
		else if (entry.isFile()) {
			if (EXCLUDE_FILES.has(entry.name)) continue;
			files.push({ name: rel, data: fs.readFileSync(full) });
		}
	}
	return files;
}

function buildZip(files) {
	const locals = [];
	const central = [];
	let offset = 0;

	for (const file of files) {
		const nameBuf = Buffer.from(file.name, 'utf8');
		const deflated = zlib.deflateRawSync(file.data, { level: 9 });
		// Fall back to "stored" if deflate made it bigger.
		const useDeflate = deflated.length < file.data.length;
		const payload = useDeflate ? deflated : file.data;
		const method = useDeflate ? 8 : 0;
		const crc = crc32(file.data);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);           // version needed
		local.writeUInt16LE(0, 6);            // flags
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(0, 10);           // mod time
		local.writeUInt16LE(0x21, 12);        // mod date (1980-01-01)
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(payload.length, 18);
		local.writeUInt32LE(file.data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		local.writeUInt16LE(0, 28);
		locals.push(local, nameBuf, payload);

		const dir = Buffer.alloc(46);
		dir.writeUInt32LE(0x02014b50, 0);
		dir.writeUInt16LE(20, 4);            // version made by
		dir.writeUInt16LE(20, 6);            // version needed
		dir.writeUInt16LE(0, 8);
		dir.writeUInt16LE(method, 10);
		dir.writeUInt16LE(0, 12);
		dir.writeUInt16LE(0x21, 14);
		dir.writeUInt32LE(crc, 16);
		dir.writeUInt32LE(payload.length, 20);
		dir.writeUInt32LE(file.data.length, 24);
		dir.writeUInt16LE(nameBuf.length, 28);
		dir.writeUInt16LE(0, 30);            // extra
		dir.writeUInt16LE(0, 32);            // comment
		dir.writeUInt16LE(0, 34);            // disk
		dir.writeUInt16LE(0, 36);            // internal attrs
		dir.writeUInt32LE(0, 38);            // external attrs
		dir.writeUInt32LE(offset, 42);
		central.push(dir, nameBuf);

		offset += local.length + nameBuf.length + payload.length;
	}

	const centralBuf = Buffer.concat(central);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(files.length, 8);
	eocd.writeUInt16LE(files.length, 10);
	eocd.writeUInt32LE(centralBuf.length, 12);
	eocd.writeUInt32LE(offset, 16);
	eocd.writeUInt16LE(0, 20);

	return Buffer.concat([...locals, centralBuf, eocd]);
}

/* ---------------------------------- main ---------------------------------- */

const files = collect(ROOT, '', []);
if (!files.some(f => f.name === 'manifest.json')) {
	console.error('manifest.json is missing from the archive root — aborting.');
	process.exit(1);
}

fs.writeFileSync(OUTPUT, buildZip(files));
console.log('wrote ' + OUTPUT + ' (' + fs.statSync(OUTPUT).size + ' bytes, ' + files.length + ' files)');
for (const f of files) {
	console.log('  ' + f.name);
}
