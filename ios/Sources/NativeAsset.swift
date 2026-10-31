import Foundation
import WebKit

/// Reads a ghostphoto:// or ghostvault:// resource through the "dg" message channel instead of a page load.
///
/// On the phone, WebKit blocks every custom-scheme load from the https Snapchat page as mixed content
/// ("was not allowed to display insecure content"), <img>/<video> included, not just fetch(). The Gallery,
/// photo picker and My Eyes Only showed grey tiles because of it. The scheme handlers still do all the work:
/// this feeds them a stand-in WKURLSchemeTask that collects the response, and the bytes go back to ui.js as
/// base64, where they become a same-origin blob: URL. Range requests work the same way (videos load in chunks).
final class CapturedSchemeTask: NSObject, WKURLSchemeTask {
    let request: URLRequest
    private var response: HTTPURLResponse?
    private var body = Data()
    private var done = false
    private let reply: (Any?, String?) -> Void

    init(request: URLRequest, reply: @escaping (Any?, String?) -> Void) {
        self.request = request
        self.reply = reply
    }

    func didReceive(_ response: URLResponse) { self.response = response as? HTTPURLResponse }
    func didReceive(_ data: Data) { body.append(data) }
    func didFinish() {
        finish {
            let status = self.response?.statusCode ?? 0
            guard (200..<300).contains(status) else { return (nil, "status \(status)") }
            return ([
                "status": status,
                "type": self.response?.value(forHTTPHeaderField: "Content-Type") ?? "",
                "range": self.response?.value(forHTTPHeaderField: "Content-Range") ?? "",
                "body": self.body.base64EncodedString(),
            ], nil)
        }
    }
    func didFailWithError(_ error: Error) { finish { (nil, error.localizedDescription) } }

    private func finish(_ make: @escaping () -> (Any?, String?)) {
        let run = {
            guard !self.done else { return }
            self.done = true
            let (value, err) = make()
            self.reply(value, err)
        }
        if Thread.isMainThread { run() } else { DispatchQueue.main.async(execute: run) }
    }

    /// Starts `url` on `handler` (the one registered for its scheme). `range` is an HTTP Range value, e.g. "bytes=0-8388607".
    static func load(url: URL, range: String?, handler: WKURLSchemeHandler, webView: WKWebView,
                     reply: @escaping (Any?, String?) -> Void) {
        var request = URLRequest(url: url)
        if let range, !range.isEmpty { request.setValue(range, forHTTPHeaderField: "Range") }
        handler.webView(webView, start: CapturedSchemeTask(request: request, reply: reply))
    }
}
