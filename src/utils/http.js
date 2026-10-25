/**
 * HTTP helpers.
 *
 * `Zotero.HTTP.request()` resolves with the **XMLHttpRequest** object, not
 * with a Fetch `Response` — so the body is in `responseText`, and
 * `response.text()` does not exist. (A Fetch-style helper is used by the
 * connector, but not by this API.)
 */

/**
 * Read the body of a response, whichever shape it has.
 * @param {Object} response - what Zotero.HTTP.request resolved with
 * @returns {Promise<String>}
 */
export async function responseText(response) {
	if (!response) {
		return "";
	}
	if (typeof response.text === "function") {
		return await response.text();
	}
	if (typeof response.responseText === "string") {
		return response.responseText;
	}
	if (typeof response.body === "string") {
		return response.body;
	}
	return "";
}

/**
 * The status code of a response, if it has one.
 * @param {Object} response
 * @returns {Number}
 */
export function responseStatus(response) {
	if (!response) {
		return 0;
	}
	if (typeof response.status === "number") {
		return response.status;
	}
	if (typeof response.responseStatus === "number") {
		return response.responseStatus;
	}
	return 0;
}
