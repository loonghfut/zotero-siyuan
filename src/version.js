/**
 * The version of this build.
 *
 * Written by `tools/bump-version.mjs` on every build, so it always says
 * the same thing as the manifest. The addon manager keeps its own copy of
 * the version, and that copy can be a version behind the code that is
 * really running.
 */
export const VERSION = "0.2.94";
