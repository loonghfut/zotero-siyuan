/**
 * Path helpers.
 *
 * `Zotero.getTempDirectory()` returns an **nsIFile**, not a string, and
 * `PathUtils.join()` only accepts strings — handing it the nsIFile produces
 * a garbage path (or a TypeError), so the temporary files the plugin writes
 * would never land where they should. Always go through `.path`.
 */

function fromDirSvc(key) {
	try {
		const dir = Services.dirsvc.get(key);
		return dir && dir.path ? dir.path : "";
	}
	catch (e) {
		return "";
	}
}

/**
 * The first source that yields a non-empty value.
 *
 * Every getter is independent, because no single one is guaranteed to work
 * everywhere: `Services.dirsvc` is not reachable in every scope, while
 * `Services.env` and `PathUtils` are — and vice versa.
 *
 * @param {...Function} getters
 * @returns {String}
 */
export function firstOf(...getters) {
	for (const getter of getters) {
		try {
			const value = getter();
			if (value) {
				return String(value);
			}
		}
		catch (e) {
			// try the next source
		}
	}
	return "";
}

/** The user's home directory. */
export function homeDir() {
	return firstOf(
		() => Services.dirsvc.get("Home").path,
		() => PathUtils.homeDir,
		() => Services.env.get("USERPROFILE"),
	);
}

/** The roaming application data directory (`%APPDATA%`). */
export function roamingAppDataDir() {
	return firstOf(
		() => Services.dirsvc.get("AppData").path,
		() => Services.env.get("APPDATA"),
	);
}

/** The local application data directory (`%LOCALAPPDATA%`). */
export function localAppDataDir() {
	const home = homeDir();
	return firstOf(
		() => Services.dirsvc.get("LocalAppData").path,
		() => Services.env.get("LOCALAPPDATA"),
		() => (home ? `${home}\\AppData\\Local` : ""),
	);
}

/** The system temp directory as a plain string path. */
export function tempDirPath() {
	try {
		const dir = Zotero.getTempDirectory();
		if (typeof dir === "string" && dir) {
			return dir;
		}
		if (dir && dir.path) {
			return dir.path;
		}
	}
	catch (e) {
		// fall through
	}

	try {
		if (PathUtils.tempDir) {
			return PathUtils.tempDir;
		}
	}
	catch (e) {
		// fall through
	}

	return fromDirSvc("Tmp");
}

/**
 * Join a file name onto the temp directory.
 * @param {String} name
 * @returns {String} an absolute path
 */
export function tempFilePath(name) {
	const dir = tempDirPath();
	if (!dir) {
		return name;
	}
	try {
		return PathUtils.join(dir, name);
	}
	catch (e) {
		return `${dir}\\${name}`;
	}
}
