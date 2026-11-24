#!/usr/bin/env python3
"""Make every image/form referenced by fetch-laws.py available offline.

Run after fetch-laws.py, before gzipping the final law JSON files:
python3 scripts/fetch-law-figures.py --corpus law-corpus --raw law-raw

Downloads the official e-Gov attachment ZIP for each law revision. Only safe,
matching archive members are written, preserving official source URLs.
"""
from __future__ import annotations
import argparse
import concurrent.futures
import hashlib
import io
import json
import mimetypes
import pathlib
import stat
import time
import urllib.request
import zipfile


def normalize_src(value: str) -> str:
    value = value.replace("\\", "/")
    while value.startswith("./"):
        value = value[2:]
    path = pathlib.PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or not value:
        raise ValueError("Unsafe attachment path")
    return path.as_posix()


def read_zip(url: str, local: pathlib.Path) -> bytes:
    if local.exists():
        return local.read_bytes()
    error = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=55) as response:
                data = response.read(150 * 1024 * 1024 + 1)
                if len(data) > 150 * 1024 * 1024:
                    raise RuntimeError("Official attachment ZIP exceeds 150 MiB; inspect before continuing")
                zipfile.ZipFile(io.BytesIO(data)).close()
                local.parent.mkdir(parents=True, exist_ok=True)
                local.write_bytes(data)
                return data
        except Exception as exc:
            error = exc
            if attempt < 2:
                time.sleep(attempt + 1)
    raise RuntimeError(str(error))


def process_law(item: dict, corpus: pathlib.Path, raw_dir: pathlib.Path) -> dict:
    path = corpus / item["file"]
    law = json.loads(path.read_text(encoding="utf-8"))
    required = law.get("figureLinks", [])
    if not required:
        return {"id": item["id"], "files": [], "zipBytes": 0}
    revision = law["revisionId"]
    official_url = "https://laws.e-gov.go.jp/api/2/attachment/" + revision
    raw = read_zip(official_url, raw_dir / (revision + "-attachments.zip"))
    archive = zipfile.ZipFile(io.BytesIO(raw))
    members = {normalize_src(x.filename): x for x in archive.infolist() if not x.is_dir()}
    if sum(x.file_size for x in members.values()) > 250 * 1024 * 1024:
        raise RuntimeError("Official attachment contents exceed 250 MiB; inspect before continuing")
    files = []
    src_map = {}
    for fig in required:
        src = normalize_src(fig["src"])
        candidates = [name for name in members if name == src or name.endswith("/" + src)]
        if len(candidates) != 1:
            raise RuntimeError(f"Attachment archive match is not unique for {src}: {candidates}")
        member = members[candidates[0]]
        if stat.S_ISLNK(member.external_attr >> 16):
            raise RuntimeError("Attachment archive contains a symbolic link")
        data = archive.read(member)
        relative = (pathlib.PurePosixPath("figures") / law["id"] / src).as_posix()
        destination = corpus / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
        mime = mimetypes.guess_type(relative)[0] or "application/octet-stream"
        entry = {"path": relative, "bytes": len(data), "mimeType": mime,
                 "lawId": law["id"], "sha256": hashlib.sha256(data).hexdigest()}
        files.append(entry)
        src_map[src] = entry

    def localize(fig):
        match = src_map[normalize_src(fig["src"])]
        if not fig.get("offline"):
            fig["officialSourceUrl"] = fig["url"]
        fig.update({"url": match["path"], "file": match["path"], "bytes": match["bytes"],
                    "mimeType": match["mimeType"], "offline": True,
                    "note": "図・画像様式を画像・PDFとして収録。画像内文字は本文テキストとは別です。"})

    for fig in law.get("figureLinks", []):
        localize(fig)
    for record in law["articles"] + law["appendices"]:
        for fig in record.get("figureLinks", []):
            localize(fig)
    law["coverage"]["offlineFigureFiles"] = len(files)
    law["coverage"]["offlineFigureBytes"] = sum(x["bytes"] for x in files)
    law["coverageNote"] = "e-Govの指定時点の法令XMLに含まれる本則・附則・別表等のテキストを収録。図・画像様式は同梱の画像・PDFで参照できます。条約・判例は別資料です。"
    path.write_text(json.dumps(law, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return {"id": law["id"], "files": files, "zipBytes": len(raw)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", default="law-corpus")
    parser.add_argument("--raw", default="law-raw")
    parser.add_argument("--workers", type=int, default=3)
    args = parser.parse_args()
    corpus = pathlib.Path(args.corpus)
    raw_dir = pathlib.Path(args.raw)
    manifest_path = corpus / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    targets = [x for x in manifest["laws"] if x.get("figureCount")]
    results = {}
    errors = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(args.workers, 3))) as pool:
        futures = {pool.submit(process_law, item, corpus, raw_dir): item for item in targets}
        for future in concurrent.futures.as_completed(futures):
            item = futures[future]
            try:
                result = future.result()
                results[item["id"]] = result
                print(json.dumps({"ok": True, "id": item["id"], "title": item["title"],
                                  "figures": len(result["files"]), "bytes": sum(x["bytes"] for x in result["files"]),
                                  "zipBytes": result["zipBytes"]}, ensure_ascii=False), flush=True)
            except Exception as error:
                errors.append({"id": item["id"], "title": item["title"], "error": str(error)})
                print(json.dumps({"ok": False, **errors[-1]}, ensure_ascii=False), flush=True)
    files = []
    for item in manifest["laws"]:
        path = corpus / item["file"]
        item["bytes"] = path.stat().st_size
        result = results.get(item["id"])
        if result:
            item["offlineFigureFiles"] = len(result["files"])
            item["offlineFigureBytes"] = sum(x["bytes"] for x in result["files"])
        files.append({"path": item["file"], "bytes": item["bytes"],
                      "mimeType": "application/json", "lawId": item["id"]})
        if result:
            files.extend(result["files"])
    manifest["files"] = files
    manifest["jsonBytes"] = sum(x["bytes"] for x in files if x["mimeType"] == "application/json")
    manifest["assetBytes"] = sum(x["bytes"] for x in files if x["mimeType"] != "application/json")
    manifest["offlineFigureFiles"] = sum(len(x["files"]) for x in results.values())
    manifest["offlineFigureComplete"] = not errors
    manifest["attachmentErrors"] = errors
    manifest["totalBytes"] = sum(x["bytes"] for x in files)
    manifest["attachmentNote"] = "図・画像様式は画像・PDFとして同梱。本文・附則・別表のテキストとは別に参照できます。"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"complete": not errors, "files": len(files), "jsonBytes": manifest["jsonBytes"],
                      "assetBytes": manifest["assetBytes"], "totalBytes": manifest["totalBytes"]}, ensure_ascii=False), flush=True)
    if errors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
