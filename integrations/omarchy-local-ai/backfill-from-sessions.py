"""Seed the coder usage ledger from recorded sessions.

llama-server keeps no history, so the calendar grid would start empty. Pi
sessions record the usage of every assistant message (input, cacheRead, output),
which is exactly the work the local server did. Sessions that were still being
written when the ledger started are skipped, so the live /slots accounting does
not double-count them.
"""
import glob
import json
import os
import time
from collections import defaultdict
from pathlib import Path

LEDGER = Path.home() / '.local/state/coder/usage.json'
SESSIONS = Path.home() / '.config/piharness/agent/sessions'
WARM = 900  # seconds: a session touched this recently may still be running

cutoff = time.time() - WARM
days = defaultdict(lambda: {'in': 0, 'out': 0, 'requests': 0})
skipped, files, messages = 0, 0, 0

for path in glob.glob(str(SESSIONS / '*' / '*.jsonl')):
    try:
        if os.path.getmtime(path) > cutoff:
            skipped += 1
            continue
        files += 1
        for line in open(path, encoding='utf-8', errors='replace'):
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue
            msg = event.get('message') or {}
            usage = msg.get('usage') if isinstance(msg, dict) else None
            if not usage:
                continue
            stamp = event.get('timestamp') or ''
            try:
                day = stamp[:10] if stamp else time.strftime('%Y-%m-%d', time.localtime(os.path.getmtime(path)))
                if not day.startswith('20'):
                    raise ValueError
            except ValueError:
                continue
            rec = days[day]
            # input excludes cached prompt tokens; both were processed, and the
            # model emitted output on top
            rec['in'] += int(usage.get('input') or 0) + int(usage.get('cacheRead') or 0)
            rec['out'] += int(usage.get('output') or 0)
            rec['requests'] += 1
            messages += 1
    except OSError:
        continue

data = {'days': dict(days), 'seen': {}, 'backfilled': int(time.time())}
existing = {}
try:
    existing = json.loads(LEDGER.read_text())
except (OSError, ValueError):
    existing = {}
# keep live samples already recorded (they are newer than the cutoff)
for day, rec in (existing.get('days') or {}).items():
    base = data['days'].get(day, {'in': 0, 'out': 0, 'requests': 0})
    if not isinstance(rec, dict):
        continue
    # only keep the live share from today onwards: earlier days came from files
    if day >= min(days) if days else True:
        base['in'] = max(base['in'], int(rec.get('in') or 0))
        base['out'] = max(base['out'], int(rec.get('out') or 0))
        base['requests'] = max(base['requests'], int(rec.get('requests') or 0))
    data['days'][day] = base
if existing.get('seen'):
    data['seen'] = existing['seen']

LEDGER.parent.mkdir(parents=True, exist_ok=True)
LEDGER.write_text(json.dumps(data))
total = sum(r['in'] + r['out'] for r in data['days'].values())
print(json.dumps({
    'files': files, 'skipped_recent': skipped, 'messages': messages,
    'days': {d: dict(r) for d, r in sorted(data['days'].items())},
    'total_tokens': total,
}, indent=1))
