/**
 * Generates the Zotero → SiYuan plugin icons (48.png, 96.png).
 * Node built-ins only: zlib for the PNG IDAT stream.
 *
 * Usage: node make-icons.js <output-dir>
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ------------------------------- PNG encoder ------------------------------- */

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

function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const typeBuf = Buffer.from(type, 'ascii');
	const crcBuf = Buffer.alloc(4);
	crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
	return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;   // bit depth
	ihdr[9] = 6;   // colour type: RGBA
	ihdr[10] = 0;  // compression
	ihdr[11] = 0;  // filter
	ihdr[12] = 0;  // interlace

	// Each scanline is prefixed with filter type 0 (None).
	const stride = width * 4;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0;
		rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	}

	return Buffer.concat([
		signature,
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0))
	]);
}

/* --------------------------------- drawing -------------------------------- */

const ARROW = [
	[9, 2.5], [15.5, 8], [9, 13.5], [9, 9.6], [2.5, 9.6], [2.5, 6.4], [9, 6.4]
];

function pointInPolygon(x, y, poly) {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const xi = poly[i][0], yi = poly[i][1];
		const xj = poly[j][0], yj = poly[j][1];
		const intersect = ((yi > y) !== (yj > y))
			&& (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
		if (intersect) inside = !inside;
	}
	return inside;
}

function inRoundedRect(x, y, size, radius) {
	const r = radius;
	if (x < r && y < r) {
		return (x - r) ** 2 + (y - r) ** 2 <= r * r;
	}
	if (x > size - r && y < r) {
		return (x - (size - r)) ** 2 + (y - r) ** 2 <= r * r;
	}
	if (x < r && y > size - r) {
		return (x - r) ** 2 + (y - (size - r)) ** 2 <= r * r;
	}
	if (x > size - r && y > size - r) {
		return (x - (size - r)) ** 2 + (y - (size - r)) ** 2 <= r * r;
	}
	return true;
}

function mix(a, b, t) {
	return [
		Math.round(a[0] + (b[0] - a[0]) * t),
		Math.round(a[1] + (b[1] - a[1]) * t),
		Math.round(a[2] + (b[2] - a[2]) * t)
	];
}

function drawIcon(size) {
	const rgba = Buffer.alloc(size * size * 4);
	const SS = 4;                       // supersampling factor
	const radius = size * 0.22;
	const top = [0x4d, 0xa3, 0xf0];     // gradient top
	const bottom = [0x1e, 0x6f, 0xd9];  // gradient bottom
	const arrow = [0xff, 0xff, 0xff];

	for (let py = 0; py < size; py++) {
		for (let px = 0; px < size; px++) {
			let bgHits = 0;
			let arrowHits = 0;
			for (let sy = 0; sy < SS; sy++) {
				for (let sx = 0; sx < SS; sx++) {
					const x = px + (sx + 0.5) / SS;
					const y = py + (sy + 0.5) / SS;
					if (!inRoundedRect(x, y, size, radius)) continue;
					bgHits++;
					const ux = (x / size) * 16;
					const uy = (y / size) * 16;
					if (pointInPolygon(ux, uy, ARROW)) arrowHits++;
				}
			}
			const total = SS * SS;
			const alpha = bgHits / total;
			const offset = (py * size + px) * 4;
			if (alpha === 0) {
				rgba[offset + 3] = 0;
				continue;
			}
			const bg = mix(top, bottom, py / (size - 1));
			const a = arrowHits / total;
			const rgb = a > 0 ? mix(bg, arrow, a / (bgHits / total || 1)) : bg;
			rgba[offset] = rgb[0];
			rgba[offset + 1] = rgb[1];
			rgba[offset + 2] = rgb[2];
			rgba[offset + 3] = Math.round(alpha * 255);
		}
	}
	return encodePNG(size, size, rgba);
}

const outDir = process.argv[2] || '.';
fs.mkdirSync(path.join(outDir, 'icons'), { recursive: true });
for (const size of [48, 96]) {
	const file = path.join(outDir, 'icons', `${size}.png`);
	fs.writeFileSync(file, drawIcon(size));
	console.log('wrote ' + file + ' (' + fs.statSync(file).size + ' bytes)');
}
