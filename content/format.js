/**
 * Zotero → SiYuan — markdown formatting.
 *
 * Turns a reader annotation plus its parent bibliographic item into the
 * Markdown that gets appended to the SiYuan daily note.
 *
 * Exposed as a global (the file is loaded into the plugin scope with
 * Services.scriptloader.loadSubScript), so everything is a `var` declaration.
 */

"use strict";

var ZS_FORMAT = (function () {
	/**
	 * Escape the characters that would otherwise be interpreted as Markdown
	 * structure inside a paragraph. We keep the text readable rather than
	 * producing a perfectly lossless round-trip.
	 */
	function escapeInline(text) {
		return String(text == null ? '' : text)
			.replace(/\\/g, '\\\\')
			.replace(/([*_`])/g, '\\$1')
			.replace(/^(\s*)([-+>])(\s)/gm, '$1\\$2$3')
			.replace(/^(\s*)(\d+)\.(\s)/gm, '$1$2\\.$3');
	}

	/** Trim, collapse blank lines, and prefix every line with "> " for a callout. */
	function toCallout(lines, label) {
		var body = lines
			.join('\n')
			.split('\n')
			.map(function (line) {
				return line.trim() ? '> ' + line : '>';
			})
			.join('\n');
		return '> [!' + label.type + '] ' + label.title + '\n' + body;
	}

	function getYear(item) {
		var date = item.getField('date') || '';
		var match = String(date).match(/(\d{4})/);
		return match ? match[1] : '';
	}

	function getCreatorList(item) {
		var creators = null;
		try {
			// CSL JSON gives correctly ordered names and puts CJK names into
			// `literal`, which is what we want for a personal note.
			var csl = Zotero.Utilities.Item.itemToCSLJSON(item);
			if (csl) {
				creators = []
					.concat(csl.author || [])
					.concat(csl.editor || [])
					.concat(csl.translator || []);
			}
		}
		catch (e) {
			creators = null;
		}
		if (!creators || !creators.length) {
			creators = (item.getCreators() || []).map(function (creator) {
				return creator.fieldMode === 1
					? { literal: creator.name }
					: { given: creator.firstName, family: creator.lastName };
			});
		}
		return creators
			.map(function (creator) {
				if (creator.literal) {
					return creator.literal;
				}
				return [creator.given, creator.family].filter(Boolean).join(' ');
			})
			.filter(Boolean)
			.join('、');
	}

	/**
	 * @param {Object} options
	 * @param {Object} options.annotation - the reader's annotation model
	 *   ({ id, type, text, comment, pageLabel, authorName, dateModified, color })
	 * @param {Zotero.Item} options.parentItem - the bibliographic item
	 * @param {Object} options.strings - localized labels
	 * @returns {String} Markdown
	 */
	function buildMarkdown(options) {
		var annotation = options.annotation || {};
		var parentItem = options.parentItem;
		var strings = options.strings || {};
		var blocks = [];

		var title = parentItem ? parentItem.getField('title') : '';
		var quoteTitle = strings.quoteTitle || 'Quote';
		if (title) {
			quoteTitle += ' · ' + title;
		}

		// --- The highlighted / selected text -------------------------------
		var text = String(annotation.text || '').trim();
		if (text) {
			blocks.push(toCallout(text.split('\n'), { type: 'quote', title: quoteTitle }));
		}

		// --- The comment the user typed on the annotation -----------------
		var comment = String(annotation.comment || '').trim();
		if (comment) {
			blocks.push(toCallout(comment.split('\n'), {
				type: 'note',
				title: strings.commentTitle || 'Comment'
			}));
		}

		if (!blocks.length) {
			blocks.push(toCallout([strings.emptyAnnotation || '(empty annotation)'], {
				type: 'note',
				title: strings.commentTitle || 'Comment'
			}));
		}

		// --- Bibliographic metadata + Zotero deep link --------------------
		var meta = [];
		if (parentItem) {
			var creators = getCreatorList(parentItem);
			var year = getYear(parentItem);
			if (creators) {
				meta.push((strings.authorLabel || 'Author') + '：' + creators);
			}
			if (year) {
				meta.push((strings.yearLabel || 'Year') + '：' + year);
			}
			if (parentItem.getField('publicationTitle')) {
				meta.push((strings.publicationLabel || 'Publication') + '：' + parentItem.getField('publicationTitle'));
			}
		}
		if (annotation.pageLabel) {
			meta.push((strings.pageLabel || 'Page') + '：' + annotation.pageLabel);
		}
		if (annotation.authorName) {
			meta.push((strings.annotatorLabel || 'Annotated by') + '：' + annotation.authorName);
		}
		if (parentItem && parentItem.key) {
			meta.push((strings.sourceLabel || 'Source')
				+ '：[' + escapeInline(parentItem.getField('title') || parentItem.key)
				+ '](zotero://select/library/items/' + parentItem.key + ')');
		}

		if (meta.length) {
			blocks.push(meta.join('  \n'));
		}

		return blocks.join('\n\n');
	}

	return {
		buildMarkdown: buildMarkdown,
		escapeInline: escapeInline
	};
}());
