import UIKit
import WebKit
import Photos
import AVFoundation
import CoreLocation

extension WKWebView {
    /// Runs JS in the "darkmobile" content world, where ghost/ui.js (and its window.__ghost* hooks) actually live -
    /// a plain evaluateJavaScript runs in the PAGE world, which can't see them (App.swift's own calls pass `world`).
    func ghostEval(_ js: String) {
        evaluateJavaScript(js, in: nil, in: WKContentWorld.world(name: "darkmobile"), completionHandler: nil)
    }
}

/// Ghost's Gallery tab (ghost/ui.js "Gallery" section): albums, month index, paged listing, "N years ago today",
/// info, favorite, delete, share, and Range-capable video playback for the viewer.
///
/// Thumbnails keep using GhostPhotoPicker's "ghostphoto://thumb/<id>" (asset ids are library-wide). Video playback
/// is "ghostphoto://video/<id>", forwarded here by GhostPhotoPicker's scheme handler: WebKit passes the <video>
/// element's Range header to WKURLSchemeHandler (WebKit r276932, iOS 15+), so we answer 206 slices of the
/// ORIGINAL local file (no re-encode) — one prepared file per asset, concurrent requests for the same asset wait
/// on the same preparation instead of each starting their own export.
final class GhostGallery: NSObject, PHPhotoLibraryChangeObserver {
    private weak var webView: WKWebView?
    private weak var presenter: UIViewController?
    private weak var picker: GhostPhotoPicker?

    // album id ("all" or a PHAssetCollection localIdentifier) -> newest-first fetch result + its month index
    private var fetchResults: [String: PHFetchResult<PHAsset>] = [:]
    private var monthIndex: [String: [[String: Int]]] = [:]
    private let workQueue = DispatchQueue(label: "ghost.gallery", qos: .userInitiated)

    // video playback: asset id -> local file url (original, or an export for iCloud-only / composition assets)
    private var videoFiles: [String: (url: URL, mime: String, temp: Bool)] = [:]
    private var videoOrder: [String] = [] // LRU of ids whose file is a temp export (trimmed to 3)
    private var videoWaiters: [String: [(URL?, String) -> Void]] = [:]

    init(presenter: UIViewController, picker: GhostPhotoPicker) {
        self.presenter = presenter
        self.picker = picker
        super.init()
        PHPhotoLibrary.shared().register(self)
        Self.sweepTemp()
    }

    deinit { PHPhotoLibrary.shared().unregisterChangeObserver(self) }

    func attach(to webView: WKWebView) { self.webView = webView }

    // MARK: - op dispatch (App.swift forwards every "gallery*" op here)

    func handle(op: String, body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        switch op {
        case "galleryAlbums": albums(reply: reply)
        case "galleryMonths": months(album: body["album"] as? String ?? "all", reply: reply)
        case "galleryList":
            list(album: body["album"] as? String ?? "all",
                 offset: (body["offset"] as? NSNumber)?.intValue ?? 0,
                 limit: (body["limit"] as? NSNumber)?.intValue ?? 120, reply: reply)
        case "galleryOnThisDay": onThisDay(reply: reply)
        case "galleryInfo":
            guard let id = body["id"] as? String else { return reply(nil, "bad id") }
            info(id: id, reply: reply)
        case "galleryFavorite":
            guard let id = body["id"] as? String else { return reply(nil, "bad id") }
            favorite(id: id, on: (body["on"] as? Bool) ?? true, reply: reply)
        case "galleryDelete":
            guard let ids = body["ids"] as? [String], !ids.isEmpty else { return reply(nil, "bad ids") }
            delete(ids: ids, reply: reply)
        case "galleryRender": render(body: body, reply: reply)
        case "galleryShare":
            guard let ids = body["ids"] as? [String], !ids.isEmpty else { return reply(nil, "bad ids") }
            share(ids: ids, reply: reply)
        default: reply(nil, "unknown op")
        }
    }

    // MARK: - fetching

    private static func mediaOptions() -> PHFetchOptions {
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.predicate = NSPredicate(format: "mediaType == %d OR mediaType == %d",
                                        PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue)
        return options
    }

    /// Must run on workQueue (fetchResults is only touched there, plus the main-queue change observer which
    /// hops onto workQueue too).
    private func fetch(album: String) -> PHFetchResult<PHAsset>? {
        if let cached = fetchResults[album] { return cached }
        let result: PHFetchResult<PHAsset>
        if album == "all" {
            result = PHAsset.fetchAssets(with: Self.mediaOptions())
        } else {
            guard let collection = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [album], options: nil).firstObject else { return nil }
            result = PHAsset.fetchAssets(in: collection, options: Self.mediaOptions())
        }
        fetchResults[album] = result
        return result
    }

    private static func itemDict(_ asset: PHAsset) -> [String: Any] {
        return [
            "id": asset.localIdentifier,
            "mediaType": asset.mediaType == .video ? "video" : "image",
            "duration": asset.duration,
            "width": asset.pixelWidth,
            "height": asset.pixelHeight,
            "date": (asset.creationDate?.timeIntervalSince1970 ?? 0) * 1000,
            "favorite": asset.isFavorite,
            "live": asset.mediaSubtypes.contains(.photoLive),
        ]
    }

    private func albums(reply: @escaping (Any?, String?) -> Void) {
        workQueue.async {
            var out: [[String: Any]] = []
            func add(_ collection: PHAssetCollection, kind: String) {
                let result = PHAsset.fetchAssets(in: collection, options: Self.mediaOptions())
                guard result.count > 0 || kind == "smart-fav" else { return }
                out.append([
                    "id": collection.localIdentifier,
                    "title": collection.localizedTitle ?? "Album",
                    "count": result.count,
                    "cover": result.firstObject?.localIdentifier ?? "",
                    "kind": kind,
                ])
            }
            let smart: [(PHAssetCollectionSubtype, String)] = [
                (.smartAlbumFavorites, "smart-fav"), (.smartAlbumVideos, "smart"), (.smartAlbumScreenshots, "smart"),
                (.smartAlbumSelfPortraits, "smart"), (.smartAlbumLivePhotos, "smart"), (.smartAlbumPanoramas, "smart"),
            ]
            for (subtype, kind) in smart {
                if let c = PHAssetCollection.fetchAssetCollections(with: .smartAlbum, subtype: subtype, options: nil).firstObject { add(c, kind: kind) }
            }
            let user = PHAssetCollection.fetchAssetCollections(with: .album, subtype: .any, options: nil)
            user.enumerateObjects { c, _, _ in add(c, kind: "user") }
            let all = self.fetch(album: "all")
            let head: [String: Any] = ["id": "all", "title": "Recents", "count": all?.count ?? 0,
                                       "cover": all?.firstObject?.localIdentifier ?? "", "kind": "all"]
            DispatchQueue.main.async { reply(["albums": [head] + out], nil) }
        }
    }

    /// Newest-first [{y, m (1-12), count}] for the whole album, so the grid can lay out every month section (and
    /// the scrubber can jump anywhere) before any page of metadata is loaded.
    private func months(album: String, reply: @escaping (Any?, String?) -> Void) {
        workQueue.async {
            if let cached = self.monthIndex[album], let result = self.fetchResults[album] {
                return DispatchQueue.main.async { reply(["months": cached, "total": result.count], nil) }
            }
            guard let result = self.fetch(album: album) else {
                return DispatchQueue.main.async { reply(["months": [], "total": 0], nil) }
            }
            let cal = Calendar.current
            var months: [[String: Int]] = []
            var curY = Int.min, curM = Int.min, count = 0
            result.enumerateObjects { asset, _, _ in
                let d = asset.creationDate ?? Date(timeIntervalSince1970: 0)
                let comps = cal.dateComponents([.year, .month], from: d)
                let y = comps.year ?? 1970, m = comps.month ?? 1
                if y != curY || m != curM {
                    if count > 0 { months.append(["y": curY, "m": curM, "count": count]) }
                    curY = y; curM = m; count = 0
                }
                count += 1
            }
            if count > 0 { months.append(["y": curY, "m": curM, "count": count]) }
            self.monthIndex[album] = months
            DispatchQueue.main.async { reply(["months": months, "total": result.count], nil) }
        }
    }

    private func list(album: String, offset: Int, limit: Int, reply: @escaping (Any?, String?) -> Void) {
        workQueue.async {
            guard let result = self.fetch(album: album) else {
                return DispatchQueue.main.async { reply(["items": [], "total": 0], nil) }
            }
            let total = result.count
            let start = max(0, min(offset, total))
            let end = max(start, min(start + max(0, min(limit, 500)), total))
            var items: [[String: Any]] = []
            items.reserveCapacity(end - start)
            if start < end {
                result.enumerateObjects(at: IndexSet(integersIn: start..<end)) { asset, _, _ in items.append(Self.itemDict(asset)) }
            }
            DispatchQueue.main.async { reply(["items": items, "offset": start, "total": total], nil) }
        }
    }

    /// One entry per past year that has photos on today's month/day (local time zone), newest year first.
    /// Feb 29 photos also show on Feb 28 when the current year isn't a leap year.
    private func onThisDay(reply: @escaping (Any?, String?) -> Void) {
        workQueue.async {
            let cal = Calendar.current
            let now = Date()
            let today = cal.dateComponents([.year, .month, .day], from: now)
            guard let thisYear = today.year, let month = today.month, let day = today.day else {
                return DispatchQueue.main.async { reply(["years": []], nil) }
            }
            let thisYearIsLeap = cal.range(of: .day, in: .month, for: cal.date(from: DateComponents(year: thisYear, month: 2, day: 1)) ?? now)?.count == 29
            var years: [[String: Any]] = []
            for back in 1...30 {
                let y = thisYear - back
                var days = [day]
                if month == 2 && day == 28 && !thisYearIsLeap { days.append(29) }
                var ranges: [NSPredicate] = []
                for d in days {
                    guard let start = cal.date(from: DateComponents(year: y, month: month, day: d)),
                          cal.component(.day, from: start) == d, // Feb 29 in a non-leap year rolls to Mar 1: skip
                          let end = cal.date(byAdding: .day, value: 1, to: start) else { continue }
                    ranges.append(NSPredicate(format: "creationDate >= %@ AND creationDate < %@", start as NSDate, end as NSDate))
                }
                if ranges.isEmpty { continue }
                let options = Self.mediaOptions()
                options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
                options.predicate = NSCompoundPredicate(andPredicateWithSubpredicates: [
                    NSPredicate(format: "mediaType == %d OR mediaType == %d", PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue),
                    NSCompoundPredicate(orPredicateWithSubpredicates: ranges),
                ])
                let result = PHAsset.fetchAssets(with: options)
                guard result.count > 0 else { continue }
                var items: [[String: Any]] = []
                result.enumerateObjects(at: IndexSet(integersIn: 0..<min(result.count, 500))) { asset, _, _ in items.append(Self.itemDict(asset)) }
                years.append(["yearsAgo": back, "year": y, "count": result.count, "items": items])
            }
            DispatchQueue.main.async { reply(["years": years, "month": month, "day": day], nil) }
        }
    }

    private func asset(_ id: String) -> PHAsset? {
        PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject
    }

    // MARK: - info / favorite / delete

    private func info(id: String, reply: @escaping (Any?, String?) -> Void) {
        guard let asset = asset(id) else { return reply(nil, "not found") }
        var out = Self.itemDict(asset)
        let resources = PHAssetResource.assetResources(for: asset)
        let primary = resources.first(where: { $0.type == .photo || $0.type == .video }) ?? resources.first
        if let primary {
            out["filename"] = primary.originalFilename
            // "fileSize" isn't public API; read defensively and just omit it if the key ever disappears
            if let size = (primary.value(forKey: "fileSize") as? NSNumber)?.int64Value { out["size"] = size }
        }
        if let modified = asset.modificationDate { out["modified"] = modified.timeIntervalSince1970 * 1000 }
        out["cloud"] = asset.sourceType.contains(.typeCloudShared)
        guard let location = asset.location else { return reply(out, nil) }
        out["lat"] = location.coordinate.latitude
        out["lon"] = location.coordinate.longitude
        var replied = false
        let finish: (String?) -> Void = { place in
            DispatchQueue.main.async {
                guard !replied else { return }
                replied = true
                if let place { out["place"] = place }
                reply(out, nil)
            }
        }
        CLGeocoder().reverseGeocodeLocation(location) { marks, _ in
            let m = marks?.first
            let parts = [m?.name, m?.locality, m?.country].compactMap { $0 }.filter { !$0.isEmpty }
            var seen = Set<String>()
            finish(parts.isEmpty ? nil : parts.filter { seen.insert($0).inserted }.joined(separator: ", "))
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { finish(nil) } // offline: don't hang the info sheet
    }

    private func favorite(id: String, on: Bool, reply: @escaping (Any?, String?) -> Void) {
        guard let asset = asset(id) else { return reply(nil, "not found") }
        PHPhotoLibrary.shared().performChanges({
            PHAssetChangeRequest(for: asset).isFavorite = on
        }) { ok, error in
            DispatchQueue.main.async { ok ? reply(["favorite": on], nil) : reply(nil, error?.localizedDescription ?? "couldn't change favorite") }
        }
    }

    /// iOS shows its own confirmation; cancelling it comes back as an error, reported as "cancelled".
    private func delete(ids: [String], reply: @escaping (Any?, String?) -> Void) {
        let assets = PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil)
        guard assets.count > 0 else { return reply(nil, "not found") }
        PHPhotoLibrary.shared().performChanges({
            PHAssetChangeRequest.deleteAssets(assets)
        }) { ok, error in
            if ok {
                // drop cached fetch results first so the JS reload that follows this reply already sees the
                // deletion (the change observer's own update can arrive after the reply)
                return self.workQueue.async {
                    self.fetchResults.removeAll()
                    self.monthIndex.removeAll()
                    DispatchQueue.main.async { reply(["deleted": ids], nil) }
                }
            }
            DispatchQueue.main.async {
                let ns = error as NSError?
                // PHPhotosError.userCancelled (3072)
                if ns?.code == 3072 { return reply(["deleted": [], "cancelled": true], nil) }
                reply(nil, error?.localizedDescription ?? "couldn't delete")
            }
        }
    }

    // MARK: - share (original files through the iOS share sheet)

    private func share(ids: [String], reply: @escaping (Any?, String?) -> Void) {
        let assets = PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil)
        var list: [PHAsset] = []
        assets.enumerateObjects { a, _, _ in list.append(a) }
        guard !list.isEmpty else { return reply(nil, "not found") }
        let dir = Self.tempRoot.appendingPathComponent("share-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let group = DispatchGroup()
        var urls: [URL] = []
        let lock = NSLock()
        for asset in list {
            let resources = PHAssetResource.assetResources(for: asset)
            // the current (edited if edited) full-size version first, else the original
            let preferred: PHAssetResourceType = asset.mediaType == .video ? .fullSizeVideo : .fullSizePhoto
            let original: PHAssetResourceType = asset.mediaType == .video ? .video : .photo
            guard let res = resources.first(where: { $0.type == preferred }) ?? resources.first(where: { $0.type == original }) else { continue }
            let url = dir.appendingPathComponent(res.originalFilename.isEmpty ? UUID().uuidString : res.originalFilename)
            let opts = PHAssetResourceRequestOptions()
            opts.isNetworkAccessAllowed = true
            group.enter()
            PHAssetResourceManager.default().writeData(for: res, toFile: url, options: opts) { error in
                if error == nil { lock.lock(); urls.append(url); lock.unlock() }
                group.leave()
            }
        }
        group.notify(queue: .main) { [weak self] in
            guard let self, let presenter = self.presenter, !urls.isEmpty else {
                try? FileManager.default.removeItem(at: dir)
                return reply(nil, "couldn't prepare the files")
            }
            let sheet = UIActivityViewController(activityItems: urls, applicationActivities: nil)
            sheet.completionWithItemsHandler = { _, _, _, _ in try? FileManager.default.removeItem(at: dir) }
            if let pop = sheet.popoverPresentationController {
                pop.sourceView = presenter.view
                pop.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.maxY - 80, width: 1, height: 1)
            }
            presenter.present(sheet, animated: true)
            reply(["shared": urls.count], nil)
        }
    }

    // MARK: - edits: overlay (drawing/text/stickers PNG from the JS editor) composited onto the ORIGINAL

    /// op "galleryRender" {source: {type: "library", id} | {type: "data", data (base64), kind}, overlay (base64 PNG,
    /// optional), mode: "send" | "copy" | "replace"}. The JS editor only renders the overlay (capped size); the
    /// full-resolution composite happens here, so 48 MP photos never go through a WebKit canvas and big videos never
    /// go through JS. send -> {data, mime} (photo ≤ 2560 px, medium video); copy -> new library item;
    /// replace -> PHContentEditingOutput on the original (library only; revertible in Photos).
    /// fx (optional, ghost/snapfx.js): the snap filter - colour look {matrix, fade, vignette, grain}, video speed/reverse
    /// (SnapFX.swift). full: a camera snap's video is sent at full quality (it went out untouched before 1.12).
    private func render(body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        guard let source = body["source"] as? [String: Any], let type = source["type"] as? String,
              let mode = body["mode"] as? String else { return reply(nil, "bad args") }
        let overlay: UIImage? = (body["overlay"] as? String).flatMap { Data(base64Encoded: $0) }.flatMap { UIImage(data: $0) }
        let fx = body["fx"] as? [String: Any]
        let full = body["full"] as? Bool ?? false
        let done: (Any?, String?) -> Void = { value, error in DispatchQueue.main.async { reply(value, error) } }
        if type == "data" {
            guard let b64 = source["data"] as? String, let data = Data(base64Encoded: b64) else { return reply(nil, "no data") }
            let isVideo = (source["kind"] as? String) == "video"
            DispatchQueue.global(qos: .userInitiated).async {
                if isVideo {
                    let inURL = GhostGallery.tempRoot.appendingPathComponent("in-\(UUID().uuidString).mp4")
                    do { try data.write(to: inURL) } catch { return done(nil, "couldn't read that video") }
                    self.finishVideo(asset: AVURLAsset(url: inURL), overlay: overlay, mode: mode, fx: fx, full: full) { value, error in
                        try? FileManager.default.removeItem(at: inURL)
                        done(value, error)
                    }
                } else {
                    guard let image = UIImage(data: data) else { return done(nil, "couldn't read that photo") }
                    self.finishPhoto(image: image, overlay: overlay, mode: mode, fx: fx, reply: done)
                }
            }
            return
        }
        guard type == "library", let id = source["id"] as? String, let asset = asset(id) else { return reply(nil, "not found") }
        if mode == "replace" { return replace(asset: asset, overlay: overlay, fx: fx, reply: done) }
        if asset.mediaType == .video {
            let options = PHVideoRequestOptions()
            options.isNetworkAccessAllowed = true
            options.deliveryMode = .highQualityFormat
            options.version = .current
            options.progressHandler = { [weak self] progress, _, _, _ in self?.reportProgress(id: id, progress) }
            PHImageManager.default().requestAVAsset(forVideo: asset, options: options) { av, _, _ in
                guard let av else { return done(nil, "couldn't open that video") }
                self.finishVideo(asset: av, overlay: overlay, mode: mode, fx: fx, full: false, reply: done)
            }
        } else {
            let options = PHImageRequestOptions()
            options.isNetworkAccessAllowed = true
            options.deliveryMode = .highQualityFormat
            options.version = .current
            options.isSynchronous = false
            options.progressHandler = { [weak self] progress, _, _, _ in self?.reportProgress(id: id, progress) }
            PHImageManager.default().requestImageDataAndOrientation(for: asset, options: options) { data, _, _, _ in
                DispatchQueue.global(qos: .userInitiated).async {
                    guard let data, let image = UIImage(data: data) else { return done(nil, "couldn't open that photo") }
                    self.finishPhoto(image: image, overlay: overlay, mode: mode, fx: fx, reply: done)
                }
            }
        }
    }

    /// Draws the photo (EXIF orientation applied by UIImage), its snap filter (fx) and the overlay stretched over it, as a JPEG.
    static func composite(image: UIImage, overlay: UIImage?, maxEdge: CGFloat?, fx: [String: Any]? = nil) -> Data? {
        var size = CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
        if let maxEdge, max(size.width, size.height) > maxEdge {
            let k = maxEdge / max(size.width, size.height)
            size = CGSize(width: (size.width * k).rounded(), height: (size.height * k).rounded())
        }
        guard size.width >= 1, size.height >= 1 else { return nil }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        let rect = CGRect(origin: .zero, size: size)
        var base = image
        if let look = SnapFX.look(fx) { // filter the photo at its final size, then draw the overlay on top
            let plain = renderer.image { _ in image.draw(in: rect) }
            if let filtered = SnapFX.filtered(plain, look: look) { base = filtered }
        }
        return renderer.jpegData(withCompressionQuality: 0.92) { _ in
            base.draw(in: rect)
            overlay?.draw(in: rect)
        }
    }

    private func finishPhoto(image: UIImage, overlay: UIImage?, mode: String, fx: [String: Any]?, reply: @escaping (Any?, String?) -> Void) {
        guard let jpeg = Self.composite(image: image, overlay: overlay, maxEdge: mode == "send" ? 2560 : nil, fx: fx) else {
            return reply(nil, "couldn't draw that photo")
        }
        if mode == "send" { return reply(["data": jpeg.base64EncodedString(), "mime": "image/jpeg"], nil) }
        let url = Self.tempRoot.appendingPathComponent("edit-\(UUID().uuidString).jpg")
        do { try jpeg.write(to: url) } catch { return reply(nil, error.localizedDescription) }
        PHPhotoLibrary.shared().performChanges({
            _ = PHAssetChangeRequest.creationRequestForAssetFromImage(atFileURL: url)
        }) { ok, error in
            try? FileManager.default.removeItem(at: url)
            ok ? reply(["saved": true], nil) : reply(nil, error?.localizedDescription ?? "couldn't save")
        }
    }

    private func finishVideo(asset: AVAsset, overlay: UIImage?, mode: String, fx: [String: Any]?, full: Bool, reply: @escaping (Any?, String?) -> Void) {
        let out = Self.tempRoot.appendingPathComponent("edit-\(UUID().uuidString).mp4")
        let preset = mode == "send" && !full ? AVAssetExportPresetMediumQuality : AVAssetExportPresetHighestQuality
        Self.compositeVideo(asset: asset, overlay: overlay, preset: preset, fileType: .mp4, outputURL: out, fx: fx) { ok in
            guard ok else { try? FileManager.default.removeItem(at: out); return reply(nil, "couldn't render that video") }
            if mode == "send" {
                defer { try? FileManager.default.removeItem(at: out) }
                guard let data = try? Data(contentsOf: out) else { return reply(nil, "couldn't read the rendered video") }
                return reply(["data": data.base64EncodedString(), "mime": "video/mp4"], nil)
            }
            PHPhotoLibrary.shared().performChanges({
                _ = PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: out)
            }) { ok, error in
                try? FileManager.default.removeItem(at: out)
                ok ? reply(["saved": true], nil) : reply(nil, error?.localizedDescription ?? "couldn't save")
            }
        }
    }

    /// Video + full-frame overlay via AVVideoCompositionCoreAnimationTool, honouring the track's preferredTransform
    /// (portrait iPhone video is stored landscape + a rotation). Without an overlay it's a plain (re-)export.
    /// A snap filter or speed change (fx) goes through SnapFX.renderVideo instead (Core Image per frame).
    static func compositeVideo(asset: AVAsset, overlay: UIImage?, preset: String, fileType: AVFileType, outputURL: URL,
                               fx: [String: Any]? = nil, completion: @escaping (Bool) -> Void) {
        if SnapFX.changesVideo(fx) {
            return SnapFX.renderVideo(asset: asset, overlay: overlay, fx: fx ?? [:], preset: preset, fileType: fileType, outputURL: outputURL, completion: completion)
        }
        guard let srcVideo = asset.tracks(withMediaType: .video).first else { return completion(false) }
        let composition = AVMutableComposition()
        let range = CMTimeRange(start: .zero, duration: asset.duration)
        guard let vTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else { return completion(false) }
        do { try vTrack.insertTimeRange(range, of: srcVideo, at: .zero) } catch { return completion(false) }
        if let srcAudio = asset.tracks(withMediaType: .audio).first,
           let aTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
            try? aTrack.insertTimeRange(range, of: srcAudio, at: .zero)
        }
        let t = srcVideo.preferredTransform
        let box = CGRect(origin: .zero, size: srcVideo.naturalSize).applying(t)
        let renderSize = CGSize(width: abs(box.width).rounded(), height: abs(box.height).rounded())
        let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: vTrack)
        layerInstruction.setTransform(t.concatenating(CGAffineTransform(translationX: -box.origin.x, y: -box.origin.y)), at: .zero)
        let instruction = AVMutableVideoCompositionInstruction()
        instruction.timeRange = range
        instruction.layerInstructions = [layerInstruction]
        let videoComposition = AVMutableVideoComposition()
        videoComposition.renderSize = renderSize
        let fps = srcVideo.nominalFrameRate > 0 ? srcVideo.nominalFrameRate : 30
        videoComposition.frameDuration = CMTime(value: 1, timescale: CMTimeScale(max(1, min(120, fps.rounded()))))
        videoComposition.instructions = [instruction]
        if let cg = overlay?.cgImage {
            let frame = CGRect(origin: .zero, size: renderSize)
            let parent = CALayer()
            parent.frame = frame
            let videoLayer = CALayer()
            videoLayer.frame = frame
            let overlayLayer = CALayer()
            overlayLayer.frame = frame
            overlayLayer.contents = cg
            overlayLayer.contentsGravity = .resize
            parent.addSublayer(videoLayer)
            parent.addSublayer(overlayLayer)
            videoComposition.animationTool = AVVideoCompositionCoreAnimationTool(postProcessingAsVideoLayer: videoLayer, in: parent)
        }
        guard let session = AVAssetExportSession(asset: composition, presetName: preset) else { return completion(false) }
        try? FileManager.default.removeItem(at: outputURL)
        session.videoComposition = videoComposition
        session.outputURL = outputURL
        session.outputFileType = fileType
        session.shouldOptimizeForNetworkUse = true
        session.exportAsynchronously { completion(session.status == .completed) }
    }

    /// "Replace original": a real Photos edit (PHContentEditingOutput) so the Photos app can still Revert it.
    private func replace(asset: PHAsset, overlay: UIImage?, fx: [String: Any]?, reply: @escaping (Any?, String?) -> Void) {
        let options = PHContentEditingInputRequestOptions()
        options.isNetworkAccessAllowed = true
        options.canHandleAdjustmentData = { _ in false }
        asset.requestContentEditingInput(with: options) { input, _ in
            guard let input else { return reply(nil, "couldn't open the original") }
            let output = PHContentEditingOutput(contentEditingInput: input)
            output.adjustmentData = PHAdjustmentData(formatIdentifier: "com.dltnp.ghost.edit", formatVersion: "1", data: Data("ghost-overlay".utf8))
            let commit: () -> Void = {
                PHPhotoLibrary.shared().performChanges({
                    PHAssetChangeRequest(for: asset).contentEditingOutput = output
                }) { ok, error in
                    ok ? reply(["replaced": true], nil) : reply(nil, error?.localizedDescription ?? "couldn't replace the original")
                }
            }
            DispatchQueue.global(qos: .userInitiated).async {
                if asset.mediaType == .video {
                    guard let av = input.audiovisualAsset else { return reply(nil, "couldn't open the original video") }
                    Self.compositeVideo(asset: av, overlay: overlay, preset: AVAssetExportPresetHighestQuality, fileType: .mov,
                                        outputURL: output.renderedContentURL, fx: fx) { ok in
                        ok ? commit() : reply(nil, "couldn't render that video")
                    }
                } else {
                    guard let url = input.fullSizeImageURL, let data = try? Data(contentsOf: url), let image = UIImage(data: data),
                          let jpeg = Self.composite(image: image, overlay: overlay, maxEdge: nil, fx: fx) else {
                        return reply(nil, "couldn't open the original photo")
                    }
                    do { try jpeg.write(to: output.renderedContentURL) } catch { return reply(nil, error.localizedDescription) }
                    commit()
                }
            }
        }
    }

    // MARK: - video playback (called from GhostPhotoPicker's scheme handler for host "video")

    func serveVideo(id: String, task: WKURLSchemeTask) {
        prepareVideo(id: id) { [weak self] url, mime in
            guard let self, let picker = self.picker else { return }
            guard let url else { return picker.failTask(task, 404) }
            picker.respondFile(task, url: url, mime: mime)
        }
    }

    private func prepareVideo(id: String, done: @escaping (URL?, String) -> Void) {
        if let hit = videoFiles[id], FileManager.default.fileExists(atPath: hit.url.path) {
            // real LRU: the video being watched (it keeps asking for more Ranges) must never be the one trimmed
            if hit.temp, let i = videoOrder.firstIndex(of: id) { videoOrder.remove(at: i); videoOrder.append(id) }
            return done(hit.url, hit.mime)
        }
        if videoWaiters[id] != nil { videoWaiters[id]?.append(done); return }
        videoWaiters[id] = [done]
        let finish: (URL?, String, Bool) -> Void = { [weak self] url, mime, temp in
            DispatchQueue.main.async {
                guard let self else { return }
                if let url {
                    self.videoFiles[id] = (url, mime, temp)
                    if temp { self.videoOrder.append(id); self.trimVideoCache() }
                }
                let waiters = self.videoWaiters.removeValue(forKey: id) ?? []
                for w in waiters { w(url, mime) }
            }
        }
        guard let asset = asset(id), asset.mediaType == .video else { return finish(nil, "", false) }
        let options = PHVideoRequestOptions()
        options.isNetworkAccessAllowed = true
        options.deliveryMode = .highQualityFormat
        options.version = .current
        options.progressHandler = { [weak self] progress, _, _, _ in self?.reportProgress(id: id, progress) }
        PHImageManager.default().requestAVAsset(forVideo: asset, options: options) { av, _, _ in
            if let urlAsset = av as? AVURLAsset, FileManager.default.isReadableFile(atPath: urlAsset.url.path) {
                let ext = urlAsset.url.pathExtension.lowercased()
                return finish(urlAsset.url, ext == "mov" ? "video/quicktime" : "video/mp4", false)
            }
            // slow-motion (AVComposition) or unreadable: export once to our own temp file
            guard let av, let session = AVAssetExportSession(asset: av, presetName: AVAssetExportPresetHighestQuality) else {
                return finish(nil, "", false)
            }
            let out = GhostGallery.tempRoot.appendingPathComponent("video-\(UUID().uuidString).mp4")
            session.outputURL = out
            session.outputFileType = .mp4
            session.exportAsynchronously {
                if session.status == .completed { finish(out, "video/mp4", true) } else { try? FileManager.default.removeItem(at: out); finish(nil, "", false) }
            }
        }
    }

    private func trimVideoCache() {
        while videoOrder.count > 3 {
            let old = videoOrder.removeFirst()
            if let entry = videoFiles.removeValue(forKey: old), entry.temp { try? FileManager.default.removeItem(at: entry.url) }
        }
    }

    private func reportProgress(id: String, _ progress: Double) {
        DispatchQueue.main.async { [weak self] in
            guard let data = try? JSONSerialization.data(withJSONObject: [id]), let s = String(data: data, encoding: .utf8) else { return }
            self?.webView?.ghostEval("window.__ghostGalleryProgress && window.__ghostGalleryProgress(\(s)[0], \(progress))")
        }
    }

    // MARK: - temp files

    static var tempRoot: URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("ghost-gallery", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private static func sweepTemp() {
        let root = tempRoot
        let items = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        for item in items { try? FileManager.default.removeItem(at: item) }
    }

    // MARK: - PHPhotoLibraryChangeObserver

    func photoLibraryDidChange(_ changeInstance: PHChange) {
        workQueue.async { [weak self] in
            guard let self else { return }
            var changed: [String] = []
            for (album, result) in self.fetchResults {
                guard let details = changeInstance.changeDetails(for: result) else { continue }
                self.fetchResults[album] = details.fetchResultAfterChanges
                self.monthIndex[album] = nil
                changed.append(album)
            }
            DispatchQueue.main.async {
                guard !changed.isEmpty, let data = try? JSONSerialization.data(withJSONObject: changed),
                      let s = String(data: data, encoding: .utf8) else { return }
                self.webView?.ghostEval("window.__ghostGalleryChanged && window.__ghostGalleryChanged(\(s))")
            }
        }
    }
}
