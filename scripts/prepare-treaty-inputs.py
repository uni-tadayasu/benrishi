#!/usr/bin/env python3
"""Prepare the pinned 2026-11-25 treaty inputs without relabelling new editions."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
INPUTS = Path(__file__).resolve().parent / 'inputs'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--web', type=Path, default=ROOT / 'dist' if (ROOT / 'dist').is_dir() else ROOT)
parser.add_argument('--raw', type=Path, default=Path('work/treaty-raw'))
parser.add_argument('--refresh', action='store_true', help='Fetch official PDFs instead of using checked-in copies; hashes must still match the pinned edition.')
args = parser.parse_args()
args.raw.mkdir(parents=True, exist_ok=True)
sources = json.loads((INPUTS / 'treaty-pdf-sources.json').read_text())
for item in sources['pdfs']:
    local = args.web / 'treaty-corpus' / item['file']
    if local.is_file() and not args.refresh:
        data = local.read_bytes()
    else:
        request = urllib.request.Request(item['sourceUrl'], headers={'User-Agent': 'BenrishiStudyCorpus/1.0'})
        with urllib.request.urlopen(request, timeout=60) as response:
            data = response.read()
    digest = hashlib.sha256(data).hexdigest()
    if not data.startswith(b'%PDF-') or len(data) != item['bytes'] or digest != item['sha256']:
        raise RuntimeError('PDF differs from the reviewed edition: ' + item['id'] + '. Review the new edition, language, rights notice and parsing before updating pinned metadata.')
    (args.raw / item['file']).write_bytes(data)
    print('verified PDF:', item['id'])
bundle = json.loads(gzip.decompress((INPUTS / 'treaty-web-extracts.json.gz').read_bytes()))
for record in bundle['records']:
    if len(record['lines']) != record['total']:
        raise RuntimeError('Incomplete stored official text: ' + record['id'])
    (args.raw / (record['id'] + '-web-extract.json')).write_text(json.dumps(record, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
print('Restored', len(bundle['records']), 'saved official-page text extracts; no claim of fresh MOFA retrieval.')
