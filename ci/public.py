"""Public-build metadata helpers. No local paths or account identities."""
import hashlib
import json
from pathlib import Path
import math
import os
import re
import plistlib

# XcodeGen's exact semantic Info.plist for the pinned project.yml (including
# its standard app defaults). Formatting/order may differ across hosts; values
# may not. Do not exempt arbitrary generated plists or change the app pin.
GLASS_GENERATED_INFO_DIGEST = '4fbee009b7bf091076a891913cd503b9743dddcede7745c7bea876e271976c31'

# One owner-authorized release, not a general release override. App bytes are
# the scoped Glass candidate; tooling/CI may change without changing that app.
GLASS_POLICY = 'owner-accepted-glass-1.19.9-timing-2026-10-31'
GLASS_APP_DIGEST = '6d1ed02e550fd9e561cbfc306d693adb0c304e8f5b7b5e9720ad05bba31facc8'
TIMING_CHECK = 'no scripted-scroll frame gap > 50ms'
BASE_FILES = 'build-userscripts.py presence.js snap-clean.js gifs-find.js userscripts-adapter.js background.js glass.css mobile.css glass.js gifs-show.js gif-picker.js gif-anim.js'.split()
GHOST_FILES = 'retention.js bridge.js network.js games.js snapfx.js whatsnew.js ui.js ui.css tiktok-page.js tiktok-dm-page.js tiktok-video-page.js'.split()


def json_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


class UniquePlist(dict):
    def __setitem__(self, key, value):
        if key in self:
            raise ValueError('duplicate generated plist key')
        super().__setitem__(key, value)


def application_digest(root):
    h = hashlib.sha256()
    for f in sorted(root.rglob('*')):
        rel = f.relative_to(root).as_posix()
        included = (rel in BASE_FILES or rel == 'ios/project.yml' or rel in ['ghost/' + n for n in GHOST_FILES]
                    or rel.startswith(('ios/Sources/', 'ios/Resources/', 'ghost/games/')))
        generated = (f.parent == root / 'ios/Resources' and f.suffix == '.js'
                     and (f.name in ('hooks.js', 'ui.js') or f.name.startswith('ghost-')))
        if included and not generated:
            if f.is_symlink():
                raise ValueError('symlink in application scope')
            if f.is_file():
                if rel == 'ios/Sources/Info.plist':
                    try:
                        valid = json_digest(plistlib.loads(f.read_bytes(), dict_type=UniquePlist)) == GLASS_GENERATED_INFO_DIGEST
                    except (ValueError, TypeError, plistlib.InvalidFileException):
                        valid = False
                    if not valid:
                        raise ValueError('unexpected generated Info.plist for the exact Glass-only application')
                    continue
                h.update(rel.encode() + b'\0' + f.read_bytes())
    return h.hexdigest()


def glass_scope(root):
    if application_digest(root) != GLASS_APP_DIGEST:
        raise ValueError('timing exception is only for the exact Glass-only 1.19.9 application')


def deferred_shape(d, version):
    required = {'policy', 'status', 'application_digest', 'run_id', 'evidence_digest', 'failures'}
    if (not isinstance(d, dict) or set(d) != required or version != '1.19.9'
            or d['policy'] != GLASS_POLICY or d['status'] != 'OWNER_ACCEPTED_DEFERRED'
            or d['application_digest'] != GLASS_APP_DIGEST
            or not isinstance(d['run_id'], str) or not re.fullmatch('[0-9a-f]{32}', d['run_id'])
            or not isinstance(d['evidence_digest'], str) or not re.fullmatch('[0-9a-f]{64}', d['evidence_digest'])
            or not isinstance(d['failures'], list) or not 1 <= len(d['failures']) <= 2):
        raise ValueError('invalid owner-deferred timing disclosure')
    seen = set()
    for f in d['failures']:
        fields = {'case', 'scale', 'check', 'frames', 'over_budget', 'max_gap_ms', 'log_sha256', 'result_sha256'}
        if (not isinstance(f, dict) or set(f) != fields or f['case'] not in ('s1', 's08')
                or f['case'] in seen or f['scale'] != (1 if f['case'] == 's1' else 0.8)
                or f['check'] != TIMING_CHECK or type(f['frames']) is not int or f['frames'] <= 0
                or type(f['over_budget']) is not int or not 0 < f['over_budget'] <= f['frames']
                or type(f['max_gap_ms']) not in (int, float) or not math.isfinite(f['max_gap_ms']) or f['max_gap_ms'] <= 50
                or any(not isinstance(f[k], str) or not re.fullmatch('[0-9a-f]{64}', f[k]) for k in ('log_sha256', 'result_sha256'))):
            raise ValueError('invalid owner-deferred timing failure')
        seen.add(f['case'])


def timing_metadata(request, version):
    if 'deferred_timing' not in request:
        return {}
    if request.get('mode') not in ('full', 'release') or request.get('full_gate_results') != 44 or request.get('linux_checks', 0) <= 0:
        raise ValueError('deferred timing requires complete full evidence')
    deferred_shape(request['deferred_timing'], version)
    return {'deferred_timing': request['deferred_timing'], 'linux_request_sha256': json_digest(request)}


def build_receipt(request, version, number, builds):
    return {'version': version, 'build': number, 'builds': builds,
            'native_runtime_tests': 'not configured; private Linux JS tests/rig are the behavior gate',
            'public_revision': os.environ['GITHUB_SHA'], 'workflow_run_id': os.environ['GITHUB_RUN_ID'],
            'export_digest': request['digest'], **timing_metadata(request, version)}


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
    if 'deferred_timing' in r:
        glass_scope(root)
        timing_metadata(r, '1.19.9')
    return r


if __name__ == '__main__':
    validate(Path(__file__).resolve().parents[1])
    print('Export digest and nonzero Linux check evidence verified')
