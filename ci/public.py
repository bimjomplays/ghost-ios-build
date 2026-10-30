"""Public-build metadata helpers. No local paths or account identities."""
import hashlib
import json
from pathlib import Path


def build_number(run_number):
    if not 1 <= run_number <= 8999:
        raise ValueError('run number must be 1..8999; allocate a new build sequence before exhaustion')
    return str(1000 + run_number)


def processed_build(data, version, number):
    versions = {v['id']: v.get('attributes', {}).get('version') for v in data.get('included', []) if v.get('type') == 'preReleaseVersions'}
    for b in data.get('data', []):
        a = b.get('attributes', {})
        rel = b.get('relationships', {}).get('preReleaseVersion', {}).get('data') or {}
        if a.get('version') != number or versions.get(rel.get('id')) != version:
            continue
        if a.get('processingState') in ('FAILED', 'INVALID') or a.get('expired'):
            raise ValueError('App Store Connect rejected/expired the uploaded build')
        if a.get('processingState') == 'VALID' and a.get('expired') is False:
            return b['id']
    return None


def digest(root):
    h = hashlib.sha256()
    for f in sorted(root.rglob('*')):
        rel = f.relative_to(root)
        if '.git' in rel.parts:
            continue
        if f.is_symlink():
            raise ValueError('symlinks are not permitted in build exports')
        if f.is_file() and rel.as_posix() != 'ci/request.json':
            h.update(rel.as_posix().encode() + b'\0' + f.read_bytes())
    return h.hexdigest()


def validate(root):
    r = json.loads((root / 'ci/request.json').read_text())
    if r.get('schema') != 1 or r.get('mode') not in ('quick', 'full', 'release') or r.get('linux_checks', 0) <= 0 or r.get('digest') != digest(root):
        raise ValueError('invalid/stale public export request')
    if r['mode'] != 'quick' and r.get('full_gate_results') != 44:
        raise ValueError('missing complete full gate evidence')
    return r


if __name__ == '__main__':
    validate(Path(__file__).resolve().parents[1])
    print('Export digest and nonzero Linux check evidence verified')
