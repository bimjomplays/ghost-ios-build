import UIKit
import WebKit

/// TikTok messages in Ghost's TikTok tab (ui.js "TikTok messages", page script ghost/tiktok-dm-page.js).
///
/// TikTok's phone website has no chats, so this is a third, hidden WKWebView that loads the *desktop* site's
/// https://www.tiktok.com/messages (desktop Safari user agent, desktop content mode, a desktop-sized frame nobody sees).
/// It shares the default website data store, so the TikTok sign-in from the TikTok tab is the same one.
/// ghost-tiktok-dm.js reads TikTok's own page as it renders and posts snapshots here; they are forwarded to ui.js in
/// the darkmobile world only (never Snapchat's page, never logged). Sending drives TikTok's own message box.
///
/// It exists only while the Messages screens are in use: "dmActive" off starts a 2-minute timer, then everything is
/// torn down. "dmStop" (Messages or the TikTok tab switched off, sign-out) tears it down at once.
final class GhostTikTokDM: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    static let messagesURL = URL(string: "https://www.tiktok.com/messages")!
    static let userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15"
    /// the desktop messages page lays out the list and the chat side by side from about 1000 px
    static let pageSize = CGSize(width: 1280, height: 900)

    private weak var host: UIViewController?
    private weak var ghost: WKWebView?
    private var web: WKWebView?
    private var sheet: UIViewController?
    private var idleTimer: Timer?
    private var lastSnap: [String: Any]?
    /// sends TikTok's page is still working on: tearing the page down under one could leave it unknown whether the
    /// message went out, so stop() waits for them (a few seconds at most)
    private var sendsInFlight = 0
    private var stopWhenIdle = false

    init(host: UIViewController, ghost: WKWebView) {
        self.host = host
        self.ghost = ghost
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(background), name: UIApplication.didEnterBackgroundNotification, object: nil)
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    func handle(_ body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        switch body["cmd"] as? String ?? "" {
        case "dmStart": start(); reply(lastSnap ?? ["state": "loading"], nil)
        case "dmActive": setActive(body["on"] as? Bool == true); reply(true, nil)
        case "dmStop": stop(); reply(true, nil)
        case "dmState": reply(["running": web != nil, "snap": lastSnap ?? ["state": web == nil ? "stopped" : "loading"]], nil)
        case "dmOpen":
            call("return await window.__ghostDMOpen(id, name);", ["id": body["id"] as? String ?? "", "name": body["name"] as? String ?? ""], reply: reply)
        case "dmSend":
            guard let id = body["id"] as? String, let text = body["text"] as? String, let rid = body["rid"] as? String, !rid.isEmpty,
                  !text.isEmpty, text.count <= 6000 else { return reply(nil, "bad send") }
            sendsInFlight += 1
            call("return await window.__ghostDMSend(id, name, text, rid);", ["id": id, "name": body["name"] as? String ?? "", "text": text, "rid": rid]) { [weak self] value, error in
                reply(value, error)
                guard let self else { return }
                self.sendsInFlight = max(0, self.sendsInFlight - 1)
                if self.sendsInFlight == 0 && self.stopWhenIdle { self.stop() }
            }
        case "dmLeave":
            call("return window.__ghostDMViewing ? window.__ghostDMViewing(false) : false;", [:], reply: reply)
        case "dmOlder":
            call("return window.__ghostDMOlder ? window.__ghostDMOlder() : false;", [:], reply: reply)
        case "dmShow": show(); reply(true, nil)
        default: reply(nil, "unknown dm command")
        }
    }

    private func start() {
        idleTimer?.invalidate(); idleTimer = nil
        if web != nil { return }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.defaultWebpagePreferences.preferredContentMode = .desktop
        config.mediaTypesRequiringUserActionForPlayback = .all
        let ucc = WKUserContentController()
        if let url = Bundle.main.url(forResource: "ghost-tiktok-dm", withExtension: "js"), let js = try? String(contentsOf: url, encoding: .utf8) {
            ucc.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        }
        ucc.add(WeakHandler(self), name: "ghostttdm")
        config.userContentController = ucc
        let wv = WKWebView(frame: CGRect(origin: .zero, size: Self.pageSize), configuration: config)
        wv.customUserAgent = Self.userAgent
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.isUserInteractionEnabled = false
        wv.alpha = 0.01 // never shows through Ghost (WebKit still treats it as on screen, so its timers keep running)
        if #available(iOS 16.4, *) { wv.isInspectable = true }
        host?.view.insertSubview(wv, at: 0)
        web = wv
        // pictures and video never load in this page: Ghost fetches the avatars it shows itself
        let rules = """
        [{"trigger":{"url-filter":".*","resource-type":["image","media"]},"action":{"type":"block"}}]
        """
        guard let store = WKContentRuleListStore.default() else { wv.load(URLRequest(url: Self.messagesURL)); return }
        store.compileContentRuleList(forIdentifier: "ghost-tiktok-dm-quiet", encodedContentRuleList: rules) { [weak self] list, _ in
            DispatchQueue.main.async {
                guard let self, let wv = self.web else { return }
                if let list { wv.configuration.userContentController.add(list) }
                wv.load(URLRequest(url: Self.messagesURL))
            }
        }
    }

    func stop() {
        idleTimer?.invalidate(); idleTimer = nil
        if sendsInFlight > 0 && web != nil {
            // a message is being sent: finish that first (the page answers within ~10 s), then tear down
            stopWhenIdle = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
                guard let self, self.stopWhenIdle else { return }
                self.sendsInFlight = 0
                self.stop()
            }
            return
        }
        stopWhenIdle = false
        if sheet != nil { sheet?.dismiss(animated: false); sheet = nil }
        lastSnap = nil
        guard let wv = web else { return }
        wv.stopLoading()
        wv.navigationDelegate = nil
        wv.uiDelegate = nil
        wv.configuration.userContentController.removeScriptMessageHandler(forName: "ghostttdm")
        wv.configuration.userContentController.removeAllUserScripts()
        wv.removeFromSuperview()
        web = nil
    }

    private func setActive(_ on: Bool) {
        idleTimer?.invalidate(); idleTimer = nil
        if on { start(); return }
        idleTimer = Timer.scheduledTimer(withTimeInterval: 120, repeats: false) { [weak self] _ in self?.stop() }
    }

    @objc private func background() {
        if web != nil && sheet == nil { setActive(false) }
    }

    /// Runs one of the page script's functions; waits (a few seconds) for the script while the page is loading.
    private func call(_ js: String, _ args: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        if web == nil { start() }
        idleTimer?.invalidate(); idleTimer = nil
        guard let wv = web else { return reply(nil, "not running") }
        func attempt(_ n: Int) {
            wv.callAsyncJavaScript("if (!window.__ghostDMSend) return { notReady: true };\n" + js, arguments: args, in: nil, in: .page) { [weak self] result in
                guard let self, self.web === wv else { return reply(nil, "stopped") }
                switch result {
                case .success(let value):
                    if let d = value as? [String: Any], d["notReady"] as? Bool == true {
                        if n < 30 { DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { attempt(n + 1) } }
                        else { reply(nil, "TikTok's messages page didn't load") }
                        return
                    }
                    reply(value, nil)
                case .failure(let error):
                    reply(nil, error.localizedDescription)
                }
            }
        }
        attempt(0)
    }

    // MARK: page -> ui.js

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.webView === web, let body = message.body as? [String: Any], body["type"] as? String == "dm",
              let snap = body["snap"] as? [String: Any] else { return }
        lastSnap = snap
        guard let data = try? JSONSerialization.data(withJSONObject: [snap]), let json = String(data: data, encoding: .utf8) else { return }
        ghost?.ghostEval("window.__ghostTikTok && window.__ghostTikTok.dm && window.__ghostTikTok.dm(\(json)[0])")
    }

    // MARK: show the page itself (TikTok asks to verify, or something only its own page can do)

    private func show() {
        start()
        guard let wv = web, let host, sheet == nil else { return }
        let vc = UIViewController()
        vc.title = "TikTok"
        vc.view.backgroundColor = .black
        wv.removeFromSuperview()
        wv.frame = vc.view.bounds
        wv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        wv.isUserInteractionEnabled = true
        wv.alpha = 1
        vc.view.addSubview(wv)
        vc.navigationItem.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .done, target: self, action: #selector(showDone))
        let nav = UINavigationController(rootViewController: vc)
        nav.modalPresentationStyle = .fullScreen
        nav.overrideUserInterfaceStyle = .dark
        sheet = nav
        host.present(nav, animated: true)
    }

    @objc private func showDone() {
        guard let nav = sheet else { return }
        sheet = nil
        nav.dismiss(animated: true) { [weak self] in
            guard let self, let wv = self.web, let host = self.host else { return }
            wv.removeFromSuperview()
            wv.autoresizingMask = []
            wv.isUserInteractionEnabled = false
            wv.alpha = 0.01
            wv.frame = CGRect(origin: .zero, size: Self.pageSize)
            host.view.insertSubview(wv, at: 0)
            wv.load(URLRequest(url: Self.messagesURL))
        }
    }

    // MARK: navigation: the hidden page stays on TikTok; app links never open

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url, let scheme = url.scheme?.lowercased() else { return decisionHandler(.cancel) }
        if scheme == "about" || scheme == "blob" || scheme == "data" { return decisionHandler(.allow) }
        guard scheme == "https" || scheme == "http" else { return decisionHandler(.cancel) }
        if sheet != nil { return decisionHandler(.allow) }
        if navigationAction.targetFrame?.isMainFrame == false { return decisionHandler(.allow) }
        decisionHandler(GhostTikTok.allowed(url.host ?? "") ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        nil // links TikTok opens in a new tab (profiles, videos) never open here
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // iOS closed the page (memory): load it again only while the Messages screens are in use
        if webView === web, idleTimer == nil { webView.load(URLRequest(url: Self.messagesURL)) }
    }

    private final class WeakHandler: NSObject, WKScriptMessageHandler {
        weak var target: WKScriptMessageHandler?
        init(_ target: WKScriptMessageHandler) { self.target = target }
        func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) { target?.userContentController(c, didReceive: m) }
    }
}
