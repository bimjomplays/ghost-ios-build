import UIKit
import WebKit
import Photos
import AVFoundation
import CryptoKit
import CommonCrypto
import LocalAuthentication
import ImageIO
import UniformTypeIdentifiers

/// My Eyes Only: Ghost's private, encrypted photo vault (ghost/ui.js "My Eyes Only"; plan in ghost/GALLERY_PLAN.md).
///
/// - Every file lives in Application Support/GhostVault (NOT Documents: the app has UIFileSharingEnabled, which
///   would show Documents in the Files app), written with FileProtection .complete, and encrypted with a random
///   256-bit vault key (VK) in 1 MB AES-GCM chunks (random nonce per chunk, file id + chunk index as AAD), so a
///   video can be streamed/Range-served by decrypting only the chunks asked for.
/// - VK is stored twice in the Keychain, both ThisDeviceOnly: wrapped by a key derived from the 6-digit PIN
///   (PBKDF2-SHA256), and raw behind Face ID (.biometryCurrentSet, WhenPasscodeSet). Forgot PIN = Face ID
///   releases VK and a new PIN re-wraps it. A new Face ID enrollment or removing the passcode drops the Face ID
///   copy; the next PIN unlock quietly re-creates it.
/// - A device backup alone can't be opened (the wrapped keys never leave this device); the export file
///   (.ghostvault: PIN-wrapped VK + the already-encrypted files) is the only portable copy.
/// - Wrong PINs: 5 free tries, then 30 s, 1 min, 5 min, 15 min, 1 h lockouts (persisted in the Keychain).
/// - VK is only in memory while unlocked; it is dropped on lock, on app background, and on JS request.
final class GhostVault: NSObject, WKURLSchemeHandler, UIDocumentPickerDelegate {
    static let scheme = "ghostvault"
    private static let service = "com.dltnp.ghost.vault"
    private static let chunkSize = 1 << 20
    private static let pbkdfRounds: UInt32 = 400_000

    private weak var webView: WKWebView?
    private weak var presenter: UIViewController?
    private let q = DispatchQueue(label: "ghost.vault", qos: .userInitiated)

    // q-confined state
    private var key: SymmetricKey?
    private var index: [[String: Any]] = []
    // read from the scheme handler on the main thread, written on q: guarded by tokenLock
    private let tokenLock = NSLock()
    private var token = ""
    private var stoppedTasks = Set<ObjectIdentifier>()
    private var pendingExportURL: URL?
    private var pendingImportURL: URL?
    private var pickerReply: ((Any?, String?) -> Void)?
    private var pickerMode = ""

    init(presenter: UIViewController) {
        self.presenter = presenter
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(appBackgrounded), name: UIApplication.didEnterBackgroundNotification, object: nil)
        Self.sweepTemp()
    }

    func attach(to webView: WKWebView) { self.webView = webView }

    @objc private func appBackgrounded() { q.async { self.lockNow() } }

    // MARK: - paths

    private static var root: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let url = base.appendingPathComponent("GhostVault", isDirectory: true)
        if !FileManager.default.fileExists(atPath: url.path) {
            try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
            var u = url
            var values = URLResourceValues()
            values.isExcludedFromBackup = false
            try? u.setResourceValues(values)
        }
        return url
    }
    private static var itemsDir: URL {
        let url = root.appendingPathComponent("items", isDirectory: true)
        if !FileManager.default.fileExists(atPath: url.path) {
            try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        }
        return url
    }
    private static var indexURL: URL { root.appendingPathComponent("index.bin") }
    private static func fileURL(_ id: String, _ part: String) -> URL { itemsDir.appendingPathComponent("\(id).\(part)") }
    static var tempRoot: URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("ghost-vault", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        return url
    }
    private static func sweepTemp() {
        let items = (try? FileManager.default.contentsOfDirectory(at: tempRoot, includingPropertiesForKeys: nil)) ?? []
        for item in items { try? FileManager.default.removeItem(at: item) }
    }
    private static func tempFile(_ ext: String) -> URL { tempRoot.appendingPathComponent(UUID().uuidString + (ext.isEmpty ? "" : "." + ext)) }

    // MARK: - Keychain

    private static func kcBase(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }
    @discardableResult
    private static func kcSet(_ account: String, _ data: Data, access: SecAccessControl? = nil) -> Bool {
        kcDelete(account)
        var query = kcBase(account)
        query[kSecValueData as String] = data
        if let access { query[kSecAttrAccessControl as String] = access }
        else { query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly }
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }
    private static func kcGet(_ account: String, context: LAContext? = nil) -> (Data?, OSStatus) {
        var query = kcBase(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        if let context { query[kSecUseAuthenticationContext as String] = context }
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        return (out as? Data, status)
    }
    private static func kcDelete(_ account: String) { SecItemDelete(kcBase(account) as CFDictionary) }
    /// Whether the Face ID copy exists, without showing Face ID.
    private static func bioItemExists() -> Bool {
        let context = LAContext()
        context.interactionNotAllowed = true
        let status = kcGet("bio", context: context).1
        return status == errSecSuccess || status == errSecInteractionNotAllowed
    }

    // MARK: - crypto

    private static func randomData(_ n: Int) -> Data {
        var d = Data(count: n)
        let ok = d.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, n, $0.baseAddress!) }
        return ok == errSecSuccess ? d : Data((0..<n).map { _ in UInt8.random(in: 0...255) })
    }

    private static func derive(pin: String, salt: Data, rounds: UInt32) -> SymmetricKey? {
        let pinData = Data(pin.utf8)
        var out = Data(count: 32)
        let status: Int32 = out.withUnsafeMutableBytes { outPtr in
            salt.withUnsafeBytes { saltPtr in
                pinData.withUnsafeBytes { pinPtr in
                    CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2),
                                         pinPtr.baseAddress?.assumingMemoryBound(to: Int8.self), pinData.count,
                                         saltPtr.baseAddress?.assumingMemoryBound(to: UInt8.self), salt.count,
                                         CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), rounds,
                                         outPtr.baseAddress?.assumingMemoryBound(to: UInt8.self), 32)
                }
            }
        }
        return status == Int32(kCCSuccess) ? SymmetricKey(data: out) : nil
    }

    private static func keyData(_ key: SymmetricKey) -> Data { key.withUnsafeBytes { Data($0) } }

    /// {salt, rounds, box} JSON: VK sealed with the PIN-derived key.
    private static func wrap(_ vk: SymmetricKey, pin: String) -> Data? {
        let salt = randomData(16)
        guard let kek = derive(pin: pin, salt: salt, rounds: pbkdfRounds),
              let box = try? AES.GCM.seal(keyData(vk), using: kek).combined else { return nil }
        let json: [String: Any] = ["salt": salt.base64EncodedString(), "rounds": Int(pbkdfRounds), "box": box.base64EncodedString(), "v": 1]
        return try? JSONSerialization.data(withJSONObject: json)
    }
    private static func unwrap(_ blob: Data, pin: String) -> SymmetricKey? {
        guard let json = try? JSONSerialization.jsonObject(with: blob) as? [String: Any],
              let salt = (json["salt"] as? String).flatMap({ Data(base64Encoded: $0) }),
              let rounds = json["rounds"] as? Int,
              let box = (json["box"] as? String).flatMap({ Data(base64Encoded: $0) }),
              let kek = derive(pin: pin, salt: salt, rounds: UInt32(rounds)),
              let sealed = try? AES.GCM.SealedBox(combined: box),
              let raw = try? AES.GCM.open(sealed, using: kek) else { return nil }
        return SymmetricKey(data: raw)
    }

    private static func aad(_ fileId: String, _ chunk: UInt64) -> Data {
        var d = Data(fileId.utf8)
        var be = chunk.bigEndian
        withUnsafeBytes(of: &be) { d.append(contentsOf: $0) }
        return d
    }
    private static let headerSize = 8
    private static var chunkOverhead: Int { 12 + 16 }

    private static func createProtected(_ url: URL) -> FileHandle? {
        try? FileManager.default.removeItem(at: url)
        guard FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.protectionKey: FileProtectionType.complete]) else { return nil }
        return try? FileHandle(forWritingTo: url)
    }

    /// Streams `src` into the chunked format at `dst`. Returns the plaintext size.
    @discardableResult
    private static func encryptFile(from src: URL, to dst: URL, key: SymmetricKey, fileId: String) throws -> Int64 {
        let input = try FileHandle(forReadingFrom: src)
        defer { try? input.close() }
        guard let output = createProtected(dst) else { throw VaultError.io }
        defer { try? output.close() }
        var header = Data("GVC1".utf8)
        var cs = UInt32(chunkSize).bigEndian
        withUnsafeBytes(of: &cs) { header.append(contentsOf: $0) }
        output.write(header)
        var n: UInt64 = 0
        var total: Int64 = 0
        while true {
            let chunk = try autoreleasepool { () -> Data in (try input.read(upToCount: chunkSize)) ?? Data() }
            if chunk.isEmpty { break }
            guard let combined = try AES.GCM.seal(chunk, using: key, authenticating: aad(fileId, n)).combined else { throw VaultError.crypto }
            output.write(combined)
            total += Int64(chunk.count)
            n += 1
            if chunk.count < chunkSize { break }
        }
        return total
    }
    private static func encryptData(_ data: Data, to dst: URL, key: SymmetricKey, fileId: String) throws {
        let tmp = tempFile("")
        try data.write(to: tmp, options: .completeFileProtection)
        defer { try? FileManager.default.removeItem(at: tmp) }
        try encryptFile(from: tmp, to: dst, key: key, fileId: fileId)
    }
    private static func plainSize(of url: URL) -> Int64 {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let size = (attrs[.size] as? NSNumber)?.int64Value, size >= Int64(headerSize) else { return 0 }
        let body = size - Int64(headerSize)
        let full = Int64(chunkSize + chunkOverhead)
        let chunks = (body + full - 1) / full
        return body - chunks * Int64(chunkOverhead)
    }
    /// Plaintext bytes [lower, upper) decrypting only the chunks that cover them.
    private static func decryptRange(_ url: URL, key: SymmetricKey, fileId: String, lower: Int64, upper: Int64) throws -> Data {
        guard upper > lower else { return Data() }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let first = lower / Int64(chunkSize), last = (upper - 1) / Int64(chunkSize)
        var out = Data()
        out.reserveCapacity(Int(upper - lower))
        for c in first...last {
            let offset = UInt64(headerSize) + UInt64(c) * UInt64(chunkSize + chunkOverhead)
            try handle.seek(toOffset: offset)
            guard let combined = try handle.read(upToCount: chunkSize + chunkOverhead), !combined.isEmpty else { throw VaultError.crypto }
            let plain = try AES.GCM.open(AES.GCM.SealedBox(combined: combined), using: key, authenticating: aad(fileId, UInt64(c)))
            let chunkStart = c * Int64(chunkSize)
            let from = max(0, Int(lower - chunkStart)), to = min(plain.count, Int(upper - chunkStart))
            if from < to { out.append(plain.subdata(in: from..<to)) }
        }
        return out
    }
    private static func decryptAll(_ url: URL, key: SymmetricKey, fileId: String) throws -> Data {
        try decryptRange(url, key: key, fileId: fileId, lower: 0, upper: plainSize(of: url))
    }
    private static func decryptToFile(_ url: URL, key: SymmetricKey, fileId: String, ext: String) throws -> URL {
        let out = tempFile(ext)
        guard let handle = createProtected(out) else { throw VaultError.io }
        defer { try? handle.close() }
        let total = plainSize(of: url)
        var pos: Int64 = 0
        while pos < total {
            let end = min(total, pos + Int64(chunkSize) * 4)
            let part = try autoreleasepool { try decryptRange(url, key: key, fileId: fileId, lower: pos, upper: end) }
            handle.write(part)
            pos = end
        }
        return out
    }
    /// Re-keys one chunked file (import: backup key -> this vault's key), chunk by chunk.
    private static func rekey(_ src: URL, from oldKey: SymmetricKey, to dst: URL, newKey: SymmetricKey, fileId: String) throws {
        let plain = try decryptToFile(src, key: oldKey, fileId: fileId, ext: "")
        defer { try? FileManager.default.removeItem(at: plain) }
        try encryptFile(from: plain, to: dst, key: newKey, fileId: fileId)
    }

    enum VaultError: Error { case io, crypto, locked }

    // MARK: - index

    private func loadIndex() -> Bool {
        guard let key else { return false }
        guard FileManager.default.fileExists(atPath: Self.indexURL.path) else { index = []; return true }
        guard let data = try? Self.decryptAll(Self.indexURL, key: key, fileId: "index"),
              let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return false }
        index = list
        return true
    }
    private func saveIndex() -> Bool {
        guard let key, let data = try? JSONSerialization.data(withJSONObject: index) else { return false }
        let tmp = Self.root.appendingPathComponent("index.tmp")
        do {
            try Self.encryptData(data, to: tmp, key: key, fileId: "index")
            if FileManager.default.fileExists(atPath: Self.indexURL.path) {
                _ = try FileManager.default.replaceItemAt(Self.indexURL, withItemAt: tmp)
            } else {
                try FileManager.default.moveItem(at: tmp, to: Self.indexURL)
            }
            return true
        } catch { return false }
    }
    private func entry(_ id: String) -> [String: Any]? { index.first { ($0["id"] as? String) == id } }

    // MARK: - session

    private func unlocked(with vk: SymmetricKey) -> [String: Any]? {
        key = vk
        guard loadIndex() else { key = nil; return nil }
        let t = UUID().uuidString
        tokenLock.lock(); token = t; tokenLock.unlock()
        return ["ok": true, "token": t, "count": index.count]
    }
    private func lockNow() {
        key = nil
        index = []
        tokenLock.lock(); token = ""; tokenLock.unlock()
    }
    private func currentToken() -> String { tokenLock.lock(); defer { tokenLock.unlock() }; return token }

    private static var isSetUp: Bool { kcGet("pinwrap").0 != nil }

    private static func bioInfo() -> (available: Bool, type: String) {
        let context = LAContext()
        var error: NSError?
        let ok = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        let type: String
        switch context.biometryType {
        case .faceID: type = "faceID"
        case .touchID: type = "touchID"
        default: type = "none"
        }
        return (ok, type)
    }

    private struct Lockout { var fails: Int; var until: Double }
    private static func lockout() -> Lockout {
        guard let data = kcGet("lockout").0, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return Lockout(fails: 0, until: 0) }
        return Lockout(fails: json["fails"] as? Int ?? 0, until: json["until"] as? Double ?? 0)
    }
    private static func setLockout(_ l: Lockout) {
        if let data = try? JSONSerialization.data(withJSONObject: ["fails": l.fails, "until": l.until]) { kcSet("lockout", data) }
    }
    private static func delayFor(fails: Int) -> Double {
        switch fails {
        case ..<5: return 0
        case 5: return 30
        case 6: return 60
        case 7: return 300
        case 8: return 900
        default: return 3600
        }
    }

    private static func bioAccess() -> SecAccessControl? {
        SecAccessControlCreateWithFlags(kCFAllocatorDefault, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .biometryCurrentSet, nil)
    }
    private static let bioWantedKey = "ghost.vault.bioWanted"

    // MARK: - op dispatch (App.swift forwards every "vault*" op here)

    func handle(op: String, body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        let done: (Any?, String?) -> Void = { v, e in DispatchQueue.main.async { reply(v, e) } }
        switch op {
        case "vaultImportPick": return importPick(reply: reply)
        case "vaultExport": return q.async { self.export(reply: done) }
        case "vaultShare":
            let ids = body["ids"] as? [String] ?? []
            return q.async { self.share(ids: ids, reply: done) }
        default: break
        }
        q.async {
            switch op {
            case "vaultStatus": done(self.status(), nil)
            case "vaultSetup": self.setup(pin: body["pin"] as? String ?? "", bio: body["bio"] as? Bool ?? false, reply: done)
            case "vaultUnlockPin": self.unlockPin(body["pin"] as? String ?? "", reply: done)
            case "vaultUnlockBio": self.unlockBio(reply: done)
            case "vaultResetPinBio": self.resetPinBio(newPin: body["pin"] as? String ?? "", reply: done)
            case "vaultChangePin": self.changePin(body["pin"] as? String ?? "", reply: done)
            case "vaultSetBio": self.setBio(on: body["on"] as? Bool ?? false, reply: done)
            case "vaultLock": self.lockNow(); done(["ok": true], nil)
            case "vaultList":
                guard self.key != nil else { return done(nil, "locked") }
                done(["items": self.index.sorted { ($0["date"] as? Double ?? 0) > ($1["date"] as? Double ?? 0) }, "token": self.currentToken()], nil)
            case "vaultInfo":
                guard self.key != nil else { return done(nil, "locked") }
                done(self.entry(body["id"] as? String ?? "") ?? [:], nil)
            case "vaultAddFromLibrary":
                self.addFromLibrary(ids: body["ids"] as? [String] ?? [], deleteOriginals: body["deleteOriginals"] as? Bool ?? true, reply: done)
            case "vaultDelete": self.delete(ids: body["ids"] as? [String] ?? [], reply: done)
            case "vaultExportToPhotos":
                self.exportToPhotos(ids: body["ids"] as? [String] ?? [], remove: body["remove"] as? Bool ?? true, reply: done)
            case "vaultFull": self.full(id: body["id"] as? String ?? "", reply: done)
            case "vaultRender": self.render(body: body, reply: done)
            case "vaultImportFinish": self.importFinish(pin: body["pin"] as? String ?? "", reply: done)
            case "vaultImportCancel":
                if let url = self.pendingImportURL { try? FileManager.default.removeItem(at: url) }
                self.pendingImportURL = nil
                done(["ok": true], nil)
            case "vaultErase": self.erase(reply: done)
            case "vaultUsage":
                let items = (try? FileManager.default.contentsOfDirectory(at: Self.itemsDir, includingPropertiesForKeys: [.fileSizeKey])) ?? []
                let total = items.reduce(Int64(0)) { $0 + Int64((try? $1.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
                done(["bytes": total, "count": self.key != nil ? self.index.count : -1], nil)
            default: done(nil, "unknown op")
            }
        }
    }

    // MARK: - setup / unlock

    private func status() -> [String: Any] {
        let bio = Self.bioInfo()
        let l = Self.lockout()
        let bioWanted = UserDefaults.standard.bool(forKey: Self.bioWantedKey)
        let bioItem = Self.bioItemExists()
        var out: [String: Any] = [
            "setUp": Self.isSetUp, "locked": key == nil,
            "bioAvailable": bio.available, "bioType": bio.type,
            "bioEnabled": bioWanted && bioItem, "bioWanted": bioWanted,
            // Face ID can only reset a forgotten PIN while its keychain copy exists
            "bioResetAvailable": bioItem && bio.available,
            "fails": l.fails, "lockedUntil": l.until * 1000,
        ]
        if key != nil { out["token"] = currentToken(); out["count"] = index.count }
        return out
    }

    private static func validPin(_ pin: String) -> Bool { pin.count == 6 && pin.allSatisfy { $0.isASCII && $0.isNumber } }

    private func setup(pin: String, bio: Bool, reply: @escaping (Any?, String?) -> Void) {
        guard Self.validPin(pin) else { return reply(nil, "PIN must be 6 digits") }
        guard !Self.isSetUp else { return reply(nil, "already set up") }
        let vk = SymmetricKey(size: .bits256)
        guard let wrapped = Self.wrap(vk, pin: pin), Self.kcSet("pinwrap", wrapped) else { return reply(nil, "couldn't store the key") }
        Self.setLockout(Lockout(fails: 0, until: 0))
        UserDefaults.standard.set(bio, forKey: Self.bioWantedKey)
        if bio, let access = Self.bioAccess() { Self.kcSet("bio", Self.keyData(vk), access: access) }
        key = vk
        index = []
        guard saveIndex(), let res = unlocked(with: vk) else { return reply(nil, "couldn't create the vault") }
        reply(res, nil)
    }

    private func unlockPin(_ pin: String, reply: @escaping (Any?, String?) -> Void) {
        var l = Self.lockout()
        let now = Date().timeIntervalSince1970
        if l.until > now { return reply(["ok": false, "fails": l.fails, "lockedUntil": l.until * 1000], nil) }
        guard let wrapped = Self.kcGet("pinwrap").0 else { return reply(nil, "not set up") }
        guard Self.validPin(pin), let vk = Self.unwrap(wrapped, pin: pin) else {
            l.fails += 1
            let delay = Self.delayFor(fails: l.fails)
            l.until = delay > 0 ? now + delay : 0
            Self.setLockout(l)
            return reply(["ok": false, "fails": l.fails, "lockedUntil": l.until * 1000], nil)
        }
        Self.setLockout(Lockout(fails: 0, until: 0))
        // Face ID copy lost (new enrollment / passcode removed): put it back now that we have the key
        if UserDefaults.standard.bool(forKey: Self.bioWantedKey), !Self.bioItemExists(), Self.bioInfo().available, let access = Self.bioAccess() {
            Self.kcSet("bio", Self.keyData(vk), access: access)
        }
        guard let res = unlocked(with: vk) else { return reply(nil, "couldn't open the vault") }
        reply(res, nil)
    }

    private func bioKey(reason: String) -> (SymmetricKey?, String?) {
        let context = LAContext()
        context.localizedReason = reason
        context.localizedFallbackTitle = "Use PIN"
        let (data, status) = Self.kcGet("bio", context: context)
        if let data, data.count == 32 { return (SymmetricKey(data: data), nil) }
        switch status {
        case errSecUserCanceled: return (nil, "cancelled")
        case errSecItemNotFound: return (nil, "unavailable")
        case errSecAuthFailed: return (nil, "failed")
        default: return (nil, "failed")
        }
    }

    private func unlockBio(reply: @escaping (Any?, String?) -> Void) {
        let (vk, err) = bioKey(reason: "Unlock My Eyes Only")
        guard let vk else { return reply(["ok": false, "reason": err ?? "failed"], nil) }
        guard let res = unlocked(with: vk) else { return reply(nil, "couldn't open the vault") }
        reply(res, nil)
    }

    private func resetPinBio(newPin: String, reply: @escaping (Any?, String?) -> Void) {
        guard Self.validPin(newPin) else { return reply(nil, "PIN must be 6 digits") }
        let (vk, err) = bioKey(reason: "Set a new My Eyes Only PIN")
        guard let vk else { return reply(["ok": false, "reason": err ?? "failed"], nil) }
        guard let wrapped = Self.wrap(vk, pin: newPin), Self.kcSet("pinwrap", wrapped) else { return reply(nil, "couldn't store the new PIN") }
        Self.setLockout(Lockout(fails: 0, until: 0))
        guard let res = unlocked(with: vk) else { return reply(nil, "couldn't open the vault") }
        reply(res, nil)
    }

    private func changePin(_ pin: String, reply: @escaping (Any?, String?) -> Void) {
        guard let key else { return reply(nil, "locked") }
        guard Self.validPin(pin) else { return reply(nil, "PIN must be 6 digits") }
        guard let wrapped = Self.wrap(key, pin: pin), Self.kcSet("pinwrap", wrapped) else { return reply(nil, "couldn't store the new PIN") }
        reply(["ok": true], nil)
    }

    private func setBio(on: Bool, reply: @escaping (Any?, String?) -> Void) {
        guard let key else { return reply(nil, "locked") }
        UserDefaults.standard.set(on, forKey: Self.bioWantedKey)
        if on {
            guard let access = Self.bioAccess(), Self.kcSet("bio", Self.keyData(key), access: access) else {
                return reply(nil, "Face ID needs a device passcode")
            }
        } else {
            Self.kcDelete("bio")
        }
        reply(["ok": true, "bioEnabled": on], nil)
    }

    private func erase(reply: @escaping (Any?, String?) -> Void) {
        lockNow()
        try? FileManager.default.removeItem(at: Self.root)
        for account in ["pinwrap", "bio", "lockout"] { Self.kcDelete(account) }
        UserDefaults.standard.removeObject(forKey: Self.bioWantedKey)
        reply(["ok": true], nil)
    }

    // MARK: - adding items

    private static func extFor(uti: String?, fallback: String) -> String {
        if let uti, let type = UTType(uti), let ext = type.preferredFilenameExtension { return ext }
        return fallback
    }

    /// Thumbnail (≈480 px) and viewer (≤2400 px) JPEGs for an image file, orientation applied.
    private static func imagePreviews(_ url: URL) -> (thumb: Data, view: Data, width: Int, height: Int)? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        func make(_ maxPixel: Int) -> CGImage? {
            let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                         kCGImageSourceThumbnailMaxPixelSize: maxPixel]
            return CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary)
        }
        guard let thumb = make(480), let view = make(2400),
              let t = UIImage(cgImage: thumb).jpegData(compressionQuality: 0.8),
              let v = UIImage(cgImage: view).jpegData(compressionQuality: 0.88) else { return nil }
        var w = view.width, h = view.height
        if let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
           let pw = props[kCGImagePropertyPixelWidth] as? Int, let ph = props[kCGImagePropertyPixelHeight] as? Int {
            let orientation = props[kCGImagePropertyOrientation] as? Int ?? 1
            (w, h) = orientation >= 5 ? (ph, pw) : (pw, ph)
        }
        return (t, v, w, h)
    }
    private static func videoPreviews(_ url: URL) -> (thumb: Data, view: Data, width: Int, height: Int, duration: Double)? {
        let asset = AVURLAsset(url: url)
        let gen = AVAssetImageGenerator(asset: asset)
        gen.appliesPreferredTrackTransform = true
        gen.maximumSize = CGSize(width: 2400, height: 2400)
        guard let cg = try? gen.copyCGImage(at: CMTime(seconds: min(0.5, asset.duration.seconds / 2), preferredTimescale: 600), actualTime: nil) else { return nil }
        let image = UIImage(cgImage: cg)
        let thumbImage = UIGraphicsImageRenderer(size: CGSize(width: 480, height: 480 * CGFloat(cg.height) / CGFloat(max(1, cg.width)))).image { _ in
            image.draw(in: CGRect(x: 0, y: 0, width: 480, height: 480 * CGFloat(cg.height) / CGFloat(max(1, cg.width))))
        }
        guard let t = thumbImage.jpegData(compressionQuality: 0.8), let v = image.jpegData(compressionQuality: 0.85) else { return nil }
        var w = cg.width, h = cg.height
        if let track = asset.tracks(withMediaType: .video).first {
            let box = CGRect(origin: .zero, size: track.naturalSize).applying(track.preferredTransform)
            w = Int(abs(box.width).rounded()); h = Int(abs(box.height).rounded())
        }
        return (t, v, w, h, asset.duration.seconds)
    }

    /// Encrypts one media file (+ optional Live Photo video) as a new vault item, verifies it decrypts, returns the entry.
    private func addItem(file: URL, isVideo: Bool, uti: String?, filename: String, date: Double, live: URL?) -> [String: Any]? {
        guard let key else { return nil }
        let id = UUID().uuidString
        let previews: (Data, Data, Int, Int, Double)?
        if isVideo { previews = Self.videoPreviews(file).map { ($0.thumb, $0.view, $0.width, $0.height, $0.duration) } }
        else { previews = Self.imagePreviews(file).map { ($0.thumb, $0.view, $0.width, $0.height, 0) } }
        guard let p = previews else { return nil }
        do {
            let size = try Self.encryptFile(from: file, to: Self.fileURL(id, "bin"), key: key, fileId: id)
            try Self.encryptData(p.0, to: Self.fileURL(id, "thumb"), key: key, fileId: id + ".thumb")
            try Self.encryptData(p.1, to: Self.fileURL(id, "view"), key: key, fileId: id + ".view")
            if let live { try Self.encryptFile(from: live, to: Self.fileURL(id, "live"), key: key, fileId: id + ".live") }
            // verify: the first and last chunk of the original and the thumbnail decrypt
            let bin = Self.fileURL(id, "bin")
            let plain = Self.plainSize(of: bin)
            guard plain == size else { throw VaultError.crypto }
            _ = try Self.decryptRange(bin, key: key, fileId: id, lower: 0, upper: min(plain, 16))
            if plain > 16 { _ = try Self.decryptRange(bin, key: key, fileId: id, lower: plain - 16, upper: plain) }
            _ = try Self.decryptAll(Self.fileURL(id, "thumb"), key: key, fileId: id + ".thumb")
        } catch {
            for part in ["bin", "thumb", "view", "live"] { try? FileManager.default.removeItem(at: Self.fileURL(id, part)) }
            return nil
        }
        return [
            "id": id, "mediaType": isVideo ? "video" : "image", "width": p.2, "height": p.3, "duration": p.4,
            "date": date, "added": Date().timeIntervalSince1970 * 1000, "filename": filename, "uti": uti ?? "",
            "size": Self.plainSize(of: Self.fileURL(id, "bin")), "live": live != nil, "vault": true,
        ]
    }

    private static func writeResource(_ res: PHAssetResource, to url: URL) -> Bool {
        let opts = PHAssetResourceRequestOptions()
        opts.isNetworkAccessAllowed = true
        let sem = DispatchSemaphore(value: 0)
        var ok = false
        PHAssetResourceManager.default().writeData(for: res, toFile: url, options: opts) { error in ok = error == nil; sem.signal() }
        sem.wait()
        return ok
    }

    /// Copies each asset's current full-size resource (and a Live Photo's paired video) into the vault, then deletes
    /// ONLY the originals that were verified in one performChanges (one iOS confirmation). Failures stay in Photos.
    private func addFromLibrary(ids: [String], deleteOriginals: Bool, reply: @escaping (Any?, String?) -> Void) {
        guard key != nil else { return reply(nil, "locked") }
        let fetched = PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil)
        var assets: [PHAsset] = []
        fetched.enumerateObjects { a, _, _ in assets.append(a) }
        var added: [[String: Any]] = []
        var verified: [PHAsset] = []
        var failed = 0
        for (i, asset) in assets.enumerated() {
            progress(Double(i) / Double(max(1, assets.count)))
            let ok: Bool = autoreleasepool {
                let resources = PHAssetResource.assetResources(for: asset)
                let isVideo = asset.mediaType == .video
                let primary = isVideo
                    ? (resources.first { $0.type == .fullSizeVideo } ?? resources.first { $0.type == .video })
                    : (resources.first { $0.type == .fullSizePhoto } ?? resources.first { $0.type == .photo })
                guard let primary else { return false }
                let paired = isVideo ? nil : (resources.first { $0.type == .fullSizePairedVideo } ?? resources.first { $0.type == .pairedVideo })
                let original = resources.first { $0.type == (isVideo ? .video : .photo) }
                let filename = original?.originalFilename ?? primary.originalFilename
                let ext = Self.extFor(uti: primary.uniformTypeIdentifier, fallback: isVideo ? "mov" : "jpg")
                let file = Self.tempFile(ext)
                defer { try? FileManager.default.removeItem(at: file) }
                guard Self.writeResource(primary, to: file) else { return false }
                var liveURL: URL?
                if let paired {
                    let u = Self.tempFile("mov")
                    if Self.writeResource(paired, to: u) { liveURL = u }
                }
                defer { if let liveURL { try? FileManager.default.removeItem(at: liveURL) } }
                guard var item = addItem(file: file, isVideo: isVideo, uti: primary.uniformTypeIdentifier, filename: filename,
                                         date: (asset.creationDate?.timeIntervalSince1970 ?? Date().timeIntervalSince1970) * 1000, live: liveURL) else { return false }
                if asset.pixelWidth > 0 { item["width"] = asset.pixelWidth; item["height"] = asset.pixelHeight }
                if isVideo { item["duration"] = asset.duration }
                added.append(item)
                return true
            }
            if ok { verified.append(asset) } else { failed += 1 }
        }
        index.append(contentsOf: added)
        guard saveIndex() else {
            // the index didn't save: forget these items rather than delete originals we can't list
            for item in added { if let id = item["id"] as? String { for part in ["bin", "thumb", "view", "live"] { try? FileManager.default.removeItem(at: Self.fileURL(id, part)) } } }
            index.removeAll { item in added.contains { ($0["id"] as? String) == (item["id"] as? String) } }
            return reply(nil, "couldn't save the vault")
        }
        progress(1)
        var result: [String: Any] = ["added": added, "failed": failed, "deleted": false]
        guard deleteOriginals, !verified.isEmpty else { return reply(result, nil) }
        PHPhotoLibrary.shared().performChanges({
            PHAssetChangeRequest.deleteAssets(verified as NSArray)
        }) { ok, error in
            result["deleted"] = ok
            if !ok, (error as NSError?)?.code == 3072 { result["deleteCancelled"] = true }
            reply(result, nil)
        }
    }

    private func progress(_ p: Double) {
        DispatchQueue.main.async { [weak self] in
            self?.webView?.ghostEval("window.__ghostVaultProgress && window.__ghostVaultProgress(\(p))")
        }
    }

    // MARK: - reading items

    private func originalFile(_ entry: [String: Any]) throws -> URL {
        guard let key, let id = entry["id"] as? String else { throw VaultError.locked }
        let isVideo = (entry["mediaType"] as? String) == "video"
        return try Self.decryptToFile(Self.fileURL(id, "bin"), key: key, fileId: id,
                                      ext: Self.extFor(uti: entry["uti"] as? String, fallback: isVideo ? "mov" : "jpg"))
    }

    /// Bytes for sending: photo as JPEG (≤ 2560 px), video as a medium-quality mp4.
    private func full(id: String, reply: @escaping (Any?, String?) -> Void) {
        guard key != nil, let entry = entry(id) else { return reply(nil, "not found") }
        let file: URL
        do { file = try originalFile(entry) } catch { return reply(nil, "couldn't open that item") }
        if (entry["mediaType"] as? String) == "video" {
            let out = Self.tempFile("mp4")
            GhostGallery.compositeVideo(asset: AVURLAsset(url: file), overlay: nil, preset: AVAssetExportPresetMediumQuality, fileType: .mp4, outputURL: out) { ok in
                defer { try? FileManager.default.removeItem(at: file); try? FileManager.default.removeItem(at: out) }
                guard ok, let data = try? Data(contentsOf: out) else { return reply(nil, "couldn't prepare that video") }
                reply(["data": data.base64EncodedString(), "mime": "video/mp4"], nil)
            }
        } else {
            defer { try? FileManager.default.removeItem(at: file) }
            guard let data = try? Data(contentsOf: file), let image = UIImage(data: data),
                  let jpeg = GhostGallery.composite(image: image, overlay: nil, maxEdge: 2560) else { return reply(nil, "couldn't prepare that photo") }
            reply(["data": jpeg.base64EncodedString(), "mime": "image/jpeg"], nil)
        }
    }

    /// Same contract as galleryRender, with the vault as source and destination (copy/replace stay private).
    private func render(body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        guard key != nil, let source = body["source"] as? [String: Any], let id = source["id"] as? String,
              let entry = entry(id), let mode = body["mode"] as? String else { return reply(nil, "not found") }
        let overlay: UIImage? = (body["overlay"] as? String).flatMap { Data(base64Encoded: $0) }.flatMap { UIImage(data: $0) }
        let fx = body["fx"] as? [String: Any] // snap filter (SnapFX.swift)
        let file: URL
        do { file = try originalFile(entry) } catch { return reply(nil, "couldn't open that item") }
        let isVideo = (entry["mediaType"] as? String) == "video"
        let store: (URL, Bool) -> Void = { rendered, video in
            // runs on q: add as a new item, or swap the files of the existing one (same id)
            defer { try? FileManager.default.removeItem(at: rendered) }
            let date = entry["date"] as? Double ?? Date().timeIntervalSince1970 * 1000
            guard var item = self.addItem(file: rendered, isVideo: video, uti: video ? "com.apple.quicktime-movie" : "public.jpeg",
                                          filename: (entry["filename"] as? String) ?? "Ghost", date: date, live: nil) else { return reply(nil, "couldn't save the edit") }
            if mode == "replace", let newId = item["id"] as? String {
                for part in ["bin", "thumb", "view"] {
                    let from = Self.fileURL(newId, part), to = Self.fileURL(id, part)
                    // chunks are bound to their file id (AAD), so re-encrypt under the old id rather than rename
                    guard let key = self.key, let plain = try? Self.decryptToFile(from, key: key, fileId: part == "bin" ? newId : "\(newId).\(part)", ext: "") else { return reply(nil, "couldn't save the edit") }
                    defer { try? FileManager.default.removeItem(at: plain) }
                    do { try Self.encryptFile(from: plain, to: to, key: key, fileId: part == "bin" ? id : "\(id).\(part)") } catch { return reply(nil, "couldn't save the edit") }
                    try? FileManager.default.removeItem(at: from)
                }
                try? FileManager.default.removeItem(at: Self.fileURL(id, "live"))
                item["id"] = id
                item["added"] = entry["added"] ?? item["added"]
                if let i = self.index.firstIndex(where: { ($0["id"] as? String) == id }) { self.index[i] = item }
            } else {
                self.index.append(item)
            }
            guard self.saveIndex() else { return reply(nil, "couldn't save the vault") }
            reply(["saved": true, "item": item], nil)
        }
        if isVideo {
            let out = Self.tempFile(mode == "send" ? "mp4" : "mov")
            let preset = mode == "send" ? AVAssetExportPresetMediumQuality : AVAssetExportPresetHighestQuality
            GhostGallery.compositeVideo(asset: AVURLAsset(url: file), overlay: overlay, preset: preset, fileType: mode == "send" ? .mp4 : .mov, outputURL: out, fx: fx) { ok in
                try? FileManager.default.removeItem(at: file)
                guard ok else { try? FileManager.default.removeItem(at: out); return reply(nil, "couldn't render that video") }
                if mode == "send" {
                    defer { try? FileManager.default.removeItem(at: out) }
                    guard let data = try? Data(contentsOf: out) else { return reply(nil, "couldn't read the video") }
                    return reply(["data": data.base64EncodedString(), "mime": "video/mp4"], nil)
                }
                self.q.async { store(out, true) }
            }
        } else {
            defer { try? FileManager.default.removeItem(at: file) }
            guard let data = try? Data(contentsOf: file), let image = UIImage(data: data),
                  let jpeg = GhostGallery.composite(image: image, overlay: overlay, maxEdge: mode == "send" ? 2560 : nil, fx: fx) else { return reply(nil, "couldn't draw that photo") }
            if mode == "send" { return reply(["data": jpeg.base64EncodedString(), "mime": "image/jpeg"], nil) }
            let out = Self.tempFile("jpg")
            do { try jpeg.write(to: out, options: .completeFileProtection) } catch { return reply(nil, "couldn't save the edit") }
            store(out, false)
        }
    }

    private func delete(ids: [String], reply: @escaping (Any?, String?) -> Void) {
        guard key != nil else { return reply(nil, "locked") }
        let set = Set(ids)
        let before = index
        index.removeAll { set.contains($0["id"] as? String ?? "") }
        guard saveIndex() else { index = before; return reply(nil, "couldn't update the vault") }
        for id in ids { for part in ["bin", "thumb", "view", "live"] { try? FileManager.default.removeItem(at: Self.fileURL(id, part)) } }
        reply(["deleted": ids], nil)
    }

    /// Move out: back into Photos (a Live Photo comes back as a Live Photo), then optionally out of the vault.
    private func exportToPhotos(ids: [String], remove: Bool, reply: @escaping (Any?, String?) -> Void) {
        guard let key else { return reply(nil, "locked") }
        var saved: [String] = []
        for id in ids {
            guard let entry = entry(id) else { continue }
            let isVideo = (entry["mediaType"] as? String) == "video"
            guard let file = try? originalFile(entry) else { continue }
            var live: URL?
            if (entry["live"] as? Bool) == true { live = try? Self.decryptToFile(Self.fileURL(id, "live"), key: key, fileId: id + ".live", ext: "mov") }
            let sem = DispatchSemaphore(value: 0)
            var ok = false
            PHPhotoLibrary.shared().performChanges({
                let request = PHAssetCreationRequest.forAsset()
                let opts = PHAssetResourceCreationOptions()
                opts.originalFilename = entry["filename"] as? String
                request.addResource(with: isVideo ? .video : .photo, fileURL: file, options: opts)
                if let live { request.addResource(with: .pairedVideo, fileURL: live, options: nil) }
                if let ms = entry["date"] as? Double { request.creationDate = Date(timeIntervalSince1970: ms / 1000) }
            }) { success, _ in ok = success; sem.signal() }
            sem.wait()
            try? FileManager.default.removeItem(at: file)
            if let live { try? FileManager.default.removeItem(at: live) }
            if ok { saved.append(id) }
        }
        if remove && !saved.isEmpty {
            let set = Set(saved)
            index.removeAll { set.contains($0["id"] as? String ?? "") }
            if saveIndex() { for id in saved { for part in ["bin", "thumb", "view", "live"] { try? FileManager.default.removeItem(at: Self.fileURL(id, part)) } } }
        }
        reply(["saved": saved, "failed": ids.count - saved.count], nil)
    }

    private func share(ids: [String], reply: @escaping (Any?, String?) -> Void) {
        guard key != nil else { return reply(nil, "locked") }
        let dir = Self.tempRoot.appendingPathComponent("share-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        var urls: [URL] = []
        for id in ids {
            guard let entry = entry(id), let file = try? originalFile(entry) else { continue }
            let name = (entry["filename"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? file.lastPathComponent
            let dest = dir.appendingPathComponent(name)
            if (try? FileManager.default.moveItem(at: file, to: dest)) != nil { urls.append(dest) } else { try? FileManager.default.removeItem(at: file) }
        }
        DispatchQueue.main.async { [weak self] in
            guard let presenter = self?.presenter, !urls.isEmpty else {
                try? FileManager.default.removeItem(at: dir)
                return reply(nil, "couldn't prepare the files")
            }
            let sheet = UIActivityViewController(activityItems: urls, applicationActivities: nil)
            sheet.completionWithItemsHandler = { _, _, _, _ in try? FileManager.default.removeItem(at: dir) }
            if let pop = sheet.popoverPresentationController { pop.sourceView = presenter.view; pop.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.maxY - 80, width: 1, height: 1) }
            presenter.present(sheet, animated: true)
            reply(["shared": urls.count], nil)
        }
    }

    // MARK: - export / import (.ghostvault)
    //
    // Layout: "GHOSTVLT" | u32 headerLen | header JSON {v, pinwrap (the Keychain PIN wrap, base64), created, count}
    //         | u32 indexLen | index (chunked-encrypted with VK, fileId "index")
    //         | repeated: u16 nameLen | name ("<id>.<part>") | u64 len | the item file exactly as stored (already encrypted)
    // Nothing is decrypted on export. Import asks for the PIN the backup was made with, re-keys each file into this vault.

    private func export(reply: @escaping (Any?, String?) -> Void) {
        guard key != nil else { return reply(nil, "locked") }
        guard let wrap = Self.kcGet("pinwrap").0 else { return reply(nil, "not set up") }
        let stamp = ISO8601DateFormatter().string(from: Date()).prefix(10)
        let url = Self.tempRoot.appendingPathComponent("My Eyes Only \(stamp).ghostvault")
        guard let out = Self.createProtected(url) else { return reply(nil, "couldn't write the backup") }
        func u32(_ v: Int) -> Data { var b = UInt32(v).bigEndian; return withUnsafeBytes(of: &b) { Data($0) } }
        func u16(_ v: Int) -> Data { var b = UInt16(v).bigEndian; return withUnsafeBytes(of: &b) { Data($0) } }
        func u64(_ v: Int64) -> Data { var b = UInt64(v).bigEndian; return withUnsafeBytes(of: &b) { Data($0) } }
        do {
            let header: [String: Any] = ["v": 1, "pinwrap": wrap.base64EncodedString(), "created": Date().timeIntervalSince1970 * 1000, "count": index.count]
            let headerData = try JSONSerialization.data(withJSONObject: header)
            out.write(Data("GHOSTVLT".utf8)); out.write(u32(headerData.count)); out.write(headerData)
            let indexData = try Data(contentsOf: Self.indexURL)
            out.write(u32(indexData.count)); out.write(indexData)
            for item in index {
                guard let id = item["id"] as? String else { continue }
                for part in ["bin", "thumb", "view", "live"] {
                    let file = Self.fileURL(id, part)
                    guard let attrs = try? FileManager.default.attributesOfItem(atPath: file.path), let size = (attrs[.size] as? NSNumber)?.int64Value else { continue }
                    let name = Data("\(id).\(part)".utf8)
                    out.write(u16(name.count)); out.write(name); out.write(u64(size))
                    let input = try FileHandle(forReadingFrom: file)
                    while let chunk = try input.read(upToCount: 4 << 20), !chunk.isEmpty { out.write(chunk) }
                    try? input.close()
                }
            }
            try out.close()
        } catch {
            try? out.close()
            try? FileManager.default.removeItem(at: url)
            return reply(nil, "couldn't write the backup")
        }
        DispatchQueue.main.async { [weak self] in
            guard let self, let presenter = self.presenter else { try? FileManager.default.removeItem(at: url); return reply(nil, "unavailable") }
            self.pendingExportURL = url
            self.pickerMode = "export"
            self.pickerReply = reply
            let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
            picker.delegate = self
            presenter.present(picker, animated: true)
        }
    }

    private func importPick(reply: @escaping (Any?, String?) -> Void) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let presenter = self.presenter else { return reply(nil, "unavailable") }
            self.pickerMode = "import"
            self.pickerReply = reply
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.data, .item], asCopy: true)
            picker.allowsMultipleSelection = false
            picker.delegate = self
            presenter.present(picker, animated: true)
        }
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        finishPicker(picked: urls.first)
    }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finishPicker(picked: nil) }

    private func finishPicker(picked: URL?) {
        let reply = pickerReply
        pickerReply = nil
        if pickerMode == "export" {
            if let url = pendingExportURL { try? FileManager.default.removeItem(at: url) }
            pendingExportURL = nil
            reply?(["exported": picked != nil], nil)
            return
        }
        guard let picked else { reply?(["picked": false], nil); return }
        q.async {
            let dest = Self.tempFile("ghostvault")
            let scoped = picked.startAccessingSecurityScopedResource()
            defer { if scoped { picked.stopAccessingSecurityScopedResource() } }
            do { try FileManager.default.copyItem(at: picked, to: dest) } catch {
                return DispatchQueue.main.async { reply?(nil, "couldn't read that file") }
            }
            guard let header = Self.readBackupHeader(dest) else {
                try? FileManager.default.removeItem(at: dest)
                return DispatchQueue.main.async { reply?(nil, "that isn't a My Eyes Only backup") }
            }
            if let old = self.pendingImportURL { try? FileManager.default.removeItem(at: old) }
            self.pendingImportURL = dest
            DispatchQueue.main.async { reply?(["picked": true, "count": header["count"] ?? 0, "created": header["created"] ?? 0], nil) }
        }
    }

    private static func readBackupHeader(_ url: URL) -> [String: Any]? {
        guard let h = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? h.close() }
        guard let magic = try? h.read(upToCount: 8), magic == Data("GHOSTVLT".utf8),
              let lenData = try? h.read(upToCount: 4), lenData.count == 4 else { return nil }
        let len = Int(lenData.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }.bigEndian)
        guard len > 0, len < 1 << 20, let json = try? h.read(upToCount: len) else { return nil }
        return try? JSONSerialization.jsonObject(with: json) as? [String: Any]
    }

    private func importFinish(pin: String, reply: @escaping (Any?, String?) -> Void) {
        guard let key else { return reply(nil, "locked") }
        guard let url = pendingImportURL, let h = try? FileHandle(forReadingFrom: url) else { return reply(nil, "no backup picked") }
        defer { try? h.close() }
        func readU(_ n: Int) -> UInt64? {
            guard let d = try? h.read(upToCount: n), d.count == n else { return nil }
            return d.reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
        }
        guard (try? h.read(upToCount: 8)) == Data("GHOSTVLT".utf8), let hl = readU(4),
              let headerData = try? h.read(upToCount: Int(hl)),
              let header = try? JSONSerialization.jsonObject(with: headerData) as? [String: Any],
              let wrap = (header["pinwrap"] as? String).flatMap({ Data(base64Encoded: $0) }) else { return reply(nil, "that backup is damaged") }
        guard let oldKey = Self.unwrap(wrap, pin: pin) else { return reply(["ok": false, "reason": "pin"], nil) }
        guard let il = readU(4), let indexData = try? h.read(upToCount: Int(il)) else { return reply(nil, "that backup is damaged") }
        let indexFile = Self.tempFile("")
        defer { try? FileManager.default.removeItem(at: indexFile) }
        guard (try? indexData.write(to: indexFile, options: .completeFileProtection)) != nil,
              let plainIndex = try? Self.decryptAll(indexFile, key: oldKey, fileId: "index"),
              let items = try? JSONSerialization.jsonObject(with: plainIndex) as? [[String: Any]] else { return reply(nil, "that backup is damaged") }
        let existing = Set(index.compactMap { $0["id"] as? String })
        var imported: [[String: Any]] = []
        var written = Set<String>()
        // stream through the file records, re-keying the parts of items we don't already have
        while let nl = readU(2), let nameData = try? h.read(upToCount: Int(nl)), let name = String(data: nameData, encoding: .utf8), let size = readU(8) {
            let dot = name.firstIndex(of: ".") ?? name.endIndex
            let id = String(name[..<dot]), part = dot < name.endIndex ? String(name[name.index(after: dot)...]) : ""
            let raw = Self.tempFile("")
            guard let out = Self.createProtected(raw) else { break }
            var left = size
            while left > 0 {
                guard let chunk = try? h.read(upToCount: Int(min(left, 4 << 20))), !chunk.isEmpty else { break }
                out.write(chunk); left -= UInt64(chunk.count)
            }
            try? out.close()
            defer { try? FileManager.default.removeItem(at: raw) }
            guard left == 0 else { break }
            guard !existing.contains(id), ["bin", "thumb", "view", "live"].contains(part), UUID(uuidString: id) != nil else { continue }
            let fileId = part == "bin" ? id : "\(id).\(part)"
            do { try Self.rekey(raw, from: oldKey, to: Self.fileURL(id, part), newKey: key, fileId: fileId); written.insert(name) } catch { continue }
        }
        for item in items {
            guard let id = item["id"] as? String, !existing.contains(id), written.contains("\(id).bin"), written.contains("\(id).thumb") else { continue }
            imported.append(item)
        }
        index.append(contentsOf: imported)
        guard saveIndex() else { return reply(nil, "couldn't save the vault") }
        try? FileManager.default.removeItem(at: url)
        pendingImportURL = nil
        reply(["ok": true, "imported": imported.count, "skipped": items.count - imported.count], nil)
    }

    // MARK: - WKURLSchemeHandler: ghostvault://thumb|view|video/<id>?t=<session token>

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, let host = url.host,
              let comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return fail(task, 400) }
        let id = String(comps.percentEncodedPath.dropFirst()).removingPercentEncoding ?? ""
        let t = comps.queryItems?.first(where: { $0.name == "t" })?.value ?? ""
        let current = currentToken()
        guard !current.isEmpty, t == current, UUID(uuidString: id) != nil else { return fail(task, 403) }
        let range = task.request.value(forHTTPHeaderField: "Range")
        q.async {
            guard let key = self.key, let entry = self.entry(id) else { return DispatchQueue.main.async { self.fail(task, 404) } }
            switch host {
            case "thumb", "view":
                let data = try? Self.decryptAll(Self.fileURL(id, host), key: key, fileId: "\(id).\(host)")
                DispatchQueue.main.async { if let data { self.respond(task, data: data, mime: "image/jpeg", status: 200, extra: [:]) } else { self.fail(task, 500) } }
            case "video":
                let file = Self.fileURL(id, "bin")
                let total = Self.plainSize(of: file)
                var lower: Int64 = 0, upper: Int64 = total
                var status = 200
                if let range, range.hasPrefix("bytes="), total > 0 {
                    let parts = range.dropFirst(6).split(separator: ",").first.map(String.init)?
                        .split(separator: "-", omittingEmptySubsequences: false).map { String($0).trimmingCharacters(in: .whitespaces) } ?? []
                    if parts.count == 2 {
                        if parts[0].isEmpty { lower = max(0, total - (Int64(parts[1]) ?? 0)); upper = total }
                        else {
                            lower = Int64(parts[0]) ?? 0
                            upper = parts[1].isEmpty ? min(total, lower + 8 * 1024 * 1024) : min(total, (Int64(parts[1]) ?? (total - 1)) + 1)
                        }
                        status = 206
                    }
                }
                guard lower < upper else { return DispatchQueue.main.async { self.fail(task, 416) } }
                let data = try? Self.decryptRange(file, key: key, fileId: id, lower: lower, upper: upper)
                let uti = entry["uti"] as? String ?? ""
                let mime = UTType(uti)?.preferredMIMEType ?? "video/quicktime"
                var extra = ["Accept-Ranges": "bytes"]
                if status == 206 { extra["Content-Range"] = "bytes \(lower)-\(upper - 1)/\(total)" }
                DispatchQueue.main.async { if let data { self.respond(task, data: data, mime: mime, status: status, extra: extra) } else { self.fail(task, 500) } }
            default:
                DispatchQueue.main.async { self.fail(task, 404) }
            }
        }
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) { stoppedTasks.insert(ObjectIdentifier(task)) }

    private func fail(_ task: WKURLSchemeTask, _ code: Int) {
        guard !stoppedTasks.contains(ObjectIdentifier(task)), let url = task.request.url,
              let r = HTTPURLResponse(url: url, statusCode: code, httpVersion: "HTTP/1.1", headerFields: nil) else { return }
        task.didReceive(r)
        if !stoppedTasks.contains(ObjectIdentifier(task)) { task.didFinish() }
    }
    private func respond(_ task: WKURLSchemeTask, data: Data, mime: String, status: Int, extra: [String: String]) {
        guard !stoppedTasks.contains(ObjectIdentifier(task)), let url = task.request.url else { return }
        var headers = ["Content-Type": mime, "Content-Length": String(data.count), "Cache-Control": "no-store"]
        for (k, v) in extra { headers[k] = v }
        guard let r = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else { return fail(task, 500) }
        task.didReceive(r)
        guard !stoppedTasks.contains(ObjectIdentifier(task)) else { return }
        task.didReceive(data)
        guard !stoppedTasks.contains(ObjectIdentifier(task)) else { return }
        task.didFinish()
    }
}
