#!/usr/bin/env python3
"""Regenerate the offline asset list after the final publication files are ready."""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--web', type=Path, default=ROOT / 'dist' if (ROOT / 'dist').is_dir() else ROOT)
parser.add_argument('--version', default='2026.11.25.4')
args = parser.parse_args()
WEB = args.web.resolve()
files, seen = [], set()

def add(path):
    if path in seen:
        raise ValueError('Duplicate asset: ' + path)
    source = (WEB / path).resolve()
    if not source.is_relative_to(WEB):
        raise ValueError('Asset is outside the publication directory')
    raw = source.read_bytes()
    files.append({'path': path, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
    seen.add(path)

for path in sorted(WEB.iterdir()):
    if path.is_file() and path.name not in {'offline-assets.json', 'sw.js', 'qa-preview.html', 'README.md', '.nojekyll'} and path.suffix in {'.html', '.css', '.js', '.svg', '.png', '.ico', '.webmanifest', '.json', '.gz'}:
        add(path.name)
for folder in ['law-corpus', 'treaty-corpus']:
    metadata = json.loads((WEB / folder / 'manifest.json').read_text())
    add(folder + '/manifest.json')
    for record in metadata['files']:
        path = folder + '/' + record['path']
        if (WEB / path).stat().st_size != record['bytes']:
            raise RuntimeError('Corpus manifest size mismatch: ' + path)
        add(path)
art_manifest = json.loads((WEB / 'art/manifest.json').read_text())
add('art/manifest.json')
for record in art_manifest['files']:
    add(record['path'])
    if files[-1]['bytes'] != record['bytes'] or files[-1]['sha256'] != record['sha256']:
        raise RuntimeError('Artwork manifest mismatch: ' + record['path'])
law_manifest = json.loads((WEB / 'law-corpus/manifest.json').read_text())
manifest = {'version': args.version, 'asOf': law_manifest['asOf'], 'files': files,
            'totalBytes': sum(item['bytes'] for item in files)}
(WEB / 'offline-assets.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'files': len(files), 'totalBytes': manifest['totalBytes']}))
