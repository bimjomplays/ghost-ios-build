#!/usr/bin/env python3
"""Runner-only ASC preflight/processing verification. Never prints API bodies or credentials."""
import base64
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

PUBLIC = runpy.run_path(str(Path(__file__).with_name('public.py')))
BASE = 'https://api.appstoreconnect.apple.com'
BUNDLE = 'com.dltnp.ghost'


def raw_signature(der):
    # OpenSSL emits ASN.1 DER; JWT ES256 needs fixed-width R || S.
    if len(der) < 6 or der[0] != 0x30 or der[1] != len(der) - 2:
        raise ValueError('unexpected signing response')
    pos, parts = 2, []
    for _ in range(2):
        if pos + 2 > len(der) or der[pos] != 2:
            raise ValueError('unexpected signature integer')
        n = der[pos + 1]
        if pos + 2 + n > len(der):
            raise ValueError('truncated signature integer')
        value = der[pos + 2:pos + 2 + n].lstrip(b'\0')
        if not n or len(value) > 32:
            raise ValueError('invalid signature width')
        parts.append(value.rjust(32, b'\0'))
        pos += 2 + n
    if pos != len(der):
        raise ValueError('unexpected signature suffix')
    return b''.join(parts)


def token():
    def b64(data):
        return base64.urlsafe_b64encode(data).rstrip(b'=')
    now = int(time.time())
    head = {'alg': 'ES256', 'kid': os.environ['ASC_KEY_ID'], 'typ': 'JWT'}
    body = {'iss': os.environ['ASC_ISSUER_ID'], 'iat': now - 10, 'exp': now + 600, 'aud': 'appstoreconnect-v1'}
    payload = b'.'.join(b64(json.dumps(x, separators=(',', ':')).encode()) for x in (head, body))
    key = Path(os.environ['RUNNER_TEMP']) / 'asc/key.p8'
    p = subprocess.run(['openssl', 'dgst', '-sha256', '-sign', str(key)], input=payload, capture_output=True)
    if p.returncode:
        raise ValueError('ASC signing failed (check the environment key)')
    return (payload + b'.' + b64(raw_signature(p.stdout))).decode()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('refusing API redirect with authorization')


def api(path, params=None, method='GET', data=None):
    if path.startswith(BASE + '/'):
        url = path
    elif path.startswith('/v1/'):
        url = BASE + path
    else:
        raise ValueError('refusing off-host API pagination')
    if params:
        url += '?' + urllib.parse.urlencode(params)
    body = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, method=method,
                                 headers={'Authorization': 'Bearer ' + token(), 'Content-Type': 'application/json'})
    try:
        with urllib.request.build_opener(NoRedirect).open(req, timeout=45) as response:
            return json.load(response)
    except urllib.error.HTTPError as e:
        raise ValueError(f'App Store Connect HTTP {e.code}; inspect account roles/agreements in ASC (body withheld)') from None


def app_id():
    apps = api('/v1/apps', {'filter[bundleId]': BUNDLE})['data']
    if len(apps) != 1:
        raise ValueError('expected one accessible App Store Connect app for the bundle ID')
    if apps[0]['id'] != os.environ['ASC_APP_ID']:
        raise ValueError('App Store Connect app does not match the configured ASC_APP_ID')
    return apps[0]['id']


def metadata():
    root = Path(__file__).resolve().parents[1]
    version = re.search(r'CFBundleShortVersionString: "(\d+\.\d+\.\d+)"', (root / 'ios/project.yml').read_text())
    if not version:
        raise ValueError('missing real X.Y.Z marketing version')
    number = os.environ['BUILD_NUMBER']
    if number != PUBLIC['build_number'](int(os.environ['GITHUB_RUN_NUMBER'])):
        raise ValueError('unexpected build sequence')
    return root, version[1], number


def preflight():
    _, version, number = metadata()
    app = app_id()
    path = '/v1/builds'
    params = {'filter[app]': app, 'limit': 200}
    while path:
        page = api(path, params)
        for build in page['data']:
            old = build['attributes']['version']
            # Fail closed across the entire app, not just this marketing version.
            if not re.fullmatch(r'\d+(\.\d+){0,2}', old):
                raise ValueError('existing ASC build sequence needs manual review')
            a = tuple(map(int, old.split('.'))) + (0,) * (3 - len(old.split('.')))
            if a >= (int(number), 0, 0):
                raise ValueError('build number is already used or behind ASC; allocate a fresh sequence/run')
        path = page.get('links', {}).get('next')
        params = None
    print(f'ASC app exists; build {version} ({number}) is unused and greater than existing builds')


def notes(root, version):
    js = "const fs=require('fs'),vm=require('vm'),w={};vm.runInNewContext(fs.readFileSync('ghost/whatsnew.js','utf8'),{window:w});process.stdout.write(JSON.stringify(w.GHOST_WHATS_NEW));"
    data = json.loads(subprocess.check_output(['node', '-e', js], cwd=root))
    return '\n'.join('- ' + it['t'] + (' ' + it['how'] if it.get('how') else '') for it in data[version]['items'])


def verify():
    root, version, number = metadata()
    app = app_id()
    deadline = time.monotonic() + 35 * 60
    while time.monotonic() < deadline:
        data = api('/v1/builds', {'filter[app]': app, 'filter[version]': number,
                                'include': 'preReleaseVersion,buildBetaDetail', 'limit': 200})
        build = PUBLIC['processed_build'](data, version, number)
        if build:
            break
        print('Waiting for Apple build processing (not yet verified)', flush=True)
        time.sleep(30)
    else:
        raise ValueError('processing not verified within 35 minutes; upload may exist, do not blindly re-upload')
    text = notes(root, version)
    localizations = api(f'/v1/builds/{build}/betaBuildLocalizations')['data']
    existing = next((v for v in localizations if v['attributes']['locale'] == 'en-US'), None)
    if existing:
        api('/v1/betaBuildLocalizations/' + existing['id'], method='PATCH', data={
            'data': {'type': 'betaBuildLocalizations', 'id': existing['id'], 'attributes': {'whatsNew': text}}})
    else:
        api('/v1/betaBuildLocalizations', method='POST', data={'data': {'type': 'betaBuildLocalizations',
            'attributes': {'locale': 'en-US', 'whatsNew': text},
            'relationships': {'build': {'data': {'type': 'builds', 'id': build}}}}})
    confirmed = api(f'/v1/builds/{build}/betaBuildLocalizations')['data']
    if not any(v['attributes']['locale'] == 'en-US' and v['attributes'].get('whatsNew') == text for v in confirmed):
        raise ValueError('TestFlight release notes did not round-trip')
    detail = api(f'/v1/builds/{build}/buildBetaDetail')['data']['attributes']
    selected = next(b for b in data['data'] if b['id'] == build)
    request = json.loads((root / 'ci/request.json').read_text())
    receipt = {'schema': 1, 'bundle_id': BUNDLE, 'app_id': app, 'build_id': build,
               'public_revision': os.environ['GITHUB_SHA'], 'export_digest': request['digest'],
               'workflow_run_id': os.environ['GITHUB_RUN_ID'], 'build_repository': os.environ['GITHUB_REPOSITORY'],
               'expirationDate': selected['attributes']['expirationDate'],
               'version': version, 'build': number, 'processingState': 'VALID', 'notes_verified': True,
               'internalBuildState': detail.get('internalBuildState'), 'externalBuildState': detail.get('externalBuildState'),
               'tester_install_verified': False, 'migration_verified': False}
    Path('testflight-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(f'Processed TestFlight build verified: {version} ({number}); notes match. Tester assignment/install/migration still require verification.')


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2 or sys.argv[1] not in ('preflight', 'verify'):
            raise ValueError('usage: testflight.py preflight|verify')
        (preflight if sys.argv[1] == 'preflight' else verify)()
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as e:
        print(f'TestFlight NOT VERIFIED: {type(e).__name__}: {e}', file=sys.stderr)
        sys.exit(1)
