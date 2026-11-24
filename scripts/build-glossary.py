#!/usr/bin/env python3
"""Build a finite, offline statutory glossary from the checked law corpus.

Every definition retains its complete, unchanged source paragraph.  This is an
index of explicit definitions / local shorthand, not generated legal advice or
a claim to define every Japanese word.  No web access or language model is used.
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import gzip
import hashlib
import json
from pathlib import Path
import re

QUOTED_DEFINITION = re.compile(r'「([^「」\n]{1,100})」とは')
QUOTED_ALIAS = re.compile(r'「([^「」\n]{1,100})」と(?:いう|いい|総称する|称する)')
SCOPE = re.compile(r'(?:以下|同条|同項|同号|次条|次項|次号|前条|前項|前号|第[一二三四五六七八九十百千万〇零0-9０-９]+[条項号])')
NUMBERED_ITEM = re.compile(r'(?m)^([一二三四五六七八九十百千万〇零]+(?:の[一二三四五六七八九十百千万〇零]+)*)\n')
NOUN_BEFORE_PAREN = re.compile(r'[一-龯々〆ヵヶァ-ヿーA-Za-zＡ-Ｚａ-ｚ0-9０-９]+$')
REFERENCE_TERM = re.compile(r'^(?:(?:第|同|前|次|本)?[一二三四五六七八九十百千万〇零0-9０-９条項号章節款目の]+|各号|各項|以下|前段|後段)$')
DEFINITION_CUE = re.compile(r'を(?:いう|いい|指す|意味する)(?:[。、]|$)')
GENERIC_FRAGMENT = {'法律', '条例', '命令', '行為', '方法', '事項', '期間', '期限', '場合', '目的', '規定', '関係', '部分', '変更', '国民', '翌年'}
# Complete phrases verified in the source. These prevent a known qualified
# phrase from being indexed under just its final generic noun.
QUALIFIED_TERMS = ('世界貿易機関の加盟国の国民', '国際登録の所有権の変更', '商品及び役務の区分', '引渡し期限', '不正の目的')
PRIORITY = {'quoted-definition': 0, 'enumerated-definition': 1, 'parenthetical-definition': 2, 'scope-rule': 3, 'alias': 4}


def parenthesis_pairs(text):
    stack, pairs = [], {}
    for i, char in enumerate(text):
        if char == '（':
            stack.append(i)
        elif char == '）' and stack:
            pairs[stack.pop()] = i
    return pairs


def without_nested(text):
    depth, out = 0, []
    for char in text:
        if char == '（':
            depth += 1
        elif char == '）':
            depth = max(depth - 1, 0)
        elif not depth:
            out.append(char)
    return ''.join(out)


def candidates(text):
    """Return only terms explicitly tied to a source definition or shorthand."""
    found = {}

    def add(term, kind, anchor):
        if not term or len(term) > 100 or '\n' in term:
            return
        old = found.get(term)
        if old is None or PRIORITY[kind] < PRIORITY[old[0]]:
            found[term] = (kind, anchor)

    for match in QUOTED_DEFINITION.finditer(text):
        add(match[1], 'quoted-definition', match.group(0))

    pairs = parenthesis_pairs(text)
    for match in QUOTED_ALIAS.finditer(text):
        containing = [(start, end) for start, end in pairs.items() if start < match.start() < end]
        if not containing:
            continue
        start, end = max(containing)
        before = text[start + 1:match.start()]
        # A quoted replacement in an amendment is not automatically a definition.
        # Require a legal scope marker in its immediately enclosing parenthesis.
        if SCOPE.search(before):
            add(match[1], 'alias', text[start:end + 1])

    # E.g. Copyright Act 2(1): 一 / 著作物 / [definition], with subordinate
    # イ・ロ items kept as part of the original paragraph, never cut off.
    if '用語の意義は' in text and '次の各号' in text:
        items = list(NUMBERED_ITEM.finditer(text))
        for i, item in enumerate(items):
            end = items[i + 1].start() if i + 1 < len(items) else len(text)
            body = text[item.end():end]
            lines = body.split('\n', 1)
            if len(lines) == 2 and 1 <= len(lines[0]) <= 60 and DEFINITION_CUE.search(without_nested(lines[1])):
                add(lines[0], 'enumerated-definition', text[item.start():end].rstrip('\n'))

    # Conservative unquoted inline definitions: a contiguous noun immediately
    # before a parenthesis whose own (not nested) content says をいう / をいい.
    # This intentionally misses some terms rather than inventing segmentation.
    for start, end in pairs.items():
        content = text[start + 1:end]
        if not DEFINITION_CUE.search(without_nested(content)):
            continue
        qualified = next((term for term in QUALIFIED_TERMS if text[:start].endswith(term)), None)
        if qualified:
            add(qualified, 'parenthetical-definition', text[start - len(qualified):end + 1])
            continue
        match = NOUN_BEFORE_PAREN.search(text[:start])
        if not match:
            continue
        term = match.group(0)
        if len(term) < 2 or len(term) > 60 or REFERENCE_TERM.fullmatch(term):
            continue
        # Never label the tail of a qualified phrase as its general meaning:
        # e.g. 不正の目的 -> 目的, 引渡し期限 -> 期限, ...を改正する法律 -> 法律.
        if term in GENERIC_FRAGMENT or term.startswith('当該'):
            continue
        preceding = text[match.start() - 1] if match.start() else ''
        if preceding == 'の' or (preceding and '\u3040' <= preceding <= '\u309f' and preceding not in 'をがはにとでへや'):
            if not text[:match.start()].endswith(('及び', '又は', '若しくは', '並びに')):
                continue
        add(term, 'parenthetical-definition', text[match.start():end + 1])

    # Explicit statutory inclusion rules are labelled separately from definitions.
    for match in re.finditer(r'(?:この法律にいう|この法律において|この法律で)「([^「」\n]{1,100})」(?:には|に含まれる)', text):
        add(match[1], 'scope-rule', match.group(0))
    return found


def scope_note(section, kind):
    if kind == 'alias':
        note = 'この条文中の略称。一般的な語義ではなく、引用に示された適用範囲に限ります。'
    elif kind == 'parenthetical-definition':
        note = 'この条文の括弧書きによる定義。引用に示された対象・適用範囲に限ります。'
    elif kind == 'scope-rule':
        note = 'この法令で用語に含める範囲を定めた規定。語義全体の定義とは区別してください。'
    else:
        note = 'この法令における定義。引用中の条・項・号等の適用範囲の限定を含みます。'
    if section != '本則':
        note += ' 附則の規定です。施行日・経過措置等の文脈を原文で確認してください。'
    return note


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--corpus', type=Path, default=Path(__file__).resolve().parent.parent / 'law-corpus')
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parent.parent / 'glossary-data.json')
    args = parser.parse_args()
    manifest = json.loads((args.corpus / 'manifest.json').read_text())
    grouped, seen, source_paragraphs = collections.defaultdict(list), set(), {}
    term_readings = collections.defaultdict(set)
    by_law, by_kind, excluded = [], collections.Counter(), []
    total_paragraphs = 0
    for meta in manifest['laws']:
        law = json.loads((args.corpus / meta['file']).read_text())
        for reading in law.get('readings', []):
            if reading.get('text') and reading.get('reading'):
                term_readings[reading['text']].add(reading['reading'])
        count = 0
        for article in law['articles']:
            for pi, paragraph in enumerate(article['paragraphs']):
                total_paragraphs += 1
                text = paragraph['text']
                paragraph_key = (law['id'], article['id'], pi)
                source_paragraphs[paragraph_key] = text
                for term, (kind, anchor) in candidates(text).items():
                    # Avoid fragmentary noun extraction from a longer quoted term.
                    if kind == 'parenthetical-definition':
                        at = text.find(anchor)
                        if at > 0 and text[at - 1] == '「':
                            excluded.append({'term': term, 'reason': 'inside-unclosed-quotation', 'lawId': law['id'], 'articleId': article['id']})
                            continue
                    key = (term, *paragraph_key)
                    if key in seen:
                        continue
                    seen.add(key)
                    definition = {
                        'text': text,
                        'lawId': law['id'],
                        'lawTitle': law['title'],
                        'articleId': article['id'],
                        'articleTitle': article['title'],
                        'articleCaption': article.get('caption', ''),
                        'paragraphNumber': paragraph['number'],
                        'paragraphIndex': pi,
                        'section': article['section'],
                        'sourceUrl': law['sourceUrl'],
                        'scopeNote': scope_note(article['section'], kind),
                        'definitionType': kind,
                        'matchedText': anchor,
                    }
                    assert text == source_paragraphs[paragraph_key]
                    assert anchor in text
                    grouped[term].append(definition)
                    by_kind[kind] += 1
                    count += 1
        by_law.append({'id': law['id'], 'title': law['title'], 'definitionCount': count})

    entries = []
    for term, definitions in sorted(grouped.items()):
        definitions.sort(key=lambda d: (d['section'] != '本則', PRIORITY[d['definitionType']], d['lawTitle'], d['articleId'], d['paragraphIndex']))
        readings = sorted(term_readings.get(term, set()))
        entries.append({'term': term, 'reading': readings[0] if len(readings) == 1 else '', 'kind': 'statutory', 'definitions': definitions})

    all_defs = [d for entry in entries for d in entry['definitions']]
    output = {
        'version': 1,
        'asOf': manifest['asOf'],
        'generatedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
        'source': 'e-Gov法令APIから取得した収録42法令の条文本文',
        'scopeNote': '収録42法令の本則・附則から、明示的な定義・用語の範囲・略称を抽出したオフライン辞書です。日本語や法律用語を全て網羅するものではありません。同じ語でも法令・条文・経過措置により意味が異なります。未知の語の意味は補完していません。',
        'textNote': '各定義のtextは出典の項全体をそのまま収録しています。matchedTextは該当箇所を見つけるための原文抜粋で、単独で完全な定義を示すとは限りません。',
        'readingNote': 'readingは法令XMLのルビが用語全体と完全一致し、一意に確認できた場合のみ収録しています。空欄は未確認です。',
        'stats': {
            'lawCount': len(by_law),
            'scannedParagraphCount': total_paragraphs,
            'termCount': len(entries),
            'definitionCount': len(all_defs),
            'mainProvisionDefinitionCount': sum(d['section'] == '本則' for d in all_defs),
            'supplementaryProvisionDefinitionCount': sum(d['section'] != '本則' for d in all_defs),
            'verifiedReadingCount': sum(bool(e['reading']) for e in entries),
            'definitionTypes': dict(by_kind),
            'maxParagraphCharacters': max((len(d['text']) for d in all_defs), default=0),
            'truncatedParagraphCount': 0,
        },
        'laws': by_law,
        'entries': entries,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, separators=(',', ':')) + '\n')
    raw = args.output.read_bytes()
    compressed = gzip.compress(raw, compresslevel=9, mtime=0)
    args.output.with_suffix('.json.gz').write_bytes(compressed)
    validation = {
        'stats': output['stats'], 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
        'allDefinitionsMatchOriginalParagraph': True, 'allMatchedTextInParagraph': True,
        'uniqueTerms': len({e['term'] for e in entries}) == len(entries),
        'emptyDefinitions': sum(not d['text'] for d in all_defs),
        'gzipBytes': len(compressed), 'gzipSha256': hashlib.sha256(compressed).hexdigest(),
        'excludedCandidates': excluded,
    }
    args.output.with_name('glossary-validation.json').write_text(json.dumps(validation, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(validation, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
