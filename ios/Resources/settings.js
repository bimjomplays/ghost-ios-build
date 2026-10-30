// App only: the app's own settings (native settings sheet <-> page). Contract used by every feature script:
//   dgSetting(key, fallback)   current value (defaults come from settings-schema.json, filled in by the app)
//   dgOnSettings(fn)           fn(changedKeys, allValues) after the user changes something in the sheet
//   dgSetSetting(key, value)   change a value from the page (saved by the app, other listeners notified)
//   dgOpenSettings()           open the native settings sheet
// App.swift injects `window.__dgSettingsInit = {...}` right before this file and calls
// window.__dgApplySettings({...}) with the full set whenever the sheet changes something.
(() => {
  if (window.top !== window || window.dgSetting) return;
  let values = Object.assign({}, window.__dgSettingsInit || {});
  const listeners = [];
  const post = (msg) => { try { window.webkit.messageHandlers.dg.postMessage(msg).catch(() => {}); } catch (e) {} };
  const notify = (changed) => {
    if (!changed.length) return;
    for (const fn of listeners) { try { fn(changed, values); } catch (e) { post({ op: "trail", text: "SETTINGS listener error " + e }); } }
  };
  window.dgSetting = (key, fallback) => (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback);
  window.dgOnSettings = (fn) => { listeners.push(fn); };
  window.dgSetSetting = (key, value) => {
    values = Object.assign({}, values, { [key]: value });
    post({ op: "setSetting", key, value });
    notify([key]);
  };
  window.dgOpenSettings = () => post({ op: "openSettings" });
  window.__dgApplySettings = (next) => {
    const changed = Object.keys(Object.assign({}, values, next)).filter((k) => JSON.stringify(values[k]) !== JSON.stringify(next[k]));
    values = Object.assign({}, next);
    notify(changed);
  };
})();
