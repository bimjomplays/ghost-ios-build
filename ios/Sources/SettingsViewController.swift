import UIKit

/// The app's dark palette, shared by the settings sheet's screens.
enum DGColors {
    static let background = UIColor(red: 0x12 / 255, green: 0x12 / 255, blue: 0x12 / 255, alpha: 1)
    static let card = UIColor(red: 0x1e / 255, green: 0x1e / 255, blue: 0x1e / 255, alpha: 1)
    static let accent = UIColor(red: 0xff / 255, green: 0xfc / 255, blue: 0, alpha: 1)
}

/// WebViewController implements this to react to the settings sheet: push the new merged settings into the
/// darkmobile world, and carry out the three "action" rows (they need native code the sheet itself doesn't have).
protocol SettingsActionsDelegate: AnyObject {
    func settingsDidChange()
    func performSettingsAction(_ action: String)
}

/// Native settings sheet, built entirely from settings-schema.json (SettingsStore.shared.sections): a toggle
/// row is a UISwitch, "choice" pushes a checkmark list, "slider" is inline, "textlist" pushes a plain text
/// editor (one entry per line), "action" is a tappable row. Presented as a page sheet (App.swift's
/// presentSettingsSheet) with medium/large detents and a grabber.
final class SettingsRootViewController: UITableViewController {
    private weak var actionsDelegate: SettingsActionsDelegate?

    init(delegate: SettingsActionsDelegate?) {
        self.actionsDelegate = delegate
        super.init(style: .insetGrouped)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Settings"
        overrideUserInterfaceStyle = .dark
        view.backgroundColor = DGColors.background
        tableView.backgroundColor = DGColors.background
        navigationItem.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .done, target: self, action: #selector(doneTapped))
    }

    @objc private func doneTapped() {
        dismiss(animated: true)
    }

    private func haptic() {
        guard SettingsStore.shared.bool("haptics") else { return }
        UISelectionFeedbackGenerator().selectionChanged()
    }

    private func item(at indexPath: IndexPath) -> SettingsRow {
        SettingsStore.shared.sections[indexPath.section].rows[indexPath.row]
    }

    private static func formatSlider(_ value: Double) -> String {
        value.rounded() == value ? String(Int(value)) : String(format: "%.2f", value)
    }

    // MARK: table data

    override func numberOfSections(in tableView: UITableView) -> Int {
        SettingsStore.shared.sections.count
    }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        SettingsStore.shared.sections[section].rows.count
    }

    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        SettingsStore.shared.sections[section].title
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let row = item(at: indexPath)
        let identifier = "row-" + row.type
        let style: UITableViewCell.CellStyle = (row.type == "choice" || row.type == "textlist" || row.type == "slider") ? .value1 : .default
        let cell = tableView.dequeueReusableCell(withIdentifier: identifier) ?? UITableViewCell(style: style, reuseIdentifier: identifier)
        cell.selectionStyle = .default
        cell.accessoryView = nil
        cell.accessoryType = .none
        cell.backgroundColor = DGColors.card
        cell.textLabel?.textColor = .white
        cell.textLabel?.text = row.title
        cell.detailTextLabel?.text = nil
        cell.detailTextLabel?.textColor = UIColor(white: 0.6, alpha: 1)

        switch row.type {
        case "toggle":
            let key = row.key ?? ""
            let toggle = UISwitch()
            toggle.isOn = SettingsStore.shared.bool(key, default: (row.defaultValue as? Bool) ?? false)
            // [weak toggle]: UIControl retains its own UIAction, so capturing `toggle` strongly here would
            // keep every toggle this cell has ever shown alive forever (cells - and their accessoryView - are
            // replaced on every dequeue, not deallocated).
            toggle.addAction(UIAction { [weak self, weak toggle] _ in
                guard let isOn = toggle?.isOn else { return }
                self?.haptic()
                SettingsStore.shared.set(key, isOn)
                self?.actionsDelegate?.settingsDidChange()
            }, for: .valueChanged)
            cell.accessoryView = toggle
            cell.selectionStyle = .none

        case "choice":
            let currentValue = SettingsStore.shared.value(row.key ?? "") as? String
            cell.detailTextLabel?.text = row.options.first(where: { $0.first == currentValue })?.last ?? row.options.first?.last
            cell.accessoryType = .disclosureIndicator

        case "slider":
            let key = row.key ?? ""
            let current = (SettingsStore.shared.value(key) as? Double) ?? (row.defaultValue as? Double) ?? row.min
            cell.detailTextLabel?.text = Self.formatSlider(current)
            let slider = UISlider()
            slider.minimumValue = Float(row.min)
            slider.maximumValue = Float(row.max)
            slider.value = Float(current)
            let step = row.step
            // [weak slider]/[weak cell]: same reasoning as the toggle above - UIControl retains its own
            // UIAction, so a strong capture of the control it belongs to would leak it on every dequeue.
            slider.addAction(UIAction { [weak cell, weak slider] _ in
                guard let value = slider?.value else { return }
                let stepped = step > 0 ? (Double(value) / step).rounded() * step : Double(value)
                cell?.detailTextLabel?.text = Self.formatSlider(stepped)
            }, for: .valueChanged)
            let commit: UIActionHandler = { [weak self, weak slider] _ in
                guard let value = slider?.value else { return }
                let stepped = step > 0 ? (Double(value) / step).rounded() * step : Double(value)
                self?.haptic()
                SettingsStore.shared.set(key, stepped)
                self?.actionsDelegate?.settingsDidChange()
            }
            slider.addAction(UIAction(handler: commit), for: .touchUpInside)
            slider.addAction(UIAction(handler: commit), for: .touchUpOutside)
            cell.accessoryView = slider
            cell.selectionStyle = .none

        case "textlist":
            let count = (SettingsStore.shared.value(row.key ?? "") as? [String])?.count ?? 0
            cell.detailTextLabel?.text = "\(count)"
            cell.accessoryType = .disclosureIndicator

        case "action":
            cell.textLabel?.textColor = DGColors.accent

        default:
            break
        }
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        let row = item(at: indexPath)
        switch row.type {
        case "choice":
            guard let key = row.key else { return }
            let picker = SettingsChoiceViewController(title: row.title, key: key, options: row.options) { [weak self, weak tableView] in
                self?.haptic()
                self?.actionsDelegate?.settingsDidChange()
                tableView?.reloadRows(at: [indexPath], with: .automatic)
            }
            navigationController?.pushViewController(picker, animated: true)

        case "textlist":
            guard let key = row.key else { return }
            let editor = SettingsTextListViewController(title: row.title, key: key) { [weak self, weak tableView] in
                self?.actionsDelegate?.settingsDidChange()
                tableView?.reloadRows(at: [indexPath], with: .automatic)
            }
            navigationController?.pushViewController(editor, animated: true)

        case "action":
            haptic()
            if let action = row.action { actionsDelegate?.performSettingsAction(action) }

        default:
            break
        }
    }
}

/// Pushed by a "choice" row: a plain checkmark list built from the row's `options` ([value, label] pairs).
final class SettingsChoiceViewController: UITableViewController {
    private let key: String
    private let options: [[String]]
    private let onChange: () -> Void

    init(title: String, key: String, options: [[String]], onChange: @escaping () -> Void) {
        self.key = key
        self.options = options
        self.onChange = onChange
        super.init(style: .insetGrouped)
        self.title = title
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        overrideUserInterfaceStyle = .dark
        view.backgroundColor = DGColors.background
        tableView.backgroundColor = DGColors.background
    }

    override func numberOfSections(in tableView: UITableView) -> Int { 1 }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { options.count }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let identifier = "choice"
        let cell = tableView.dequeueReusableCell(withIdentifier: identifier) ?? UITableViewCell(style: .default, reuseIdentifier: identifier)
        let option = options[indexPath.row]
        cell.backgroundColor = DGColors.card
        cell.textLabel?.textColor = .white
        cell.textLabel?.text = option.last ?? option.first ?? ""
        let current = SettingsStore.shared.value(key) as? String
        cell.accessoryType = (option.first == current) ? .checkmark : .none
        cell.tintColor = DGColors.accent
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        guard let value = options[indexPath.row].first else { return }
        SettingsStore.shared.set(key, value)
        onChange()
        tableView.reloadData()
    }
}

/// Pushed by a "textlist" row: one plain text editor, one entry per line, saved when the screen goes away.
final class SettingsTextListViewController: UIViewController, UITextViewDelegate {
    private let key: String
    private let onChange: () -> Void
    private let textView = UITextView()

    init(title: String, key: String, onChange: @escaping () -> Void) {
        self.key = key
        self.onChange = onChange
        super.init(nibName: nil, bundle: nil)
        self.title = title
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        overrideUserInterfaceStyle = .dark
        view.backgroundColor = DGColors.background

        let lines = (SettingsStore.shared.value(key) as? [String]) ?? []
        textView.text = lines.joined(separator: "\n")
        textView.backgroundColor = DGColors.card
        textView.textColor = .white
        textView.font = .systemFont(ofSize: 17)
        textView.keyboardAppearance = .dark
        textView.delegate = self
        textView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(textView)
        NSLayoutConstraint.activate([
            textView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 12),
            textView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -12),
            textView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            textView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -8),
        ])
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        save()
    }

    private func save() {
        let lines = textView.text.components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        SettingsStore.shared.set(key, lines)
        onChange()
    }
}
