/**
 * Zotero → SiYuan — the notification bubble.
 *
 * Zotero has no toast API, so the bubble is built here: a fixed element in
 * the document the user is looking at that fades away on its own. It can
 * carry a link — for instance to the SiYuan block that was just written.
 *
 * **Where** the bubble appears matters: a send starts from the PDF reader,
 * and a message in the main window's items list is a message the user does
 * not see while the reader fills the window. So a caller passes the
 * document it is working in (`doc`), and only a caller without one falls
 * back to `ZoteroPane`'s document.
 */

import { getString } from "../utils/locale.js";

const HTML_NS = "http://www.w3.org/1999/xhtml";

const TOAST_STYLE =
	"display:flex;flex-direction:column;gap:8px;position:relative;" +
	"pointer-events:auto;" +
	"max-width:400px;padding:12px 14px;border-radius:8px;" +
	"background:#2f2f33;color:#f4f4f5;font-size:13px;line-height:1.5;" +
	"box-shadow:0 6px 24px rgba(0,0,0,.35);" +
	"transition:opacity .25s ease, transform .25s ease;";

/**
 * Where bubbles are stacked.
 *
 * One fixed box at the corner of each document, with the bubbles as its
 * children — two messages at the same time would otherwise be drawn
 * exactly on top of each other, and the older one would only be readable
 * while the newer one is on its way out. With the container anchored at
 * the bottom, a new bubble takes the corner and pushes the older ones up.
 */
const CONTAINER_STYLE =
	"position:fixed;bottom:24px;right:24px;z-index:2147483647;" +
	"display:flex;flex-direction:column;align-items:flex-end;gap:8px;" +
	"pointer-events:none;";

/**
 * The stack of every document that is showing a bubble.
 *
 * One per document, not one for the plugin: a bubble can be shown in the
 * reader and in the main window at the same time, and the reader document
 * is replaced whenever a PDF is reopened — the old stack belongs to a
 * document that is no longer on screen.
 */
const stacks = new WeakMap();

const TITLE_STYLE = "display:block;font-weight:600;font-size:13px;";

const MESSAGE_STYLE =
	"display:block;opacity:.85;font-size:12.5px;white-space:pre-line;";

const LINK_STYLE =
	"display:block;color:#7cc4ff;text-decoration:underline;cursor:pointer;font-size:12.5px;";

const ACTIONS_STYLE =
	"display:flex;flex-wrap:wrap;gap:8px;margin-top:2px;";

const ACTION_STYLE =
	"padding:5px 9px;border:1px solid #55555c;border-radius:5px;" +
	"background:transparent;color:#f4f4f5;cursor:pointer;font:inherit;" +
	"font-size:12.5px;";

const ACTION_PRIMARY_STYLE =
	"padding:5px 9px;border:1px solid transparent;border-radius:5px;" +
	"background:#4a7dff;color:#fff;cursor:pointer;font:inherit;" +
	"font-size:12.5px;";

const CLOSE_STYLE =
	"position:absolute;top:6px;right:8px;color:#bbb;cursor:pointer;font-size:14px;line-height:1;";

/**
 * The stack a bubble goes into, for this document.
 *
 * @param {Object} doc
 * @returns {Object} the element
 */
function stackFor(doc) {
	const stack = stacks.get(doc);
	if (stack && stack.isConnected) {
		return stack;
	}
	const fresh = doc.createElementNS(HTML_NS, "div");
	fresh.style.cssText = CONTAINER_STYLE;
	(doc.body || doc.documentElement).appendChild(fresh);
	stacks.set(doc, fresh);
	return fresh;
}

/**
 * The document a bubble can be shown in.
 *
 * @param {Object} [doc] - the document the caller is working in
 * @returns {Object|null} { win, doc }
 */
export function toastTarget(doc = null) {
	// The caller's own document — the reader the send came from — is where
	// the user is looking.
	if (doc && doc.documentElement && (doc.body || doc.documentElement)) {
		return { win: doc.defaultView || null, doc };
	}
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
 * @param {Array} options.actions - buttons: { label, onClick, primary }
 * @param {Function} options.onClose - called once when the bubble goes away
 * @param {Object} options.doc - the document to show it in
 * @param {Boolean} options.retry - try again shortly when there is no window
 * @returns {Object|null} { element, close, update }
 */
export function showToast({
	title = "",
	message = "",
	link = "",
	linkLabel = "",
	timeout = 9000,
	onLink = null,
	actions = [],
	onClose = null,
	doc = null,
	retry = true,
} = {}) {
	const target = toastTarget(doc);
	if (!target) {
		// The content area may not exist yet right after startup — try again
		// a moment later rather than losing the message.
		if (retry) {
			const again = {
				title,
				message,
				link,
				linkLabel,
				timeout,
				onLink,
				actions,
				onClose,
				doc,
				retry: false,
			};
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

	const { win, doc: targetDoc } = target;
	const stack = stackFor(targetDoc);
	const create = (tag) => targetDoc.createElementNS(HTML_NS, tag);

	const box = create("div");
	box.style.cssText = TOAST_STYLE;
	// Read out by a screen reader when it appears — an error that is only
	// drawn in a corner is an error a blind user never learns about.
	box.setAttribute("role", "status");
	box.setAttribute("aria-live", "polite");

	let heading = null;
	if (title) {
		heading = create("div");
		heading.style.cssText = TITLE_STYLE;
		heading.textContent = title;
		box.appendChild(heading);
	}

	let body = null;
	if (message) {
		body = create("div");
		body.style.cssText = MESSAGE_STYLE;
		body.textContent = message;
		box.appendChild(body);
	}

	// A bubble that asks a question needs buttons the keyboard can reach —
	// a div with a click handler is invisible to it.
	if (Array.isArray(actions) && actions.length) {
		const row = create("div");
		row.style.cssText = ACTIONS_STYLE;
		for (const entry of actions) {
			if (!entry || !entry.label) {
				continue;
			}
			const button = create("button");
			button.type = "button";
			button.textContent = String(entry.label);
			button.style.cssText = entry.primary
				? ACTION_PRIMARY_STYLE
				: ACTION_STYLE;
			button.addEventListener("click", (e) => {
				e.preventDefault();
				try {
					if (entry.onClick) {
						entry.onClick();
					}
				}
				catch (err) {
					Zotero.debug(`ZoteroSiYuan: the toast action failed: ${err}`);
				}
				if (entry.close !== false) {
					close();
				}
			});
			row.appendChild(button);
		}
		if (row.childElementCount) {
			box.appendChild(row);
		}
	}

	const closeButton = create("div");
	closeButton.style.cssText = CLOSE_STYLE;
	closeButton.textContent = "×";
	// A `div` with a click handler is invisible to the keyboard. The bubble
	// carries the only way to dismiss an error that stays on screen, so it
	// has to be reachable without a mouse.
	closeButton.setAttribute("role", "button");
	closeButton.setAttribute("tabindex", "0");
	const closeLabel = getString(
		"zoteroSiYuan-toast-close",
		"Dismiss this message",
	);
	closeButton.setAttribute("aria-label", closeLabel);
	closeButton.title = closeLabel;
	closeButton.addEventListener("click", () => close());
	closeButton.addEventListener("keydown", (e) => {
		if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
			e.preventDefault();
			close();
		}
	});
	box.appendChild(closeButton);

	// The link can arrive later: a batch says "sending" first and only knows
	// where the block is once the last annotation is in. So it lives in
	// variables that `update()` may change, and the element is built the
	// first time there is something to link to.
	let actionLink = link;
	let actionLabel = linkLabel;
	let actionHandler = onLink;
	let action = null;
	function paintAction() {
		if (!actionLink && !actionHandler) {
			if (action) {
				action.style.display = "none";
			}
			return;
		}
		if (!action) {
			action = create("div");
			action.style.cssText = LINK_STYLE;
			// Same reason as the close button: it is the bubble's action,
			// and a keyboard has to be able to reach it.
			action.setAttribute("role", "link");
			action.setAttribute("tabindex", "0");
			box.insertBefore(action, closeButton);
			action.addEventListener("click", (e) => {
				e.preventDefault();
				try {
					if (actionHandler) {
						actionHandler();
					}
					else {
						Zotero.launchURL(actionLink);
					}
				}
				catch (err) {
					Zotero.debug(`ZoteroSiYuan: the toast link failed: ${err}`);
				}
				close();
			});
			action.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
					e.preventDefault();
					action.click();
				}
			});
		}
		action.style.display = "block";
		action.textContent = actionLabel || "Open in SiYuan";
	}
	paintAction();

	stack.appendChild(box);

	const later = win && win.setTimeout ? win.setTimeout.bind(win) : setTimeout;
	let timer = null;
	let closed = false;
	// The stack goes with its last bubble — an empty fixed element in the
	// corner is harmless but it is still litter.
	const dropStack = () => {
		if (stack.childElementCount) {
			return;
		}
		stack.remove();
		if (stacks.get(targetDoc) === stack) {
			stacks.delete(targetDoc);
		}
	};
	function close() {
		if (closed) {
			return;
		}
		closed = true;
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		try {
			if (onClose) {
				onClose();
			}
		}
		catch (e) {
			// The caller's cleanup must not keep the bubble on screen.
		}
		try {
			box.style.opacity = "0";
			box.style.transform = "translateY(6px)";
			later(() => {
				box.remove();
				dropStack();
			}, 260);
		}
		catch (e) {
			box.remove();
			dropStack();
		}
	}

	/**
	 * Say something else in the bubble that is already there.
	 *
	 * A batch send runs one annotation after another, and a bubble per
	 * annotation would pile up ten of them; the one that is already on
	 * screen carries the progress instead.
	 */
	function update(next = {}) {
		try {
			if (next.title !== undefined && heading) {
				heading.textContent = next.title;
			}
			if (next.message !== undefined && body) {
				body.textContent = next.message;
			}
			if (next.link !== undefined) {
				actionLink = next.link;
			}
			if (next.linkLabel !== undefined) {
				actionLabel = next.linkLabel;
			}
			if (next.onLink !== undefined) {
				actionHandler = next.onLink;
			}
			if (
				next.link !== undefined ||
				next.linkLabel !== undefined ||
				next.onLink !== undefined
			) {
				paintAction();
			}
			if (next.timeout !== undefined) {
				timeout = next.timeout;
			}
			// Each update gives the bubble a fresh moment to live.
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			if (timeout > 0) {
				timer = later(() => close(), timeout);
			}
		}
		catch (e) {
			// The document went away — the bubble went with it.
		}
	}

	if (timeout > 0) {
		timer = later(() => close(), timeout);
	}

	return { element: box, close, update };
}
