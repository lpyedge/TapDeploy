"""Bounded public ZIP/tar scanner. Diagnostics contain paths/types, never values."""
import io
import re
import stat
import tarfile
import zipfile
from pathlib import PurePosixPath

MAX_BYTES = 256 * 1024 * 1024
MAX_FILE = 64 * 1024 * 1024
MAX_ENTRIES = 20000
FORBIDDEN = {'.git', '.wrangler', 'plan', 'temp', 'node_modules', '.npmrc', '.netrc', 'credentials', 'cookies.txt', 'storageState.json', 'storage-state.json', 'trace.zip', 'id_rsa', 'id_ed25519'}
PATTERNS = [
    ('private-key', re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')),
    ('github-token', re.compile(rb'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b')),
    ('synthetic-secret', re.compile(b'CWI_SYNTHETIC_' + b'SECRET_[A-Za-z0-9]+')),
]

class Refusal(Exception):
    pass


def safe_path(name):
    parts = PurePosixPath(name).parts
    return bool(parts) and not name.startswith('/') and '\\' not in name and not any(p in ('..', '.') for p in parts) and not any(ord(c) < 32 for c in name) and ':' not in name


def scan(data, name='artifact.zip'):
    findings = []
    totals = {'bytes': 0, 'entries': 0}

    def refuse(path, kind):
        findings.append({'path': path, 'type': kind})

    def visit(payload, path, depth):
        totals['bytes'] += len(payload)
        if depth > 4 or totals['bytes'] > MAX_BYTES:
            raise Refusal('expansion-limit')
        # Magic bytes also detect ZIP archives disguised with another extension.
        if payload.startswith(b'PK\x03\x04') or payload.startswith(b'PK\x05\x06') or path.lower().endswith('.zip'):
            with zipfile.ZipFile(io.BytesIO(payload)) as archive:
                names = set()
                for member in archive.infolist():
                    if member.filename in names:
                        refuse(path, 'duplicate-entry')
                    names.add(member.filename)
                    if member.is_dir():
                        continue
                    if stat.S_ISLNK(member.external_attr >> 16) or member.flag_bits & 1:
                        refuse(path + '!' + member.filename, 'link-or-encrypted-entry')
                        continue
                    if member.file_size > MAX_FILE or member.file_size > MAX_BYTES - totals['bytes']:
                        raise Refusal('entry-size-limit')
                    with archive.open(member) as stream:
                        content = stream.read(MAX_FILE + 1)
                    entry(content, member.filename, path, depth)
        elif path.lower().endswith(('.tar', '.tar.gz', '.tgz')) or payload.startswith(b'\x1f\x8b') or payload[257:262] == b'ustar':
            with tarfile.open(fileobj=io.BytesIO(payload), mode='r|*') as archive:
                for member in archive:
                    if member.isdir():
                        continue
                    if not member.isfile():
                        refuse(path + '!' + member.name, 'nonregular-entry')
                        continue
                    if member.size > MAX_FILE or member.size > MAX_BYTES - totals['bytes']:
                        raise Refusal('entry-size-limit')
                    stream = archive.extractfile(member)
                    if stream is None:
                        raise Refusal('unreadable-entry')
                    with stream:
                        entry(stream.read(MAX_FILE + 1), member.name, path, depth)
        elif path.lower().endswith(('.7z', '.rar', '.gz', '.bz2', '.xz')):
            refuse(path, 'unsupported-archive')
        else:
            for kind, pattern in PATTERNS:
                if pattern.search(payload):
                    refuse(path, kind)

    def entry(content, name, parent, depth):
        totals['entries'] += 1
        if totals['entries'] > MAX_ENTRIES or len(content) > MAX_FILE:
            raise Refusal('entry-limit')
        path = parent + '!' + name
        if not safe_path(name):
            refuse(path, 'unsafe-path')
        parts = PurePosixPath(name).parts
        if any(p in FORBIDDEN or (p.startswith('.env') and p != '.env.example') or p.startswith('.dev.vars') or p.lower().endswith(('.har', '.pem', '.key', '.local')) for p in parts):
            refuse(path, 'private-path')
        visit(content, path, depth + 1)

    try:
        if len(data) > MAX_BYTES:
            raise Refusal('archive-size-limit')
        visit(data, name, 0)
    except (Refusal, zipfile.BadZipFile, tarfile.TarError, OSError, RuntimeError, ValueError, EOFError):
        refuse(name, 'invalid-or-unbounded-archive')
    return {'ok': not findings, 'entries': totals['entries'], 'expandedBytes': totals['bytes'], 'findings': findings}
