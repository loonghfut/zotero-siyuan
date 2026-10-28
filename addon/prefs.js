pref("cliPath", "");
pref("workspace", "");
pref("notebook", "");
// Where a note goes: "daily" (today's daily note), "document" (a fixed
// document) or "item" (one document per Zotero item).
pref("destination", "daily");
// For "document": a document id, or the title of a document to look up.
pref("targetDocument", "");
// For "item": the title template and the parent document path of the
// document created for an item.
pref("itemDocName", "{{title}}");
pref("itemDocPath", "/");
// What a click on an already-sent annotation does: "ask", "skip", "send"
// (append another note) or "replace" (delete the old note first).
pref("sentAction", "ask");
// The send template. Empty = use the built-in default.
pref("template", "");
// The template for "one document per item". Empty = use the template above:
// a per-item note is often a reading note with a different shape, but not
// every user needs two of them.
pref("itemTemplate", "");
// The templates the user saved for later: a JSON array of
// { "id": …, "name": …, "template": … }. Empty = none saved yet.
pref("templates", "[]");
// The picture of a "框选" annotation is a screenshot of the page — several
// times as big as it needs to be. "0" sends it as it is; the quality is
// the JPEG quality in percent.
pref("imageCompress", "1");
pref("imageQuality", "82");
// "1" runs the end-to-end self test on every start (dry run, nothing is
// written). It is off by default: it costs a few seconds of polling on
// every start. The preferences pane has a button that runs it on demand.
pref("selfTest", "0");
// "1" for selfTestWrite additionally appends a real test block (and removes
// it again). Only meaningful together with selfTest.
pref("selfTestWrite", "");
// "1" lets the plugin stop the browser's "open with SiYuan?" confirmation
// for siyuan:// links. That is a browser-wide preference, so it happens
// only when it is asked for.
pref("silentProtocol", "");
