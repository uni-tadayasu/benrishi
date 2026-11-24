#!/usr/bin/env python3
"""Download a finite, verified e-Gov law catalog and preserve its full text.

python3 scripts/fetch-laws.py --catalog law-catalog.json --out law-corpus \
  --raw law-raw --as-of 2026-11-25 --workers 3

The catalog must contain verified e-Gov IDs. Requests use the official API v2
with an explicit asof date, include consolidated supplementary provisions, and
exclude attachment bytes. Figure/form references are kept as official links.
Raw XML is retained separately for reproducibility and never included in the
public JSON directory. No API credentials or non-official proxy are used.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import copy
import datetime as dt
import hashlib
import json
import pathlib
import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET


def compact(value: str | None) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def inline(node: ET.Element | None, speech: bool = False) -> str:
    if node is None or node.tag == "Rt":
        return ""
    if node.tag == "Ruby" and speech:
        reading = "".join("".join(x.itertext()) for x in node.findall("Rt"))
        if reading:
            return compact(reading)
    text = node.text or ""
    for child in node:
        text += inline(child, speech)
        text += child.tail or ""
    return compact(text)


def render(node: ET.Element | None, speech: bool = False) -> str:
    if node is None or node.tag == "Rt":
        return ""
    if node.tag == "Fig":
        return "〔図・画像様式：" + node.attrib.get("src", "公式原文を参照") + "〕"
    if node.tag in {"Sentence", "Ruby", "LawTitle", "LawNum", "ArticleCaption",
                    "ArticleTitle", "ParagraphNum", "ItemTitle", "SupplProvisionLabel",
                    "RelatedArticleNum"} or node.tag.endswith("Title"):
        return inline(node, speech)
    if len(node) == 0:
        return compact(node.text)
    parts = []
    if compact(node.text):
        parts.append(compact(node.text))
    for child in node:
        value = render(child, speech)
        if value:
            parts.append(value)
        if compact(child.tail):
            parts.append(compact(child.tail))
    sep = "\t" if node.tag in {"TableRow", "TableHeaderRow"} else "\n"
    return sep.join(parts)


def figure_links(node: ET.Element, revision: str, source_url: str) -> list[dict]:
    values = []
    seen = set()
    for fig in node.iter("Fig"):
        src = fig.attrib.get("src", "")
        if src in seen:
            continue
        seen.add(src)
        endpoint = "https://laws.e-gov.go.jp/api/2/attachment/" + urllib.parse.quote(revision, safe="")
        if src:
            endpoint += "?" + urllib.parse.urlencode({"src": src})
        values.append({"title": "図・画像様式（公式データ）", "src": src,
                       "url": endpoint if revision else source_url,
                       "sourceUrl": source_url,
                       "note": "画像に含まれる文字は本文テキストに含まれません。公式データを参照してください。"})
    return values


def without_articles(node: ET.Element) -> ET.Element:
    result = copy.deepcopy(node)
    for parent in list(result.iter()):
        for child in list(parent):
            if child.tag == "Article":
                parent.remove(child)
    return result


def get_xml(url: str, raw_path: pathlib.Path, refresh: bool) -> bytes:
    if raw_path.exists() and not refresh:
        return raw_path.read_bytes()
    last_error = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=55) as response:
                data = response.read()
                if response.status != 200:
                    raise RuntimeError(f"HTTP {response.status}")
                ET.fromstring(data)
                raw_path.parent.mkdir(parents=True, exist_ok=True)
                raw_path.write_bytes(data)
                return data
        except Exception as error:
            last_error = error
            if attempt < 2:
                time.sleep(1 + attempt)
    raise RuntimeError(f"Official e-Gov request failed: {last_error}")


def parse_law(entry: dict, raw: bytes, asof: str, api_url: str) -> dict:
    root = ET.fromstring(raw)
    if root.tag != "law_data_response":
        raise ValueError(f"Unexpected API response {root.tag}")
    law = root.find("law_full_text/Law")
    if law is None:
        raise ValueError("Missing law_full_text/Law")
    body = law.find("LawBody")
    if body is None:
        raise ValueError("Missing LawBody")
    law_info_node = root.find("law_info")
    revision_info_node = root.find("revision_info")
    law_info = {x.tag: compact(x.text) for x in (law_info_node if law_info_node is not None else [])}
    revision_info = {x.tag: compact(x.text) for x in (revision_info_node if revision_info_node is not None else [])}
    actual_id = law_info.get("law_id")
    if actual_id != entry["id"]:
        raise ValueError(f"Law ID mismatch: {actual_id} != {entry['id']}")
    title = inline(body.find("LawTitle"))
    if title != entry["title"]:
        raise ValueError(f"Law title mismatch: {title} != {entry['title']}")
    enforcement = revision_info.get("amendment_enforcement_date", "")
    if enforcement and enforcement > asof:
        raise ValueError(f"Future-enforced revision returned: {enforcement} > {asof}")
    revision = revision_info.get("law_revision_id", "")
    source_url = "https://laws.e-gov.go.jp/document?lawid=" + urllib.parse.quote(revision or entry["id"], safe="_")
    articles = []
    appendices = []
    seen_ids: set[str] = set()
    sup_number = 0

    def collect(container: ET.Element, section: str, prefix: str, headings: list[str] | None = None):
        headings = headings or []
        local_heads = headings + [inline(x) for x in container
                                  if x.tag in {"PartTitle", "ChapterTitle", "SectionTitle", "SubsectionTitle", "DivisionTitle"}]
        for node in container:
            if node.tag == "Article":
                num = node.attrib.get("Num", str(len(articles) + 1))
                base_id = prefix + "A" + num.replace("_", "-")
                ident = base_id
                duplicate = 2
                while ident in seen_ids:
                    ident = base_id + "-" + str(duplicate)
                    duplicate += 1
                seen_ids.add(ident)
                paragraphs = []
                for paragraph in node.findall("Paragraph"):
                    number = inline(paragraph.find("ParagraphNum")) or paragraph.attrib.get("Num", "")
                    text_node = copy.deepcopy(paragraph)
                    for child in list(text_node):
                        if child.tag == "ParagraphNum":
                            text_node.remove(child)
                    paragraphs.append({"number": number, "text": render(text_node)})
                record = {"id": ident, "number": num, "title": inline(node.find("ArticleTitle")),
                          "caption": inline(node.find("ArticleCaption")), "section": section,
                          "heading": " / ".join(local_heads), "paragraphs": paragraphs,
                          "text": render(node), "speechText": render(node, True),
                          "deleted": node.attrib.get("Delete") == "true" or (bool(paragraphs) and all(p["text"].strip() == "削除" for p in paragraphs)),
                          "figureLinks": figure_links(node, revision, source_url)}
                if record["speechText"] == record["text"]:
                    del record["speechText"]
                articles.append(record)
                # Quoted provisions may contain further Article elements.
                collect(node, section, prefix, local_heads)
            else:
                collect(node, section, prefix, local_heads)

    label_map = {"TOC": "目次", "Preamble": "前文", "EnactStatement": "制定文",
                 "MainProvision": "本則・条以外の規定と章節見出し",
                 "AppdxTable": "別表", "AppdxNote": "別記", "AppdxStyle": "様式",
                 "AppdxFormat": "書式", "Appdx": "付録", "AppdxFig": "別図"}
    for child in body:
        if child.tag == "LawTitle":
            continue
        if child.tag == "SupplProvision":
            sup_number += 1
            amendment = child.attrib.get("AmendLawNum", "")
            section = "附則" + ("（" + amendment + "）" if amendment else "（制定時）")
            prefix = f"S{sup_number}-"
        else:
            section = "本則" if child.tag == "MainProvision" else "関連資料"
            prefix = "" if child.tag == "MainProvision" else "X" + str(len(appendices) + 1) + "-"
        collect(child, section, prefix)
        remainder = without_articles(child)
        remaining_text = render(remainder)
        if remaining_text:
            first_title = next((inline(x) for x in child if x.tag.endswith("Title")), "")
            appendix_title = (section + "・条以外の規定") if child.tag == "SupplProvision" else (first_title or label_map.get(child.tag, child.tag))
            appendix = {"id": "P" + str(len(appendices) + 1), "title": appendix_title,
                        "section": section, "kind": child.tag, "text": remaining_text,
                        "speechText": render(remainder, True),
                        "extract": child.attrib.get("Extract") == "true",
                        "figureLinks": figure_links(remainder, revision, source_url)}
            if appendix["speechText"] == appendix["text"]:
                del appendix["speechText"]
            appendices.append(appendix)
    law_num = inline(law.find("LawNum")) or law_info.get("law_num", entry.get("lawNum", ""))
    combined = title + law_num + "".join(x["text"] for x in articles) + "".join(x["text"] for x in appendices)
    normalized = re.sub(r"\s+", "", combined)
    # Every textual leaf in LawBody, except ruby pronunciation, must survive.
    leaves = [compact(x.text) for x in body.iter() if len(x) == 0 and x.tag != "Rt" and compact(x.text)]
    missing = [x for x in leaves if re.sub(r"\s+", "", x) not in normalized]
    if missing:
        raise ValueError("Text preservation failed: " + repr(missing[:4]))
    expected_articles = sum(1 for _ in body.iter("Article"))
    if len(articles) != expected_articles:
        raise ValueError(f"Article count mismatch: {len(articles)} != {expected_articles}")
    ruby_pairs = []
    seen_ruby = set()
    for ruby in body.iter("Ruby"):
        base = inline(ruby)
        reading = compact("".join("".join(rt.itertext()) for rt in ruby.findall("Rt")))
        if base and reading and (base, reading) not in seen_ruby:
            seen_ruby.add((base, reading))
            ruby_pairs.append({"text": base, "reading": reading})
    return {"id": entry["id"], "title": title, "lawNum": law_num,
            "category": entry["category"], "sourceUrl": source_url,
            "apiUrl": api_url, "verifiedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
            "asOf": asof, "revisionId": revision, "revisionInfo": revision_info,
            "titleReading": revision_info.get("law_title_kana", ""),
            "articles": articles, "appendices": appendices, "readings": ruby_pairs,
            "figureLinks": figure_links(body, revision, source_url),
            "coverage": {"sourceArticleCount": expected_articles, "articleCount": len(articles),
                         "mainArticleCount": sum(x["section"] == "本則" for x in articles),
                         "supplementaryArticleCount": sum(x["section"].startswith("附則") for x in articles),
                         "sourceTextLeafCount": len(leaves), "missingTextLeafCount": 0,
                         "appendixCount": len(appendices), "figureCount": sum(1 for _ in body.iter("Fig")),
                         "rawSha256": hashlib.sha256(raw).hexdigest(), "rawBytes": len(raw)},
            "coverageNote": "e-Govの指定時点の法令XMLに含まれる本則・附則・別表等のテキストを収録。図・画像様式の画像内文字は公式データのリンクで確認。条約・判例は別資料。"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", default="law-catalog.json")
    parser.add_argument("--out", default="law-corpus")
    parser.add_argument("--raw", default="law-raw")
    parser.add_argument("--as-of", default=dt.date.today().isoformat())
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args()
    dt.date.fromisoformat(args.as_of)
    catalog = json.loads(pathlib.Path(args.catalog).read_text())
    entries = catalog["laws"]
    out = pathlib.Path(args.out)
    raw_dir = pathlib.Path(args.raw)
    out.mkdir(parents=True, exist_ok=True)
    raw_dir.mkdir(parents=True, exist_ok=True)
    manifests = {}
    errors = []

    def process(entry):
        query = urllib.parse.urlencode({"asof": args.as_of, "response_format": "xml",
                                     "law_full_text_format": "xml", "omit_amendment_suppl_provision": "false",
                                     "include_attached_file_content": "false"})
        url = "https://laws.e-gov.go.jp/api/2/law_data/" + entry["id"] + "?" + query
        raw = get_xml(url, raw_dir / (entry["id"] + "_" + args.as_of + ".xml"), args.refresh)
        data = parse_law(entry, raw, args.as_of, url)
        path = out / (entry["id"] + ".json")
        encoded = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
        path.write_text(encoded, encoding="utf-8")
        return {key: data[key] for key in ["id", "title", "lawNum", "category", "sourceUrl", "verifiedAt", "asOf", "revisionId", "titleReading"]} | data["coverage"] | {"file": path.name, "bytes": len(encoded.encode("utf-8")), "figureNote": bool(data["figureLinks"])}

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(args.workers, 3))) as executor:
        futures = {executor.submit(process, entry): entry for entry in entries}
        for future in concurrent.futures.as_completed(futures):
            entry = futures[future]
            try:
                item = future.result()
                manifests[entry["id"]] = item
                print(json.dumps({"ok": True, "id": item["id"], "title": item["title"],
                                  "articles": item["articleCount"], "appendices": item["appendixCount"],
                                  "figures": item["figureCount"], "bytes": item["bytes"]}, ensure_ascii=False), flush=True)
            except Exception as error:
                errors.append({"id": entry["id"], "title": entry["title"], "error": str(error)})
                print(json.dumps({"ok": False, **errors[-1]}, ensure_ascii=False), flush=True)
    ordered = [manifests[x["id"]] for x in entries if x["id"] in manifests]
    manifest = {"asOf": args.as_of, "verifiedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
                "source": "e-Gov 法令API Version2", "sourceUrl": "https://laws.e-gov.go.jp/api/2/swagger-ui/index.html",
                "scopeNote": catalog.get("scope", "明示した法令リストに基づく収録"),
                "attachmentNote": "図・画像様式の画像内文字は全文テキストに含めず、公式データへのリンクを表示します。",
                "lawCount": len(ordered), "requestedLawCount": len(entries),
                "articleCount": sum(x["articleCount"] for x in ordered),
                "mainArticleCount": sum(x["mainArticleCount"] for x in ordered),
                "supplementaryArticleCount": sum(x["supplementaryArticleCount"] for x in ordered),
                "appendixCount": sum(x["appendixCount"] for x in ordered),
                "figureCount": sum(x["figureCount"] for x in ordered),
                "totalBytes": sum(x["bytes"] for x in ordered), "laws": ordered, "errors": errors}
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"complete": not errors, "lawCount": len(ordered), "articleCount": manifest["articleCount"],
                      "manifest": str(out / "manifest.json")}, ensure_ascii=False), flush=True)
    if errors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
