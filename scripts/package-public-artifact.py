#!/usr/bin/env python3
"""Explicit source/runtime distribution; never package the workspace wholesale."""
import sys
sys.dont_write_bytecode = True
import argparse
import hashlib
import json
import subprocess
import zipfile
import io
from pathlib import Path
from lib.public_artifact import scan

ROOT = Path(__file__).resolve().parents[1]
ROOT_FILES = {'.dockerignore', '.gitignore', '.nvmrc', '.env.example', 'Dockerfile', 'compose.yaml', 'LICENSE', 'README.md', 'README.zh-TW.md', 'package.json', 'package-lock.json', 'eslint.config.js', 'playwright.config.ts', 'tsconfig.json', 'vite.config.ts', 'vitest.config.ts', 'wrangler.jsonc'}
SOURCE_TREES = {'src', 'tests', 'schemas', 'scripts', 'docs', '.github'}

def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('kind', choices=['source', 'runtime'])
    parser.add_argument('--identity', required=True, help='source_fingerprint.py summary JSON')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    identity = json.loads(Path(args.identity).read_text())
    if not isinstance(identity.get('fingerprint'), str) or len(identity['fingerprint']) != 64:
        raise SystemExit('invalid source identity')
    actual = json.loads(subprocess.check_output(['python3', str(ROOT / 'scripts/source-fingerprint.py'), '--repo', str(ROOT)]))
    if identity['fingerprint'] != actual['fingerprint']:
        raise SystemExit('source identity is stale')
    output = Path(args.output).resolve()
    if not output.is_relative_to(ROOT / 'dist/releases') and not output.is_relative_to(ROOT / 'temp'):
        raise SystemExit('output must be under dist/releases or temp')
    names = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=ROOT).decode().split('\0')
    if args.kind == 'source':
        paths = sorted({n for n in names if n and (n in ROOT_FILES or n.split('/')[0] in SOURCE_TREES) and (ROOT / n).exists()})
    else:
        paths = []
        for name in ['dist/node/server.mjs', 'dist/workers/worker.mjs', 'package.json', 'package-lock.json', 'LICENSE']:
            if not (ROOT / name).is_file():
                raise SystemExit('build runtime before packaging')
            paths.append(name)
        for folder in ['dist/node/public', 'dist/workers/assets']:
            paths += [str(p.relative_to(ROOT)) for p in (ROOT / folder).rglob('*') if p.is_file()]
        paths.sort()
    contents = {}
    for name in paths:
        path = ROOT / name
        if path.is_symlink() or not path.resolve().is_relative_to(ROOT):
            raise SystemExit('symlinks are not public inputs')
        contents[name] = path.read_bytes()
    manifest = {'schemaVersion': 1, 'kind': args.kind, 'sourceFingerprint': identity['fingerprint'], 'head': identity.get('head'),
                'lockfileSha256': sha((ROOT / 'package-lock.json').read_bytes()), 'buildCommand': 'npm run build',
                'nodeVersion': subprocess.check_output(['node', '--version'], text=True).strip(),
                'npmVersion': subprocess.check_output(['npm', '--version'], text=True).strip(),
                'files': {name: sha(data) for name, data in contents.items()}}
    contents['manifest.json'] = (json.dumps(manifest, indent=2) + '\n').encode()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(contents.items()):
            info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    payload = buffer.getvalue()
    result = scan(payload, output.name)
    if not result['ok']:
        print(json.dumps(result));return 1
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(payload)
    manifest.update(archiveSha256=sha(payload), scanner=result)
    output.with_suffix('.manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'kind': args.kind, 'files': len(paths), 'archiveSha256': manifest['archiveSha256'], 'scanner': 'PASS'}))
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
