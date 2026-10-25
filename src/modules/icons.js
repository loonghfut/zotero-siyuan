/**
 * Zotero → SiYuan — the SiYuan logo.
 *
 * The artwork is SiYuan's own application icon, redrawn as **inline SVG**:
 * four polygons traced from `resources/stage/icon-large.png` in the SiYuan
 * installation.
 *
 * Inline SVG is the right shape here for two reasons:
 *
 * - Zotero's own icons are SVG, so this matches the platform.
 * - The reader's sidebar runs in a **separate content process**, where a
 *   `chrome://` URL for a plugin-registered package is not readable, and a
 *   bitmap would have to be inlined as a `data:` URI. An inline SVG needs no
 *   URL at all, so it renders in every document the plugin can reach.
 */

/** The namespace SVG elements live in. */
export const SVG_NS = "http://www.w3.org/2000/svg";

/** The SiYuan logo, traced from the application's own icon. */
export const SIYUAN_ICON_SHAPES = [
	{ points: "158,84 165,84 165,316 46,435 46,196", fill: "#DA3939" },
	{ points: "166,84 173,84 255,166 255,316 166,405", fill: "#3B3E43" },
	{ points: "338,84 345,84 345,316 256,405 256,166", fill: "#DA3939" },
	{ points: "346,84 465,203 465,435 346,316", fill: "#3B3E43" },
];

/** The part of the original artwork the shapes cover. */
export const SIYUAN_ICON_VIEWBOX = "46 84 419 351";

/**
 * Build the logo as an SVG element inside a given document.
 *
 * @param {Object} doc - the document to create the element in
 * @param {Number} size - the edge length in CSS pixels
 * @returns {Object} the <svg> element
 */
export function createSiyuanIcon(doc, size = 14) {
	const svg = doc.createElementNS(SVG_NS, "svg");
	svg.setAttribute("viewBox", SIYUAN_ICON_VIEWBOX);
	svg.setAttribute("width", String(size));
	svg.setAttribute("height", String(size));
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("focusable", "false");
	svg.setAttribute("class", "zotero-siyuan-sent-icon");
	for (const shape of SIYUAN_ICON_SHAPES) {
		const polygon = doc.createElementNS(SVG_NS, "polygon");
		polygon.setAttribute("points", shape.points);
		polygon.setAttribute("fill", shape.fill);
		svg.appendChild(polygon);
	}
	return svg;
}
