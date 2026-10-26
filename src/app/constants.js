/**
 * Zotero → SiYuan — the values every part of the plugin shares.
 *
 * Kept in one file so there is a single place to look when a number, an id
 * or a piece of markup has to change.
 */

import { VERSION } from "../version.js";

/** The arrow that is drawn inside the send button. */
export const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><path fill="currentColor" d="M9 2.5 15.5 8 9 13.5V9.6H2.5V6.4H9V2.5Z"/></svg>';

export const PLUGIN_ID = "zotero-siyuan@example.com";

/**
 * How long the notebook list is trusted, in milliseconds.
 *
 * Listing the notebooks spawns the CLI, and a batch send would do it for
 * every annotation. A minute is short enough that a notebook created or
 * renamed in SiYuan is picked up without restarting Zotero.
 */
export const NOTEBOOK_CACHE_MS = 60000;

/**
 * How long the sample annotation behind the template preview is reused, in
 * milliseconds.
 *
 * The preview re-renders on every keystroke; picking the sample means a
 * query plus a few item reads, and none of that changes while the user is
 * typing a template.
 */
export const SAMPLE_CACHE_MS = 60000;

/**
 * How long the automatically detected SiYuan workspace is trusted, in
 * milliseconds.
 *
 * The workspace decides where a picture is put. SiYuan keeps one workspace
 * open at a time and the user can switch it while Zotero runs, so the
 * answer cannot be cached for the rest of the session: half a minute keeps
 * a batch cheap and still notices a switch before the next send.
 */
export const WORKSPACE_CACHE_MS = 30000;

/**
 * How long after startup the plugin first looks at the sidebars that are
 * already drawn, in milliseconds.
 *
 * A reader that was restored when Zotero started drew its sidebar before
 * this plugin was awake, and the reader's own event never reached it — so
 * those sidebars are patched by hand. Doing that on the startup path would
 * put a process (the index query) in front of the window being drawn, so the
 * first look waits until the window is up.
 */
export const WATCH_FIRST_DELAY = 1200;

/** The longest pause between two looks at the sidebars, in milliseconds. */
export const WATCH_MAX_DELAY = 5000;

/**
 * How long the sidebars are watched at all, in milliseconds.
 *
 * The watcher only exists for a reader that drew its sidebar *before* this
 * plugin was awake — those are ready within a moment of the window coming
 * up. A reader that is still loading does not need to be waited for: it
 * hands the render event over as soon as it draws, and the plugin is
 * listening by then. So the ceiling is a safety net, not a working window,
 * and it is short enough that a plugin which never finds anything to patch
 * has stopped before the user could notice it running.
 */
export const WATCH_WINDOW_MS = 45000;

/**
 * How many looks happen before the watcher may stop early.
 *
 * A reader takes a moment to appear after startup — stopping at the first
 * tick would miss a session that is still being restored.
 */
export const WATCH_MIN_TICKS = 3;

/**
 * How a button looks while a send is running.
 *
 * Every button of the reader is dimmed for the duration, not only the one
 * that was clicked: a second click while the first send is in flight would
 * write the same note twice.
 */
export const BUSY_OPACITY = "0.4";

/**
 * Which build is running.
 *
 * The debug log says it on startup, so it is always possible to tell from a
 * log which code is really in the profile — replacing the XPI does not
 * always replace the script on the first start. `tools/bump-version.mjs`
 * keeps this in step with the manifest.
 */
export const BUILD = VERSION;

export const BUTTON_STYLE =
  "display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;min-width:20px;padding:0;margin:0 2px;border:0;border-radius:3px;background:transparent;color:inherit;cursor:pointer;opacity:.65;";

export const SENT_LINK_STYLE =
  "display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;min-width:18px;padding:0;margin:0 2px;border:0;border-radius:3px;background:transparent;cursor:pointer;opacity:.85;text-decoration:none;";

export const SENT_ICON_STYLE = "display:block;flex:none;";
