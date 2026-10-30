"""Build two Safari Userscripts files without changing the desktop extension."""
from pathlib import Path
import json
import zipfile

root = Path(__file__).resolve().parent
out = root / 'safari-install'
out.mkdir(exist_ok=True)

def header(name, world, timing, grants):
    lines = ['// ==UserScript==', f'// @name {name}', '// @version 0.5.0',
             '// @description Experimental iPhone port of Dark Glass for Snapchat',
             '// @match https://www.snapchat.com/web*', '// @match https://web.snapchat.com/*',
             f'// @inject-into {world}', f'// @run-at {timing}', '// @noframes']
    lines += [f'// @grant {grant}' for grant in grants]
    return '\n'.join(lines + ['// ==/UserScript==', ''])

def read(name):
    return (root / name).read_text()

# Userscripts' own page injection is an inline <script>, which Snapchat's CSP blocks
# (script-src has no 'unsafe-inline' but does allow blob:). So this runs in the content
# world and loads the hooks into the page as a blob: script before Snapchat's deferred bundle.
hooks = '\n'.join(read(name) for name in ['presence.js', 'snap-clean.js', 'gifs-find.js'])
hooks = ('(() => { if (window.__dgHooks) return; window.__dgHooks = true;\n'
         'document.documentElement.dataset.dgHooks = document.readyState === "loading" ? "early" : "late";\n'
         + hooks + '\n})();\n')
page = header('Dark Mobile — page hooks', 'content', 'document-start', ['none'])
page += '(() => {\nif (window.top !== window) return;\nconst code = ' + json.dumps(hooks) + ';\n'
page += '''const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
const tag = document.createElement("script");
tag.src = url;
tag.onload = tag.onerror = () => { URL.revokeObjectURL(url); tag.remove(); };
(document.head || document.documentElement).appendChild(tag);
})();
'''
(out / 'dark-mobile-hooks.user.js').write_text(page)

content = header('Dark Mobile — theme and GIFs', 'content', 'document-start',
                 ['GM.getValue', 'GM.setValue', 'GM.xmlHttpRequest'])
content += '\n(() => {\nif (window.top !== window) return;\n'
content += read('userscripts-adapter.js') + '\n' + read('background.js') + '\n'
css = read('glass.css') + '\n' + read('mobile.css')
content += 'const css = ' + json.dumps(css) + ';\n'
content += '''function start() {
  if (!document.documentElement) return void setTimeout(start, 10);
  if (document.getElementById('dg-mobile-style')) return;
  const style = document.createElement('style');
  style.id = 'dg-mobile-style'; style.textContent = css;
  document.documentElement.appendChild(style);
'''
content += '\n'.join(read(name) for name in ['glass.js', 'gifs-show.js', 'gif-picker.js', 'gif-anim.js'])
# No console on iPhone: say so on screen if the page hooks didn't load.
content += '''
setTimeout(() => {
  // presence can only be fixed if the hooks ran before Snapchat's bundle; "late" here is a readyState
  // guess and was a false alarm on iPhone (hooks still in time), so only a missing script is reported
  if (document.documentElement.dataset.dgHooks) return;
  const note = document.createElement("div");
  note.textContent = "Dark Mobile: page hooks script isn't running";
  note.style.cssText = "position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483647;padding:10px 14px;border-radius:10px;background:#b3261e;color:#fff;font:14px system-ui;text-align:center";
  note.onclick = () => note.remove();
  document.body.appendChild(note);
  setTimeout(() => note.remove(), 8000);
}, 4000);
'''
content += '\n}\nstart();\n})();\n'
(out / 'dark-mobile-ui.user.js').write_text(content)

# iPhone app (ios/): the same code, injected by WKWebView instead of Userscripts
app = root / 'ios' / 'Resources'
(app / 'hooks.js').write_text(hooks)
(app / 'ui.js').write_text(content)

# Ghost line (branch main): the new UI and its data bridge, bundled for App.swift's GhostMode
ghost = root / 'ghost'
if (ghost / 'bridge.js').exists():
    (app / 'ghost-bridge.js').write_text((ghost / 'retention.js').read_text() + '\n' + (ghost / 'bridge.js').read_text())
if (ghost / 'ui.js').exists():
    css = (ghost / 'ui.css').read_text() if (ghost / 'ui.css').exists() else ''
    # the GIF player from the Snapchat-look app, without its page scanner: animates GIFs sent as photos
    gifanim = 'window.__ghostNoGifScan = true;\n' + read('gif-anim.js') + '\n'
    # network.js (Ghost accounts core) defines GhostNetCore at the top of the same script, before ui.js reads it
    net = (ghost / 'network.js').read_text() + '\n' if (ghost / 'network.js').exists() else ''
    # Ghost games (ghost/GAMES.md): the framework, then each game's libraries/engines, then the game modules
    games = ''
    if (ghost / 'games.js').exists():
        mods = sorted((ghost / 'games').glob('*.js')) if (ghost / 'games').exists() else []
        first = [m for m in mods if m.stem.endswith('-lib') or m.stem.endswith('-engine')]
        games = ''.join(f.read_text() + '\n' for f in [ghost / 'games.js'] + first + [m for m in mods if m not in first])
    # snap filters (colour looks, WebGL renderer, native parameters): SnapFX, read by ui.js's snap editor
    snapfx = (ghost / 'snapfx.js').read_text() + '\n' if (ghost / 'snapfx.js').exists() else ''
    # the What's New text (window.GHOST_WHATS_NEW, written at publish time): read by ui.js on the first open after an update
    whatsnew = (ghost / 'whatsnew.js').read_text() + '\n' if (ghost / 'whatsnew.js').exists() else ''
    (app / 'ghost-ui.js').write_text(gifanim + 'const GHOST_CSS = ' + json.dumps(css) + ';\n' + net + games + snapfx + whatsnew + (ghost / 'ui.js').read_text())
# the TikTok tab's hidden TikTok page script (runs in TikTokFeed.swift's own web view, never in Snapchat's page)
if (ghost / 'tiktok-page.js').exists():
    (app / 'ghost-tiktok.js').write_text((ghost / 'tiktok-page.js').read_text())
if (ghost / 'tiktok-dm-page.js').exists():
    (app / 'ghost-tiktok-dm.js').write_text((ghost / 'tiktok-dm-page.js').read_text())
if (ghost / 'tiktok-video-page.js').exists():
    # the hidden desktop page turns TikTok's list answers into the same compact items as the TikTok tab:
    # copy pick/urlOf + compact() out of tiktok-page.js at the /* @ghost-compact */ marker (str/num exist there already)
    tp = (ghost / 'tiktok-page.js').read_text()
    a = tp.index('  const pick = '); b = tp.index('\n', tp.index('  const urlOf = ')) + 1
    c = tp.index('  function compact(it) {'); d = tp.index('  // a search/user result')
    vp = (ghost / 'tiktok-video-page.js').read_text()
    assert '/* @ghost-compact */' in vp
    (app / 'ghost-tiktok-video.js').write_text(vp.replace('/* @ghost-compact */', tp[a:b] + tp[c:d]))

with zipfile.ZipFile(root / 'Dark-Mobile-Safari.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(out.glob('*.user.js')):
        archive.write(path, path.name)
print(root / 'Dark-Mobile-Safari.zip')
