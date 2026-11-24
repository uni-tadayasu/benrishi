#!/usr/bin/env python3
"""Package offline law figures in 12 browser-readable ZIP_STORED archives.

Run after fetch-laws.py and fetch-law-figures.py, before gzipping law JSON.
python3 scripts/package-law-figures.py --corpus law-corpus

Archive members use the exact same corpus-relative path as figureLinks.url,
for example figures/335M50000400010/pict/2FH00000012345.pdf. Every member has
ZIP compression method 0 (STORED). The browser can locate each member from the
central directory and slice its bytes without an external decompression library.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import mimetypes
import pathlib
import zipfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", default="law-corpus")
    args = parser.parse_args()
    corpus = pathlib.Path(args.corpus)
    manifest_path = corpus / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    files = []
    archive_bytes = 0
    uncompressed_bytes = 0
    figures_count = 0
    archive_count = 0
    for item in manifest["laws"]:
        law_path = corpus / item["file"]
        law = json.loads(law_path.read_text())
        figures = law.get("figureLinks", [])
        figure_archive = None
        if figures:
            filename = "figures-" + law["id"] + ".zip"
            entries = []
            archive_path = corpus / filename
            with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_STORED, allowZip64=False) as archive:
                seen = set()
                for figure in figures:
                    rel = figure["file"]
                    rel_path = pathlib.PurePosixPath(rel)
                    if rel_path.is_absolute() or ".." in rel_path.parts:
                        raise ValueError("Unsafe local figure path")
                    if rel in seen:
                        continue
                    seen.add(rel)
                    data = (corpus / rel).read_bytes()
                    info = zipfile.ZipInfo(rel, date_time=(2026, 11, 25, 0, 0, 0))
                    info.compress_type = zipfile.ZIP_STORED
                    info.external_attr = 0o100644 << 16
                    archive.writestr(info, data)
                    entries.append({"path": rel, "mimeType": figure.get("mimeType") or mimetypes.guess_type(rel)[0],
                                    "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
            with zipfile.ZipFile(archive_path) as archive:
                if archive.testzip() is not None:
                    raise ValueError("ZIP CRC validation failed")
                if any(x.compress_type != zipfile.ZIP_STORED for x in archive.infolist()):
                    raise ValueError("ZIP includes compressed members")
                for entry in entries:
                    if archive.getinfo(entry["path"]).file_size != entry["size"]:
                        raise ValueError("ZIP member size mismatch")
            size = archive_path.stat().st_size
            figure_archive = {"file": filename, "bytes": size, "compression": "stored", "method": 0,
                              "entryCount": len(entries), "entries": entries}
            law["figureArchive"] = figure_archive
            item["figureArchive"] = figure_archive
            archive_bytes += size
            uncompressed_bytes += sum(x["size"] for x in entries)
            figures_count += len(entries)
            archive_count += 1
            for record in [law] + law["articles"] + law["appendices"]:
                for figure in record.get("figureLinks", []):
                    figure["archiveFile"] = filename
                    figure["archivePath"] = figure["file"]
                    figure["offline"] = True
            law["coverageNote"] = "e-Govの指定時点の法令XMLに含まれる本則・附則・別表等のテキストを収録。図・画像様式は同梱アーカイブから表示できます。条約・判例は別資料です。"
        law_path.write_text(json.dumps(law, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        item["bytes"] = law_path.stat().st_size
        files.append({"path": item["file"], "bytes": item["bytes"], "mimeType": "application/json", "lawId": law["id"]})
        if figure_archive:
            files.append({"path": figure_archive["file"], "bytes": figure_archive["bytes"],
                          "mimeType": "application/zip", "lawId": law["id"], "compression": "stored",
                          "sha256": hashlib.sha256((corpus / figure_archive["file"]).read_bytes()).hexdigest()})
    manifest["files"] = files
    manifest["jsonBytes"] = sum(x["bytes"] for x in files if x["mimeType"] == "application/json")
    manifest["assetBytes"] = archive_bytes
    manifest["uncompressedFigureBytes"] = uncompressed_bytes
    manifest["totalFigureCount"] = figures_count
    manifest["offlineFigureFiles"] = figures_count
    manifest["figureArchiveCount"] = archive_count
    manifest["offlineFigureComplete"] = figures_count == manifest["figureCount"]
    manifest["deployedFileCount"] = len(files)
    manifest["totalBytes"] = sum(x["bytes"] for x in files)
    manifest["attachmentNote"] = f"図・画像様式は無圧縮ZIPに収録した{figures_count}点のPDF。表示時は端末内でPDFのデータを取り出します。"
    manifest["archiveFormat"] = {"compressionMethod": 0, "zip64": False,
                                  "memberPath": "figureLinks.archivePath matches figureLinks.url and the ZIP central-directory member name exactly",
                                  "deployedFiles": "Only manifest.files are needed; loose figures remain in scratch for validation."}
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"laws": manifest["lawCount"], "figureArchives": archive_count,
                      "figureFiles": figures_count, "deployedFiles": len(files),
                      "jsonBytes": manifest["jsonBytes"], "archiveBytes": archive_bytes,
                      "totalBytes": manifest["totalBytes"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
