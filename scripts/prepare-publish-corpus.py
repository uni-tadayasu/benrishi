#!/usr/bin/env python3
"""Copy a prepared law corpus and split large stored ZIPs for static hosting."""
import argparse
import copy
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--corpus', type=Path, required=True)
parser.add_argument('--out', type=Path, required=True)
parser.add_argument('--part-bytes', type=int, default=2 * 1024 * 1024)
args = parser.parse_args()
if args.corpus.resolve() == args.out.resolve():
    raise ValueError('Use a separate output directory; the acquired source corpus is retained.')
if args.part_bytes < 1024:
    raise ValueError('part-bytes must be at least 1024')
args.out.mkdir(parents=True, exist_ok=True)
manifest = json.loads((args.corpus / 'manifest.json').read_text())
if manifest.get('errors') or manifest.get('attachmentErrors') or not manifest.get('offlineFigureComplete'):
    raise ValueError('Finish law and figure acquisition before preparing publication files.')
records, mapping = [], {}
for record in manifest['files']:
    path = PurePosixPath(record['path'])
    if path.is_absolute() or '..' in path.parts:
        raise ValueError('Unsafe corpus path')
    source = args.corpus / path
    data = source.read_bytes()
    if len(data) != record['bytes']:
        raise ValueError('Source size mismatch: ' + str(path))
    if source.suffix == '.zip' and len(data) > args.part_bytes:
        parts = []
        for i, start in enumerate(range(0, len(data), args.part_bytes), 1):
            part = data[start:start + args.part_bytes]
            name = str(path) + '.part%03d.bin' % i
            target = args.out / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(part)
            parts.append({'path': name, 'bytes': len(part)})
            records.append({'path': name, 'bytes': len(part), 'mimeType': 'application/octet-stream',
                            'lawId': record.get('lawId'), 'sha256': hashlib.sha256(part).hexdigest()})
        mapping[str(path)] = parts
    else:
        target = args.out / path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        records.append(copy.deepcopy(record))
manifest['files'] = records
manifest['archiveParts'] = mapping
manifest['archivePartCount'] = sum(map(len, mapping.values()))
manifest['archivePartMaxBytes'] = args.part_bytes
manifest['deployedFileCount'] = len(records)
manifest['totalBytes'] = sum(r['bytes'] for r in records)
(args.out / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'files': len(records), 'parts': manifest['archivePartCount'], 'bytes': manifest['totalBytes']}))
