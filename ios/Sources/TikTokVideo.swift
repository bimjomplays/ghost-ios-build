import UIKit
import WebKit

/// TikTok actions in Ghost's player (ui.js "TikTok actions", page script ghost/tiktok-video-page.js): like, save,
/// follow, comments, "Not interested".
///
/// TikTok's phone website sends people to the app for most of these, and they're requests TikTok signs with its own
/// security tokens. So this is a hidden WKWebView on TikTok's *desktop* website showing the one video the user acted
/// on (https://www.tiktok.com/@<user>/video/<id>), and the page script presses TikTok's own buttons there - only after
/// a tap in Ghost - and reads the result back. Same default website data store as the TikTok tab, so it's the same
/// sign-in. No pictures or video load in it. It exists only while used: torn down a minute after the last action, and
/// at once when the TikTok tab is switched off.
final class GhostTikTokVideo: NSObject, WKNavigationDelegate, WKUIDelegate {
    static let userAgent = GhostTikTokDM.userAgent
    static let pageSize = CGSize(width: 1280, height: 900)

    private weak var host: UIViewController?
    private var web: WKWebView?
    private var loadedID = ""
    private var idleTimer: Timer?
    private var busy = 0
    /// actions run one after another: a new one (maybe for another video) never navigates the page away while an
    /// earlier action is still pressing buttons or waiting for TikTok's answer there
    private var queue: [(run: () -> Void, cancel: () -> Void)] = []

    init(host: UIViewController) {
        self.host = host
        super.init()
    }

    func handle(_ body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        switch body["cmd"] as? String ?? "" {
        case "vpRun":
            guard let action = body["action"] as? String, ["state", "like", "save", "follow", "comments", "replies", "likeComment", "comment", "notInterested", "play"].contains(action),
                  let id = body["id"] as? String, id.range(of: "^[0-9]{5,30}$", options: .regularExpression) != nil else { return reply(nil, "bad action") }
            let handle = (body["handle"] as? String ?? "").range(of: "^[A-Za-z0-9._]{1,40}$", options: .regularExpression) != nil ? body["handle"] as! String : "i"
            var args = body["args"] as? [String: Any] ?? [:]
            args["id"] = id
            enqueue(run: { [weak self] in self?.run(action, id: id, handle: handle, args: args, reply: reply) }, cancel: { reply(nil, "stopped") })
        case "vpList":
            // a profile / hashtag / sound page on TikTok's desktop site: TikTok's own page fetches the video list
            // (Ghost's own request gets an empty answer), the page script keeps a copy (window.__ghostVPList)
            let kind = body["kind"] as? String ?? ""
            let ok: (String?, String) -> String? = { v, re in (v ?? "").range(of: re, options: .regularExpression) != nil ? v : nil }
            var path = ""
            if kind == "user", let h = ok(body["handle"] as? String, "^[A-Za-z0-9._]{1,40}$") { path = "/@\(h)" }
            else if kind == "tag", let n = ok(body["name"] as? String, "^[\\p{L}\\p{N}_]{1,80}$"), let e = n.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) { path = "/tag/\(e)" }
            else if kind == "sound", let i = ok(body["id"] as? String, "^[0-9]{1,30}$") {
                let slug = (body["slug"] as? String ?? "").replacingOccurrences(of: "[^A-Za-z0-9-]+", with: "-", options: .regularExpression).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
                path = "/music/\(slug.isEmpty ? "original-sound" : String(slug.prefix(60)))-\(i)"
            }
            guard !path.isEmpty, let url = URL(string: "https://www.tiktok.com" + path) else { return reply(nil, "bad list") }
            // which page the answer must come from (not the page that was open before this load)
            let match: [String: String] = kind == "sound" ? ["suffix": "-" + (body["id"] as? String ?? "")] : ["exact": path.removingPercentEncoding?.lowercased() ?? path.lowercased()]
            let args: [String: Any] = ["from": body["from"] as? Int ?? 0, "more": body["more"] as? Bool == true, "match": match]
            enqueue(run: { [weak self] in self?.runList(url, key: path, args: args, reply: reply) }, cancel: { reply(nil, "stopped") })
        case "vpStop": stop(); reply(true, nil)
        default: reply(nil, "unknown video command")
        }
    }

    private func start() {
        if web != nil { return }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.defaultWebpagePreferences.preferredContentMode = .desktop
        config.mediaTypesRequiringUserActionForPlayback = .all
        let ucc = WKUserContentController()
        if let url = Bundle.main.url(forResource: "ghost-tiktok-video", withExtension: "js"), let js = try? String(contentsOf: url, encoding: .utf8) {
            ucc.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        }
        config.userContentController = ucc
        let wv = WKWebView(frame: CGRect(origin: .zero, size: Self.pageSize), configuration: config)
        wv.customUserAgent = Self.userAgent
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.isUserInteractionEnabled = false
        wv.alpha = 0.01
        if #available(iOS 16.4, *) { wv.isInspectable = true }
        host?.view.insertSubview(wv, at: 0)
        web = wv
        let rules = """
        [{"trigger":{"url-filter":".*","resource-type":["image","media"]},"action":{"type":"block"}}]
        """
        if let store = WKContentRuleListStore.default() {
            store.compileContentRuleList(forIdentifier: "ghost-tiktok-video-quiet", encodedContentRuleList: rules) { [weak self] list, _ in
                DispatchQueue.main.async { if let list, let wv = self?.web { wv.configuration.userContentController.add(list) } }
            }
        }
    }

    private func enqueue(run job: @escaping () -> Void, cancel: @escaping () -> Void) {
        queue.append((run: job, cancel: cancel))
        if busy == 0 { next() }
    }

    private func next() {
        guard busy == 0, !queue.isEmpty else { return }
        queue.removeFirst().run()
    }

    func stop() {
        idleTimer?.invalidate(); idleTimer = nil
        let waiting = queue
        queue.removeAll()
        for j in waiting { j.cancel() } // every waiting tap gets an answer (Ghost un-does its optimistic change)
        guard let wv = web else { return }
        wv.stopLoading()
        wv.navigationDelegate = nil
        wv.uiDelegate = nil
        wv.configuration.userContentController.removeAllUserScripts()
        wv.removeFromSuperview()
        web = nil
        loadedID = ""
    }

    private func armIdle() {
        idleTimer?.invalidate()
        idleTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: false) { [weak self] _ in
            guard let self, self.busy == 0 else { self?.armIdle(); return }
            self.stop()
        }
    }

    private func run(_ action: String, id: String, handle: String, args: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        start()
        idleTimer?.invalidate(); idleTimer = nil
        guard let wv = web else { reply(nil, "not running"); return next() }
        busy += 1
        var finished = false
        let done: (Any?, String?) -> Void = { [weak self] v, e in
            guard !finished else { return }
            finished = true
            reply(v, e)
            guard let self else { return }
            self.busy = max(0, self.busy - 1)
            self.armIdle()
            self.next()
        }
        if loadedID != id {
            loadedID = id
            guard let url = URL(string: "https://www.tiktok.com/@\(handle)/video/\(id)") else { return done(nil, "bad url") }
            wv.load(URLRequest(url: url))
        }
        // wait for the page script and for TikTok's page to show this video (up to ~15 s), then run the action
        func attempt(_ n: Int) {
            guard self.web === wv else { return done(nil, "stopped") }
            wv.callAsyncJavaScript("""
                if (!window.__ghostVP || !window.__ghostVPRead) return { notReady: true };
                const s = window.__ghostVPRead.state(args.id);
                if (!s.ok && action !== "state") return { notReady: true };
                return await window.__ghostVP(action, args);
                """, arguments: ["action": action, "args": args], in: nil, in: .page) { [weak self] result in
                guard let self, self.web === wv else { return done(nil, "stopped") }
                switch result {
                case .success(let value):
                    if let d = value as? [String: Any], d["notReady"] as? Bool == true {
                        if n < 50 { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { attempt(n + 1) } }
                        else { done(["error": "TikTok's page didn't load that video", "notDone": true, "notSent": true], nil) }
                        return
                    }
                    done(value, nil)
                case .failure(let error):
                    // the first action on a video starts loading its page, and a call that lands while the old page
                    // is being replaced fails ("navigated"/"unloaded") - that's "not ready yet", not a failed like
                    // (phone 2026-09-29: every first like/comments said "Couldn't ... on TikTok")
                    if n < 50 { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { attempt(n + 1) } }
                    else { done(nil, error.localizedDescription) }
                }
            }
        }
        attempt(0)
    }

    private func runList(_ url: URL, key: String, args: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        start()
        idleTimer?.invalidate(); idleTimer = nil
        guard let wv = web else { reply(nil, "not running"); return next() }
        busy += 1
        var finished = false
        let done: (Any?, String?) -> Void = { [weak self] v, e in
            guard !finished else { return }
            finished = true
            reply(v, e)
            guard let self else { return }
            self.busy = max(0, self.busy - 1)
            self.armIdle()
            self.next()
        }
        if loadedID != key { loadedID = key; wv.load(URLRequest(url: url)) }
        func attempt(_ n: Int) {
            guard self.web === wv else { return done(nil, "stopped") }
            wv.callAsyncJavaScript("""
                const p = decodeURIComponent(location.pathname).replace(/\\/+$/, "").toLowerCase();
                const m = args.match || {};
                if (!window.__ghostVPList || document.readyState === "loading" || (m.exact && p !== m.exact) || (m.suffix && !p.endsWith(m.suffix))) return { notReady: true };
                return await window.__ghostVPList(args);
                """, arguments: ["args": args], in: nil, in: .page) { [weak self] result in
                guard let self, self.web === wv else { return done(nil, "stopped") }
                switch result {
                case .success(let value):
                    if let d = value as? [String: Any], d["notReady"] as? Bool == true {
                        if n < 50 { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { attempt(n + 1) } }
                        else { done(["error": "TikTok's page didn't load"], nil) }
                        return
                    }
                    done(value, nil)
                case .failure(let error):
                    // same as run(): a call landing while the page is being replaced is "not ready yet"
                    if n < 50 { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { attempt(n + 1) } }
                    else { done(nil, error.localizedDescription) }
                }
            }
        }
        attempt(0)
    }

    // MARK: navigation: stays on TikTok; nothing opens

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url, let scheme = url.scheme?.lowercased() else { return decisionHandler(.cancel) }
        if scheme == "about" || scheme == "blob" || scheme == "data" { return decisionHandler(.allow) }
        guard scheme == "https" else { return decisionHandler(.cancel) }
        if navigationAction.targetFrame?.isMainFrame == false { return decisionHandler(.allow) }
        decisionHandler(GhostTikTok.allowed(url.host ?? "") ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if webView === web { stop() } // iOS closed it (memory): the next action starts a fresh one
    }
}
