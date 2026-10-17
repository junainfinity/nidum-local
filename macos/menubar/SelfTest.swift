// --self-test <scenario>: runs an action headlessly against the server described by
// <home>/session.json (for example test/helpers/mock-api.js), with the browser opener
// and alerts replaced by stdout lines. Never creates any UI. Exit 0 = the action ended
// the way the user asked (opened / stopped / quit); 1 = it ended in an error alert or Cancel;
// 2 = usage error.
//
// Self-test never reaches real state (N7 validation 1 finding 1):
//   - it refuses to run (exit 2) unless `--home` or NIDUM_HOME names the home explicitly,
//     so the default ~/.nidum-local is never read;
//   - it starts a server only with an explicit `--app-root` (as the app does), and prints
//     which src/server.js and which Node it starts.
//
//   open        Open Dashboard (starts the server first when it isn't running)
//   stop        Stop All Services
//   quit        Quit (stop, then POST /api/quit)
//   menu-state  print each item's enabled state as the menu would show it
//   lock        check the single-instance lock
//   alert-keys  build the real "Sharing is still on." alert without showing it, and print
//               its key equivalents, default button, key presses and odd responses (D55);
//               then drive the real key monitor with synthesized key-downs for the
//               alert's window and for another window. Without a window server (ssh,
//               CI) it prints "skipped: <why>" and exits 0
//
// --alert-response <button title> picks the alert button. Without it (or when it names a
// button the alert doesn't have) the choice is AlertPolicy.safeChoice — Cancel when it is
// offered, else the first button — which is what Return, Escape and any unexpected
// response pick in the real alert (D55).

import Foundation

final class ConsoleSurface: MenuSurface {
    private let response: String?
    private var shown: [MenuItemID: String] = [:]
    private let lock = NSLock()

    init(response: String?) {
        self.response = response
        for id in MenuItemID.allCases { shown[id] = id.title }
    }

    func out(_ line: String) {
        lock.lock(); defer { lock.unlock() }
        FileHandle.standardOutput.write(Data((line + "\n").utf8))
    }

    func note(_ line: String) { out("note: \(line)") }

    func open(_ url: URL) -> Bool {
        out("open-url: \(url.absoluteString)")
        return true
    }

    func alert(title: String, info: String, buttons: [String]) -> String {
        let choice = response.flatMap { buttons.contains($0) ? $0 : nil } ?? AlertPolicy.safeChoice(buttons)
        out("alert: \(title) | \(info) | buttons: \(buttons.joined(separator: ", ")) -> \(choice)")
        return choice
    }

    func show(_ id: MenuItemID, title: String, enabled: Bool) {
        let label = title + (enabled ? "" : " (disabled)")
        lock.lock()
        let changed = shown[id] != label
        shown[id] = label
        lock.unlock()
        if changed { out("menu: \(id.title) -> \(label)") }
    }
}

enum SelfTest {
    static let scenarios = ["open", "stop", "quit", "menu-state", "lock", "alert-keys"]

    static func run(_ scenario: String, controller: Controller, home: URL, alertResponse: String?) -> Int32 {
        let ui = ConsoleSurface(response: alertResponse)
        controller.ui = ui
        controller.pollInterval = 0.1
        ui.out("self-test: \(scenario)")
        ui.out("home: \(home.path)")
        controller.starter.onStart = { server, node in ui.out("server: starting \(server) with \(node)") }
        switch scenario {
        case "open":
            return finish(ui, controller.openDashboard())
        case "stop":
            return finish(ui, controller.stopAll())
        case "quit":
            let quit = controller.quitAll()
            if quit.quitApp { ui.out("exit: menu app quits") }
            return finish(ui, quit.quitApp && quit.ok)
        case "menu-state":
            controller.refreshState()
            let state = controller.sharingOn.map { $0 ? "on" : "off" } ?? "unknown"
            ui.out("sharing: \(state)")
            ui.out("item: \(Titles.openDashboard) enabled=true")
            ui.out("item: \(Titles.stopAll) enabled=\(controller.stopEnabled)")
            ui.out("item: \(Titles.quit) enabled=\(controller.quitEnabled)")
            return finish(ui, true)
        case "lock":
            let first = InstanceLock(home: home)
            let second = InstanceLock(home: home)
            let a = first.acquire()
            ui.out("lock: first instance \(describe(a, "holds the lock"))")
            if case .unusable = a { return finish(ui, false) }
            let b = second.acquire()
            ui.out("lock: second instance \(describe(b, "also got the lock"))")
            first.release()
            let c = second.acquire()
            ui.out("lock: after release \(describe(c, "acquired"))")
            second.release()
            return finish(ui, a == .acquired && b == .heldElsewhere && c == .acquired)
        case "alert-keys":
            // Alerts and their windows need a window server. Without one (ssh, CI) this
            // scenario is skipped, says why, and exits 0 (N7 validation 3 P3).
            if let why = AlertPolicy.monitorSkipReason() {
                ui.out("skipped: \(why)")
                return 0
            }
            let report = AlertPolicy.describeQuitAlert()
            for line in report { ui.out(line) }
            // The key monitor itself (N7 validation 3 finding 3).
            let lines = AlertPolicy.driveKeyMonitor()
            for line in lines { ui.out(line) }
            let want = [
                "monitor: windows alert=true other=true distinct=true",
                "monitor: return in alert -> \(Titles.cancel) (held back)",
                "monitor: enter in alert -> \(Titles.cancel) (held back)",
                "monitor: escape in alert -> \(Titles.cancel) (held back)",
                "monitor: command-. in alert -> \(Titles.cancel) (held back)",
                "monitor: q in alert -> none (passed on)",
                "monitor: return in other window -> none (passed on)",
                "monitor: escape in other window -> none (passed on)",
                "monitor: escape after removal -> none (not seen)",
            ]
            let monitorOK = lines == want
            let expected = [
                "button: \(Titles.cancel) key=return default=true destructive=false",
                "button: \(Titles.quitAnyway) key=none default=false destructive=true",
            ]
            let keysOK = report.filter { $0.hasPrefix("button: ") } == expected
            let picks = report.filter { $0.hasPrefix("key: ") || $0.hasPrefix("response: ") }
            let picksOK = picks.allSatisfy { line in
                if line.hasPrefix("key: q ") { return line.hasSuffix("-> none") }
                if line.hasPrefix("response: second button") { return line.hasSuffix("-> \(Titles.quitAnyway)") }
                return line.hasSuffix("-> \(Titles.cancel)")
            }
            return finish(ui, keysOK && picksOK && monitorOK)
        default:
            ui.out("unknown scenario \(scenario); use one of \(scenarios.joined(separator: ", "))")
            return 2
        }
    }

    private static func describe(_ r: LockResult, _ acquired: String) -> String {
        switch r {
        case .acquired: return acquired
        case .heldElsewhere: return "refused"
        case .unusable(let why): return "unusable: \(why)"
        }
    }

    private static func finish(_ ui: ConsoleSurface, _ ok: Bool) -> Int32 {
        ui.out("result: \(ok ? "ok" : "failed")")
        return ok ? 0 : 1
    }
}
