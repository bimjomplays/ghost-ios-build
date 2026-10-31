// What's New text (ghost/whatsnew.js): every release has an entry written for users. `node ghost/tests/whatsnew.test.cjs`
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..", "..");
const win = {};
vm.runInNewContext(fs.readFileSync(path.join(root, "ghost", "whatsnew.js"), "utf8"), { window: win });
const notes = win.GHOST_WHATS_NEW;
const version = /CFBundleShortVersionString: "([^"]+)"/.exec(fs.readFileSync(path.join(root, "ios", "project.yml"), "utf8"))[1];

let pass = 0, fail = 0;
function check(name, ok, detail) { if (ok) pass++; else fail++; console.log((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "  " + (detail || ""))); }

check("notes is an object", notes && typeof notes === "object");
check("the version in project.yml (" + version + ") has an entry with items", !!(notes[version] && notes[version].items && notes[version].items.length), Object.keys(notes).join(","));
// internal wording that must never reach a friend: ticket/issue numbers, test counts, file/function names, protocol terms
const BAD = [[/#\d+/, "ticket number"], [/\bticket\b/i, "ticket"], [/\b\d+\s*(\/\s*\d+\s*)?(tests?|checks?|suites?)\b/i, "test count"],
  [/\.(js|swift|py|cjs|yml|md)\b/i, "file name"], [/\b(rig|gate|CI|bridge|relay|protocol|IndexedDB|WKWebView|build \d+)\b/i, "internal term"]];
for (const [ver, entry] of Object.entries(notes)) {
  check(ver + ": version looks like X.Y.Z", /^\d+\.\d+\.\d+$/.test(ver));
  const items = (entry && entry.items) || [];
  check(ver + ": at most 6 bullets", items.length <= 6, String(items.length));
  items.forEach((it, i) => {
    const t = ver + " bullet " + (i + 1);
    check(t + ": plain text, one short line or two", typeof it.t === "string" && it.t.length > 0 && it.t.length <= 140, String(it.t && it.t.length));
    check(t + ": how-to is short", it.how === undefined || (typeof it.how === "string" && it.how.length > 0 && it.how.length <= 80), String(it.how));
    for (const [re, what] of BAD) check(t + ": no " + what, !re.test(it.t + " " + (it.how || "")), it.t + " | " + (it.how || ""));
  });
}
console.log("whatsnew.test: pass=" + pass + " fail=" + fail);
process.exitCode = fail ? 1 : 0;
