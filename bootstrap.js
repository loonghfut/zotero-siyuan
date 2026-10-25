/**
 * Zotero → SiYuan — bootstrap.js
 *
 * Lifecycle hooks for a bootstrapped Zotero plugin. In Zotero 8+ the bootstrap
 * scope exposes Zotero, Services, ChromeUtils, IOUtils, PathUtils,
 * Localization, … but NOT Components / Cc / Ci.
 */

var Plugin;

function install() {}

function uninstall() {}

async function startup({ id, version, rootURI }, reason) {
	// Load order matters only in that main.js uses the other two at call time.
	Services.scriptloader.loadSubScript(rootURI + 'content/format.js');
	Services.scriptloader.loadSubScript(rootURI + 'content/siyuan.js');
	Services.scriptloader.loadSubScript(rootURI + 'content/main.js');

	Plugin = new ZoteroSiYuan({ id, version, rootURI });
	await Plugin.init();
}

function shutdown() {
	if (Plugin) {
		Plugin.destroy();
		Plugin = undefined;
	}
}

// The plugin does not touch the main Zotero window's DOM: the reader UI is
// reached through Zotero.Reader's event API, and the preferences pane through
// Zotero.PreferencePanes. Both are torn down in destroy().
