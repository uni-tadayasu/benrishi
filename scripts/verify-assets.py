#!/usr/bin/env python3
"""Read-only verification of the published assets and glossary source paragraphs."""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--web', type=Path, default=ROOT / 'dist' if (ROOT / 'dist').is_dir() else ROOT)
parser.add_argument('--skip-offline', action='store_true', help='Check the corpora while the final offline manifest is still being rebuilt.')
args = parser.parse_args()
WEB = args.web.resolve()

def safe_file(path):
    rel = PurePosixPath(path)
    if rel.is_absolute() or '..' in rel.parts:
        raise ValueError('Unsafe relative path: ' + path)
    p = (WEB / rel).resolve()
    if not p.is_relative_to(WEB):
        raise ValueError('File is outside publication tree')
    return p

def check_file(path, record):
    data = safe_file(path).read_bytes()
    assert len(data) == record['bytes'], ('byte count', path)
    if record.get('sha256'):
        assert hashlib.sha256(data).hexdigest() == record['sha256'], ('sha256', path)
    return data

laws = json.loads(safe_file('law-corpus/manifest.json').read_text())
treaties = json.loads(safe_file('treaty-corpus/manifest.json').read_text())
assert len(laws['laws']) == laws['lawCount'] == 42
assert len(treaties['treaties']) == treaties['treatyCount'] == 12
assert not laws.get('errors') and not laws.get('attachmentErrors')
loaded_laws, figures = {}, 0
for folder, manifest in [('law-corpus', laws), ('treaty-corpus', treaties)]:
    assert len({r['path'] for r in manifest['files']}) == len(manifest['files'])
    for record in manifest['files']:
        check_file(folder + '/' + record['path'], record)
for meta in laws['laws']:
    law = json.loads(safe_file('law-corpus/' + meta['file']).read_text())
    loaded_laws[law['id']] = law
    assert len(law['articles']) == meta['articleCount'], law['id']
    assert len({a['id'] for a in law['articles']}) == len(law['articles']), law['id']
    assert not law['coverage']['missingTextLeafCount'], law['id']
    archive = law.get('figureArchive')
    if not archive:
        continue
    parts = laws.get('archiveParts', {}).get(archive['file'])
    raw = b''.join(safe_file('law-corpus/' + p['path']).read_bytes() for p in parts) if parts else safe_file('law-corpus/' + archive['file']).read_bytes()
    assert len(raw) == archive['bytes'], archive['file']
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        assert z.testzip() is None, archive['file']
        assert len(z.infolist()) == archive['entryCount']
        for item in archive['entries']:
            member = z.getinfo(item['path'])
            data = z.read(item['path'])
            assert member.compress_type == zipfile.ZIP_STORED
            assert len(data) == item['size']
            assert hashlib.sha256(data).hexdigest() == item['sha256']
            if item.get('mimeType') == 'application/pdf':
                assert data.startswith(b'%PDF-')
            figures += 1
assert figures == laws['figureCount'] == 405
for meta in treaties['treaties']:
    treaty = json.loads(safe_file('treaty-corpus/' + meta['textFile']).read_text())
    assert len(treaty['articles']) == meta['sectionCount'], meta['id']
    assert treaty['sourceUrl'] == meta['sourceUrl'], meta['id']
    assert treaty['status'] == meta['status'], meta['id']
assert {t['id'] for t in treaties['treaties'] if t['status'] == 'historical'} == {'paris', 'madrid'}
glossary_path = safe_file('glossary-data.json')
glossary = json.loads(glossary_path.read_text())
assert gzip.decompress(safe_file('glossary-data.json.gz').read_bytes()) == glossary_path.read_bytes()
assert len(glossary['entries']) == glossary['stats']['termCount']
assert len({e['term'] for e in glossary['entries']}) == len(glossary['entries'])
definition_count = 0
for entry in glossary['entries']:
    for d in entry['definitions']:
        law = loaded_laws[d['lawId']]
        article = next(a for a in law['articles'] if a['id'] == d['articleId'])
        assert article['paragraphs'][d['paragraphIndex']]['text'] == d['text'], entry['term']
        assert article['section'] == d['section'], entry['term']
        assert law['sourceUrl'] == d['sourceUrl'], entry['term']
        assert d['matchedText'] in d['text'], entry['term']
        definition_count += 1
assert definition_count == glossary['stats']['definitionCount']
if not args.skip_offline:
    offline = json.loads(safe_file('offline-assets.json').read_text())
    assert len({r['path'] for r in offline['files']}) == len(offline['files'])
    assert sum(r['bytes'] for r in offline['files']) == offline['totalBytes']
    for record in offline['files']:
        check_file(record['path'], record)
    # Every local HTML script and each install-time SW dependency must exist.
    html = safe_file('index.html').read_text()
    for source in re.findall(r'<script[^>]+src=[\"\']([^\"\']+)', html):
        if not source.startswith(('http:', 'https:', '//')):
            assert safe_file(source.removeprefix('./')).is_file(), source
    sw = safe_file('sw.js').read_text()
    core = re.search(r'const CORE=\[([^\]]+)\]', sw)
    if core:
        for source in re.findall(r"'([^']+)'", core[1]):
            if source not in ('./', '/'):
                assert safe_file(source.removeprefix('./')).is_file(), source
print(json.dumps({'ok': True, 'laws': len(loaded_laws), 'articles': sum(len(l['articles']) for l in loaded_laws.values()),
                  'figurePdfs': figures, 'treaties': len(treaties['treaties']), 'glossaryTerms': len(glossary['entries']),
                  'glossaryDefinitions': definition_count, 'offlineManifestChecked': not args.skip_offline}, ensure_ascii=False))
