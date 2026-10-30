import UIKit
import WebKit
import QuartzCore
import AVFoundation
import Vision
import CoreImage
import Photos
import UserNotifications
import Network

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // the notification delegate has to be in place before launching ends, or a tap on a banner that
        // cold-launches Ghost (an Apple push from the relay, or one of Ghost's own) never reaches it
        if WebViewController.ghostMode { _ = GhostNotifications.shared }
        return true
    }

    func application(_ application: UIApplication,
                     configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        UISceneConfiguration(name: "Default", sessionRole: session.role)
    }

    // Apple push device token (GhostPush.swift): only asked for when Ghost's profile has Push
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        GhostPush.didRegister(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        GhostPush.didFail(error: error)
    }
}

/// Sees every touch before the app does (without taking part in it), so the web view can be kept rendering at
/// 120Hz while a finger is on the screen and for a moment after (scroll momentum).
final class TouchWindow: UIWindow {
    static var onTouch: (() -> Void)?
    override func sendEvent(_ event: UIEvent) {
        if event.type == .touches { TouchWindow.onTouch?() }
        super.sendEvent(event)
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = TouchWindow(windowScene: scene)
        window.overrideUserInterfaceStyle = .dark
        let vc = WebViewController()
        window.rootViewController = vc
        window.makeKeyAndVisible()
        self.window = window
        // opened by a dltnpghost:// link (the notification relay's pairing QR, or an ntfy notification's click)
        if let url = options.urlContexts.first?.url { vc.handleOpenURL(url) }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        guard let url = URLContexts.first?.url else { return }
        (window?.rootViewController as? WebViewController)?.handleOpenURL(url)
    }
}

/// Snapchat Web in a full-screen WKWebView with the Dark Mobile scripts built in.
///
/// - hooks.js (presence, snap-clean, gifs-find) runs in the page's own world at document start. WKUserScript
///   injection isn't subject to Snapchat's CSP, so it always lands before Snapchat's bundle.
/// - ui.js (theme, GIF picker/display, gif-anim) runs in a private content world with gm-shim.js, which
///   backs the GM.* calls with the "dg" message handler below (settings in UserDefaults, Giphy downloads).
final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply, UIScrollViewDelegate {
    private static let home = URL(string: "https://www.snapchat.com/web")!
    /// Ghost (branch main): a completely different app UI (ghost-ui.js) over a hidden Snapchat Web page, fed by
    /// ghost-bridge.js. Set by the GhostMode Info.plist key; without it this is the Snapchat-look app.
    static let ghostMode = Bundle.main.object(forInfoDictionaryKey: "GhostMode") as? Bool ?? false
    // Logged out, Snapchat shows "Download Snapchat" instead of the login form when the page is narrower
    // than ~700px, and WKWebView has no "Request Desktop Website" (Safari's private wide-layout setting;
    // a width=980 viewport tag was ignored too). So outside Snapchat Web itself the web view is
    // loginWidth points wide and scaled down to fit; on /web it's the phone's real width. The Mac user
    // agent and compat.js keep Snapchat treating it as a desktop browser.
    private static let loginWidth: CGFloat = 820
    /// Snapchat Web's own sizes are a bit big on a phone; lay it out this much wider and scale it down
    /// (textscale.js then makes the text itself bigger again).
    private static let appScale: CGFloat = 0.8
    private static let tabBarColor = UIColor(red: 0x1e / 255, green: 0x1e / 255, blue: 0x1e / 255, alpha: 1)
    private static let tabBarHeight: CGFloat = 82
    private static let userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"
    private static let giphyHosts: Set<String> = ["media.giphy.com", "api.giphy.com", "api.bitmoji.com", "cf-st.sc-cdn.net", "images.bitmoji.com"] // + the Bitmoji sticker catalog and sticker images (Ghost editor: a Bitmoji sticker's pixels for the saved/sent picture)
    private static let background = UIColor(red: 0x12 / 255, green: 0x12 / 255, blue: 0x12 / 255, alpha: 1)

    private let world = WKContentWorld.world(name: "darkmobile")
    private var reduceTransparencyScript: WKUserScript?
    /// A dltnpghost:// link (notification pairing, "open this chat") waiting for ui.js: it asks with "takeOpenURL"
    /// when it starts, and is told directly when it's already running. Only the Ghost scheme, only two short shapes.
    private var pendingOpenURL: String?
    func handleOpenURL(_ url: URL) {
        guard url.scheme?.lowercased() == "dltnpghost", url.absoluteString.count <= 8192 else { return }
        let text = url.absoluteString
        pendingOpenURL = text
        guard let data = try? JSONSerialization.data(withJSONObject: [text]), let json = String(data: data, encoding: .utf8) else { return }
        webView?.ghostEval("window.__ghostOpenURL && window.__ghostOpenURL(\(json)[0])")
    }
    private var webView: WKWebView!
    // starts true because the app opens /web: laying the page out at the login width first and then
    // switching once the URL arrived sometimes left Snapchat's grid at a stale height, which also kept
    // glass.js from switching to the single-pane layout (desktop two-pane view, list cut off)
    private var inApp = true
    private var chatOpen = false
    private var storiesOpen = false
    private var cameraOpen = false
    private var previewOpen = false // taken-snap screen: Snapchat's own back button sits where our close-camera X is
    private let closeStoriesButton = UIButton(type: .system)
    private let tabBar = UIView()
    private weak var storiesButton: UIButton?
    private var urlObservation: NSKeyValueObservation?
    private var urlLog: [String] = []
    private var healed = false
    private var loaded = false
    private var lastShowBar: Bool?
    private var keyboardOverlap: CGFloat = 0
    private var lastGhostSafe = ""
    private var speakerOn = false
    private var keepAwake: GhostKeepAwake?
    /// Ghost: wifi <-> mobile data, or back online. ui.js (window.__ghostNetChanged) then tries what waits on ntfy.sh
    /// at once (queued bug reports): ntfy.sh's limits are per IP address, so another network can get through.
    private var pathMonitor: NWPathMonitor?
    private var pathKey: String?
    private func startPathMonitor() {
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            let up = path.status == .satisfied
            let key = "\(up)|\(path.usesInterfaceType(.wifi))|\(path.usesInterfaceType(.cellular))|\(path.usesInterfaceType(.wiredEthernet))"
            DispatchQueue.main.async {
                guard let self else { return }
                let first = self.pathKey == nil
                let changed = self.pathKey != key
                self.pathKey = key
                if !first && changed && up {
                    self.webView?.ghostEval("window.__ghostNetChanged && window.__ghostNetChanged()")
                }
            }
        }
        monitor.start(queue: DispatchQueue(label: "com.dltnp.ghost.path"))
        pathMonitor = monitor
    }
    // Ghost's built-in photo/gallery picker (composer's gallery button): PhotoKit behind a WKURLSchemeHandler,
    // registered on the config below before the web view exists. nil outside Ghost mode.
    private var photoPicker: GhostPhotoPicker?
    private var gallery: GhostGallery?
    private var vault: GhostVault?
    private var notifications: GhostNotifications?
    private var tiktok: GhostTikTok? // the TikTok tab's hidden TikTok page (TikTokFeed.swift), created on first use
    private lazy var context = GhostContext()
    // The app switcher cover shows Ghost's own logo - the same picture as the Home Screen icon the user picked
    // (Settings > Appearance > App Icon), as a rounded app-icon tile - instead of the ghost emoji.
    private let shieldLogo = UIImageView()
    private lazy var shield: UIView = {
        let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
        self.shieldLogo.contentMode = .scaleAspectFill
        self.shieldLogo.clipsToBounds = true
        self.shieldLogo.layer.cornerRadius = 22
        self.shieldLogo.layer.cornerCurve = .continuous
        self.shieldLogo.translatesAutoresizingMaskIntoConstraints = false
        blur.contentView.addSubview(self.shieldLogo)
        NSLayoutConstraint.activate([self.shieldLogo.centerXAnchor.constraint(equalTo: blur.contentView.centerXAnchor),
                                     self.shieldLogo.centerYAnchor.constraint(equalTo: blur.contentView.centerYAnchor),
                                     self.shieldLogo.widthAnchor.constraint(equalToConstant: 96),
                                     self.shieldLogo.heightAnchor.constraint(equalToConstant: 96)])
        return blur
    }()
    /// "GhostLogo" + the variant of the current app icon ("AppIconBerry" -> "GhostLogoBerry"); the default icon -> "GhostLogo".
    private func currentShieldLogo() -> UIImage? {
        let alt = UIApplication.shared.alternateIconName ?? ""
        let variant = alt.hasPrefix("AppIcon") ? String(alt.dropFirst("AppIcon".count)) : ""
        return UIImage(named: "GhostLogo" + variant) ?? UIImage(named: "GhostLogo")
    }
    /// Ghost's privacy shield (Settings > Chats): covers the app while it's in the app switcher or the screen is
    /// being recorded / mirrored. (iOS gives apps no way to block a plain screenshot.)
    // willResignActive fires while applicationState is still .active (so reading the state there never showed
    // the shield - the 2026-09-27 bug); the notification itself says where we're going.
    private var shieldGoingInactive = false
    @objc private func shieldResign() { shieldGoingInactive = true; updateShield() }
    @objc private func shieldActive() { shieldGoingInactive = false; updateShield(); refreshReduceTransparency() }
    /// WebKit on iOS has no prefers-reduced-transparency media query. Read-only Ghost UI signal only.
    @objc private func refreshReduceTransparency() {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { [weak self] in self?.refreshReduceTransparency() }
            return
        }
        guard Self.ghostMode, let web = webView else { return }
        let source = "window.__ghostReduceTransparency = \(UIAccessibility.isReduceTransparencyEnabled);"
        if let previous = reduceTransparencyScript, previous.source != source {
            // Refresh only our document-start signal, retaining every other script and its injection order.
            let replacement = WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: world)
            let controller = web.configuration.userContentController
            let updated = controller.userScripts.map { $0 === previous ? replacement : $0 }
            controller.removeAllUserScripts()
            updated.forEach { controller.addUserScript($0) }
            reduceTransparencyScript = replacement
        }
        web.evaluateJavaScript(source + " dispatchEvent(new Event('ghostReduceTransparency'));", in: nil, in: world)
    }
    @objc private func updateShield() {
        let on = SettingsStore.shared.bool("privacyShield")
        let inactive = shieldGoingInactive || UIApplication.shared.applicationState != .active
        let captured = view.window?.windowScene?.screen.isCaptured ?? UIScreen.main.isCaptured
        let show = on && (inactive || captured)
        if show {
            // on the window (above the tab bar, launch picture and any sheet), not just this view
            let host: UIView = view.window ?? view
            shieldLogo.image = currentShieldLogo()
            if shield.superview !== host { shield.removeFromSuperview(); shield.frame = host.bounds; shield.autoresizingMask = [.flexibleWidth, .flexibleHeight]; host.addSubview(shield) }
            host.bringSubviewToFront(shield)
        } else {
            shield.removeFromSuperview()
        }
    }
    /// Save a photo/video to the camera roll (Ghost's "Save to Photos").
    private func saveToPhotos(_ data: Data, video: Bool, done: @escaping (String?) -> Void) {
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            guard status == .authorized || status == .limited else { return DispatchQueue.main.async { done("Photos access is off for Ghost") } }
            let ext = video ? "mp4" : "jpg"
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("ghost-\(UUID().uuidString).\(ext)")
            do { try data.write(to: url) } catch { return DispatchQueue.main.async { done(error.localizedDescription) } }
            PHPhotoLibrary.shared().performChanges({
                if video { PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: url) }
                else { PHAssetChangeRequest.creationRequestForAssetFromImage(atFileURL: url) }
            }) { ok, error in
                try? FileManager.default.removeItem(at: url)
                DispatchQueue.main.async { done(ok ? nil : (error?.localizedDescription ?? "couldn't save")) }
            }
        }
    }
    /// Ghost calls: loudspeaker vs earpiece. A voice-chat session with defaultToSpeaker plus the port override.
    private func applySpeaker() throws {
        // Only the output route: changing the category/mode under WebKit's call audio cut the other side off entirely
        // (device 2026-09-27). With the real microphone open, WebKit's session is already play-and-record.
        try AVAudioSession.sharedInstance().overrideOutputAudioPort(speakerOn ? .speaker : .none)
    }
    // edge swipe = back; off in an open chat, where gestures.js drags the chat itself (interactive, like the app)
    private weak var edgeBack: UIScreenEdgePanGestureRecognizer?
    // smoothness: 120Hz while touching, and a picture of the last chat list shown at launch
    private var displayLink: CADisplayLink?
    private var fastUntil: CFTimeInterval = 0
    private let launchCover = UIImageView()
    private var launchCoverChecks = 0
    private static var launchPictureURL: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?.appendingPathComponent("launch-picture.png")
    }
    /// The settings sheet's "Clear launch picture" action row.
    static func clearLaunchPicture() {
        guard let url = launchPictureURL else { return }
        try? FileManager.default.removeItem(at: url)
    }
    // Tap the status bar / safe-area-top strip to scroll the visible chat or chat list to the top. Only
    // covers that strip (see viewDidLayoutSubviews: it never reaches down to where the page's own header
    // sits, so it can't block the page's own header taps).
    private let topTapView = UIView()

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Self.background

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.defaultWebpagePreferences.preferredContentMode = .mobile
        let scripts = config.userContentController
        let chromeMode = UserDefaults.standard.object(forKey: "chromeMode") as? Bool ?? true
        scripts.addUserScript(WKUserScript(source: "window.__dgChromeUA = \(chromeMode);\n" + Self.resource("compat"), injectionTime: .atDocumentStart,
                                           forMainFrameOnly: false, in: .page))
        // Settings, page world: a small user script so any page-world script can read the merged settings
        // dictionary via window.__dgSettingsInit. Read-only here - the darkmobile world (below) is the one
        // that gets live updates through window.__dgApplySettings whenever the sheet changes something.
        scripts.addUserScript(WKUserScript(source: "window.__dgSettingsInit = \(SettingsStore.shared.mergedJSON);",
                                           injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        scripts.addUserScript(WKUserScript(source: Self.resource("viewport"), injectionTime: .atDocumentStart,
                                           forMainFrameOnly: true, in: .page))
        scripts.addUserScript(WKUserScript(source: Self.resource("recorder"), injectionTime: .atDocumentStart,
                                           forMainFrameOnly: true, in: .page))
        scripts.addUserScript(WKUserScript(source: Self.resource("camhook"), injectionTime: .atDocumentStart,
                                           forMainFrameOnly: true, in: .page))
        scripts.addUserScript(WKUserScript(source: Self.resource("hooks"), injectionTime: .atDocumentStart,
                                           forMainFrameOnly: true, in: .page))
        if Self.ghostMode { // reaches Snapchat's own app state before Snapchat's scripts run
            scripts.addUserScript(WKUserScript(source: Self.resource("ghost-bridge"), injectionTime: .atDocumentStart,
                                               forMainFrameOnly: true, in: .page))
        }
        // Settings, darkmobile world: window.__dgSettingsInit first, then settings.js right after gm-shim so
        // every later script in this list can call dgSetting()/dgOnSettings()/dgSetSetting()/dgOpenSettings()
        // from the moment it runs. appmenu.js (after header.js) wires header.js's decorative "..." button to
        // dgOpenSettings().
        // one script, in this order: settings first, then the page scripts, then the stylesheets (an array + joined, not a
        // long `+` chain: Swift's type checker can give up on those)
        var worldScripts: [String]
        if Self.ghostMode {
            // Ghost: only the plumbing + the new UI (no Snapchat restyling at all). __ghostScale lets the UI undo the
            // page scale, so 1 CSS px of Ghost = 1 point on the phone.
            worldScripts = ["window.__dgSettingsInit = \(SettingsStore.shared.mergedJSON); window.__ghostScale = \(Double(Self.appScale)); window.__ghostApp = \(Self.appInfoJSON);"]
            let accessibility = WKUserScript(source: "window.__ghostReduceTransparency = \(UIAccessibility.isReduceTransparencyEnabled);",
                                             injectionTime: .atDocumentStart, forMainFrameOnly: true, in: world)
            reduceTransparencyScript = accessibility
            scripts.addUserScript(accessibility)
            worldScripts += ["gm-shim", "settings", "bridge", "perf", "ghost-ui"].map { Self.resource($0) }
        } else {
            worldScripts = ["window.__dgSettingsInit = \(SettingsStore.shared.mergedJSON);"]
            worldScripts += ["gm-shim", "settings", "ui", "bridge", "theme", "textscale", "header", "appmenu", "stories", "camera", "fit", "touch", "chat", "gestures", "qol", "perf", "streaks"].map { Self.resource($0) }
            worldScripts += ["newchat", "camera", "stories", "header", "snap", "chat", "gestures", "gifs", "theme", "qol"].map { Self.cssScript($0) }
        }
        scripts.addUserScript(WKUserScript(source: worldScripts.joined(separator: "\n"),
                                           injectionTime: .atDocumentStart, forMainFrameOnly: true, in: world))
        scripts.addScriptMessageHandler(self, contentWorld: world, name: "dg")

        // Must be registered on the configuration before the WKWebView below is created (WKURLSchemeHandler
        // docs: setURLSchemeHandler(_:forURLScheme:) has no effect on a web view that already exists).
        if Self.ghostMode {
            let picker = GhostPhotoPicker(presenter: self)
            config.setURLSchemeHandler(picker, forURLScheme: GhostPhotoPicker.scheme)
            photoPicker = picker
            let lib = GhostGallery(presenter: self, picker: picker)
            picker.gallery = lib
            gallery = lib
            let eyes = GhostVault(presenter: self)
            config.setURLSchemeHandler(eyes, forURLScheme: GhostVault.scheme)
            vault = eyes
            notifications = GhostNotifications.shared
        }

        Self.preferHighRefresh(config.preferences)
        webView = WKWebView(frame: .zero, configuration: config)
        webView.customUserAgent = Self.userAgent
        photoPicker?.attach(to: webView)
        gallery?.attach(to: webView)
        vault?.attach(to: webView)
        notifications?.attach(to: webView)
        if Self.ghostMode { tiktok = GhostTikTok(host: self, ghost: webView) }
        // lets Safari's Web Inspector protocol (ios-webkit-debug-proxy on the PC, phone on USB) attach to the page
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        // Draw the page at 2x instead of the screen's 3x. iOS closes Ghost's web process at ~1.5 GB, Snapchat's own web app
        // already takes ~0.95 GB, and opening a chat briefly added 300-450 MB - all of it graphics memory (layer and
        // canvas backing stores), which scales with pixels: 2x needs 4/9 of it (measured on the phone 2026-09-29).
        // WKWebView SPI (WKWebViewPrivate.h, ios 16.4+): KVC reaches -_setOverrideDeviceScaleFactor:.
        if webView.responds(to: NSSelectorFromString("_setOverrideDeviceScaleFactor:")) {
            webView.setValue(NSNumber(value: 2.0), forKey: "overrideDeviceScaleFactor")
        }
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.isOpaque = false
        webView.backgroundColor = Self.background
        webView.scrollView.backgroundColor = Self.background
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        // the page is a fixed app layout: only its inner lists scroll, the page itself never rubber-bands
        webView.scrollView.bounces = false
        webView.scrollView.alwaysBounceVertical = false
        webView.scrollView.showsVerticalScrollIndicator = false
        webView.scrollView.showsHorizontalScrollIndicator = false
        webView.allowsLinkPreview = false

        webView.scrollView.delegate = self
        view.addSubview(webView)
        topTapView.backgroundColor = .clear
        topTapView.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(scrollToTopTapped)))
        view.addSubview(topTapView)
        // Launch picture: the chat list as it looked when the app was last left, shown until Snapchat has drawn
        // the real one (a cold start otherwise shows an empty dark screen for a few seconds).
        // a picture saved by an older build shows the old design (device report: Ghost's launch showed the previous
        // look): only use it if this same build saved it
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
        if UserDefaults.standard.string(forKey: "launchPictureBuild") != build { Self.clearLaunchPicture() }
        if SettingsStore.shared.bool("launchPicture"), let url = Self.launchPictureURL, let picture = UIImage(contentsOfFile: url.path) {
            launchCover.image = picture
            launchCover.contentMode = .scaleToFill
            launchCover.isUserInteractionEnabled = true // just a picture: taps wait for the real page
            view.addSubview(launchCover)
        }
        NotificationCenter.default.addObserver(self, selector: #selector(saveLaunchPicture),
                                               name: UIApplication.willResignActiveNotification, object: nil)
        if Self.ghostMode { // privacy shield: nothing readable in the app switcher or in a screen recording
            NotificationCenter.default.addObserver(self, selector: #selector(shieldResign),
                                                   name: UIApplication.willResignActiveNotification, object: nil)
            NotificationCenter.default.addObserver(self, selector: #selector(shieldResign),
                                                   name: UIApplication.didEnterBackgroundNotification, object: nil)
            NotificationCenter.default.addObserver(self, selector: #selector(shieldActive),
                                                   name: UIApplication.didBecomeActiveNotification, object: nil)
            NotificationCenter.default.addObserver(self, selector: #selector(updateShield),
                                                   name: UIScreen.capturedDidChangeNotification, object: nil)
            NotificationCenter.default.addObserver(self, selector: #selector(refreshReduceTransparency),
                                                   name: UIAccessibility.reduceTransparencyStatusDidChangeNotification, object: nil)
        }
        if Self.ghostMode { keepAwake = GhostKeepAwake() }
        if Self.ghostMode { startPathMonitor() }
        TouchWindow.onTouch = { [weak self] in self?.renderFast(for: 2.5) }
        buildTabBar()
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged(_:)),
                                               name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged(_:)),
                                               name: UIResponder.keyboardWillHideNotification, object: nil)
        urlObservation = webView.observe(\.url, options: [.initial, .new]) { [weak self] _, _ in
            self?.updateLayoutMode()
        }
        removeInputAccessory()
        // (the page is loaded from viewDidLayoutSubviews, once the web view has its real size)

        let back = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(edgeSwipe(_:)))
        edgeBack = back
        back.isEnabled = !Self.ghostMode // Ghost has its own swipe-back
        back.edges = .left
        view.addGestureRecognizer(back)

        // Settings must always be reachable, so this is never gated by a setting: three-finger tap opens the
        // native settings sheet (diagnostics moved into the sheet's "Diagnostics" action row).
        let openSettingsGesture = UITapGestureRecognizer(target: self, action: #selector(threeFingerTap))
        openSettingsGesture.numberOfTouchesRequired = 3
        openSettingsGesture.cancelsTouchesInView = false
        view.addGestureRecognizer(openSettingsGesture)
    }

    /// Troubleshooting log that survives page loads: Documents/trail.txt (last 300 lines).
    private var trailLines: [String] = []
    private func trail(_ text: String) {
        let time = String(format: "%.2f", Date().timeIntervalSince1970.truncatingRemainder(dividingBy: 10000))
        trailLines.append("\(time) \(text)")
        if trailLines.count > 300 { trailLines.removeFirst(trailLines.count - 300) }
        if let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
            try? trailLines.joined(separator: "\n").write(to: dir.appendingPathComponent("trail.txt"), atomically: true, encoding: .utf8)
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        refreshReduceTransparency() // install the current value before the new document's scripts run
        trail("NATIVE page load started: \(webView.url?.absoluteString ?? "?")")
    }

    /// Page structure + sizes into Documents/<name>-<time>.html, readable from the PC over USB.
    private func dump(_ name: String, note: String = "") {
        let js = """
        (() => { const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(), c = getComputedStyle(e);
            return [e.tagName, e.className, Math.round(b.width), Math.round(b.height), c.position, c.display, c.height]; };
          const main = document.querySelector('main');
          return '<!-- ' + JSON.stringify({ innerWidth, innerHeight, client: [document.documentElement.clientWidth, document.documentElement.clientHeight],
            vv: window.visualViewport ? [visualViewport.width, visualViewport.height, visualViewport.scale] : null,
            html: r(document.documentElement), body: r(document.body), main: r(main),
            kids: main ? [...main.children].map(r) : [], layout: document.documentElement.className,
            errors: window.__dgErrors ?? [], media: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) }) + ' --> '
            + document.documentElement.outerHTML; })()
        """
        let native = "note [\(note)] chat \(chatOpen) stories \(storiesOpen) camera \(cameraOpen) kb \(keyboardOverlap) bounds \(webView.bounds) frame \(webView.frame) zoom \(webView.scrollView.zoomScale) content \(webView.scrollView.contentSize) urls \(urlLog)"
        webView.evaluateJavaScript(js) { result, error in
            guard let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
            let html = (result as? String) ?? "dump failed: \(String(describing: error))"
            let stamp = Int(Date().timeIntervalSince1970)
            try? ("<!-- " + native + " -->\n" + html).write(to: dir.appendingPathComponent("\(name)-\(stamp).html"),
                                                           atomically: true, encoding: .utf8)
        }
    }

    /// Three-finger tap: opens the native settings sheet.
    @objc private func threeFingerTap() {
        presentSettingsSheet()
    }

    /// Fires haptic feedback unless the "haptics" setting is off (checked live, not just at launch).
    private func haptic(_ style: UIImpactFeedbackGenerator.FeedbackStyle) {
        guard SettingsStore.shared.bool("haptics") else { return }
        UIImpactFeedbackGenerator(style: style).impactOccurred()
    }

    /// Tap the status bar / safe-area-top strip: scroll the visible chat or chat-list container to the top.
    @objc private func scrollToTopTapped() {
        guard SettingsStore.shared.bool("scrollToTopTap") else { return }
        let js = """
        (() => {
          const isScrollable = (n) => n && /(auto|scroll)/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight + 2;
          let target = null;
          const cv = document.querySelector('[data-dg-column] ul[id^="cv-"]');
          if (cv) { for (let n = cv.parentElement; n; n = n.parentElement) { if (isScrollable(n)) { target = n; break; } } }
          else { target = document.querySelector('[data-dg-sidebar] .ReactVirtualized__Grid'); }
          if (target && target.scrollTo) target.scrollTo({ top: 0, behavior: 'smooth' });
        })();
        """
        webView.evaluateJavaScript(js, in: nil, in: world)
    }

    /// What the page sees (for troubleshooting without a Mac and Web Inspector). The settings sheet's
    /// "Diagnostics" action row; used to be the three-finger tap's own action.
    private func presentDiagnostics() {
        let js = """
        JSON.stringify({ url: location.href, innerWidth, screenWidth: screen.width,
          viewport: document.querySelector('meta[name="viewport"]')?.content ?? null,
          platform: navigator.platform, touchPoints: navigator.maxTouchPoints,
          hooks: document.documentElement.dataset.dgHooks ?? null, ua: navigator.userAgent,
          errors: window.__dgErrors ?? [], jsUA: navigator.userAgent.includes('Chrome/') ? 'chrome' : 'safari', rec: [typeof VideoEncoder, typeof AudioEncoder, typeof AudioData, typeof MediaStreamTrackProcessor], innerHeight, docHeight: document.documentElement.clientHeight,
          layout: document.documentElement.className,
          grid: document.querySelector('[data-dg-root]')?.getBoundingClientRect().height ?? null,
          urls: \(urlLog.description), inApp: \(inApp) }, null, 1)
        """
        // page structure for troubleshooting layout from the PC (Files > On My iPhone > Snapchat, or USB)
        webView.evaluateJavaScript("document.documentElement.outerHTML") { result, _ in
            guard let html = result as? String,
                  let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
            let stamp = Int(Date().timeIntervalSince1970)
            try? html.write(to: dir.appendingPathComponent("dom-\(stamp).html"), atomically: true, encoding: .utf8)
        }
        webView.evaluateJavaScript(js) { [weak self] result, error in
            let text = (result as? String) ?? error?.localizedDescription ?? "no result"
            let alert = UIAlertController(title: "Diagnostics", message: text, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Reload", style: .default) { _ in self?.webView.reload() })
            let chrome = UserDefaults.standard.object(forKey: "chromeMode") as? Bool ?? true
            alert.addAction(UIAlertAction(title: chrome ? "Turn Chrome mode off (then reopen the app)" : "Turn Chrome mode on (then reopen the app)",
                                          style: .default) { _ in UserDefaults.standard.set(!chrome, forKey: "chromeMode") })
            alert.addAction(UIAlertAction(title: "OK", style: .cancel))
            self?.present(alert, animated: true)
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let insets = view.safeAreaInsets
        // in a chat the strip under the message box (home indicator) matches the box's keyboard grey
        let colors = Self.themeColors()
        view.backgroundColor = chatOpen && inApp ? colors.composer : colors.background
        webView.backgroundColor = colors.background
        webView.scrollView.backgroundColor = colors.background
        tabBar.backgroundColor = colors.bar
        let showBar = inApp && !Self.ghostMode && !chatOpen && !storiesOpen && keyboardOverlap == 0
        if showBar != lastShowBar {
            lastShowBar = showBar
            trail("NATIVE bar \(showBar) inApp \(inApp) chat \(chatOpen) stories \(storiesOpen) camera \(cameraOpen) kb \(keyboardOverlap)")
        }
        topTapView.frame = CGRect(x: 0, y: 0, width: view.bounds.width, height: insets.top)
        closeStoriesButton.isHidden = Self.ghostMode || !cameraOpen || previewOpen // stories: Snapchat's own X (top right) and the edge swipe close them
        // camera: top left (Snapchat's own menu sits top right); stories: top right
        closeStoriesButton.frame = CGRect(x: cameraOpen ? 12 : view.bounds.width - 56, y: insets.top + 8, width: 44, height: 44)
        let barTotal = Self.tabBarHeight + insets.bottom
        tabBar.frame = CGRect(x: 0, y: view.bounds.height - (showBar ? barTotal : 0),
                              width: view.bounds.width, height: barTotal)
        tabBar.alpha = showBar ? 1 : 0
        // Ghost draws edge to edge (under the clock and the home indicator, like a real app) and pads its own
        // header/composer by the safe-area sizes it's given below; the Snapchat-look app keeps the inset area.
        let fullBleed = Self.ghostMode && inApp
        let area = fullBleed
            ? CGRect(x: 0, y: 0, width: view.bounds.width, height: view.bounds.height - keyboardOverlap)
            : CGRect(x: 0, y: insets.top, width: view.bounds.width,
                     height: (showBar ? tabBar.frame.minY
                                      : view.bounds.height - max(insets.bottom, keyboardOverlap)) - insets.top)
        if fullBleed {
            let safe = "\(Int(insets.top)),\(keyboardOverlap > 0 ? 0 : Int(insets.bottom))"
            if safe != lastGhostSafe {
                lastGhostSafe = safe
                let parts = safe.split(separator: ",")
                webView.evaluateJavaScript("document.documentElement.style.setProperty('--ghost-safe-t','\(parts[0])px');document.documentElement.style.setProperty('--ghost-safe-b','\(parts[1])px')", completionHandler: nil)
            }
        }
        let scale = inApp ? Self.appScale : min(1, area.width / Self.loginWidth)
        webView.transform = .identity
        webView.bounds = CGRect(x: 0, y: 0, width: area.width / scale, height: area.height / scale)
        webView.center = CGPoint(x: area.midX, y: area.midY)
        webView.transform = CGAffineTransform(scaleX: scale, y: scale)
        // Snapchat sizes its layout from the window when it starts. Loading while the web view was still
        // 0x0 (before this first layout pass) sometimes left it a fraction of the screen tall, stuck in
        // its two-pane desktop layout - so load only now, and poke it after every later size change.
        if launchCover.superview != nil { launchCover.frame = webView.frame }
        if !loaded, area.width > 0, area.height > 0 {
            loaded = true
            webView.load(URLRequest(url: Self.home))
            if launchCover.superview != nil { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.checkLaunchCover() } }
        } else if loaded {
            webView.evaluateJavaScript("dispatchEvent(new Event('resize'))", completionHandler: nil)
        }
    }

    /// The real app's bottom bar (Map, Chat, Camera, Stories, Spotlight), drawn to match its icons.
    /// Snapchat Web only has chats and stories, so Stories opens the web stories viewer and the rest are
    /// placeholders. Hidden on login pages, inside chats and while stories play.
    private func buildTabBar() {
        tabBar.backgroundColor = Self.tabBarColor
        let stack = UIStackView()
        stack.axis = .horizontal
        stack.distribution = .fillEqually
        stack.alignment = .center
        let icons: [(UIImage, Selector?)] = [
            (TabIcons.map, nil), (TabIcons.chat, nil), (TabIcons.camera, #selector(openCamera)),
            (TabIcons.stories(preview: nil), #selector(openStories)), (TabIcons.spotlight, nil),
        ]
        for (image, action) in icons {
            let button = UIButton(type: .custom)
            button.setImage(image, for: .normal)
            button.adjustsImageWhenHighlighted = action != nil
            if let action {
                button.addTarget(self, action: action, for: .touchUpInside)
                if action == #selector(openStories) { storiesButton = button }
            }
            button.heightAnchor.constraint(equalToConstant: 56).isActive = true
            stack.addArrangedSubview(button)
        }
        stack.translatesAutoresizingMaskIntoConstraints = false
        tabBar.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: tabBar.leadingAnchor, constant: 12),
            stack.trailingAnchor.constraint(equalTo: tabBar.trailingAnchor, constant: -12),
            stack.topAnchor.constraint(equalTo: tabBar.topAnchor),
            stack.heightAnchor.constraint(equalToConstant: Self.tabBarHeight),
        ])
        view.addSubview(tabBar)

        closeStoriesButton.setImage(UIImage(systemName: "xmark", withConfiguration:
            UIImage.SymbolConfiguration(pointSize: 18, weight: .bold)), for: .normal)
        closeStoriesButton.tintColor = .white
        closeStoriesButton.backgroundColor = UIColor(white: 0, alpha: 0.45)
        closeStoriesButton.layer.cornerRadius = 22
        closeStoriesButton.isHidden = true
        closeStoriesButton.addTarget(self, action: #selector(closeStories), for: .touchUpInside)
        view.addSubview(closeStoriesButton)
    }

    @objc private func closeStories() {
        webView.evaluateJavaScript("window.__dgCloseStories && window.__dgCloseStories()", in: nil, in: world)
    }

    /// Stories: stories.js opens the web viewer full screen (it lives in the pane the phone layout hides).
    // Keyboard: the page is a fixed full-height layout, so instead of letting WebKit scroll it (which, in
    // this scaled web view, pushed the content off the top), the web view itself ends at the keyboard and
    // Snapchat lays out in the space that's left - the message box sits right on top of the keyboard.
    @objc private func keyboardChanged(_ note: Notification) {
        var overlap: CGFloat = 0
        if note.name != UIResponder.keyboardWillHideNotification,
           let frame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue {
            overlap = max(0, view.bounds.maxY - view.convert(frame, from: nil).minY)
        }
        guard overlap != keyboardOverlap else { return }
        keyboardOverlap = overlap
        // Not animated (same reason as setChatOpen): animating a web view's size stretches its old picture until
        // the page has redrawn, which looked like the page jumping. The message box moves in one step; the strip
        // under it has the box's grey, so the keyboard slides in (or out) against the same colour.
        renderFast(for: 0.6)
        UIView.performWithoutAnimation {
            self.view.setNeedsLayout()
            self.view.layoutIfNeeded()
        }
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        if inApp, scrollView.contentOffset != .zero { scrollView.contentOffset = .zero }
    }

    /// Removes the bar iOS puts above the keyboard for web pages (previous / next arrows and the checkmark).
    private func removeInputAccessory() {
        guard let content = webView.scrollView.subviews.first(where: { String(describing: type(of: $0)).hasPrefix("WKContent") }),
              let base: AnyClass = object_getClass(content) else { return }
        let name = "\(NSStringFromClass(base))_DGNoAccessory"
        var sub: AnyClass? = NSClassFromString(name)
        if sub == nil, let made = objc_allocateClassPair(base, name, 0) {
            let block: @convention(block) (AnyObject) -> UIView? = { _ in nil }
            let sel = #selector(getter: UIResponder.inputAccessoryView)
            if let method = class_getInstanceMethod(UIView.self, sel) {
                class_addMethod(made, sel, imp_implementationWithBlock(block), method_getTypeEncoding(method))
            }
            objc_registerClassPair(made)
            sub = made
        }
        if let sub { object_setClass(content, sub) }
    }

    /// Swipe in from the left edge: back to the chat list (or out of stories), like the real app.
    @objc private func edgeSwipe(_ gesture: UIScreenEdgePanGestureRecognizer) {
        guard gesture.state == .ended, inApp,
              gesture.translation(in: view).x > 50 || gesture.velocity(in: view).x > 400 else { return }
        haptic(.light)
        webView.evaluateJavaScript("window.__dgBack && window.__dgBack()", in: nil, in: world)
    }

    /// Camera: camera.js opens Snapchat Web's camera (in the pane the phone layout hides) full screen.
    @objc private func openCamera() {
        haptic(.light)
        webView.becomeFirstResponder()
        webView.evaluateJavaScript("window.__dgOpenCamera ? window.__dgOpenCamera() : 'missing'", in: nil, in: world) { [weak self] result in
            if case .success(let value) = result, let text = value as? String, text != "ok" {
                let alert = UIAlertController(title: nil, message: "Couldn't open the camera (\(text)).", preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "OK", style: .default))
                self?.present(alert, animated: true)
            }
        }
    }

    @objc private func openStories() {
        haptic(.light)
        webView.becomeFirstResponder()
        webView.evaluateJavaScript("window.__dgOpenStories ? window.__dgOpenStories() : 'missing'",
                                   in: nil, in: world) { [weak self] result in
            if case .success(let value) = result, let text = value as? String, text != "ok" {
                let message = text == "none" ? "No stories to watch right now." : "Couldn't open stories (\(text))."
                let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "OK", style: .default))
                self?.present(alert, animated: true)
            }
        }
    }

    private func setChatOpen(_ open: Bool, force: Bool = false) {
        guard force || open != chatOpen else { return }
        chatOpen = open
        renderFast(for: 0.8) // the chat's slide-in / fade animation
        // Not animated: an animated bounds change stretches the web view's old picture to the new size for the
        // length of the animation while the page has already re-laid out underneath - on the phone that was the
        // "jumping flash" when opening a chat. chat.js keeps the chat pane hidden until the new size has settled.
        UIView.performWithoutAnimation {
            self.view.setNeedsLayout()
            self.view.layoutIfNeeded()
        }
    }

    /// Snapchat Web (/web) at the phone's own width; login and other snapchat.com pages laid out wide.
    private func updateLayoutMode() {
        guard let url = webView.url, let host = url.host?.lowercased() else { return }
        urlLog.append("\(host)\(url.path)")
        if urlLog.count > 8 { urlLog.removeFirst() }
        // Only Snapchat's own pages on www switch modes. Other hosts (accounts.snapchat.com, which a logged-in
        // start can pass through) keep the current mode, so the page doesn't get squeezed to the login
        // width and back while it loads - that left Snapchat stuck in its two-pane desktop layout.
        guard host == "www.snapchat.com" else { return }
        let now = url.path.hasPrefix("/web")
        guard now != inApp else { return }
        inApp = now
        view.setNeedsLayout()
        webView.evaluateJavaScript("window.__dgViewport && window.__dgViewport(\(now))", completionHandler: nil)
        // make sure Snapchat re-measures at the new size
        webView.evaluateJavaScript("setTimeout(() => dispatchEvent(new Event('resize')), 300)", completionHandler: nil)
    }

    /// Backup for the same problem: a few seconds after Snapchat Web loads, glass.js should have switched
    /// to the one-pane phone layout (html.dg-list / dg-chat). If it hasn't, reload once.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        refreshReduceTransparency() // document-start scripts may predate a system preference change
        lastGhostSafe = "" // a new page lost the safe-area sizes: send them again on the next layout
        view.setNeedsLayout()
        guard inApp else { return }
        for delay in [0.2, 0.9] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let web = self?.webView else { return }
                var b = web.bounds
                b.size.height -= 1
                web.bounds = b
                DispatchQueue.main.async { self?.view.setNeedsLayout() }
            }
        }
        for delay in [0.3, 1.0, 2.0] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.webView.evaluateJavaScript("dispatchEvent(new Event('resize'))", completionHandler: nil)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            guard let self, self.inApp, !self.healed, !Self.ghostMode else { return } // (Ghost doesn't use Snapchat's layout)
            let check = "document.documentElement.classList.contains('dg-list') || document.documentElement.classList.contains('dg-chat')"
            self.webView.evaluateJavaScript(check) { result, _ in
                guard (result as? Bool) == false else { return }
                self.dump("broken")
                self.healed = true
                self.urlLog.append("self-heal reload")
                // back to the chat list: a fresh load straight into a chat URL doesn't get the phone layout
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.webView.load(URLRequest(url: Self.home)) }
            }
        }
    }

    /// A bundled stylesheet as a script that adds it to the page.
    private static func cssScript(_ name: String) -> String {
        guard let url = Bundle.main.url(forResource: name, withExtension: "css"),
              let css = try? String(contentsOf: url, encoding: .utf8),
              let json = try? JSONSerialization.data(withJSONObject: [css]),
              let literal = String(data: json, encoding: .utf8) else { return "" }
        return "(() => { if (window.top !== window) return; const add = () => { if (!document.documentElement) return void setTimeout(add, 10);"
            + " const s = document.createElement('style'); s.textContent = \(literal)[0]; document.documentElement.appendChild(s); }; add(); })();"
    }

    /// Ghost's version and this phone ({version, build, model "iPhone15,2", os "17.5"}), sent with a bug report
    /// (ui.js section "Feedback")
    private static var appInfoJSON: String {
        var u = utsname()
        uname(&u)
        let model = withUnsafeBytes(of: u.machine) { raw in String(decoding: raw.prefix(while: { $0 != 0 }), as: UTF8.self) }
        let info: [String: String] = [
            "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
            "build": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "",
            "model": model,
            "os": UIDevice.current.systemVersion,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: info), let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }

    private static func resource(_ name: String) -> String {
        guard let url = Bundle.main.url(forResource: name, withExtension: "js"),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return "" }
        return text
    }

    private static func isSnapchat(_ url: URL?) -> Bool {
        guard let host = url?.host?.lowercased() else { return false }
        return host == "snapchat.com" || host.hasSuffix(".snapchat.com")
    }

    @objc private func reload(_ sender: UIRefreshControl) {
        if webView.url == nil { webView.load(URLRequest(url: Self.home)) } else { webView.reload() }
        sender.endRefreshing()
    }

    // MARK: GM.* backend for ui.js

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let op = body["op"] as? String else {
            return replyHandler(nil, "bad message")
        }
        let defaults = UserDefaults.standard
        switch op {
        case "get":
            guard let key = body["key"] as? String else { return replyHandler(nil, "no key") }
            replyHandler(defaults.string(forKey: "gm." + key), nil)
        case "set":
            guard let key = body["key"] as? String else { return replyHandler(nil, "no key") }
            defaults.set(body["value"] as? String, forKey: "gm." + key)
            replyHandler(true, nil)
        case "fetch":
            guard let text = body["url"] as? String, let url = URL(string: text), url.scheme == "https",
                  let host = url.host, Self.giphyHosts.contains(host) || host == "tenor.com" || host.hasSuffix(".tenor.com") else {
                return replyHandler(nil, "Unsupported GIF host")
            }
            var request = URLRequest(url: url, timeoutInterval: 20)
            request.httpShouldHandleCookies = false
            URLSession.shared.dataTask(with: request) { data, response, error in
                let http = response as? HTTPURLResponse
                DispatchQueue.main.async {
                    if let error { return replyHandler(nil, error.localizedDescription) }
                    replyHandler([
                        "status": http?.statusCode ?? 0,
                        "type": http?.value(forHTTPHeaderField: "Content-Type") ?? "",
                        "body": (data ?? Data()).base64EncodedString(),
                    ], nil)
                }
            }.resume()
        case "trail":
            trail(body["text"] as? String ?? "")
            replyHandler(true, nil)
        case "tt": // the TikTok tab: hidden TikTok page, its feed and video bytes (TikTokFeed.swift)
            guard let tiktok else { return replyHandler(nil, "unavailable") }
            tiktok.handle(body, reply: replyHandler)
        case "gnet", "gnKeys", "gnStream": // Ghost network: ntfy.sh requests, the long-lived stream, this Ghost's keys (GhostNet.swift)
            GhostNet.handle(op, body, emit: { [weak self] js in self?.webView?.ghostEval(js) }) { value, error in replyHandler(value, error) }
        case "takeOpenURL": // Ghost: the dltnpghost:// link Ghost was opened with (once), for ui.js to act on
            let url = pendingOpenURL
            pendingOpenURL = nil
            replyHandler(url, nil)
        case "openURL": // Ghost: tapping a link in a message opens Safari (or the app that owns the link)
            guard let str = body["url"] as? String, let url = URL(string: str), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return replyHandler(nil, "bad url") }
            UIApplication.shared.open(url)
            replyHandler(true, nil)
        case "appIcon": // Ghost's Settings > Appearance > App Icon: nil name = the default icon
            let name = body["name"] as? String
            let alt = (name == nil || name == "default") ? nil : name
            if body["get"] as? Bool == true { return replyHandler(UIApplication.shared.alternateIconName ?? "default", nil) }
            guard UIApplication.shared.supportsAlternateIcons else { return replyHandler(nil, "not supported") }
            UIApplication.shared.setAlternateIconName(alt) { error in
                DispatchQueue.main.async { if let error { replyHandler(nil, error.localizedDescription) } else { replyHandler(true, nil) } }
            }
        case "streakReminders": // Ghost's Streak Keeper: reminders at each streak time
            // plain values only: these go into UserNotifications' (Sendable) completion handlers
            let items: [(id: String, hour: Int, minute: Int, name: String, skipToday: Bool)] = (body["items"] as? [[String: Any]] ?? []).compactMap { (item: [String: Any]) -> (id: String, hour: Int, minute: Int, name: String, skipToday: Bool)? in
                guard let id = item["id"] as? String else { return nil }
                return (id, (item["hour"] as? NSNumber)?.intValue ?? 12, (item["minute"] as? NSNumber)?.intValue ?? 0,
                        item["name"] as? String ?? "your friend", (item["skipToday"] as? Bool) ?? false)
            }
            let center = UNUserNotificationCenter.current()
            center.getPendingNotificationRequests { reqs in
                center.removePendingNotificationRequests(withIdentifiers: reqs.map(\.identifier).filter { $0.hasPrefix("ghost-streak-") })
                guard !items.isEmpty else { return }
                center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
                    guard granted else { return }
                    // one-off reminders for the next 7 days (not a repeating one, so a day whose streak already
                    // went out gets no nag); Ghost re-plans these every time it runs
                    let cal = Calendar.current, now = Date()
                    for item in items {
                        let id = item.id, hour = item.hour, minute = item.minute, skipToday = item.skipToday
                        for offset in 0..<7 {
                            if offset == 0 && skipToday { continue }
                            guard let day = cal.date(byAdding: .day, value: offset, to: now),
                                  let fire = cal.date(bySettingHour: hour, minute: minute, second: 0, of: day), fire > now else { continue }
                            let content = UNMutableNotificationContent()
                            content.title = "Streak time 🔥"
                            content.body = "Open Ghost to send your streak to \(item.name)"
                            content.sound = .default
                            let when = cal.dateComponents([.year, .month, .day, .hour, .minute], from: fire)
                            center.add(UNNotificationRequest(identifier: "ghost-streak-\(id)-\(offset)", content: content,
                                                             trigger: UNCalendarNotificationTrigger(dateMatching: when, repeats: false)))
                        }
                    }
                }
            }
            replyHandler(true, nil)
        case "saveToPhotos":
            guard let b64 = body["data"] as? String, let data = Data(base64Encoded: b64) else { return replyHandler(nil, "no data") }
            saveToPhotos(data, video: (body["video"] as? Bool) ?? false) { error in
                if let error { replyHandler(nil, error) } else { replyHandler(true, nil) }
            }

        // MARK: Ghost's built-in photo picker (composer's gallery button; GhostPhotoPicker.swift does the work)
        case "photoAuth":
            guard let photoPicker else { return replyHandler(["status": "denied"], nil) }
            photoPicker.handleAuth(reply: replyHandler)
        case "photoManage":
            guard let photoPicker else { return replyHandler(nil, "unavailable") }
            photoPicker.handleManage()
            replyHandler(true, nil)
        case "photoOpenSettings":
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            replyHandler(true, nil)
        case "photoList":
            guard let photoPicker else { return replyHandler(["items": [], "hasMore": false], nil) }
            let offset = (body["offset"] as? NSNumber)?.intValue ?? 0
            let limit = (body["limit"] as? NSNumber)?.intValue ?? 60
            photoPicker.handleList(offset: offset, limit: limit, reply: replyHandler)
        case "photoFull":
            guard let photoPicker, let id = body["id"] as? String else { return replyHandler(nil, "bad id") }
            photoPicker.handleFull(id: id, reply: replyHandler)
        case "asset": // ghostphoto:// / ghostvault:// bytes for ui.js (the page itself can't load them: NativeAsset.swift)
            guard let text = body["url"] as? String, let url = URL(string: text) else { return replyHandler(nil, "bad url") }
            let handler: WKURLSchemeHandler?
            switch url.scheme {
            case GhostPhotoPicker.scheme: handler = photoPicker
            case GhostVault.scheme: handler = vault
            default: handler = nil
            }
            guard let handler else { return replyHandler(nil, "unsupported scheme") }
            CapturedSchemeTask.load(url: url, range: body["range"] as? String, handler: handler, webView: webView, reply: replyHandler)
        case let galleryOp where galleryOp.hasPrefix("gallery"): // Ghost's Gallery tab (GalleryLibrary.swift)
            guard let gallery else { return replyHandler(nil, "unavailable") }
            gallery.handle(op: galleryOp, body: body, reply: replyHandler)
        case "contextInfo": // snap editor weather/location stickers (GhostContext.swift)
            context.info(maxAge: body["fresh"] as? Bool == true ? 5 : 600, reply: replyHandler)
        case "snapBackground": // snap editor background blur / swap on a photo (SnapFX.swift, Vision person segmentation)
            SnapFX.background(body: body, reply: replyHandler)
        case "notifyMessage": // new-message notification while in the background (GhostNotifications.swift)
            guard let notifications, let id = body["id"] as? String else { return replyHandler(nil, "unavailable") }
            notifications.post(id: id, title: body["title"] as? String ?? "Ghost", body: body["body"] as? String ?? "New Chat", reply: replyHandler)
        case "clearMessageNotifications":
            notifications?.clear(id: body["id"] as? String)
            replyHandler(true, nil)
        case "pushInfo": // Apple push: can this install get one (its profile has Push), and the token (GhostPush.swift)
            replyHandler(GhostPush.info(), nil)
        case "pushRegister": // Apple push: permission + device token, for ui.js to hand to the PC relay
            GhostPush.register(reply: replyHandler)
        case "pendingChat": // a notification tapped before ui.js was ready
            if let id = notifications?.takePendingChat() { replyHandler(id, nil) } else { replyHandler(nil, nil) }
        case let vaultOp where vaultOp.hasPrefix("vault"): // My Eyes Only (Vault.swift)
            guard let vault else { return replyHandler(nil, "unavailable") }
            vault.handle(op: vaultOp, body: body, reply: replyHandler)
        case "cutout": // Ghost's sticker maker: lift the subject out of a photo (iOS 17 Vision), transparent PNG back
            guard let b64 = body["image"] as? String, let data = Data(base64Encoded: b64),
                  let image = UIImage(data: data), let cg = image.cgImage else { return replyHandler(nil, "bad image") }
            if #available(iOS 17.0, *) {
                DispatchQueue.global(qos: .userInitiated).async {
                    let request = VNGenerateForegroundInstanceMaskRequest()
                    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
                    var png: String?
                    var failure = "no subject found"
                    do {
                        try handler.perform([request])
                        if let result = request.results?.first {
                            let buffer = try result.generateMaskedImage(ofInstances: result.allInstances, from: handler, croppedToInstancesExtent: true)
                            let ci = CIImage(cvPixelBuffer: buffer)
                            if let out = CIContext().createCGImage(ci, from: ci.extent) { png = UIImage(cgImage: out).pngData()?.base64EncodedString() }
                        }
                    } catch { failure = error.localizedDescription }
                    DispatchQueue.main.async { if let png { replyHandler(png, nil) } else { replyHandler(nil, failure) } }
                }
            } else {
                replyHandler(nil, "needs iOS 17")
            }
        case "speaker": // Ghost's call screen: loudspeaker on/off (WebKit leaves calls on the earpiece)
            let on = body["on"] as? Bool ?? false
            speakerOn = on
            do {
                try applySpeaker()
                // WebKit re-configures the session as the call's audio starts; apply again once it has settled
                for delay in [0.4, 1.2] { DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in try? self?.applySpeaker() } }
                replyHandler(true, nil)
            } catch {
                replyHandler(nil, error.localizedDescription)
            }
        case "keepAwake":
            guard Self.ghostMode, let keepAwake else { return replyHandler(nil, "Keep Awake is only available in Ghost mode") }
            if let enabled = body["enabled"] as? Bool {
                let state = keepAwake.setEnabled(enabled)
                replyHandler(state, keepAwake.error)
            } else {
                replyHandler(keepAwake.state, nil)
            }
        case "haptic":
            let style: UIImpactFeedbackGenerator.FeedbackStyle
            switch body["style"] as? String {
            case "medium": style = .medium
            case "heavy": style = .heavy
            default: style = .light
            }
            haptic(style)
            replyHandler(true, nil)
        case "dump":
            dump(body["name"] as? String ?? "page", note: body["note"] as? String ?? "")
            replyHandler(true, nil)
        case "storyThumb":
            let data = (body["data"] as? String).flatMap { Data(base64Encoded: $0) }
            let thumb = data.flatMap { UIImage(data: $0) }
            storiesButton?.setImage(TabIcons.stories(preview: thumb), for: .normal)
            replyHandler(true, nil)
        case "mode":
            storiesOpen = body["stories"] as? Bool ?? false
            cameraOpen = body["camera"] as? Bool ?? false
            previewOpen = body["preview"] as? Bool ?? false
            edgeBack?.isEnabled = !Self.ghostMode && !((body["chat"] as? Bool ?? false) && !storiesOpen && !cameraOpen)
            setChatOpen(body["chat"] as? Bool ?? false, force: true)
            replyHandler(true, nil)

        // MARK: settings ops (settings.js in the darkmobile world; App.swift is the only writer of "dgSettings")
        case "setSetting":
            guard let key = body["key"] as? String else { return replyHandler(nil, "no key") }
            let rawValue = body["value"]
            let value: Any? = (rawValue as? NSNull) != nil ? nil : rawValue
            let ok = SettingsStore.shared.set(key, value)
            replyHandler(ok, ok ? nil : "invalid key")
        case "openSettings":
            presentSettingsSheet()
            replyHandler(true, nil)
        case "getSettings":
            replyHandler(SettingsStore.shared.merged, nil)

        // Chat-row long-press contract (native <-> page):
        //  Page -> native: postMessage({ op: "rowMenu", title: "<friend name>", convId: "<id>", x, y }) -
        //    the page side that detects the long press on a chat-list row and decides to open this menu is
        //    implemented elsewhere (not in this file); x/y are viewport coordinates used only to anchor an
        //    iPad popover (harmless no-op on iPhone).
        //  Native -> page: after the user picks something, evaluateJavaScript calls
        //    window.__dgRowMenuResult && window.__dgRowMenuResult({ convId, action, value })
        //    where action is one of:
        //      "open"     - "Open chat" tapped; value is always null; the page should navigate to convId.
        //      "copyName" - "Copy name" tapped (native already put it on the pasteboard); value is the name.
        //      "nickname" - "Set nickname..." was saved; value is the new nickname string, or null if the
        //                   field was cleared (removed). Also stored under setting key "x_nicknames" as
        //                   {convId: nickname}, so dgSetting("x_nicknames", {}) reads the whole map.
        //    Cancelling the action sheet or the nickname alert sends nothing back.
        case "rowMenu":
            guard let title = body["title"] as? String, let convId = body["convId"] as? String else {
                return replyHandler(nil, "bad rowMenu")
            }
            let x = CGFloat((body["x"] as? Double) ?? Double(webView.bounds.midX))
            let y = CGFloat((body["y"] as? Double) ?? Double(webView.bounds.midY))
            presentRowMenu(title: title, convId: convId, x: x, y: y)
            replyHandler(true, nil)

        default:
            replyHandler(nil, "unknown op")
        }
    }

    // MARK: settings sheet

    /// The op "openSettings" (from the page's dgOpenSettings(), e.g. appmenu.js's tap on header.js's
    /// ".dg-fake-more") and the three-finger tap both present this.
    private func presentSettingsSheet() {
        let root = SettingsRootViewController(delegate: self)
        let nav = UINavigationController(rootViewController: root)
        nav.overrideUserInterfaceStyle = .dark
        if let sheet = nav.sheetPresentationController {
            sheet.detents = [.medium(), .large()]
            sheet.prefersGrabberVisible = true
        }
        present(nav, animated: true)
    }

    // MARK: chat-row long-press sheet (see the "rowMenu" op's contract comment above)

    private func presentRowMenu(title: String, convId: String, x: CGFloat, y: CGFloat) {
        let alert = UIAlertController(title: title, message: nil, preferredStyle: .actionSheet)
        if let popover = alert.popoverPresentationController {
            popover.sourceView = view
            popover.sourceRect = CGRect(x: x, y: y, width: 1, height: 1)
        }
        alert.addAction(UIAlertAction(title: "Open chat", style: .default) { [weak self] _ in
            self?.sendRowMenuResult(convId: convId, action: "open", value: nil)
        })
        alert.addAction(UIAlertAction(title: "Set nickname\u{2026}", style: .default) { [weak self] _ in
            self?.presentNicknamePrompt(convId: convId)
        })
        alert.addAction(UIAlertAction(title: "Copy name", style: .default) { [weak self] _ in
            UIPasteboard.general.string = title
            self?.sendRowMenuResult(convId: convId, action: "copyName", value: title)
        })
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        present(alert, animated: true)
    }

    private func presentNicknamePrompt(convId: String) {
        let nicknames = (SettingsStore.shared.value("x_nicknames") as? [String: String]) ?? [:]
        let alert = UIAlertController(title: "Set nickname", message: nil, preferredStyle: .alert)
        alert.addTextField { field in
            field.text = nicknames[convId]
            field.placeholder = "Nickname"
            field.autocapitalizationType = .words
            field.clearButtonMode = .whileEditing
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Save", style: .default) { [weak self] _ in
            let text = alert.textFields?.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            var updated = nicknames
            if text.isEmpty { updated.removeValue(forKey: convId) } else { updated[convId] = text }
            SettingsStore.shared.set("x_nicknames", updated)
            self?.sendRowMenuResult(convId: convId, action: "nickname", value: text.isEmpty ? nil : text)
        })
        present(alert, animated: true)
    }

    private func sendRowMenuResult(convId: String, action: String, value: Any?) {
        let payload: [String: Any] = ["convId": convId, "action": action, "value": value ?? NSNull()]
        guard let data = try? JSONSerialization.data(withJSONObject: payload), let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__dgRowMenuResult && window.__dgRowMenuResult(\(json))", in: nil, in: world)
    }

    // MARK: navigation

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url, let scheme = url.scheme?.lowercased() else { return decisionHandler(.allow) }
        if action.targetFrame?.isMainFrame != false { trail("NATIVE navigation type \(action.navigationType.rawValue) to \(url.absoluteString)") }
        if scheme == "http" || scheme == "https" || scheme == "about" || scheme == "blob" || scheme == "data" {
            // links out of Snapchat open in Safari; logins, captchas and other frames stay here
            if action.navigationType == .linkActivated, action.targetFrame?.isMainFrame != false, !Self.isSnapchat(url) {
                UIApplication.shared.open(url)
                return decisionHandler(.cancel)
            }
            return decisionHandler(.allow)
        }
        // snapchat://, itms-apps:// and the like: never leave for the App Store or the real app
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if Self.isSnapchat(url) { webView.load(action.request) } else { UIApplication.shared.open(url) }
        }
        return nil
    }

    /// WKNavigationDelegatePrivate: same event with WebKit's reason (0 memory limit, 1 CPU limit, 2 requested, 3 crash).
    /// When this exists WebKit calls ONLY this one, so it forwards to the public handler below.
    @objc(_webView:webContentProcessDidTerminateWithReason:)
    func webViewContentProcessDidTerminate(_ webView: WKWebView, reason: Int) {
        let names = ["memory limit", "CPU limit", "requested by app", "crash", "shared process crash limit"]
        let name = reason >= 0 && reason < names.count ? names[reason] : "reason \(reason)"
        urlLog.append("REASON: \(name)")
        trail("NATIVE web process ended: \(name)")
        webViewWebContentProcessDidTerminate(webView)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        urlLog.append("WEB PROCESS CRASHED")
        if let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
            let text = "crash at \(Date()) urls \(urlLog)\n"
            try? text.write(to: dir.appendingPathComponent("crash-\(Int(Date().timeIntervalSince1970)).txt"), atomically: true, encoding: .utf8)
        }
        // Ghost reopens the chat you were in after this reload (ui.js reads gm.ghostResume)
        // ...unless it's crashing again right after that (reopening the same heavy chat just crashed it a second time,
        // 19 s later - device 2026-09-28): then it starts on the chat list
        if Self.ghostMode {
            let now = Date().timeIntervalSince1970
            let last = UserDefaults.standard.double(forKey: "ghostLastCrash")
            UserDefaults.standard.set(now, forKey: "ghostLastCrash")
            UserDefaults.standard.set(now - last > 90 ? "1" : "", forKey: "gm.ghostResume")
        }
        webView.load(URLRequest(url: Self.home))
    }

    // MARK: smoothness

    /// WebKit renders web pages at 60fps on iPhone even on a 120Hz screen. Private switch
    /// (WKPreferences._setEnabled:forFeature: "PreferPageRenderingUpdatesNear60FPSEnabled" = off); on iOS 26 it
    /// only helps together with CADisableMinimumFrameDurationOnPhone and the display link below. Each step is
    /// checked first, so a WebKit without these private methods is simply left alone.
    private static func preferHighRefresh(_ prefs: WKPreferences) {
        let featuresSel = NSSelectorFromString("_features")
        let setSel = NSSelectorFromString("_setEnabled:forFeature:")
        guard let listMethod = class_getClassMethod(WKPreferences.self, featuresSel),
              let method = class_getInstanceMethod(WKPreferences.self, setSel) else { return }
        typealias Features = @convention(c) (AnyClass, Selector) -> Unmanaged<AnyObject>?
        typealias SetEnabled = @convention(c) (AnyObject, Selector, Bool, AnyObject) -> Void
        let list = unsafeBitCast(method_getImplementation(listMethod), to: Features.self)
        let setEnabled = unsafeBitCast(method_getImplementation(method), to: SetEnabled.self)
        guard let features = list(WKPreferences.self, featuresSel)?.takeUnretainedValue() as? [NSObject] else { return }
        let keySel = NSSelectorFromString("key")
        for feature in features where feature.responds(to: keySel)
            && (feature.perform(keySel)?.takeUnretainedValue() as? String) == "PreferPageRenderingUpdatesNear60FPSEnabled" {
            setEnabled(prefs, setSel, false, feature)
        }
    }

    /// Keeps the screen at up to 120Hz and nudges WebKit to draw at that pace (private
    /// WKWebView._updateVisibleContentRects each frame) - only while a finger is down or an animation runs,
    /// so it costs no battery the rest of the time.
    private func renderFast(for seconds: CFTimeInterval) {
        guard SettingsStore.shared.bool("highRefresh") else { return }
        fastUntil = max(fastUntil, CACurrentMediaTime() + seconds)
        guard displayLink == nil else { return }
        let link = CADisplayLink(target: self, selector: #selector(fastTick(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 80, maximum: 120, preferred: 120)
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    @objc private func fastTick(_ link: CADisplayLink) {
        if CACurrentMediaTime() > fastUntil {
            link.invalidate()
            displayLink = nil
            return
        }
        let sel = NSSelectorFromString("_updateVisibleContentRects")
        if webView.responds(to: sel) { webView.perform(sel) }
    }

    /// Saves what the chat list looks like right now, for the launch picture (only the plain chat list: a chat,
    /// the camera or the keyboard would show up in the wrong place next launch).
    @objc private func saveLaunchPicture() {
        guard SettingsStore.shared.bool("launchPicture"),
              inApp, !chatOpen, !storiesOpen, !cameraOpen, keyboardOverlap == 0, launchCover.superview == nil,
              let url = Self.launchPictureURL else { return }
        let config = WKSnapshotConfiguration()
        config.afterScreenUpdates = false
        // Ghost: never while something private is on screen (Gallery, My Eyes Only, a viewer, the PIN pad, the camera/
        // editor) - this picture is shown at the next launch before any lock, and it sits unencrypted in Caches
        let ghostSafe = "document.documentElement.hasAttribute('data-ghost-ready') && !(() => { const r = document.querySelector('ghost-app'); const s = r && r.shadowRoot; return !s || !!s.querySelector('.gh-gal[data-open=\"1\"], .gh-vault[data-open=\"1\"], .gh-gv[data-open=\"1\"], .gh-pin[data-open=\"1\"], .gh-camera[data-open=\"1\"], .gh-viewer[data-open=\"1\"], .gh-send-page[data-open=\"1\"]'); })()"
        webView.evaluateJavaScript(Self.ghostMode ? ghostSafe : "document.documentElement.classList.contains('dg-list') && document.querySelectorAll('[role=\"listitem\"]').length > 2") { [weak self] ready, _ in
            guard (ready as? Bool) == true, let self else { return }
            self.webView.takeSnapshot(with: config) { image, _ in
                guard let data = image?.pngData() else { return }
                DispatchQueue.global(qos: .utility).async { try? data.write(to: url, options: .atomic) }
                UserDefaults.standard.set(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "", forKey: "launchPictureBuild")
            }
        }
    }

    /// Takes the launch picture away once Snapchat has drawn the real chat list (or after ~9s, or at once on a
    /// login page).
    private func checkLaunchCover() {
        guard launchCover.superview != nil else { return }
        launchCoverChecks += 1
        let js = Self.ghostMode ? "document.documentElement.hasAttribute('data-ghost-ready')"
            : "document.documentElement.classList.contains('dg-list') && document.querySelectorAll('[role=\"listitem\"]').length > 2 && getComputedStyle(document.body).opacity === '1'"
        webView.evaluateJavaScript(js) { [weak self] ready, _ in
            guard let self else { return }
            if !self.inApp || (ready as? Bool) == true || self.launchCoverChecks > 60 {
                UIView.animate(withDuration: 0.2, delay: 0.1, options: [], animations: { self.launchCover.alpha = 0 }) { _ in
                    self.launchCover.removeFromSuperview()
                    self.launchCover.image = nil
                    self.launchCover.alpha = 1
                }
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { self.checkLaunchCover() }
            }
        }
    }

    // MARK: permissions and dialogs

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let host = origin.host.lowercased()
        decisionHandler(host == "snapchat.com" || host.hasSuffix(".snapchat.com") ? .grant : .prompt)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(alert.textFields?.first?.text) })
        present(alert, animated: true)
    }
}

/// The settings sheet (SettingsRootViewController) talks back to the web view through this.
extension WebViewController: SettingsActionsDelegate {
    /// Native colours that match the page's theme setting (theme.js), so the strips around the web view and the
    /// tab bar don't stay grey under a true-black or midnight page. "dark" = the original colours.
    static func themeColors() -> (background: UIColor, composer: UIColor, bar: UIColor) {
        func rgb(_ hex: Int) -> UIColor {
            UIColor(red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1)
        }
        switch SettingsStore.shared.value("theme") as? String ?? "dark" {
        case "true-black": return (rgb(0x000000), rgb(0x0a0a0a), rgb(0x0a0a0a))
        case "midnight": return (rgb(0x0d1117), rgb(0x141a21), rgb(0x161b22))
        default: return (background, rgb(0x1c1c1e), tabBarColor)
        }
    }

    func settingsDidChange() {
        view.setNeedsLayout() // theme colours of the native strips / tab bar
        webView.evaluateJavaScript("window.__dgApplySettings && window.__dgApplySettings(\(SettingsStore.shared.mergedJSON))", in: nil, in: world)
    }

    func performSettingsAction(_ action: String) {
        switch action {
        case "reload": webView.reload()
        case "diagnostics": presentDiagnostics()
        case "clearLaunchPicture": Self.clearLaunchPicture()
        default: break
        }
    }
}

/// Bottom bar icons, drawn after the real Snapchat app's (light grey outlines on #1e1e1e; Stories is the
/// purple story ring).
enum TabIcons {
    private static let grey = UIColor(white: 0.89, alpha: 1)

    private static func draw(_ size: CGFloat = 30, _ body: (CGContext) -> Void) -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: size, height: size)).image { body($0.cgContext) }
            .withRenderingMode(.alwaysOriginal)
    }

    private static func stroke(_ path: UIBezierPath) {
        grey.setStroke()
        path.lineWidth = 2.4
        path.lineCapStyle = .round
        path.lineJoinStyle = .round
        path.stroke()
    }

    static let map = draw { _ in
        let pin = UIBezierPath()
        pin.move(to: CGPoint(x: 15, y: 27))
        pin.addCurve(to: CGPoint(x: 5.5, y: 13), controlPoint1: CGPoint(x: 10.5, y: 23), controlPoint2: CGPoint(x: 5.5, y: 18.5))
        pin.addArc(withCenter: CGPoint(x: 15, y: 13), radius: 9.5, startAngle: .pi, endAngle: 0, clockwise: true)
        pin.addCurve(to: CGPoint(x: 15, y: 27), controlPoint1: CGPoint(x: 24.5, y: 18.5), controlPoint2: CGPoint(x: 19.5, y: 23))
        pin.close()
        stroke(pin)
        stroke(UIBezierPath(arcCenter: CGPoint(x: 15, y: 13), radius: 3.6, startAngle: 0, endAngle: 2 * .pi, clockwise: true))
    }

    static let chat = draw { _ in
        let bubble = UIBezierPath()
        bubble.move(to: CGPoint(x: 9.5, y: 4))
        bubble.addLine(to: CGPoint(x: 20.5, y: 4))
        bubble.addArc(withCenter: CGPoint(x: 20.5, y: 8.5), radius: 4.5, startAngle: -.pi / 2, endAngle: 0, clockwise: true)
        bubble.addLine(to: CGPoint(x: 25, y: 26.4))
        bubble.addQuadCurve(to: CGPoint(x: 23.2, y: 27), controlPoint: CGPoint(x: 25, y: 28))
        bubble.addLine(to: CGPoint(x: 19.6, y: 23.6))
        bubble.addLine(to: CGPoint(x: 9.5, y: 23.6))
        bubble.addArc(withCenter: CGPoint(x: 9.5, y: 19.1), radius: 4.5, startAngle: .pi / 2, endAngle: .pi, clockwise: true)
        bubble.addLine(to: CGPoint(x: 5, y: 8.5))
        bubble.addArc(withCenter: CGPoint(x: 9.5, y: 8.5), radius: 4.5, startAngle: .pi, endAngle: -.pi / 2, clockwise: true)
        bubble.close()
        grey.setFill()
        bubble.fill()
    }

    static let camera = draw { _ in
        let body = UIBezierPath()
        body.move(to: CGPoint(x: 3, y: 13))
        body.addArc(withCenter: CGPoint(x: 7, y: 13), radius: 4, startAngle: .pi, endAngle: -.pi / 2, clockwise: true)
        body.addLine(to: CGPoint(x: 9.5, y: 9))
        body.addLine(to: CGPoint(x: 11, y: 6.5))
        body.addQuadCurve(to: CGPoint(x: 12.5, y: 5.6), controlPoint: CGPoint(x: 11.5, y: 5.6))
        body.addLine(to: CGPoint(x: 17.5, y: 5.6))
        body.addQuadCurve(to: CGPoint(x: 19, y: 6.5), controlPoint: CGPoint(x: 18.5, y: 5.6))
        body.addLine(to: CGPoint(x: 20.5, y: 9))
        body.addLine(to: CGPoint(x: 23, y: 9))
        body.addArc(withCenter: CGPoint(x: 23, y: 13), radius: 4, startAngle: -.pi / 2, endAngle: 0, clockwise: true)
        body.addLine(to: CGPoint(x: 27, y: 22))
        body.addArc(withCenter: CGPoint(x: 23, y: 22), radius: 4, startAngle: 0, endAngle: .pi / 2, clockwise: true)
        body.addLine(to: CGPoint(x: 7, y: 26))
        body.addArc(withCenter: CGPoint(x: 7, y: 22), radius: 4, startAngle: .pi / 2, endAngle: .pi, clockwise: true)
        body.close()
        stroke(body)
        stroke(UIBezierPath(arcCenter: CGPoint(x: 15, y: 17), radius: 4.6, startAngle: 0, endAngle: 2 * .pi, clockwise: true))
    }

    /// Purple story ring around the first story's thumbnail (grey when there is none).
    static func stories(preview: UIImage?) -> UIImage {
        draw(36) { _ in
            let inner = UIBezierPath(arcCenter: CGPoint(x: 18, y: 18), radius: 13, startAngle: 0, endAngle: 2 * .pi, clockwise: true)
            if let preview {
                inner.addClip()
                preview.draw(in: CGRect(x: 5, y: 5, width: 26, height: 26))
                UIGraphicsGetCurrentContext()?.resetClip()
            } else {
                UIColor(white: 0.28, alpha: 1).setFill()
                inner.fill()
            }
            let ring = UIBezierPath(arcCenter: CGPoint(x: 18, y: 18), radius: 16, startAngle: 0, endAngle: 2 * .pi, clockwise: true)
            ring.lineWidth = 2.6
            UIColor(red: 0xb0 / 255, green: 0x26 / 255, blue: 0xe8 / 255, alpha: 1).setStroke()
            ring.stroke()
        }
    }

    static let spotlight = draw { _ in
        // rounded play triangle (same shape as Snapchat's own Spotlight icon)
        let shape = UIBezierPath()
        shape.move(to: CGPoint(x: 7.5, y: 7.2))
        shape.addQuadCurve(to: CGPoint(x: 10.6, y: 5.4), controlPoint: CGPoint(x: 7.5, y: 3.6))
        shape.addLine(to: CGPoint(x: 24.4, y: 13.2))
        shape.addQuadCurve(to: CGPoint(x: 24.4, y: 16.8), controlPoint: CGPoint(x: 27.4, y: 15))
        shape.addLine(to: CGPoint(x: 10.6, y: 24.6))
        shape.addQuadCurve(to: CGPoint(x: 7.5, y: 22.8), controlPoint: CGPoint(x: 7.5, y: 26.4))
        shape.close()
        stroke(shape)
    }
}
