import UIKit
import WebKit

/// Ghost's TikTok tab (ui.js section "TikTok tab", plan: ghost/TIKTOK_PLAN.md).
///
/// A second, hidden WKWebView sits behind Ghost's own and loads TikTok's mobile website. ghost-tiktok.js
/// (ghost/tiktok-page.js) runs inside it: it passes the videos TikTok's own For You requests return to this class,
/// which forwards them to ui.js (darkmobile world). ui.js plays them in its own swipe player; the video bytes come
/// through `fetch` here, because TikTok's CDN only answers with TikTok's cookies and Referer.
///
/// Nothing exists until ui.js sends "start" (the tab was opened); "stop" (tab switched off, or idle) destroys the web
/// view. The web view uses the default website data store, so signing in once sticks; "signOut" deletes TikTok's
/// website data only. TikTok's cookies never go to Snapchat's page: they are only attached to requests made here.
final class GhostTikTok: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    static let feedURL = URL(string: "https://www.tiktok.com/foryou")!
    static let loginURL = URL(string: "https://www.tiktok.com/login")!
    /// iPhone Safari: TikTok serves its mobile site (the one the page script understands) and doesn't call it an app.
    static let userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1"
    /// hosts `fetch` may reach: TikTok's site, its video CDN and its image CDN
    static func allowed(_ host: String) -> Bool {
        let h = host.lowercased()
        return ["tiktok.com", "tiktokcdn.com", "tiktokcdn-us.com", "tiktokv.com", "tiktokv.us", "ttwstatic.com", "ibytedtos.com", "byteoversea.com"]
            .contains { h == $0 || h.hasSuffix("." + $0) }
    }
    static let maxChunk = 8 * 1024 * 1024

    private weak var host: UIViewController?
    private weak var ghost: WKWebView?
    private var web: WKWebView?
    private var signInSheet: UIViewController?
    private var idleTimer: Timer?
    private var lastItemsAt = Date.distantPast
    private var reloadCheck: DispatchWorkItem?
    private var user: [String: Any]? = nil
    private lazy var session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.httpShouldSetCookies = false
        c.httpCookieAcceptPolicy = .never
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.timeoutIntervalForRequest = 25
        return URLSession(configuration: c, delegate: RedirectGuard(), delegateQueue: nil)
    }()

    init(host: UIViewController, ghost: WKWebView) {
        self.host = host
        self.ghost = ghost
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(background), name: UIApplication.didEnterBackgroundNotification, object: nil)
    }

    // MARK: ui.js ops ("tt", body.cmd)

    /// TikTok messages (TikTokMessages.swift): its own hidden desktop-site page, created on first use
    private var dm: GhostTikTokDM? // created by the first dm* command only (stop paths never create it)
    /// TikTok actions (TikTokVideo.swift): a hidden desktop-site page for the video acted on, created on first use
    private var vp: GhostTikTokVideo?
    private lazy var bookmarks = GhostTikTokBookmarks()

    func handle(_ body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        let cmd = body["cmd"] as? String ?? ""
        if cmd.hasPrefix("dm") {
            if dm == nil, let host, let ghost { dm = GhostTikTokDM(host: host, ghost: ghost) }
            guard let dm else { return reply(nil, "unavailable") }
            return dm.handle(body, reply: reply)
        }
        if cmd.hasPrefix("bm") { return bookmarks.handle(body, reply: reply) } // Ghost's own TikTok bookmarks (Gallery > TikTok)
        if cmd.hasPrefix("vp") {
            if vp == nil, let host { vp = GhostTikTokVideo(host: host) }
            guard let vp else { return reply(nil, "unavailable") }
            return vp.handle(body, reply: reply)
        }
        switch cmd {
        case "start": start(fresh: body["fresh"] as? Bool == true); reply(true, nil)
        case "stop": stop(); dm?.stop(); vp?.stop(); reply(true, nil) // the TikTok tab was switched off: messages and actions go too
        case "active": // the TikTok tab is (not) on screen: unload a few minutes after it's left
            setActive(body["on"] as? Bool == true); reply(true, nil)
        case "more": more(); reply(true, nil)
        case "refresh": refresh(); reply(true, nil)
        case "shareLink": // the share sheet's "Share to…": iOS's own share sheet with the video's TikTok link
            guard let s = body["url"] as? String, let url = URL(string: s), url.scheme == "https", url.host == "www.tiktok.com", let host else { return reply(nil, "bad link") }
            let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            if let pop = sheet.popoverPresentationController { pop.sourceView = host.view; pop.sourceRect = CGRect(x: host.view.bounds.midX, y: host.view.bounds.maxY - 80, width: 1, height: 1) }
            (host.presentedViewController ?? host).present(sheet, animated: true)
            reply(true, nil)
        case "fetch": fetch(body, reply: reply)
        case "resolve": resolve(body, reply: reply) // a TikTok short link (vm./vt.tiktok.com, /t/) -> the video URL
        case "api": api(body, reply: reply)
        case "signIn": signIn(); reply(true, nil)
        case "signOut": signOut(reply: reply)
        case "status": status(reply: reply)
        default: reply(nil, "unknown tt command")
        }
    }

    /// fresh: the player is empty (first open, or after turning the tab back on): an already running page loads the
    /// feed again so its videos are sent once more.
    private func start(fresh: Bool = false) {
        idleTimer?.invalidate(); idleTimer = nil
        if let wv = web { if fresh && signInSheet == nil { wv.load(URLRequest(url: Self.feedURL)) }; return }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = .all // TikTok's own videos never play here
        let ucc = WKUserContentController()
        if let url = Bundle.main.url(forResource: "ghost-tiktok", withExtension: "js"), let js = try? String(contentsOf: url, encoding: .utf8) {
            ucc.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        }
        ucc.add(WeakHandler(self), name: "ghosttt")
        config.userContentController = ucc
        let wv = WKWebView(frame: host?.view.bounds ?? UIScreen.main.bounds, configuration: config)
        wv.customUserAgent = Self.userAgent
        wv.navigationDelegate = self
        wv.isUserInteractionEnabled = false
        wv.alpha = 0.01 // never shows through Ghost's page (WebKit still treats it as visible, so it keeps running)
        wv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        if #available(iOS 16.4, *) { wv.isInspectable = true }
        // behind everything: "on screen" for WebKit (timers and requests keep running) but never seen or touched
        host?.view.insertSubview(wv, at: 0)
        web = wv
        // TikTok's own video/audio files: never downloaded by the hidden page (Ghost fetches the ones it plays)
        let rules = """
        [{"trigger":{"url-filter":".*","resource-type":["media"]},"action":{"type":"block"}},
         {"trigger":{"url-filter":"/video/tos/"},"action":{"type":"block"}},
         {"trigger":{"url-filter":"mime_type=video"},"action":{"type":"block"}}]
        """
        guard let store = WKContentRuleListStore.default() else { wv.load(URLRequest(url: signInSheet == nil ? Self.feedURL : Self.loginURL)); return }
        store.compileContentRuleList(forIdentifier: "ghost-tiktok-quiet", encodedContentRuleList: rules) { [weak self] list, _ in
            DispatchQueue.main.async {
                guard let self, let wv = self.web else { return }
                if let list { wv.configuration.userContentController.add(list) }
                // signIn() may have started us: then it's the sign-in page, not the feed
                wv.load(URLRequest(url: self.signInSheet == nil ? Self.feedURL : Self.loginURL))
            }
        }
    }

    private func stop() {
        idleTimer?.invalidate(); idleTimer = nil
        reloadCheck?.cancel(); reloadCheck = nil
        if signInSheet != nil { signInSheet?.dismiss(animated: false); signInSheet = nil }
        guard let wv = web else { return }
        wv.stopLoading()
        wv.navigationDelegate = nil
        wv.configuration.userContentController.removeScriptMessageHandler(forName: "ghosttt")
        wv.configuration.userContentController.removeAllUserScripts()
        wv.removeFromSuperview()
        web = nil
    }

    private func setActive(_ on: Bool) {
        idleTimer?.invalidate(); idleTimer = nil
        if on { if web == nil { start() }; return }
        idleTimer = Timer.scheduledTimer(withTimeInterval: 180, repeats: false) { [weak self] _ in self?.stop() }
    }

    @objc private func background() {
        // leaving the app counts as leaving the tab
        if web != nil && signInSheet == nil { setActive(false) }
    }

    /// Asks TikTok's page to move its feed on (it fetches the next page near the end); reloads if nothing new comes.
    /// "For You" tapped again: TikTok's own refresh - a new first page (pullType 1) through the page's signed fetch
    private func refresh() {
        guard let wv = web else { start(); return }
        wv.evaluateJavaScript("window.__ghostTTRefresh && window.__ghostTTRefresh()", in: nil, in: .page, completionHandler: nil)
    }

    private func more() {
        guard let wv = web else { start(); return }
        wv.evaluateJavaScript("window.__ghostTTMore && window.__ghostTTMore(4)", in: nil, in: .page, completionHandler: nil)
        reloadCheck?.cancel()
        let asked = Date()
        let work = DispatchWorkItem { [weak self] in
            guard let self, let wv = self.web, self.lastItemsAt < asked, self.signInSheet == nil else { return }
            wv.load(URLRequest(url: Self.feedURL)) // a fresh load brings a new batch
        }
        reloadCheck = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 9, execute: work)
    }

    // MARK: messages from the TikTok page

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.webView === web, let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "items":
            guard let items = body["items"] as? [[String: Any]] else { return }
            if !items.isEmpty { lastItemsAt = Date() }
            send("items", ["items": items, "hasMore": body["hasMore"] as? Bool ?? true, "refresh": body["refresh"] as? Bool ?? false])
        case "page":
            user = body["user"] as? [String: Any]
            refreshStatus()
        default: break
        }
    }

    private func send(_ fn: String, _ payload: Any) {
        guard let data = try? JSONSerialization.data(withJSONObject: [payload]), let json = String(data: data, encoding: .utf8) else { return }
        ghost?.ghostEval("window.__ghostTikTok && window.__ghostTikTok.\(fn)(\(json)[0])")
    }

    private func refreshStatus() { status { [weak self] value, _ in if let value { self?.send("status", value) } } }

    private func status(reply: @escaping (Any?, String?) -> Void) {
        WKWebsiteDataStore.default().httpCookieStore.getAllCookies { [weak self] cookies in
            let signedIn = cookies.contains { Self.allowed($0.domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))) && ($0.name == "sessionid" || $0.name == "sessionid_ss") && !$0.value.isEmpty }
            DispatchQueue.main.async {
                var out: [String: Any] = ["running": self?.web != nil, "signedIn": signedIn]
                if let u = self?.user { out["user"] = u }
                reply(out, nil)
            }
        }
    }

    // MARK: search / profile / sound / hashtag data for ui.js

    /// Runs one of tiktok-page.js's allow-listed requests (window.__ghostTTApi: search, suggestions, profile, sound and
    /// hashtag pages) inside the hidden TikTok page, through TikTok's own request signer. The page returns compact
    /// JSON (a few KB); nothing else about the page comes back.
    private func api(_ body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        guard let kind = body["kind"] as? String, kind.count < 20 else { return reply(nil, "bad kind") }
        let params = (body["params"] as? [String: Any]) ?? [:]
        if web == nil { start() }
        idleTimer?.invalidate(); idleTimer = nil
        guard let wv = web else { return reply(nil, "TikTok isn't running") }
        // the page script may not be in place yet (the page is still loading): try again for a while
        func attempt(_ n: Int) {
            wv.callAsyncJavaScript(
                "if (!window.__ghostTTApi) return { notReady: true }; return await window.__ghostTTApi(kind, params);",
                arguments: ["kind": kind, "params": params], in: nil, in: .page
            ) { [weak self] result in
                guard let self, self.web === wv else { return reply(nil, "stopped") }
                switch result {
                case .success(let value):
                    if let d = value as? [String: Any], d["notReady"] as? Bool == true, n < 20 {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { attempt(n + 1) }
                        return
                    }
                    reply(value, nil)
                case .failure(let error):
                    // a reload (sign-in, a fresh feed) cancels the call: once more after the new page is up
                    if n < 3 { DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { attempt(n + 4) }; return }
                    reply(nil, error.localizedDescription)
                }
            }
        }
        attempt(0)
    }

    // MARK: video / picture bytes for ui.js

    /// A TikTok share link from a chat: follow its redirects (the session only follows them within TikTok's hosts)
    /// and answer the final URL, so ui.js can read the video id. Nothing but the URL goes back.
    private func resolve(_ body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        guard let text = body["url"] as? String, text.count < 300, let url = URL(string: text), url.scheme == "https",
              let h = url.host, Self.allowed(h) else { return reply(nil, "unsupported link") }
        var request = URLRequest(url: url, timeoutInterval: 12)
        request.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("bytes=0-2047", forHTTPHeaderField: "Range") // only the address matters, not the page
        session.dataTask(with: request) { _, response, error in
            DispatchQueue.main.async {
                if let final = response?.url, final.scheme == "https", let fh = final.host, Self.allowed(fh) { return reply(["url": final.absoluteString], nil) }
                reply(nil, error?.localizedDescription ?? "no redirect")
            }
        }.resume()
    }

    private func fetch(_ body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        guard let text = body["url"] as? String, let url = URL(string: text), url.scheme == "https", let h = url.host, Self.allowed(h) else {
            return reply(nil, "unsupported host")
        }
        WKWebsiteDataStore.default().httpCookieStore.getAllCookies { [weak self] cookies in
            guard let self else { return reply(nil, "gone") }
            var request = URLRequest(url: url)
            request.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")
            request.setValue("https://www.tiktok.com/", forHTTPHeaderField: "Referer")
            // the cookies a browser would send to this host (the video CDN is under .tiktok.com: 403 without them)
            let host = h.lowercased()
            let matching = cookies.filter { c in
                let d = c.domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
                return Self.allowed(d) && (host == d || host.hasSuffix("." + d))
            }
            if let c = HTTPCookie.requestHeaderFields(with: matching)["Cookie"], !c.isEmpty { request.setValue(c, forHTTPHeaderField: "Cookie") }
            // at most maxChunk per answer: ui.js asks for the next Range itself
            var start = 0, end = Self.maxChunk - 1
            if let r = body["range"] as? String, r.hasPrefix("bytes=") {
                let parts = r.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
                start = max(0, Int(parts.first ?? "") ?? 0)
                let asked = parts.count > 1 ? Int(parts[1]) : nil
                end = min(asked ?? Int.max, start + Self.maxChunk - 1)
            }
            let range = "bytes=\(start)-\(end)"
            request.setValue(range, forHTTPHeaderField: "Range")
            self.session.dataTask(with: request) { data, response, error in
                let http = response as? HTTPURLResponse
                DispatchQueue.main.async {
                    if let error { return reply(nil, error.localizedDescription) }
                    guard let http, (200..<300).contains(http.statusCode), let data else { return reply(nil, "status \(http?.statusCode ?? 0)") }
                    guard data.count <= Self.maxChunk + 65536 else { return reply(nil, "too large") }
                    reply([
                        "status": http.statusCode,
                        "type": http.value(forHTTPHeaderField: "Content-Type") ?? "",
                        "range": http.value(forHTTPHeaderField: "Content-Range") ?? "",
                        "body": data.base64EncodedString(),
                    ], nil)
                }
            }.resume()
        }
    }

    /// Redirects only to allowed hosts (the CDN hops between its own edges).
    private final class RedirectGuard: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            guard let h = request.url?.host, request.url?.scheme == "https", GhostTikTok.allowed(h) else { return completionHandler(nil) }
            completionHandler(request)
        }
    }

    // MARK: sign in / out

    private func signIn() {
        start()
        guard let wv = web, let host, signInSheet == nil else { return }
        let vc = UIViewController()
        vc.title = "Sign in to TikTok"
        vc.view.backgroundColor = .black
        wv.removeFromSuperview()
        wv.frame = vc.view.bounds
        wv.isUserInteractionEnabled = true
        wv.alpha = 1
        vc.view.addSubview(wv)
        vc.navigationItem.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .done, target: self, action: #selector(signInDone))
        let nav = UINavigationController(rootViewController: vc)
        nav.modalPresentationStyle = .fullScreen
        nav.overrideUserInterfaceStyle = .dark
        signInSheet = nav
        wv.load(URLRequest(url: Self.loginURL))
        host.present(nav, animated: true)
    }

    @objc private func signInDone() {
        guard let nav = signInSheet else { return }
        signInSheet = nil
        nav.dismiss(animated: true) { [weak self] in
            guard let self, let wv = self.web, let host = self.host else { return }
            wv.removeFromSuperview()
            wv.isUserInteractionEnabled = false
            wv.alpha = 0.01
            wv.frame = host.view.bounds
            host.view.insertSubview(wv, at: 0)
            wv.load(URLRequest(url: Self.feedURL))
            self.send("reset", ["reason": "signIn"])
            self.refreshStatus()
        }
    }

    private func signOut(reply: @escaping (Any?, String?) -> Void) {
        stop()
        dm?.stop()
        vp?.stop()
        user = nil
        let store = WKWebsiteDataStore.default()
        store.fetchDataRecords(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes()) { records in
            let tiktok = records.filter { r in r.displayName.lowercased().contains("tiktok") || r.displayName.lowercased().contains("ttwstatic") || r.displayName.lowercased().contains("byteoversea") }
            store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), for: tiktok) {
                DispatchQueue.main.async { reply(true, nil) }
            }
        }
    }

    // MARK: navigation: the hidden page stays on TikTok; app links (snssdk://, tiktok://) never open

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url, let scheme = url.scheme?.lowercased() else { return decisionHandler(.cancel) }
        if scheme == "about" || scheme == "blob" || scheme == "data" { return decisionHandler(.allow) }
        guard scheme == "https" || scheme == "http" else { return decisionHandler(.cancel) }
        // signing in may pass through Apple / Facebook pages; the hidden feed never leaves TikTok
        if signInSheet != nil { return decisionHandler(.allow) }
        if navigationAction.targetFrame?.isMainFrame == false { return decisionHandler(.allow) }
        decisionHandler(Self.allowed(url.host ?? "") ? .allow : .cancel)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // iOS closed the TikTok page (memory): load it again only if the tab is still in use
        if webView === web, idleTimer == nil { webView.load(URLRequest(url: Self.feedURL)) }
    }

    /// WKUserContentController keeps its handlers strongly: a weak hop so stop() can free everything.
    private final class WeakHandler: NSObject, WKScriptMessageHandler {
        weak var target: WKScriptMessageHandler?
        init(_ target: WKScriptMessageHandler) { self.target = target }
        func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) { target?.userContentController(c, didReceive: m) }
    }
}
