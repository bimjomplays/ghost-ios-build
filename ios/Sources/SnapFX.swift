import AVFoundation
import CoreImage
import UIKit
import Vision

/// Ghost snap filters (ghost/snapfx.js has the looks and the photo renderer): the native half.
///  - colour looks on videos and on Gallery/My Eyes Only edits, the same maths as snapfx.js with Core Image
///  - slow-mo / fast / rewind on videos (fx.speed, fx.reverse)
///  - op "snapBackground": portrait blur or a new background behind the people in a photo (Vision)
enum SnapFX {
    struct Look {
        let matrix: [CGFloat] // rows r, g, b: three weights + an offset (sRGB 0..1)
        let fade: CGFloat
        let vignette: CGFloat
        let grain: CGFloat
    }

    static let context = CIContext()

    static func look(_ fx: [String: Any]?) -> Look? {
        guard let fx, let raw = fx["matrix"] as? [Any], raw.count == 12 else { return nil }
        let m = raw.compactMap { ($0 as? NSNumber).map { CGFloat($0.doubleValue) } }
        guard m.count == 12 else { return nil }
        func num(_ key: String) -> CGFloat { CGFloat((fx[key] as? NSNumber)?.doubleValue ?? 0) }
        return Look(matrix: m, fade: num("fade"), vignette: num("vignette"), grain: num("grain"))
    }

    static func speed(_ fx: [String: Any]?) -> Double {
        let s = (fx?["speed"] as? NSNumber)?.doubleValue ?? 1
        return s > 0.05 && s < 20 ? s : 1
    }

    static func changesVideo(_ fx: [String: Any]?) -> Bool {
        look(fx) != nil || abs(speed(fx) - 1) > 0.01 || fx?["reverse"] as? Bool == true
    }

    /// The look on one image. Core Image works on linear light, snapfx.js on sRGB values: convert around the maths.
    static func apply(_ look: Look, to input: CIImage, seed: Int = 0) -> CIImage {
        let extent = input.extent
        let m = look.matrix
        var img = input.applyingFilter("CILinearToSRGBToneCurve")
        img = img.applyingFilter("CIColorMatrix", parameters: [
            "inputRVector": CIVector(x: m[0], y: m[1], z: m[2], w: 0),
            "inputGVector": CIVector(x: m[4], y: m[5], z: m[6], w: 0),
            "inputBVector": CIVector(x: m[8], y: m[9], z: m[10], w: 0),
            "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 1),
            "inputBiasVector": CIVector(x: m[3], y: m[7], z: m[11], w: 0),
        ])
        if look.fade > 0 {
            let k = 1 - 1.4 * look.fade
            img = img.applyingFilter("CIColorMatrix", parameters: [
                "inputRVector": CIVector(x: k, y: 0, z: 0, w: 0),
                "inputGVector": CIVector(x: 0, y: k, z: 0, w: 0),
                "inputBVector": CIVector(x: 0, y: 0, z: k, w: 0),
                "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 1),
                "inputBiasVector": CIVector(x: look.fade, y: look.fade, z: look.fade, w: 0),
            ])
        }
        if look.vignette > 0 {
            let r = hypot(extent.width, extent.height) / 2
            let v = 1 - look.vignette
            if let gradient = CIFilter(name: "CIRadialGradient", parameters: [
                "inputCenter": CIVector(x: extent.midX, y: extent.midY),
                "inputRadius0": r * 0.3, "inputRadius1": r,
                "inputColor0": CIColor(red: 1, green: 1, blue: 1),
                "inputColor1": CIColor(red: v, green: v, blue: v),
            ])?.outputImage?.cropped(to: extent) {
                // the gradient's colours are sRGB and get linearised: multiply in linear light (≈ the same product)
                img = img.applyingFilter("CISRGBToneCurveToLinear")
                    .applyingFilter("CIMultiplyCompositing", parameters: [kCIInputBackgroundImageKey: gradient])
                    .applyingFilter("CILinearToSRGBToneCurve")
            }
        }
        if look.grain > 0, let noise = CIFilter(name: "CIRandomGenerator")?.outputImage {
            let g = look.grain
            let shift = CGAffineTransform(translationX: CGFloat((seed * 7919) % 997), y: CGFloat((seed * 104_729) % 991))
            let grey = noise.transformed(by: shift).applyingFilter("CIColorMatrix", parameters: [
                "inputRVector": CIVector(x: g, y: 0, z: 0, w: 0),
                "inputGVector": CIVector(x: g, y: 0, z: 0, w: 0),
                "inputBVector": CIVector(x: g, y: 0, z: 0, w: 0),
                "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 0),
                "inputBiasVector": CIVector(x: -g / 2, y: -g / 2, z: -g / 2, w: 0),
            ]).cropped(to: extent)
            img = grey.applyingFilter("CIAdditionCompositing", parameters: [kCIInputBackgroundImageKey: img])
        }
        return img.applyingFilter("CIColorClamp").applyingFilter("CISRGBToneCurveToLinear").cropped(to: extent)
    }

    /// An upright (scale 1) photo with the look applied.
    static func filtered(_ image: UIImage, look: Look) -> UIImage? {
        guard let cg = image.cgImage else { return nil }
        let out = apply(look, to: CIImage(cgImage: cg))
        guard let rendered = context.createCGImage(out, from: out.extent) else { return nil }
        return UIImage(cgImage: rendered)
    }

    // MARK: - video: look + overlay per frame, speed, rewind

    /// fx: {matrix, fade, vignette, grain} (optional look), speed (0.5 slow-mo, 2 fast), reverse (rewind: muted,
    /// at most the first 15 s). The overlay (drawing/text/stickers/info filter PNG) is drawn over every frame.
    static func renderVideo(asset: AVAsset, overlay: UIImage?, fx: [String: Any], preset: String, fileType: AVFileType,
                            outputURL: URL, completion: @escaping (Bool) -> Void) {
        guard let srcVideo = asset.tracks(withMediaType: .video).first else { return completion(false) }
        let lk = SnapFX.look(fx)
        let spd = SnapFX.speed(fx)
        let reverse = fx["reverse"] as? Bool == true
        var duration = asset.duration
        if reverse { duration = CMTimeMinimum(duration, CMTime(seconds: 15, preferredTimescale: 600)) }
        let range = CMTimeRange(start: .zero, duration: duration)
        let composition = AVMutableComposition()
        guard let vTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else { return completion(false) }
        do { try vTrack.insertTimeRange(range, of: srcVideo, at: .zero) } catch { return completion(false) }
        vTrack.preferredTransform = srcVideo.preferredTransform
        if !reverse, let srcAudio = asset.tracks(withMediaType: .audio).first,
           let aTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
            try? aTrack.insertTimeRange(range, of: srcAudio, at: .zero)
        }
        if abs(spd - 1) > 0.01 {
            composition.scaleTimeRange(range, toDuration: CMTimeMultiplyByFloat64(duration, multiplier: 1 / spd))
        }
        let t = srcVideo.preferredTransform
        let natural = srcVideo.naturalSize
        let box = CGRect(origin: .zero, size: natural).applying(t)
        let renderSize = CGSize(width: abs(box.width).rounded(), height: abs(box.height).rounded())
        guard renderSize.width >= 1, renderSize.height >= 1 else { return completion(false) }
        // the track's transform works in top-left (y down) coordinates, Core Image's in bottom-left: flip around it
        let upright = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: natural.height)
            .concatenating(t.concatenating(CGAffineTransform(translationX: -box.origin.x, y: -box.origin.y)))
            .concatenating(CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: renderSize.height))
        let rotated = abs(natural.width - renderSize.width) >= 1
        let frame = CGRect(origin: .zero, size: renderSize)
        var overlayImage: CIImage?
        if let cg = overlay?.cgImage, cg.width > 0, cg.height > 0 {
            overlayImage = CIImage(cgImage: cg).transformed(by: CGAffineTransform(scaleX: renderSize.width / CGFloat(cg.width), y: renderSize.height / CGFloat(cg.height)))
        }
        let fps = srcVideo.nominalFrameRate > 0 ? srcVideo.nominalFrameRate : 30
        let videoComposition = AVMutableVideoComposition(asset: composition) { request in
            var img = request.sourceImage
            // depending on the iOS version the frame arrives as stored (a portrait clip lying on its side): turn it upright
            if rotated, abs(img.extent.width - natural.width) < 1, abs(img.extent.height - natural.height) < 1 {
                img = img.transformed(by: upright)
            }
            img = img.transformed(by: CGAffineTransform(translationX: -img.extent.origin.x, y: -img.extent.origin.y))
            if let lk { img = SnapFX.apply(lk, to: img, seed: Int(max(0, CMTimeGetSeconds(request.compositionTime)) * 30)) }
            if let overlayImage { img = overlayImage.composited(over: img) }
            request.finish(with: img.cropped(to: frame), context: nil)
        }
        videoComposition.renderSize = renderSize
        videoComposition.frameDuration = CMTime(value: 1, timescale: CMTimeScale(max(1, min(120, fps.rounded()))))
        guard let session = AVAssetExportSession(asset: composition, presetName: preset) else { return completion(false) }
        let target = reverse ? GhostGallery.tempRoot.appendingPathComponent("fwd-\(UUID().uuidString).mp4") : outputURL
        try? FileManager.default.removeItem(at: target)
        session.videoComposition = videoComposition
        session.audioTimePitchAlgorithm = .varispeed // slow-mo sounds slowed down, like Snapchat's
        session.outputURL = target
        session.outputFileType = reverse ? .mp4 : fileType
        session.shouldOptimizeForNetworkUse = true
        session.exportAsynchronously {
            guard session.status == .completed else { try? FileManager.default.removeItem(at: target); return completion(false) }
            guard reverse else { return completion(true) }
            SnapFX.reverseVideo(from: target, to: outputURL, fileType: fileType) { ok in
                try? FileManager.default.removeItem(at: target)
                completion(ok)
            }
        }
    }

    /// Writes the clip backwards (video only): decodes it in short pieces from the end, each piece's frames reversed.
    static func reverseVideo(from input: URL, to output: URL, fileType: AVFileType, completion: @escaping (Bool) -> Void) {
        let asset = AVURLAsset(url: input)
        guard let track = asset.tracks(withMediaType: .video).first else { return completion(false) }
        try? FileManager.default.removeItem(at: output)
        guard let writer = try? AVAssetWriter(outputURL: output, fileType: fileType) else { return completion(false) }
        let size = track.naturalSize
        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: Int(size.width), AVVideoHeightKey: Int(size.height),
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: max(4_000_000, Int(track.estimatedDataRate))],
        ]
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = false
        input.transform = track.preferredTransform
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
        guard writer.canAdd(input) else { return completion(false) }
        writer.add(input)
        guard writer.startWriting() else { return completion(false) }
        writer.startSession(atSourceTime: .zero)
        let fps = track.nominalFrameRate > 0 ? Double(track.nominalFrameRate) : 30
        let step = CMTime(value: 1, timescale: CMTimeScale(max(1, min(120, fps.rounded()))))
        DispatchQueue.global(qos: .userInitiated).async {
            let piece = 0.35
            var end = CMTimeGetSeconds(asset.duration)
            var index: Int32 = 0
            var ok = true
            while ok, end > 0.0001 {
                let start = max(0, end - piece)
                autoreleasepool {
                    guard let reader = try? AVAssetReader(asset: asset) else { ok = false; return }
                    let out = AVAssetReaderTrackOutput(track: track, outputSettings: [
                        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                    ])
                    out.alwaysCopiesSampleData = false
                    guard reader.canAdd(out) else { ok = false; return }
                    reader.add(out)
                    reader.timeRange = CMTimeRange(start: CMTime(seconds: start, preferredTimescale: 6000),
                                                   end: CMTime(seconds: end, preferredTimescale: 6000))
                    guard reader.startReading() else { ok = false; return }
                    var frames: [CVPixelBuffer] = []
                    while let sample = out.copyNextSampleBuffer() {
                        let pts = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample))
                        guard pts >= start - 0.0001, pts < end - 0.0001, let buffer = CMSampleBufferGetImageBuffer(sample) else { continue }
                        frames.append(buffer)
                    }
                    reader.cancelReading()
                    for buffer in frames.reversed() {
                        while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.005) }
                        if !adaptor.append(buffer, withPresentationTime: CMTimeMultiply(step, multiplier: index)) { ok = false; return }
                        index += 1
                    }
                }
                end = start
            }
            input.markAsFinished()
            guard ok, index > 0 else { writer.cancelWriting(); return completion(false) }
            writer.finishWriting { completion(writer.status == .completed) }
        }
    }

    // MARK: - background effects (photos)

    private static var maskCache: (key: String, mask: CIImage)?
    private static let maskLock = NSLock()

    /// op "snapBackground" {image (base64 photo), mode: "blur" | "replace", strength (0...1, blur),
    /// background (base64 photo, replace)} -> {data (base64 JPEG, the photo's own size), mime}.
    /// The person mask is kept for the last photo, so moving the blur slider doesn't segment it again.
    static func background(body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        guard let b64 = body["image"] as? String, let data = Data(base64Encoded: b64) else { return reply(nil, "bad image") }
        let mode = body["mode"] as? String ?? "blur"
        let strength = CGFloat(min(1, max(0, (body["strength"] as? NSNumber)?.doubleValue ?? 0.5)))
        let backgroundData = (body["background"] as? String).flatMap { Data(base64Encoded: $0) }
        let key = "\(b64.count):\(b64.suffix(96))"
        DispatchQueue.global(qos: .userInitiated).async {
            let done: (Any?, String?) -> Void = { value, error in DispatchQueue.main.async { reply(value, error) } }
            guard let photo = CIImage(data: data, options: [.applyOrientationProperty: true]) else { return done(nil, "couldn't read that photo") }
            let image = photo.transformed(by: CGAffineTransform(translationX: -photo.extent.origin.x, y: -photo.extent.origin.y))
            let extent = image.extent
            var mask: CIImage?
            SnapFX.maskLock.lock()
            if let cached = SnapFX.maskCache, cached.key == key { mask = cached.mask }
            SnapFX.maskLock.unlock()
            if mask == nil {
                let request = VNGeneratePersonSegmentationRequest()
                request.qualityLevel = .accurate
                request.outputPixelFormat = kCVPixelFormatType_OneComponent8
                do { try VNImageRequestHandler(ciImage: image, options: [:]).perform([request]) } catch { return done(nil, error.localizedDescription) }
                guard let buffer = request.results?.first?.pixelBuffer else { return done(nil, "no people found") }
                let raw = CIImage(cvPixelBuffer: buffer)
                let scaled = raw.transformed(by: CGAffineTransform(scaleX: extent.width / raw.extent.width, y: extent.height / raw.extent.height))
                let soft = scaled.clampedToExtent().applyingGaussianBlur(sigma: 1.5).cropped(to: extent)
                mask = soft
                SnapFX.maskLock.lock(); SnapFX.maskCache = (key, soft); SnapFX.maskLock.unlock()
            }
            guard let mask else { return done(nil, "no people found") }
            let behind: CIImage
            if mode == "replace" {
                guard let backgroundData, let bg0 = CIImage(data: backgroundData, options: [.applyOrientationProperty: true]) else { return done(nil, "no background") }
                let k = max(extent.width / bg0.extent.width, extent.height / bg0.extent.height)
                var bg = bg0.transformed(by: CGAffineTransform(scaleX: k, y: k))
                bg = bg.transformed(by: CGAffineTransform(translationX: extent.midX - bg.extent.midX, y: extent.midY - bg.extent.midY))
                behind = bg.cropped(to: extent)
            } else {
                let sigma = Double(max(2, (0.15 + strength) * max(extent.width, extent.height) * 0.01))
                behind = image.clampedToExtent().applyingGaussianBlur(sigma: sigma).cropped(to: extent)
            }
            let out = image.applyingFilter("CIBlendWithMask", parameters: [kCIInputBackgroundImageKey: behind, kCIInputMaskImageKey: mask])
            guard let cg = SnapFX.context.createCGImage(out, from: extent), let jpeg = UIImage(cgImage: cg).jpegData(compressionQuality: 0.92) else {
                return done(nil, "couldn't draw that photo")
            }
            done(["data": jpeg.base64EncodedString(), "mime": "image/jpeg", "width": cg.width, "height": cg.height], nil)
        }
    }
}
