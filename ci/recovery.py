"""One verify-only recovery for an uploaded build. No archive, signing or upload.

Public constants identify public Actions/app resources, never private source IDs.
The original failed run stays failed; a separate run attests processing/notes.
"""
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import sys

PUBLIC = runpy.run_path(str(Path(__file__).with_name('public.py')))
REPO = 'bimjomplays/ghost-ios-build'
RUN = 41253228621
SHA = '4f9ca6345fdd22fe51c6b29e1934c2038a4eb0aa'
EXPORT = '04643a50b2e11478f96d27250a615c29ce8cd54d72b82a7cf92911cd8505df9b'
REQUEST = '8c948878ce7b52dfca4c732087cb0375516e0ac37b23e619be87675f8d8864d6'
APP_ID = '6828924433'
VERIFY_STEP = 'Verify processing and attach the same plain-language release notes'
UPLOAD_STEP = 'Unsigned archive, cloud-managed distribution export and upload'


def require(ok, message):
    if not ok:
        raise ValueError(message)


def original_run(run, jobs):
    expected = {'id': RUN, 'run_number': 3, 'run_attempt': 1, 'head_sha': SHA, 'head_branch': 'main',
                'status': 'completed', 'conclusion': 'failure', 'event': 'workflow_dispatch',
                'path': '.github/workflows/ios.yml'}
    require(all(run.get(k) == v for k, v in expected.items())
            and run.get('repository', {}).get('full_name') == REPO, 'unrelated original failed run')
    rows = jobs.get('jobs', [])
    require(jobs.get('total_count') == len(rows) == 3 and {j.get('name') for j in rows} == {'validate', 'build', 'testflight'},
            'incomplete original job evidence')
    required_steps = {
        'build': ['Simulator build (no signed-in account or live Snapchat navigation)', 'Unsigned device build',
                  'Verify built identity, version and required resources'],
        'testflight': ['Require matching same-run full build and truthful Linux timing disclosure',
                      'Check App Store Connect app and unused build number', 'Tools and generated scripts', UPLOAD_STEP, VERIFY_STEP]}
    for job in rows:
        expected_conclusion = 'failure' if job['name'] == 'testflight' else 'success'
        require(job.get('run_id') == RUN and job.get('status') == 'completed' and job.get('conclusion') == expected_conclusion,
                'unexpected original job result')
        steps = job.get('steps', [])
        for name in required_steps.get(job['name'], []):
            found = [s for s in steps if s.get('name') == name]
            conclusion = 'failure' if name == VERIFY_STEP else 'success'
            require(len(found) == 1 and found[0].get('status') == 'completed' and found[0].get('conclusion') == conclusion,
                    'missing required original build/upload/verification result')
        require(all(s.get('conclusion') in ('success', 'skipped') or
                    (job['name'] == 'testflight' and s.get('name') == VERIFY_STEP and s.get('conclusion') == 'failure')
                    for s in steps), 'another original step failed')


def original_claim(receipt):
    expected = {'public_revision': SHA, 'workflow_run_id': str(RUN), 'build_repository': REPO,
                'export_digest': EXPORT, 'version': '1.19.9', 'build': '1003', 'app_id': APP_ID,
                'bundle_id': 'com.dltnp.ghost', 'linux_request_sha256': REQUEST}
    require(all(receipt.get(k) == v for k, v in expected.items()), 'receipt is not the exact uploaded build')
    request = {'schema': 1, 'mode': 'release', 'linux_checks': 965, 'full_gate_results': 44,
               'no_at_bridge': True, 'digest': EXPORT, 'deferred_timing': receipt.get('deferred_timing')}
    require(PUBLIC['json_digest'](request) == REQUEST, 'original raw timing disclosure changed')


def recovery_chain(receipt, original, jobs, recovered):
    original_claim(receipt)
    original_run(original, jobs)
    r = receipt.get('recovery')
    require(isinstance(r, dict) and set(r) == {'workflow_run_id', 'public_revision', 'original_conclusion', 'original_run_attempt'},
            'missing explicit recovery provenance')
    require(r['original_conclusion'] == 'failure' and r['original_run_attempt'] == 1
            and isinstance(r['workflow_run_id'], str) and re.fullmatch('[1-9][0-9]*', r['workflow_run_id'])
            and r['workflow_run_id'] != str(RUN) and isinstance(r['public_revision'], str)
            and re.fullmatch('[0-9a-f]{40}', r['public_revision']), 'invalid recovery identity')
    expected = {'id': int(r['workflow_run_id']), 'head_sha': r['public_revision'], 'head_branch': 'main',
                'status': 'completed', 'conclusion': 'success', 'event': 'workflow_dispatch',
                'path': '.github/workflows/ios-recover.yml'}
    require(isinstance(recovered, dict) and all(recovered.get(k) == v for k, v in expected.items())
            and recovered.get('repository', {}).get('full_name') == REPO, 'unrelated/failed/unfinished recovery run')


def verify_apple():
    tf = runpy.run_path('ci/testflight.py')
    # Execute the authenticated original verifier/notes, with only the corrected
    # source-scope helper. Never modify the original checkout or request bytes.
    tf['verify'].__globals__['PUBLIC'] = PUBLIC
    tf['verify']()


def recover(root, native, run, jobs):
    original_run(run, jobs)
    require(os.environ.get('GITHUB_REPOSITORY') == REPO and os.environ.get('GITHUB_REF') == 'refs/heads/main'
            and os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
            and os.environ.get('ASC_APP_ID') == APP_ID, 'recovery requires the protected main/app context')
    provenance = {'workflow_run_id': os.environ['GITHUB_RUN_ID'], 'public_revision': os.environ['GITHUB_SHA'],
                  'original_conclusion': 'failure', 'original_run_attempt': 1}
    require(provenance['workflow_run_id'] != str(RUN), 'recovery cannot pretend to be the original run')
    # Validate the immutable original export BEFORE introducing a downloaded artifact.
    request = PUBLIC['validate'](root)
    require(request['digest'] == EXPORT and PUBLIC['json_digest'](request) == REQUEST, 'unrelated original export/request')
    require(not (root / 'build-receipt.json').exists() and not (root / 'testflight-receipt.json').exists(), 'stale recovery workspace')
    require(native.is_file() and not native.is_symlink(), 'missing native artifact')
    build = json.loads(native.read_text())
    old_env = dict(os.environ)
    before = Path.cwd()
    try:
        os.environ.update(GITHUB_SHA=SHA, GITHUB_RUN_ID=str(RUN), GITHUB_RUN_NUMBER='3', BUILD_NUMBER='1003')
        expected = PUBLIC['build_receipt'](request, '1.19.9', '1003', ['simulator', 'device'])
        require(build == expected, 'original native receipt mismatches uploaded export/run/build/timing')
        shutil.copyfile(native, root / 'build-receipt.json')
        os.chdir(root)
        verify_apple()
        path = root / 'testflight-receipt.json'
        receipt = json.loads(path.read_text())
        original_claim(receipt)
        require('recovery' not in receipt and receipt.get('processingState') == 'VALID' and receipt.get('notes_verified') is True
                and receipt.get('tester_install_verified') is False and receipt.get('migration_verified') is False,
                'unexpected processing claim')
        receipt['recovery'] = provenance
        path.write_text(json.dumps(receipt, indent=2) + '\n')
    finally:
        os.chdir(before)
        os.environ.clear()
        os.environ.update(old_env)
    print('Existing uploaded build 1.19.9 (1003) processing/notes recovered. Original release run remains FAILED; timing remains owner-deferred, not passed. Tester access/install/migration unverified.')


if __name__ == '__main__':
    try:
        if len(sys.argv) != 5:
            raise ValueError('usage: recovery.py ORIGINAL_EXPORT NATIVE_RECEIPT ORIGINAL_RUN_JSON ORIGINAL_JOBS_JSON')
        recover(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(),
                json.loads(Path(sys.argv[3]).read_text()), json.loads(Path(sys.argv[4]).read_text()))
    except (ValueError, KeyError, TypeError, OSError) as e:
        print(f'TestFlight recovery NOT VERIFIED: {type(e).__name__}: {e}', file=sys.stderr)
        sys.exit(1)
