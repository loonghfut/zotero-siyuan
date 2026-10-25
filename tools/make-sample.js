/**
 * Render the send template with a made-up annotation, using the plugin's
 * own template engine, so a sample can be produced without a running Zotero.
 */
import { renderTemplate, DEFAULT_TEMPLATE } from "../src/modules/template.js";
import { writeFileSync } from "node:fs";

// Minimal stand-ins for the Zotero APIs the metadata collector uses.
globalThis.Zotero = {
  Utilities: {
    Item: {
      itemToCSLJSON(item) {
        return {
          author: item.getCreators().map((c) => ({
            given: c.firstName,
            family: c.lastName,
            literal: c.fieldMode === 1 ? c.name : undefined,
          })),
        };
      },
    },
  },
  ItemTypes: {
    getName: () => "journalArticle",
  },
};

const parentItem = {
  key: "ABCD1234",
  itemTypeID: 1,
  getField(field) {
    return {
      title: "Attention Is All You Need",
      date: "2017",
      publicationTitle: "Advances in Neural Information Processing Systems",
      DOI: "10.5555/3295222.3295349",
    }[field] || "";
  },
  getCreators() {
    return [{ firstName: "Ashish", lastName: "Vaswani", fieldMode: 0 }];
  },
  getTags() {
    return [{ tag: "transformer" }];
  },
};

const { collectMetadata } = await import("../src/modules/metadata.js");

const vars = collectMetadata({
  annotation: {
    id: "ANNO0001",
    type: "highlight",
    text: "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.",
    comment: "This is the core idea of the paper.",
    pageLabel: "3",
    authorName: "steve",
    position: { pageIndex: 2 },
  },
  parentItem,
  attachment: { key: "ATTACH01" },
  annotationKey: "ANNO0001",
  extra: { date: "2026-10-25", time: "18:54", timestamp: "2026-10-25 18:54:33" },
});

const template = process.argv[3] || DEFAULT_TEMPLATE;
const { text, unknown } = renderTemplate(template, vars);

const out = process.argv[2] || "plugin-output.md";
writeFileSync(out, text, "utf8");
console.log(text);
if (unknown.length) {
  console.log(`\nunknown variables: ${unknown.join(", ")}`);
}
console.log(`\n--- written to ${out} ---`);
