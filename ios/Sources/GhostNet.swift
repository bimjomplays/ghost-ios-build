import Foundation
import Security
import UIKit

/// Native side of the Ghost network (ui.js section "Ghost network"): the private line between two Ghost apps.
/// - "gnet": HTTPS to ntfy.sh only (each Ghost's inbox is an ntfy topic; everything in it is encrypted and signed by
///   ui.js with WebCrypto). The page can't fetch ntfy.sh itself (Snapchat's content security policy), so it goes here.
/// - "gnKeys": this Ghost's key pair (JWK JSON) in the Keychain, so clearing website data doesn't change your Ghost ID.
/// - "gnStream" (1.19.0): ONE long-lived ntfy.sh subscription while Ghost is in front, instead of reading the inboxes
///   every round (see NetStream below; ui.js section "Ghost Network stream" decides when it's open).
enum GhostNet {
    private static let service = "com.dltnp.ghost.network"

    /// emit: runs JS in ui.js's content world (the stream's lines go to window.__ghostNetStream)
    static func handle(_ op: String, _ body: [String: Any], emit: @escaping (String) -> Void, reply: @escaping (Any?, String?) -> Void) {
        switch op {
        case "gnet": request(body, reply: reply)
        case "gnStream": stream.handle(body, emit: emit, reply: reply)
        case "gnKeys":
            // replies {"keys": String|null}; a Keychain error is an error (ui.js must never treat it as "no keys" and
            // make new ones, which would replace this Ghost's identity). slot "farewell": the old keys after Leave,
            // kept only while goodbyes to friends are still owed.
            let account = (body["slot"] as? String) == "farewell" ? "farewell" : "keys"
            if let value = body["set"] as? String {
                let status = kcSet(account, Data(value.utf8))
                status == errSecSuccess ? reply(true, nil) : reply(nil, "keychain \(status)")
            } else if body["delete"] as? Bool == true {
                kcDelete(account); reply(true, nil)
            } else {
                switch kcGet(account) {
                case .found(let data):
                    if let text = String(data: data, encoding: .utf8) { reply(["keys": text], nil) } else { reply(nil, "keychain: unreadable") }
                case .none: reply(["keys": NSNull()], nil)
                case .error(let status): reply(nil, "keychain \(status)")
                }
            }
        default: reply(nil, "unknown op")
        }
    }

    /// Only ntfy.sh, no redirects to anywhere else, and at most 4 MB per response (pictures are ~200 KB).
    private final class Guard: NSObject, URLSessionDataDelegate {
        static let maxBytes = 4 * 1024 * 1024
        private var tasks: [Int: (data: Data, done: (Data?, HTTPURLResponse?, String?) -> Void)] = [:]
        private let lock = NSLock()
        func add(_ task: URLSessionTask, _ done: @escaping (Data?, HTTPURLResponse?, String?) -> Void) {
            lock.lock(); tasks[task.taskIdentifier] = (Data(), done); lock.unlock()
        }
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(request.url?.scheme == "https" && request.url?.host == "ntfy.sh" ? request : nil)
        }
        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
            completionHandler(response.expectedContentLength > Int64(Guard.maxBytes) ? .cancel : .allow)
        }
        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
            lock.lock()
            if var entry = tasks[dataTask.taskIdentifier] {
                entry.data.append(data)
                tasks[dataTask.taskIdentifier] = entry
                if entry.data.count > Guard.maxBytes { lock.unlock(); dataTask.cancel(); return }
            }
            lock.unlock()
        }
        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            lock.lock(); let entry = tasks.removeValue(forKey: task.taskIdentifier); lock.unlock()
            guard let entry else { return }
            let http = task.response as? HTTPURLResponse
            if let error { entry.done(nil, http, error.localizedDescription) } else { entry.done(entry.data, http, nil) }
        }
    }
    private static let guardDelegate = Guard()
    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.urlCache = nil
        return URLSession(configuration: config, delegate: guardDelegate, delegateQueue: nil)
    }()

    private static func request(_ body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        guard let text = body["url"] as? String, let url = URL(string: text), url.scheme == "https", url.host == "ntfy.sh" else {
            return reply(nil, "Ghost network only talks to ntfy.sh")
        }
        let method = (body["method"] as? String ?? "GET").uppercased()
        guard ["GET", "POST", "PUT"].contains(method) else { return reply(nil, "bad method") }
        var request = URLRequest(url: url, timeoutInterval: 25)
        request.httpMethod = method
        request.httpShouldHandleCookies = false
        if let b64 = body["body"] as? String { request.httpBody = Data(base64Encoded: b64) }
        for (k, v) in (body["headers"] as? [String: String] ?? [:]) where ["Filename", "Cache", "Firebase", "X-Poll-ID"].contains(k) {
            request.setValue(v, forHTTPHeaderField: k)
        }
        let task = session.dataTask(with: request)
        guardDelegate.add(task) { data, http, error in
            DispatchQueue.main.async {
                if let error { return reply(nil, error) }
                // date: ntfy.sh's clock (the stream's cursors are in ntfy time, see network.js createStream)
                reply(["status": http?.statusCode ?? 0, "body": (data ?? Data()).base64EncodedString(),
                       "date": http?.value(forHTTPHeaderField: "Date") ?? ""], nil)
            }
        }
        task.resume()
    }

    // MARK: "gnStream": one subscription, GET https://ntfy.sh/<topic>,<topic>,.../json?since=<…>
    /// It stays open for as long as ntfy.sh keeps it (a keepalive line every 45 s); every line is handed to ui.js as it
    /// comes: window.__ghostNetStream({sid, ev:"status", status}), ({sid, ev:"lines", lines:[String]}),
    /// ({sid, ev:"end", status, error, body}). One at a time: {open: url, sid} replaces the one before (whose events
    /// stop), {close: true} ends it, and going to the background ends it too (iOS would cut it anyway). When to open,
    /// reconnect, the shared 429 wait, cursors and dedupe are all ui.js's (network.js createStream).
    /// Every reply is {ok: true, v: 1}: a build without this op answers "unknown op", and ui.js keeps polling.
    private static let stream = NetStream()
    private final class NetStream: NSObject, URLSessionDataDelegate {
        static let idle: TimeInterval = 100        // s without a byte (keepalives every 45 s): the connection is dead
        static let maxLine = 64 * 1024             // ntfy.sh's messages are 4 KB; a line this long without an end is not ntfy
        static let maxErrorBody = 4096
        private final class Conn {
            let sid: Int
            let task: URLSessionDataTask
            var status = 0
            var buffer = Data()
            var body = Data()
            var lines: [String] = []
            var flushing = false
            init(sid: Int, task: URLSessionDataTask) { self.sid = sid; self.task = task }
        }
        private let queue = DispatchQueue(label: "com.dltnp.ghost.netstream")
        private var current: Conn?
        private var emit: ((String) -> Void)?
        private lazy var session: URLSession = {
            let config = URLSessionConfiguration.ephemeral
            config.httpCookieStorage = nil
            config.urlCache = nil
            config.timeoutIntervalForRequest = NetStream.idle
            config.timeoutIntervalForResource = 24 * 3600
            let ops = OperationQueue()
            ops.maxConcurrentOperationCount = 1
            ops.underlyingQueue = queue
            return URLSession(configuration: config, delegate: self, delegateQueue: ops)
        }()

        override init() {
            super.init()
            _ = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil) { [weak self] _ in
                guard let self else { return }
                self.queue.async { self.end(self.current, error: "background", cancel: true) }
            }
        }

        func handle(_ body: [String: Any], emit: @escaping (String) -> Void, reply: @escaping (Any?, String?) -> Void) {
            if body["close"] as? Bool == true {
                queue.async { self.end(self.current, error: nil, cancel: true, quiet: true) }
                return reply(["ok": true, "v": 1], nil)
            }
            guard let text = body["open"] as? String else { return reply(["ok": true, "v": 1], nil) } // (a probe)
            guard let url = URL(string: text), url.scheme == "https", url.host == "ntfy.sh",
                  url.path.range(of: "^/[A-Za-z0-9_,-]{1,900}/json$", options: .regularExpression) != nil else {
                return reply(nil, "bad stream url")
            }
            let sid = (body["sid"] as? NSNumber)?.intValue ?? 0
            queue.async {
                self.end(self.current, error: nil, cancel: true, quiet: true) // (one stream at a time)
                self.emit = emit
                var request = URLRequest(url: url, timeoutInterval: NetStream.idle)
                request.httpMethod = "GET"
                request.httpShouldHandleCookies = false
                let task = self.session.dataTask(with: request)
                self.current = Conn(sid: sid, task: task)
                task.resume()
            }
            reply(["ok": true, "v": 1], nil)
        }

        // MARK: everything below runs on `queue`
        private func send(_ event: [String: Any]) {
            guard let emit, JSONSerialization.isValidJSONObject([event]),
                  let data = try? JSONSerialization.data(withJSONObject: [event]), let json = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async { emit("window.__ghostNetStream && window.__ghostNetStream(\(json)[0])") }
        }
        private func flush(_ conn: Conn) {
            conn.flushing = false
            guard !conn.lines.isEmpty, current === conn else { conn.lines.removeAll(); return }
            let lines = conn.lines
            conn.lines.removeAll()
            send(["sid": conn.sid, "ev": "lines", "lines": lines])
        }
        /// quiet: ui.js asked for it (or opened a new one), so no "end" event for it
        private func end(_ conn: Conn?, error: String?, cancel: Bool, quiet: Bool = false) {
            guard let conn, current === conn else { return }
            current = nil
            if cancel { conn.task.cancel() }
            if quiet { return }
            if !conn.lines.isEmpty { send(["sid": conn.sid, "ev": "lines", "lines": conn.lines]); conn.lines.removeAll() }
            var event: [String: Any] = ["sid": conn.sid, "ev": "end", "status": conn.status]
            if let error { event["error"] = error }
            if !conn.body.isEmpty { event["body"] = String(decoding: conn.body, as: UTF8.self) }
            send(event)
        }
        private func conn(_ task: URLSessionTask) -> Conn? {
            guard let c = current, c.task === task else { return nil }
            return c
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil) // never anywhere else
        }
        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
            guard let c = conn(dataTask) else { return completionHandler(.cancel) }
            c.status = (response as? HTTPURLResponse)?.statusCode ?? 0
            send(["sid": c.sid, "ev": "status", "status": c.status])
            completionHandler(.allow)
        }
        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
            guard let c = conn(dataTask) else { return }
            if c.status != 200 { // a refusal: keep the start of its answer (ntfy's JSON error, e.g. a 429's code)
                if c.body.count < NetStream.maxErrorBody { c.body.append(data.prefix(NetStream.maxErrorBody - c.body.count)) }
                return
            }
            c.buffer.append(data)
            while let nl = c.buffer.firstIndex(of: 0x0A) {
                let line = String(decoding: c.buffer[c.buffer.startIndex..<nl], as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
                c.buffer.removeSubrange(c.buffer.startIndex...nl)
                if !line.isEmpty { c.lines.append(line) }
            }
            if c.buffer.count > NetStream.maxLine { return end(c, error: "line too long", cancel: true) }
            // lines that come together go to ui.js together (a reopened stream first brings everything since its cursor)
            if !c.lines.isEmpty && !c.flushing {
                c.flushing = true
                queue.asyncAfter(deadline: .now() + 0.03) { [weak self] in self?.flush(c) }
            }
        }
        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            guard let c = conn(task) else { return }
            var why: String? = error?.localizedDescription
            if why == nil && c.status == 200 { why = "closed" } // (ntfy.sh ended a working stream)
            end(c, error: why, cancel: false)
        }
    }

    // MARK: Keychain (this device only; readable after the first unlock so a background refresh could use it later)
    private enum Read { case found(Data), none, error(OSStatus) }
    private static func base(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }
    /// Update in place (never delete-then-add: a failed add would lose the keys)
    private static func kcSet(_ account: String, _ data: Data) -> OSStatus {
        let update: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(base(account) as CFDictionary, update as CFDictionary)
        if status != errSecItemNotFound { return status }
        var q = base(account)
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(q as CFDictionary, nil)
    }
    private static func kcGet(_ account: String) -> Read {
        var q = base(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return .none }
        guard status == errSecSuccess, let data = out as? Data else { return .error(status) }
        return .found(data)
    }
    private static func kcDelete(_ account: String) { SecItemDelete(base(account) as CFDictionary) }
}
