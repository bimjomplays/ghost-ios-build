import UIKit
import WebKit

/// Ghost's own TikTok bookmarks (Ghost 1.5.0): the rail's bookmark button saves the video INTO GHOST, not to the
/// TikTok account's Favorites (user decision 2026-09-29). TikTok's video links expire after about two days, so the
/// file itself is downloaded (with TikTok's cookies + Referer, like the player's own fetch) into
/// Documents/tiktok-bookmarks/<id>.mp4 with <id>.jpg (cover) and <id>.json (author, caption, sound, link, saved date).
/// ui.js shows them in Gallery > TikTok and plays them by reading the file back in Range chunks ("bmRead").
final class GhostTikTokBookmarks: NSObject, URLSessionTaskDelegate {
    static let maxVideo = 300 * 1024 * 1024
    static let maxChunk = 8 * 1024 * 1024

    private lazy var session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.httpShouldSetCookies = false
        c.httpCookieAcceptPolicy = .never
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.timeoutIntervalForRequest = 60
        return URLSession(configuration: c, delegate: self, delegateQueue: nil)
    }()
    private var saving = Set<String>()

    private var dir: URL? {
        guard let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return nil }
        let d = docs.appendingPathComponent("tiktok-bookmarks", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }
    private static func validID(_ s: String?) -> String? {
        guard let s, s.range(of: "^[0-9]{5,30}$", options: .regularExpression) != nil else { return nil }
        return s
    }

    func handle(_ body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        switch body["cmd"] as? String ?? "" {
        case "bmSave": save(body, reply: reply)
        case "bmList": list(reply: reply)
        case "bmRemove":
            guard let id = Self.validID(body["id"] as? String), let dir else { return reply(nil, "bad id") }
            for ext in ["mp4", "jpg", "json", "part"] { try? FileManager.default.removeItem(at: dir.appendingPathComponent("\(id).\(ext)")) }
            reply(true, nil)
        case "bmRead": read(body, reply: reply)
        default: reply(nil, "unknown bookmark command")
        }
    }

    private func list(reply: @escaping (Any?, String?) -> Void) {
        guard let dir else { return reply([], nil) }
        // file reads off the main thread (a long list would hitch the UI), the answer back on it
        DispatchQueue.global(qos: .userInitiated).async {
            let out = Self.readList(dir)
            DispatchQueue.main.async { reply(out, nil) }
        }
    }
    private static func readList(_ dir: URL) -> [[String: Any]] {
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        var out: [[String: Any]] = []
        for f in files where f.pathExtension == "json" {
            let id = f.deletingPathExtension().lastPathComponent
            guard FileManager.default.fileExists(atPath: dir.appendingPathComponent("\(id).mp4").path),
                  let data = try? Data(contentsOf: f), var meta = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
            let size = (try? FileManager.default.attributesOfItem(atPath: dir.appendingPathComponent("\(id).mp4").path)[.size] as? Int) ?? 0
            meta["fileSize"] = size
            meta["hasCover"] = FileManager.default.fileExists(atPath: dir.appendingPathComponent("\(id).jpg").path)
            out.append(meta)
        }
        out.sort { ($0["savedAt"] as? Double ?? 0) > ($1["savedAt"] as? Double ?? 0) }
        return out
    }

    private func save(_ body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        guard let id = Self.validID(body["id"] as? String), let dir,
              let playS = body["play"] as? String, let play = URL(string: playS), play.scheme == "https", GhostTikTok.allowed(play.host ?? "") else { return reply(nil, "bad video") }
        guard !saving.contains(id) else { return reply(["ok": true, "busy": true], nil) }
        saving.insert(id)
        var meta = (body["meta"] as? [String: Any]) ?? [:]
        meta["id"] = id
        meta["savedAt"] = Date().timeIntervalSince1970 * 1000
        let cover = (body["cover"] as? String).flatMap { URL(string: $0) }.flatMap { ($0.scheme == "https" && GhostTikTok.allowed($0.host ?? "")) ? $0 : nil }
        let finish: (String?) -> Void = { [weak self] err in
            DispatchQueue.main.async {
                self?.saving.remove(id)
                if let err {
                    for ext in ["mp4", "part", "jpg", "json"] { try? FileManager.default.removeItem(at: dir.appendingPathComponent("\(id).\(ext)")) }
                    return reply(nil, err)
                }
                reply(["ok": true], nil)
            }
        }
        request(for: play) { [weak self] req in
            guard let self else { return finish("gone") }
            self.session.downloadTask(with: req) { tmp, response, error in
                if let error { return finish(error.localizedDescription) }
                guard let tmp, let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return finish("status \((response as? HTTPURLResponse)?.statusCode ?? 0)") }
                let size = (try? FileManager.default.attributesOfItem(atPath: tmp.path)[.size] as? Int) ?? 0
                guard size > 1000, size <= Self.maxVideo else { return finish("unexpected size") }
                let dest = dir.appendingPathComponent("\(id).mp4")
                try? FileManager.default.removeItem(at: dest)
                do { try FileManager.default.moveItem(at: tmp, to: dest) } catch { return finish("couldn't store it") }
                meta["fileSize"] = size
                let writeMeta = {
                    if let data = try? JSONSerialization.data(withJSONObject: meta) { try? data.write(to: dir.appendingPathComponent("\(id).json"), options: .atomic) }
                    finish(nil)
                }
                guard let cover else { return writeMeta() }
                self.request(for: cover) { creq in
                    self.session.dataTask(with: creq) { data, cresp, _ in
                        if let data, let h = cresp as? HTTPURLResponse, (200..<300).contains(h.statusCode), data.count < 5 * 1024 * 1024 {
                            // TikTok covers are often WebP/HEIC: store a JPEG so <img> shows it everywhere
                            let jpg = UIImage(data: data)?.jpegData(compressionQuality: 0.85) ?? data
                            try? jpg.write(to: dir.appendingPathComponent("\(id).jpg"), options: .atomic)
                        }
                        writeMeta()
                    }.resume()
                }
            }.resume()
        }
    }

    private func read(_ body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        guard let id = Self.validID(body["id"] as? String), let dir else { return reply(nil, "bad id") }
        let kind = body["kind"] as? String == "cover" ? "jpg" : "mp4"
        let url = dir.appendingPathComponent("\(id).\(kind)")
        DispatchQueue.global(qos: .userInitiated).async {
            guard let fh = try? FileHandle(forReadingFrom: url) else { return DispatchQueue.main.async { reply(nil, "missing") } }
            defer { try? fh.close() }
            let total = Int((try? fh.seekToEnd()) ?? 0)
            let start = max(0, min(total, body["offset"] as? Int ?? 0))
            let length = max(0, min(Self.maxChunk, total - start))
            try? fh.seek(toOffset: UInt64(start))
            let data = (try? fh.read(upToCount: length)) ?? Data()
            DispatchQueue.main.async {
                reply(["body": data.base64EncodedString(), "offset": start, "total": total, "type": kind == "jpg" ? "image/jpeg" : "video/mp4"], nil)
            }
        }
    }

    /// the request a browser would make for this TikTok CDN file: TikTok's cookies for that host, UA, Referer
    private func request(for url: URL, _ done: @escaping (URLRequest) -> Void) {
        WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cookies in
            var req = URLRequest(url: url)
            req.setValue(GhostTikTok.userAgent, forHTTPHeaderField: "User-Agent")
            req.setValue("https://www.tiktok.com/", forHTTPHeaderField: "Referer")
            let host = (url.host ?? "").lowercased()
            let matching = cookies.filter { c in
                let d = c.domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
                return GhostTikTok.allowed(d) && (host == d || host.hasSuffix("." + d))
            }
            if let c = HTTPCookie.requestHeaderFields(with: matching)["Cookie"], !c.isEmpty { req.setValue(c, forHTTPHeaderField: "Cookie") }
            done(req)
        }
    }

    // redirects only to TikTok's own hosts
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        guard let h = request.url?.host, request.url?.scheme == "https", GhostTikTok.allowed(h) else { return completionHandler(nil) }
        completionHandler(request)
    }
}
