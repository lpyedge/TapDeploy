#!/usr/bin/env python3
"""Scan a public archive; nonzero on unsafe/unsupported content."""
import sys
sys.dont_write_bytecode = True
import json
from pathlib import Path
from lib.public_artifact import MAX_BYTES, scan

if len(sys.argv) != 2:
    raise SystemExit('usage: python3 scripts/scan-public-artifact.py artifact.zip')
path = Path(sys.argv[1])
with path.open('rb') as stream:
    result = scan(stream.read(MAX_BYTES + 1), path.name)
print(json.dumps(result, ensure_ascii=True))
raise SystemExit(0 if result['ok'] else 1)
