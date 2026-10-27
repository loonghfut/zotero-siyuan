/**
 * Zotero → SiYuan — the static checks for The picture of an area selection:
 * what lands in the workspace.
 *
 * The checks are split in two because they are two subjects: what the
 * plugin does with a picture before it is written (`08-pictures.mjs`), and
 * what the file system ends up with (`08b-picture-file.mjs`). The second
 * one needs a stand-in for `IOUtils` and `PathUtils`, which is why it is a
 * file of its own.
 *
 * Part of `node tools/validate.mjs`: this file runs when it is imported, and
 * the entry point prints the summary. `check()` and `section()` come from
 * `harness.mjs`, together with the source readers.
 */

import {
  allSource,
  check,
  section,
  pictureSource,
} from "./harness.mjs";

/* --------------- 13b. the picture really lands in the workspace ---------- */

section("Picture in the workspace");
{
  // Read for the two checks that ask about the file APIs the package uses.
  const source = pictureSource();
  const index = allSource;
  const {
    assetsDir,
    exportPicture,
    pictureAssetNames,
    pictureFile,
    removePicture,
    compressImage,
    compressionPays,
    base64Of,
    memoizedPictures,
    forgetPictures,
  } = await import(
    new URL("../../src/modules/siyuan-image.js", import.meta.url).href
  );
  // --- the picture really lands in the workspace -------------------------
  // Outside Zotero there is no `IOUtils`, so a small stand-in is put in
  // its place — it only has to behave like the real one.
  const disk = new Map();
  const dirs = new Set();
  const hadPathUtils = "PathUtils" in globalThis;
  const hadIOUtils = "IOUtils" in globalThis;
  const oldPathUtils = globalThis.PathUtils;
  const oldIOUtils = globalThis.IOUtils;
  globalThis.PathUtils = {
    join: (...parts) => {
      // `PathUtils.join` goes through nsIFile, and nsIFile does not take
      // a component that holds a separator — "assets/name.png" is not a
      // name, and appending it fails.
      for (const part of parts.slice(1)) {
        if (/[\\/]/.test(part)) {
          throw new Error(
            "Could not append to path: NS_ERROR_FILE_UNRECOGNIZED_PATH",
          );
        }
      }
      return parts.join("/").replace(/\/{2,}/g, "/");
    },
  };
  globalThis.IOUtils = {
    exists: async (path) => disk.has(path),
    // The real `makeDirectory` throws when the directory is already
    // there, unless `ignoreExisting` says otherwise. The assets folder
    // usually is — and the picture then never arrives.
    makeDirectory: async (path, options = {}) => {
      if (dirs.has(path) && !options.ignoreExisting) {
        throw new Error(`the directory already exists: ${path}`);
      }
      dirs.add(path);
    },
    newFile: undefined,
    read: async (path) => disk.get(path),
    // The real `IOUtils.write` takes the path itself — there is no
    // `IOUtils.newFile`, and the stand-in must not invent one.
    write: async (path, data) => {
      if (typeof path !== "string") {
        throw new TypeError("IOUtils.write takes a path");
      }
      disk.set(path, data);
    },
    remove: async (path) => {
      disk.delete(path);
    },
  };
  try {
    check(
      "the assets folder is the workspace's own",
      assetsDir("D:/workspace").endsWith("data/assets"),
      assetsDir("D:/workspace"),
    );

    // The assets folder is normally already there — and the real
    // `makeDirectory` treats that as an error unless it is told not to.
    // (Zotero's own `osfile.mjs` has to say so explicitly, too.)
    {
      dirs.add("D:/siyu2/data/assets");
      let failed = "";
      try {
        await exportPicture(
          "D:/siyu2",
          { path: "C:/zotero/cache/library/ABCD1234.png" },
          "zotero-siyuan-ABCD1234-20260101000000",
        );
      }
      catch (e) {
        failed = String(e && e.message ? e.message : e);
      }
      check(
        "the picture lands in a folder that is already there",
        failed === "",
        failed,
      );
    }

    // A stand-in for the file API must not be more forgiving than the
    // real one: `IOUtils.newFile` does not exist, and a picture that
    // calls it never arrives.
    check(
      "the plugin only uses file APIs that really exist",
      !/IOUtils\.newFile\s*\(/.test(pictureSource),
      "IOUtils.newFile is not an API — IOUtils.write takes the path",
    );

    const bytes = new Uint8Array([1, 2, 3, 4]);
    disk.set("C:/zotero/cache/library/ABCD1234.png", bytes);
    let copied = { asset: "", file: "" };
    let copyError = "";
    try {
      copied = await exportPicture(
        "D:/workspace",
        { path: "C:/zotero/cache/library/ABCD1234.png" },
        "zotero-siyuan-ABCD1234-20260101000000",
      );
    }
    catch (e) {
      copyError = String(e && e.message ? e.message : e);
    }
    check(
      "the picture is copied into the workspace's assets",
      copyError === "" &&
        copied.asset === "assets/zotero-siyuan-ABCD1234-20260101000000.png" &&
        copied.file ===
          "D:/workspace/data/assets/zotero-siyuan-ABCD1234-20260101000000.png" &&
        disk.get("D:/workspace/data/assets/zotero-siyuan-ABCD1234-20260101000000.png") ===
          bytes,
      copyError || copied.asset,
    );

    const dataURL = `data:image/png;base64,${Buffer.from("PNG").toString("base64")}`;
    let written = { asset: "", file: "" };
    let writeError = "";
    try {
      written = await exportPicture(
        "D:/workspace",
        { dataURL },
        "zotero-siyuan-ABCD1234-20260101000000",
      );
    }
    catch (e) {
      writeError = String(e && e.message ? e.message : e);
    }
    const writtenBytes = disk.get(
      "D:/workspace/data/assets/zotero-siyuan-ABCD1234-20260101000000.png",
    );
    check(
      "a picture that only exists as a data URL is written out",
      writeError === "" &&
        written.asset === "assets/zotero-siyuan-ABCD1234-20260101000000.png" &&
        writtenBytes &&
        writtenBytes.length === 3 &&
        String.fromCharCode(...writtenBytes) === "PNG",
      writeError || String(writtenBytes && writtenBytes.length),
    );

    check(
      "there is no picture, there is no path",
      (await exportPicture("D:/workspace", null, "x")).asset === "",
    );

    // --- the picture is compressed before it is sent --------------------
    {
      // A gate that crashes instead of failing is a weak gate: the
      // checks after it would never run. So every call is caught.
      const tryExport = async (...args) => {
        try {
          return { result: await exportPicture(...args), error: "" };
        }
        catch (e) {
          return {
            result: { asset: "", file: "", compressed: false },
            error: String(e && e.message ? e.message : e),
          };
        }
      };

      check(
        "the compressed picture is used when it is smaller",
        compressionPays(1000, 500) === true,
      );
      check(
        "a bigger picture is not used",
        compressionPays(1000, 1500) === false,
      );
      check(
        "an empty picture is not used",
        compressionPays(1000, 0) === false,
      );

      // The stand-in for the compression: it answers with fewer bytes.
      const smaller = new Uint8Array([9, 9]);
      const compressed = await tryExport(
        "D:/workspace",
        { path: "C:/zotero/cache/library/ABCD1234.png" },
        "zotero-siyuan-COMP-20260101000000",
        {
          compressor: async () => ({
            bytes: smaller,
            type: "image/jpeg",
            width: 1918,
            height: 819,
          }),
        },
      );
      check(
        "the compressed picture is the one that goes into the workspace",
        compressed.error === "" &&
          compressed.result.asset ===
            "assets/zotero-siyuan-COMP-20260101000000.jpg" &&
          compressed.result.compressed === true &&
          disk.get("D:/workspace/data/assets/zotero-siyuan-COMP-20260101000000.jpg") ===
            smaller,
        compressed.error || compressed.result.asset,
      );

      // A compression that does not help is not worth the trouble.
      const bigger = await tryExport(
        "D:/workspace",
        { path: "C:/zotero/cache/library/ABCD1234.png" },
        "zotero-siyuan-BIG-20260101000000",
        {
          compressor: async () => ({
            bytes: new Uint8Array(99),
            type: "image/jpeg",
          }),
        },
      );
      check(
        "a picture that did not get smaller keeps its format",
        bigger.error === "" &&
          bigger.result.asset ===
            "assets/zotero-siyuan-BIG-20260101000000.png" &&
          bigger.result.compressed === false,
        bigger.error || bigger.result.asset,
      );

      // A compression that failed leaves the picture as it was.
      const failed = await tryExport(
        "D:/workspace",
        { path: "C:/zotero/cache/library/ABCD1234.png" },
        "zotero-siyuan-FAIL-20260101000000",
        { compressor: async () => null },
      );
      check(
        "a picture that could not be compressed is sent as it is",
        failed.error === "" &&
          failed.result.asset ===
            "assets/zotero-siyuan-FAIL-20260101000000.png" &&
          failed.result.compressed === false,
        failed.error || failed.result.asset,
      );

      // And the user may turn the compression off altogether.
      const off = await tryExport(
        "D:/workspace",
        { path: "C:/zotero/cache/library/ABCD1234.png" },
        "zotero-siyuan-OFF-20260101000000",
        {
          compress: false,
          compressor: async () => {
            throw new Error("the compression must not even be tried");
          },
        },
      );
      check(
        "the compression can be turned off",
        off.error === "" &&
          off.result.asset ===
            "assets/zotero-siyuan-OFF-20260101000000.png" &&
          off.result.compressed === false,
        off.error || off.result.asset,
      );

      // --- the same picture is not compressed twice ---------------------
      {
        // Decoding and re-encoding a screenshot is the most expensive step
        // of a send. Sending the same selection again — a second click, or
        // a batch that contains something already sent — must not pay for
        // it twice.
        let compressions = 0;
        let opens = 0;
        const stub = async () => {
          compressions++;
          opens++;
          return {
            bytes: new Uint8Array(120),
            type: "image/jpeg",
            width: 1918,
            height: 819,
            way: "stub",
          };
        };
        const big = new Uint8Array(777).fill(3);
        disk.set("C:/zotero/cache/library/MEMO0001.png", big);
        const first = await tryExport(
          "D:/workspace",
          { path: "C:/zotero/cache/library/MEMO0001.png" },
          "zotero-siyuan-MEMO-20260101000000",
          { compressor: stub, memo: true },
        );
        const again = await tryExport(
          "D:/workspace",
          { path: "C:/zotero/cache/library/MEMO0001.png" },
          "zotero-siyuan-MEMO2-20260101000000",
          { compressor: stub, memo: true },
        );
        check(
          "the same picture is compressed once",
          compressions === 1 &&
            first.result.memoized === false &&
            again.result.memoized === true,
          `${compressions} compression(s), memoized: ${again.result.memoized}`,
        );
        check(
          "the remembered picture is the one that is written",
          again.error === "" &&
            again.result.asset ===
              "assets/zotero-siyuan-MEMO2-20260101000000.jpg" &&
            disk.get(
              "D:/workspace/data/assets/zotero-siyuan-MEMO2-20260101000000.jpg",
            ).length === 120,
          again.error || again.result.asset,
        );
        check(
          "a remembered picture can be let go of",
          memoizedPictures() === 1,
          String(memoizedPictures()),
        );
        forgetPictures();
        check("a shutdown keeps no pictures in memory", memoizedPictures() === 0);
      }
    }

    // Outside a browser there is no canvas — and the compression must not
    // throw: a note is better than no note.
    {
      let result = null;
      let error = "";
      try {
        result = await compressImage(new Uint8Array([1, 2, 3, 4]));
      }
      catch (e) {
        error = String(e && e.message ? e.message : e);
      }
      check(
        "a picture that cannot be compressed is not an error",
        error === "" && result === null,
        error || String(result),
      );
    }
    check(
      "the bytes of a picture can be turned into a data URL",
      base64Of(new Uint8Array([80, 78, 71])) === "UE5H" &&
        base64Of(new Uint8Array(0)) === "",
      base64Of(new Uint8Array([80, 78, 71])),
    );

    // The plugin has to ask for the compression, and to say how well it
    // should be done.
    check(
      "the plugin compresses the picture before it is sent",
      /prefFlag\("imageCompress"/.test(index) &&
        /getPref\("imageQuality"/.test(index) &&
        /exportPicture\([\s\S]*?\{\s*compress,\s*quality\s*\}/.test(index),
    );

    // --- a picture that nobody refers to is litter ----------------------
    {
      let path = "";
      let error = "";
      try {
        path = pictureFile("D:/workspace", "assets/a.png");
      }
      catch (e) {
        error = String(e && e.message ? e.message : e);
      }
      check(
        "the picture's real path is inside the workspace's assets",
        error === "" && path === "D:/workspace/data/assets/a.png",
        error || path,
      );
    }
    check(
      "the pictures a Markdown refers to are found",
      pictureAssetNames(
        "> ![框选](assets/zotero-siyuan-ABCD1234-20260101000000.png)",
      ).join(",") === "zotero-siyuan-ABCD1234-20260101000000.png" &&
        pictureAssetNames("nothing here").length === 0,
      pictureAssetNames("![a](assets/x.png) and ![b](assets/y.png)").join(","),
    );
    await removePicture("D:/workspace/data/assets/zotero-siyuan-ABCD1234-20260101000000.png");
    check(
      "a picture can be taken back out of the workspace",
      !disk.has("D:/workspace/data/assets/zotero-siyuan-ABCD1234-20260101000000.png"),
    );
  }
  finally {
    if (hadPathUtils) {
      globalThis.PathUtils = oldPathUtils;
    }
    else {
      delete globalThis.PathUtils;
    }
    if (hadIOUtils) {
      globalThis.IOUtils = oldIOUtils;
    }
    else {
      delete globalThis.IOUtils;
    }
  }
}
