// The menu bar item (AppKit). Exactly three menu items, built in one place
// (MenuBuilder) for both the app and --dump-menu.

import AppKit

enum MenuBuilder {
    /// The menu: Open Dashboard, Stop All Services, Quit — nothing else.
    static func build(target: AnyObject?, action: Selector?) -> NSMenu {
        let menu = NSMenu(title: Titles.accessibilityLabel)
        menu.autoenablesItems = false
        for id in MenuItemID.allCases {
            let item = NSMenuItem(title: id.title, action: action, keyEquivalent: "")
            item.tag = id.rawValue
            item.target = target
            item.isEnabled = true
            menu.addItem(item)
        }
        return menu
    }
}

final class StatusMenu: NSObject, NSMenuDelegate, MenuSurface {
    private let controller: Controller
    private let statusItem: NSStatusItem
    private let menu: NSMenu
    private let work = DispatchQueue(label: "nidum.menubar.actions", attributes: .concurrent)

    init(controller: Controller) {
        self.controller = controller
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        menu = MenuBuilder.build(target: nil, action: #selector(StatusMenu.choose(_:)))
        super.init()
        for item in menu.items { item.target = self }
        menu.delegate = self
        if let button = statusItem.button {
            button.image = Icon.templateImage()
            button.imagePosition = .imageOnly
            button.toolTip = Titles.accessibilityLabel
            button.setAccessibilityLabel(Titles.accessibilityLabel)
        }
        statusItem.menu = menu
        controller.ui = self
    }

    @objc private func choose(_ sender: NSMenuItem) {
        guard let id = MenuItemID(rawValue: sender.tag) else { return }
        let controller = self.controller
        switch id {
        case .openDashboard:
            work.async { controller.openDashboard() }
        case .stopAll:
            work.async { controller.stopAll() }
        case .quit:
            work.async {
                if controller.quitAll().quitApp {
                    DispatchQueue.main.async { NSApp.terminate(nil) }
                }
            }
        }
    }

    // MARK: NSMenuDelegate

    func menuWillOpen(_ menu: NSMenu) {
        let controller = self.controller
        guard !controller.isBusy else { return }
        // At once from the last known state (a lock read only), then refreshed below.
        item(.stopAll)?.isEnabled = controller.stopEnabled
        item(.quit)?.isEnabled = controller.quitEnabled
        work.async {
            controller.refreshState()
            if !controller.isBusy {
                DispatchQueue.main.async {
                    self.item(.stopAll)?.isEnabled = controller.stopEnabled
                    self.item(.quit)?.isEnabled = controller.quitEnabled
                }
            }
        }
    }

    private func item(_ id: MenuItemID) -> NSMenuItem? {
        menu.items.first { $0.tag == id.rawValue }
    }

    // MARK: MenuSurface

    func note(_ line: String) {}

    func open(_ url: URL) -> Bool {
        onMain { NSWorkspace.shared.open(url) }
    }

    func alert(title: String, info: String, buttons: [String]) -> String {
        onMain { Self.runAlert(title: title, info: info, buttons: buttons) }
    }

    /// Builds the alert with D55's keys, without showing it (the self-test reads it back):
    /// the button `AlertPolicy.safeChoice` names (Cancel, when offered) gets Return
    /// explicitly, so it is the default button; every other button gets no key, and Quit
    /// Anyway is marked destructive. Escape is handled by `runAlert` (AppKit's own
    /// Escape-for-"Cancel" rule is replaced by setting Return here).
    static func makeAlert(title: String, info: String, buttons: [String]) -> NSAlert {
        let a = NSAlert()
        a.alertStyle = .warning
        a.messageText = title
        a.informativeText = info
        let safe = AlertPolicy.safeChoice(buttons)
        for b in buttons {
            let button = a.addButton(withTitle: b)
            if b == Titles.quitAnyway { button.hasDestructiveAction = true }
        }
        a.layout()
        // After addButton and layout, so AppKit's defaults can't override them.
        for button in a.buttons {
            button.keyEquivalent = button.title == safe ? "\r" : ""
            button.keyEquivalentModifierMask = []
        }
        return a
    }

    /// Shows the alert modally and returns the chosen title (D55): Return and Escape both
    /// pick Cancel when it is offered; any response that isn't one of the buttons counts
    /// as `AlertPolicy.safeChoice` (Cancel), never Quit Anyway. Main thread only.
    static func runAlert(title: String, info: String, buttons: [String]) -> String {
        if #available(macOS 14, *) {
            NSApp.activate()
        } else {
            NSApp.activate(ignoringOtherApps: true)
        }
        let a = makeAlert(title: title, info: info, buttons: buttons)
        let monitor = installKeyMonitor(a, buttons: buttons)
        defer { if let m = monitor { NSEvent.removeMonitor(m) } }
        let response = a.runModal()
        return AlertPolicy.choice(for: response, buttons: buttons)
    }

    /// Escape (and Command-.) → the Cancel button, on every macOS version, whatever key
    /// AppKit gives it; Return and Enter → the safe button too. A local monitor (it only
    /// sees this app's events) that acts only on key presses for this alert's window and
    /// clicks the button `AlertPolicy.buttonForKey` names; every other key, and every
    /// key for another window, goes on untouched. The caller removes it (`runAlert` does
    /// as soon as `runModal` returns). The self-test `alert-keys` drives this same
    /// monitor with key presses for the alert's window and for another one; `passedOn`
    /// (self-test only) is told about each key the monitor lets through.
    static func installKeyMonitor(_ a: NSAlert, buttons: [String], passedOn: ((NSEvent) -> Void)? = nil) -> Any? {
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            guard event.window === a.window,
                  let target = AlertPolicy.buttonForKey(event, buttons: buttons),
                  let button = a.buttons.first(where: { $0.title == target })
            else {
                passedOn?(event)
                return event
            }
            button.performClick(nil)
            return nil
        }
    }

    func show(_ id: MenuItemID, title: String, enabled: Bool) {
        DispatchQueue.main.async {
            guard let item = self.item(id) else { return }
            item.title = title
            item.isEnabled = enabled
        }
    }

    private func onMain<T>(_ body: () -> T) -> T {
        if Thread.isMainThread { return body() }
        return DispatchQueue.main.sync(execute: body)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let controller: Controller
    private let lock: InstanceLock
    private var statusMenu: StatusMenu?

    init(controller: Controller, lock: InstanceLock) {
        self.controller = controller
        self.lock = lock
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusMenu = StatusMenu(controller: controller)
    }

    func applicationWillTerminate(_ notification: Notification) {
        lock.release()
    }
}

/// D55: which button an alert's keys and odd responses pick. Shared by the real alert
/// (`StatusMenu.runAlert`) and the self-test (`ConsoleSurface`), so both say the same.
enum AlertPolicy {
    /// What Return, Escape and any unexpected response pick: Cancel when it is offered
    /// (never Quit Anyway), else the first button (an "OK" alert).
    static func safeChoice(_ buttons: [String]) -> String {
        buttons.contains(Titles.cancel) ? Titles.cancel : (buttons.first ?? Titles.ok)
    }

    /// The button a key press picks, or nil to let AppKit handle the key. Return and Enter
    /// pick `safeChoice`; Escape and Command-. pick Cancel when it is offered.
    static func buttonForKey(_ event: NSEvent, buttons: [String]) -> String? {
        let chars = event.charactersIgnoringModifiers ?? ""
        let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let isReturn = event.keyCode == 36 || event.keyCode == 76 || chars == "\r" || chars == "\u{3}"
        let isEscape = event.keyCode == 53 || chars == "\u{1b}" || (mods == .command && chars == ".")
        if isReturn && mods.subtracting([.numericPad, .function]).isEmpty { return safeChoice(buttons) }
        if isEscape && buttons.contains(Titles.cancel) { return Titles.cancel }
        return nil
    }

    /// The chosen title for a modal response; anything that isn't one of the buttons
    /// (an aborted or stopped modal session, …) counts as `safeChoice`.
    static func choice(for response: NSApplication.ModalResponse, buttons: [String]) -> String {
        let index = response.rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
        return (index >= 0 && index < buttons.count) ? buttons[index] : safeChoice(buttons)
    }

    /// Self-test `alert-keys`: builds the real "Sharing is still on." alert (never shown)
    /// and reports its keys, the default button, synthesized key presses and odd responses.
    static func describeQuitAlert() -> [String] {
        _ = NSApplication.shared
        let buttons = [Titles.cancel, Titles.quitAnyway]
        let a = StatusMenu.makeAlert(title: Titles.stillOn, info: "", buttons: buttons)
        var out: [String] = []
        for b in a.buttons {
            let key: String
            switch b.keyEquivalent {
            case "\r": key = "return"
            case "\u{1b}": key = "escape"
            case "": key = "none"
            default: key = b.keyEquivalent.unicodeScalars.map { String(format: "U+%04X", $0.value) }.joined()
            }
            let isDefault = a.window.defaultButtonCell === b.cell
            out.append("button: \(b.title) key=\(key) default=\(isDefault) destructive=\(b.hasDestructiveAction)")
        }
        func press(_ chars: String, _ code: UInt16, _ mods: NSEvent.ModifierFlags = []) -> String {
            guard let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: mods, timestamp: 0, windowNumber: 0,
                                           context: nil, characters: chars, charactersIgnoringModifiers: chars,
                                           isARepeat: false, keyCode: code)
            else { return "none" }
            return buttonForKey(e, buttons: buttons) ?? "none"
        }
        out.append("key: return -> \(press("\r", 36))")
        out.append("key: enter -> \(press("\u{3}", 76, .numericPad))")
        out.append("key: escape -> \(press("\u{1b}", 53))")
        out.append("key: command-. -> \(press(".", 47, .command))")
        out.append("key: q -> \(press("q", 12))")
        for (name, r) in [("abort", NSApplication.ModalResponse.abort), ("stop", .stop), ("cancel", .cancel), ("OK", .OK), ("fourth button", NSApplication.ModalResponse(rawValue: NSApplication.ModalResponse.alertFirstButtonReturn.rawValue + 3))] {
            out.append("response: \(name) -> \(choice(for: r, buttons: buttons))")
        }
        out.append("response: second button -> \(choice(for: .alertSecondButtonReturn, buttons: buttons))")
        return out
    }

    /// Why alerts can't be built or driven here (no window server: an ssh or CI
    /// session), or nil when they can.
    static func monitorSkipReason() -> String? {
        guard CGSessionCopyCurrentDictionary() != nil else {
            return "alert-keys needs a window-server connection to build the alert and send it key presses, and this process has none (it is not running in a logged-in GUI session, for example over ssh or in CI)"
        }
        return nil
    }

    /// Self-test `alert-keys`, part two: drives the real key monitor
    /// (`StatusMenu.installKeyMonitor`) with synthesized key-downs, without showing
    /// anything. The alert is built as `runAlert` builds it, but its buttons click a
    /// recorder instead of ending a modal session; its panel is ordered in fully
    /// transparent and far off screen (to get a window number), and the app can't
    /// become active (`.prohibited`), so nothing is seen and nothing takes focus. Each
    /// line says which button the monitor clicked and whether it let the key through:
    ///   - keys for the alert's window: Return, Enter, Escape, Command-. → Cancel, held
    ///     back; `q` → nothing, passed on;
    ///   - Return and Escape for another window → nothing, passed on;
    ///   - Escape for the alert's window after the monitor is removed → nothing, not seen.
    static func driveKeyMonitor() -> [String] {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        let buttons = [Titles.cancel, Titles.quitAnyway]
        let a = StatusMenu.makeAlert(title: Titles.stillOn, info: "", buttons: buttons)
        let recorder = ClickRecorder()
        for b in a.buttons {
            b.target = recorder
            b.action = #selector(ClickRecorder.clicked(_:))
        }
        // The alert's panel is deferred: it gets a window number (which key events name
        // their window by) only once it is ordered in. So it is ordered in fully
        // transparent, ignoring the mouse, far off screen and behind everything; the
        // app can't become active, so it never takes focus. It is ordered out at the end.
        let w = a.window
        w.alphaValue = 0
        w.hasShadow = false
        w.ignoresMouseEvents = true
        w.animationBehavior = .none
        w.setFrameOrigin(NSPoint(x: -30000, y: -30000))
        w.orderBack(nil)
        defer { w.orderOut(nil) }
        let other = NSWindow(contentRect: NSRect(x: -30000, y: -30000, width: 8, height: 8), styleMask: [.borderless],
                             backing: .buffered, defer: false)
        other.isReleasedWhenClosed = false
        var out = ["monitor: windows alert=\(a.window.windowNumber > 0) other=\(other.windowNumber > 0) distinct=\(a.window.windowNumber != other.windowNumber)"]
        /// Posts one key-down for `window`, then a marker event, and pumps the queue the
        /// way a modal session does (`nextEvent`, then `sendEvent`, which runs the local
        /// monitors) until the marker comes back. While this runs the buttons have no key
        /// equivalents, so only the monitor can click one (a Return that got through
        /// would otherwise click Cancel by its key and hide a broken monitor).
        var passed = false
        func press(_ name: String, _ chars: String, _ code: UInt16, _ mods: NSEvent.ModifierFlags = [], to window: NSWindow, _ label: String) {
            recorder.titles = []
            guard let key = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: mods, timestamp: ProcessInfo.processInfo.systemUptime,
                                             windowNumber: window.windowNumber, context: nil, characters: chars,
                                             charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code),
                  let marker = NSEvent.otherEvent(with: .applicationDefined, location: .zero, modifierFlags: [], timestamp: 0,
                                                  windowNumber: 0, context: nil, subtype: 0x4E4C, data1: 7, data2: 0)
            else { out.append("monitor: \(name) \(label) -> couldn't make the event"); return }
            app.postEvent(key, atStart: false)
            app.postEvent(marker, atStart: false)
            passed = false
            var sawMarker = false
            let until = Date().addingTimeInterval(3)
            while !sawMarker, Date() < until {
                guard let e = app.nextEvent(matching: [.keyDown, .applicationDefined], until: until, inMode: .default, dequeue: true) else { break }
                if e.type == .applicationDefined, e.subtype.rawValue == 0x4E4C { sawMarker = true }
                else if e.type == .keyDown { app.sendEvent(e) }
            }
            let clicked = recorder.titles.isEmpty ? "none" : recorder.titles.joined(separator: "+")
            // "held back": it clicked and kept the key; "passed on": it let the key
            // through; "not seen": it wasn't called (removed, or never installed).
            let fate = !sawMarker ? "lost" : passed ? "passed on" : recorder.titles.isEmpty ? "not seen" : "held back"
            out.append("monitor: \(name) \(label) -> \(clicked) (\(fate))")
        }
        let keys = a.buttons.map { $0.keyEquivalent }
        for b in a.buttons { b.keyEquivalent = "" }
        defer { for (b, k) in zip(a.buttons, keys) { b.keyEquivalent = k } }
        let monitor = StatusMenu.installKeyMonitor(a, buttons: buttons, passedOn: { _ in passed = true })
        press("return", "\r", 36, to: a.window, "in alert")
        press("enter", "\u{3}", 76, .numericPad, to: a.window, "in alert")
        press("escape", "\u{1b}", 53, to: a.window, "in alert")
        press("command-.", ".", 47, .command, to: a.window, "in alert")
        press("q", "q", 12, to: a.window, "in alert")
        press("return", "\r", 36, to: other, "in other window")
        press("escape", "\u{1b}", 53, to: other, "in other window")
        if let m = monitor { NSEvent.removeMonitor(m) }
        press("escape", "\u{1b}", 53, to: a.window, "after removal")
        other.close()
        return out
    }
}

/// Records which alert button was clicked (self-test only).
final class ClickRecorder: NSObject {
    var titles: [String] = []
    @objc func clicked(_ sender: NSButton) { titles.append(sender.title) }
}
