/**
 * Zotero → SiYuan — the notification bubble.
 *
 * Zotero has no toast API, so the bubble is built here: a fixed element in
 * the content area that fades away on its own. It can carry a link — for
 * instance to the SiYuan block that was just written.
 *
 * The bubble lives in `ZoteroPane`'s document, not in the main window's:
 * the main window is a **XUL** document (no `<body>`), while ZoteroPane is
 * the XHTML document that actually holds the items list and the reader.
 */

const HTML_NS = "http://www.w3.org/1999/xhtml";

const TOAST_STYLE =
	"display:block;position:fixed;bottom:24px;right:24px;z-index:2147483647;" +
	"max-width:400px;padding:12px 14px;border-radius:8px;" +
	"background:#2f2f33;color:#f4f4f5;font-size:13px;line-height:1.5;" +
	"box-shadow:0 6px 24px rgba(0,0,0,.35);" +
	"display:flex;flex-direction:column;gap:8px;" +
	"transition:opacity .25s ease, transform .25s ease;";

const TITLE_STYLE = "display:block;font-weight:600;font-size:13px;";

const MESSAGE_STYLE = "display:block;opacity:.85;font-size:12.5px;";

const LINK_STYLE =
	"display:block;color:#7cc4ff;text-decoration:underline;cursor:pointer;font-size:12.5px;";

const CLOSE_STYLE =
	"position:absolute;top:6px;right:8px;color:#bbb;cursor:pointer;font-size:14px;line-height:1;";

/**
 * Where a bubble can be shown.
 * @returns {Object|null} { win, doc }
 */
export function toastTarget() {
	let win = null;
	try {
		win = Zotero.getMainWindow();
	}
	catch (e) {
		win = null;
	}
	if (!win) {
		return null;
	}
	// The pane is the real content area, and it is a normal HTML document.
	try {
		const pane = win.ZoteroPane;
		if (pane && pane.document && pane.document.body) {
			return { win, doc: pane.document };
		}
	}
	catch (e) {
		// fall through
	}
	// The main window is XUL — its root element is the closest thing to a body.
	try {
		if (win.document && win.document.documentElement) {
			return { win, doc: win.document, root: win.document.documentElement };
		}
	}
	catch (e) {
		// give up
	}
	return null;
}

/**
 * Show a bubble.
 *
 * @param {Object} options
 * @param {String} options.title - the headline
 * @param {String} options.message - the details
 * @param {String} options.link - a URL the bubble offers
 * @param {String} options.linkLabel - the text of that link
 * @param {Number} options.timeout - how long it stays, in ms
 * @param {Function} options.onLink - called instead of opening the URL
 * @param {Boolean} options.retry - try again shortly when there is no window
 * @returns {Object|null} { element, close }
 */
export function showToast({
	title = "",
	message = "",
	link = "",
	linkLabel = "",
	timeout = 9000,
	onLink = null,
	retry = true,
} = {}) {
	const target = toastTarget();
	if (!target) {
		// The content area may not exist yet right after startup — try again
		// a moment later rather than losing the message.
		if (retry) {
			const again = { title, message, link, linkLabel, timeout, onLink, retry: false };
			try {
				const win = Zotero.getMainWindow();
				if (win && win.setTimeout) {
					win.setTimeout(() => showToast(again), 600);
				}
			}
			catch (e) {
				// give up
			}
		}
		return null;
	}

	const { win, doc } = target;
	const container = doc.body || doc.documentElement;
	const create = (tag) => doc.createElementNS(HTML_NS, tag);

	const box = create("div");
	box.style.cssText = TOAST_STYLE;

	if (title) {
		const heading = create("div");
		heading.style.cssText = TITLE_STYLE;
		heading.textContent = title;
		box.appendChild(heading);
	}

	if (message) {
		const body = create("div");
		body.style.cssText = MESSAGE_STYLE;
		body.textContent = message;
		box.appendChild(body);
	}

	if (link || onLink) {
		const action = create("div");
		action.style.cssText = LINK_STYLE;
		action.textContent = linkLabel || "Open in SiYuan";
		action.addEventListener("click", (e) => {
			e.preventDefault();
			try {
				if (onLink) {
					onLink();
				}
				else {
					Zotero.launchURL(link);
				}
			}
			catch (err) {
				Zotero.debug(`ZoteroSiYuan: the toast link failed: ${err}`);
			}
			close();
		});
		box.appendChild(action);
	}

	const closeButton = create("div");
	closeButton.style.cssText = CLOSE_STYLE;
	closeButton.textContent = "×";
	closeButton.addEventListener("click", () => close());
	box.appendChild(closeButton);

	container.appendChild(box);

	const later = win && win.setTimeout ? win.setTimeout.bind(win) : setTimeout;
	let timer = null;
	function close() {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		try {
			box.style.opacity = "0";
			box.style.transform = "translateY(6px)";
			later(() => box.remove(), 260);
		}
		catch (e) {
			box.remove();
		}
	}

	if (timeout > 0) {
		timer = later(() => close(), timeout);
	}

	return { element: box, close };
}
