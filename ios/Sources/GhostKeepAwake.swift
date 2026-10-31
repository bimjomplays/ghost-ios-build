import AVFoundation
import UIKit

/// Experimental, Ghost-only silent audio loop. This is not a guarantee of background WebKit execution.
final class GhostKeepAwake: NSObject {
    private let defaults = UserDefaults.standard
    private let enabledKey = "ghost.keepAwake.enabled"
    private var player: AVAudioPlayer?
    private var shouldResumeAfterInterruption = false
    private(set) var error: String?

    var enabled: Bool { defaults.bool(forKey: enabledKey) }
    var playing: Bool { player?.isPlaying == true }

    override init() {
        super.init()
        precondition(Thread.isMainThread)
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(interrupted(_:)), name: AVAudioSession.interruptionNotification, object: nil)
        center.addObserver(self, selector: #selector(mediaServicesReset), name: AVAudioSession.mediaServicesWereResetNotification, object: nil)
        center.addObserver(self, selector: #selector(foreground), name: UIApplication.didBecomeActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(audioRouteChanged), name: AVAudioSession.routeChangeNotification, object: nil)
        if enabled { startIfPossible() }
    }

    func setEnabled(_ value: Bool) -> [String: Any] {
        precondition(Thread.isMainThread)
        defaults.set(value, forKey: enabledKey)
        if value { startIfPossible() } else { stop() }
        return state
    }

    var state: [String: Any] {
        ["enabled": enabled, "playing": playing, "error": error.map { $0 as Any } ?? NSNull()]
    }

    private func startIfPossible() {
        precondition(Thread.isMainThread)
        guard enabled else { return }
        let session = AVAudioSession.sharedInstance()
        if session.category == .playAndRecord || session.category == .record {
            player = nil
            error = "Keep Awake is deferred while a WebKit call or microphone session is active"
            return
        }
        do {
            try session.setCategory(.playback, options: [.mixWithOthers])
            try session.setActive(true)
            let data = Self.silentWAV()
            let newPlayer = try AVAudioPlayer(data: data)
            newPlayer.numberOfLoops = -1
            newPlayer.prepareToPlay()
            guard newPlayer.play() else { throw NSError(domain: "GhostKeepAwake", code: 1, userInfo: [NSLocalizedDescriptionKey: "Audio playback could not start"]) }
            player = newPlayer
            error = nil
        } catch {
            player = nil
            self.error = error.localizedDescription
        }
    }

    private func stop() {
        shouldResumeAfterInterruption = false
        player?.stop()
        player = nil
        error = nil
        // Deliberately do not deactivate the shared session: WebKit calls/media audio own it too.
    }

    @objc private func interrupted(_ note: Notification) {
        guard Thread.isMainThread else { DispatchQueue.main.async { [weak self] in self?.interrupted(note) }; return }
        guard let type = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let interruption = AVAudioSession.InterruptionType(rawValue: type) else { return }
        if interruption == .began {
            // AVAudioPlayer may already have paused before this notification reaches us.
            shouldResumeAfterInterruption = enabled && player != nil
            player?.pause()
        } else if shouldResumeAfterInterruption && enabled {
            shouldResumeAfterInterruption = false
            let raw = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            if AVAudioSession.InterruptionOptions(rawValue: raw).contains(.shouldResume) { startIfPossible() }
        }
    }

    @objc private func mediaServicesReset() {
        guard Thread.isMainThread else { DispatchQueue.main.async { [weak self] in self?.mediaServicesReset() }; return }
        player = nil
        if enabled { startIfPossible() }
    }

    @objc private func foreground() {
        if enabled && !playing { startIfPossible() }
    }

    @objc private func audioRouteChanged() {
        guard Thread.isMainThread else { DispatchQueue.main.async { [weak self] in self?.audioRouteChanged() }; return }
        let category = AVAudioSession.sharedInstance().category
        if category == .playAndRecord || category == .record {
            player?.stop(); player = nil
            if enabled { error = "Keep Awake is paused while the microphone or a call is active" }
        }
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    private static func silentWAV() -> Data {
        let sampleRate: UInt32 = 44_100, channels: UInt16 = 1, bits: UInt16 = 16
        let samples = Int(sampleRate)
        let bytes = samples * Int(channels) * Int(bits / 8)
        var data = Data("RIFF".utf8)
        func append<T: FixedWidthInteger>(_ value: T) { var v = value.littleEndian; data.append(Data(bytes: &v, count: MemoryLayout<T>.size)) }
        append(UInt32(36 + bytes)); data.append(Data("WAVEfmt ".utf8)); append(UInt32(16)); append(UInt16(1)); append(channels)
        append(sampleRate); append(sampleRate * UInt32(channels) * UInt32(bits / 8)); append(UInt16(channels * (bits / 8))); append(bits)
        data.append(Data("data".utf8)); append(UInt32(bytes)); data.append(Data(repeating: 0, count: bytes))
        return data
    }
}
