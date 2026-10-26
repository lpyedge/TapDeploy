#!/usr/bin/env python3
"""Hash actual Git working-tree candidate inputs, not commit alone.

Includes tracked and non-ignored untracked files. Never opens ignored/private
untracked files and never outputs file contents, credential text or file list.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys


def git(repo, *args):
    result = subprocess.run(['git', '-C', str(repo), *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode:
        raise RuntimeError('git command failed: ' + ' '.join(args) + ' (no output leaked)')
    return result.stdout


def main():
    arg = argparse.ArgumentParser()
    arg.add_argument('--repo', default='.')
    arg.add_argument('--output', default=None, help='summary JSON path (not a source file)')
    a = arg.parse_args()
    repo = Path(a.repo).resolve()
    try:
        toplevel = Path(git(repo,'rev-parse','--show-toplevel').decode('utf-8').strip()).resolve()
        head = git(toplevel, 'rev-parse','HEAD').decode('ascii').strip()
        status = git(toplevel, 'status', '--porcelain=v1', '--untracked-files=normal')
        names = git(toplevel, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').split(b'\0')
        paths=sorted(set(x for x in names if x))
        h=hashlib.sha256()
        h.update(b'CWI-worktree-v1\0'+head.encode('ascii')+b'\0')
        count=0;deleted=0
        for name in paths:
            # Git filenames are filesystem bytes; no text decoding or path printing required.
            path=os.path.join(os.fsencode(toplevel), name)
            h.update(name+b'\0')
            try:
                info=os.lstat(path)
            except FileNotFoundError:
                h.update(b'DELETED\0');deleted+=1;continue
            if stat.S_ISLNK(info.st_mode):
                digest=hashlib.sha256(os.fsencode(os.readlink(path))).digest()
                kind=b'LINK'
            elif stat.S_ISREG(info.st_mode):
                sha=hashlib.sha256()
                with open(path,'rb') as f:
                    for chunk in iter(lambda:f.read(1024*1024),b''):
                        sha.update(chunk)
                digest=sha.digest();kind=b'FILE'
            else:
                digest=hashlib.sha256(b'SPECIAL').digest();kind=b'SPECIAL'
            mode=b'EXEC' if info.st_mode & stat.S_IXUSR else b'NOEXEC'
            h.update(kind+b'\0'+mode+b'\0'+digest+b'\0')
            count+=1
        summary = {
            'format':'CWI-worktree-v1', 'head':head, 'fingerprint':h.hexdigest(),
            'filesCount':count, 'deletedCount':deleted,
            'gitStatusLines':len(status.splitlines()),
            'gitDirty':bool(status.strip()),
            'includes':'tracked + non-ignored untracked workspace bytes; excludes ignored untracked private/control-plane',
        }
        payload=json.dumps(summary,indent=2,ensure_ascii=False)+'\n'
        print(payload,end='')
        if a.output: Path(a.output).write_text(payload,encoding='utf8')
        return 0
    except Exception as exc:
        # Avoid echoing potentially sensitive path/error content.
        print('source fingerprint failed (confirm real Git working tree): '+type(exc).__name__,file=sys.stderr)
        return 2

if __name__=='__main__':
    sys.exit(main())
