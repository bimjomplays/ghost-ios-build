import UIKit
import UserNotifications

/// Apple push (APNs) straight to Ghost, for notifications while Ghost is closed (ghost/NOTIFY_PLAN.md Phase 2).
///
/// Only a Ghost signed with Push can get a device token: the profile it was signed with must carry
/// `aps-environment`, which needs a paid developer account with Push on Ghost's App ID (livecontainer-refresh does
/// that with LCR_GHOST_PUSH=on). Ghost asks iOS for the token and ui.js hands it, with the bundle ID, environment and
/// team from that profile, to the PC relay over its encrypted control topic; the relay then sends banners with
/// Apple push instead of the ntfy app. A Ghost signed without Push (friends on a free account) never asks: their
/// notifications keep coming through ntfy. Tapping one of these banners opens the chat (GhostNotifications.swift
/// reads "ghostChat" from the push).
enum GhostPush {
    /// What the embedded provisioning profile says: aps-environment ("development" for a sideloaded team profile,
    /// "production"), the team, and when the profile ends. nil env = this install can't get Apple pushes.
    struct Profile {
        let env: String?
        let team: String?
        let expires: Date?
    }

    static let profile: Profile = readProfile()

    private static var token: String?
    private static var waiting: [(Any?, String?) -> Void] = []
    private static var timeout: DispatchWorkItem?

    /// embedded.mobileprovision is a CMS-signed property list; the XML plist sits in it unencrypted.
    private static func readProfile() -> Profile {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let start = data.range(of: Data("<?xml".utf8)),
              let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex),
              let plist = try? PropertyListSerialization.propertyList(from: data.subdata(in: start.lowerBound..<end.upperBound),
                                                                       format: nil) as? [String: Any]
        else { return Profile(env: nil, team: nil, expires: nil) }
        let entitlements = plist["Entitlements"] as? [String: Any]
        let env = entitlements?["aps-environment"] as? String
        return Profile(env: env == "development" || env == "production" ? env : nil,
                       team: (plist["TeamIdentifier"] as? [String])?.first,
                       expires: plist["ExpirationDate"] as? Date)
    }

    private static func describe(token: String?, allowed: Bool?) -> [String: Any] {
        var info: [String: Any] = ["env": profile.env ?? NSNull(), "team": profile.team ?? NSNull(),
                                   "topic": Bundle.main.bundleIdentifier ?? "", "token": token ?? NSNull()]
        if let allowed { info["allowed"] = allowed }
        if let expires = profile.expires { info["profileEnds"] = Int(expires.timeIntervalSince1970 * 1000) }
        return info
    }

    /// op "pushInfo": can this install get Apple pushes (env non-null), and the token if iOS gave one already.
    static func info() -> [String: Any] { describe(token: token, allowed: nil) }

    /// op "pushRegister": permission to show notifications, then the device token (iOS hands out the same one
    /// until Ghost is reinstalled or re-signed; asking on every launch is what Apple recommends).
    /// Replies {token, topic, env, team, allowed} or an error ("no-entitlement", "timeout", iOS's reason).
    static func register(reply: @escaping (Any?, String?) -> Void) {
        guard profile.env != nil else { return reply(nil, "no-entitlement") }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            DispatchQueue.main.async {
                waiting.append { value, error in
                    guard var info = value as? [String: Any] else { return reply(value, error) }
                    info["allowed"] = granted
                    reply(info, nil)
                }
                guard waiting.count == 1 else { return }
                let work = DispatchWorkItem { finish(nil, "timeout") }
                timeout = work
                DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: work)
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    // AppDelegate forwards these two from UIApplicationDelegate.
    static func didRegister(deviceToken: Data) {
        token = deviceToken.map { String(format: "%02x", $0) }.joined()
        finish(describe(token: token, allowed: nil), nil)
    }

    static func didFail(error: Error) {
        finish(nil, error.localizedDescription)
    }

    private static func finish(_ value: Any?, _ error: String?) {
        DispatchQueue.main.async {
            timeout?.cancel()
            timeout = nil
            let replies = waiting
            waiting = []
            for reply in replies { reply(value, error) }
        }
    }
}
