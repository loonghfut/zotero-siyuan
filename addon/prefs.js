pref("cliPath", "");
pref("workspace", "");
pref("notebook", "");
// The send template. Empty = use the built-in default.
pref("template", "");
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
