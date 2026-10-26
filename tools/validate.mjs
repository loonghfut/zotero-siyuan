/**
 * Static checks for the Zotero → SiYuan plugin.
 *
 * These catch the failures that a successful build does not reveal:
 *   - a method handed to an event listener without being bound
 *   - a Fluent id used in code that no locale defines
 *   - a packaged XPI that is missing a file the client needs
 *
 * The checks themselves live in `validate/`, one file per area, and run in
 * the order they are imported here. `harness.mjs` holds what they share.
 *
 * Usage: node tools/validate.mjs
 */
import "./validate/00-layout.mjs"; // The project's own layout
import "./validate/01-syntax.mjs"; // Syntax and callback binding
import "./validate/02-fluent.mjs"; // The Fluent messages the plugin asks for
import "./validate/03-cli.mjs"; // The siyuan CLI: where it is, and what it answers
import "./validate/04-template.mjs"; // The send template and its editor
import "./validate/05-pane.mjs"; // The preferences pane: conditionals and picture settings
import "./validate/06-index.mjs"; // The index of sent annotations, the launcher, the package
import "./validate/07-reader.mjs"; // The reader's sidebar contract
import "./validate/08-pictures.mjs"; // The picture of an area selection
import "./validate/08b-picture-file.mjs"; // … and what lands in the workspace
import "./validate/09-regression.mjs"; // Guards against the bugs that came back once already
import "./validate/10-startup.mjs"; // Startup and the self test
import "./validate/11-xpi.mjs"; // The packaged XPI
import { report } from "./validate/harness.mjs";

report();
