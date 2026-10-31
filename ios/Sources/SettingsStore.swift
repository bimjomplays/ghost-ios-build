import Foundation

/// One row from ios/Resources/settings-schema.json. `key` and `default` are absent for "action" rows.
/// `options` (for "choice") is an array of [value, label] pairs; `min`/`max`/`step` are for "slider".
struct SettingsRow {
    let key: String?
    let type: String
    let title: String
    let action: String?
    let options: [[String]]
    let min: Double
    let max: Double
    let step: Double
    let defaultValue: Any?

    init(raw: [String: Any]) {
        key = raw["key"] as? String
        type = raw["type"] as? String ?? ""
        title = raw["title"] as? String ?? ""
        action = raw["action"] as? String
        options = raw["options"] as? [[String]] ?? []
        min = raw["min"] as? Double ?? 0
        max = raw["max"] as? Double ?? 1
        step = raw["step"] as? Double ?? 1
        defaultValue = raw["default"]
    }
}

struct SettingsSection {
    let title: String
    let rows: [SettingsRow]
}

/// Loads ios/Resources/settings-schema.json once and is the single place native code reads or writes a
/// setting. Overrides (only the values the user actually changed) live in UserDefaults under "dgSettings"
/// as a plain JSON-compatible dictionary; `merged` = schema defaults + those overrides. The darkmobile
/// world's settings.js mirrors the same merged dictionary as `window.__dgSettingsInit` (initial value) /
/// `window.__dgApplySettings` (pushed after every native-side change - see WebViewController.settingsDidChange).
final class SettingsStore {
    static let shared = SettingsStore()
    static let userDefaultsKey = "dgSettings"

    private(set) var sections: [SettingsSection] = []
    private var defaultsDict: [String: Any] = [:]
    private var overrides: [String: Any] = [:]
    private(set) var merged: [String: Any] = [:]

    private init() {
        loadSchema()
        overrides = UserDefaults.standard.dictionary(forKey: Self.userDefaultsKey) ?? [:]
        recompute()
    }

    private func loadSchema() {
        guard let url = Bundle.main.url(forResource: "settings-schema", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let rawSections = json["sections"] as? [[String: Any]] else { return }
        var built: [SettingsSection] = []
        var defaults: [String: Any] = [:]
        for rawSection in rawSections {
            let rawRows = rawSection["rows"] as? [[String: Any]] ?? []
            // "ghostOnly" rows (e.g. showInChats) only mean something in Ghost's own UI
            let rows = rawRows.filter { ($0["ghostOnly"] as? Bool) != true || WebViewController.ghostMode }.map { SettingsRow(raw: $0) }
            for row in rows {
                if let key = row.key, let def = row.defaultValue { defaults[key] = def }
            }
            built.append(SettingsSection(title: rawSection["title"] as? String ?? "", rows: rows))
        }
        sections = built
        defaultsDict = defaults
    }

    private func recompute() {
        merged = defaultsDict.merging(overrides) { _, new in new }
    }

    /// A schema key, or a free-form "x_..." key for native-only state that has no settings-sheet row
    /// (e.g. the chat-row long-press nickname map, "x_nicknames").
    func isValidKey(_ key: String) -> Bool {
        if key.hasPrefix("x_") { return true }
        for section in sections where section.rows.contains(where: { $0.key == key }) { return true }
        return false
    }

    func value(_ key: String) -> Any? { merged[key] }

    func bool(_ key: String, default fallback: Bool = true) -> Bool {
        (merged[key] as? Bool) ?? fallback
    }

    /// Saves `value` for `key` (nil removes the override, falling back to the schema default again).
    /// Returns false if `key` isn't a schema key or an "x_..." key.
    @discardableResult
    func set(_ key: String, _ value: Any?) -> Bool {
        guard isValidKey(key) else { return false }
        // JS null arrives as NSNull, and UserDefaults throws on anything that isn't a property list (NSNull
        // anywhere inside a value included): treat null as "remove", refuse other non-plist values.
        if let value, !(value is NSNull) {
            guard PropertyListSerialization.propertyList(value, isValidFor: .binary) else { return false }
            overrides[key] = value
        } else {
            overrides.removeValue(forKey: key)
        }
        UserDefaults.standard.set(overrides, forKey: Self.userDefaultsKey)
        recompute()
        return true
    }

    /// The current merged dictionary as JSON, for `window.__dgSettingsInit` / `window.__dgApplySettings` /
    /// the reply to the "getSettings" op.
    var mergedJSON: String {
        guard JSONSerialization.isValidJSONObject(merged), let data = try? JSONSerialization.data(withJSONObject: merged) else { return "{}" }
        return String(data: data, encoding: .utf8) ?? "{}"
    }
}
