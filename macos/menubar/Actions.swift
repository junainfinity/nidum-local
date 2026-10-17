// The three actions (D40–D42), independent of AppKit so --self-test can run them
// headlessly. All of them block: the app calls them off the main thread.
//
//   Open Dashboard     health check (pid match) → open http://127.0.0.1:<port>/?t=<token>;
//                      not running → start the server, wait ≤ 10 s for health, then open.
//   Stop All Services  POST /api/proxy/stop → poll GET /api/state until the job ends
//                      (E3; service-managed proxies run `service-stop`, E12). Failure → one alert.
//   Quit               stop as above, then POST /api/quit, then exit. If stopping fails:
//                      "Sharing is still on." with Cancel / Quit Anyway. Return and Escape
//                      both pick Cancel, and so does any unexpected alert response (D55).
//                      If the server doesn't quit: "Nidum Local didn't quit." the same way.
//
// Job polling has an overall deadline (N7 validation 1 finding 2): `jobWait` (120 s) while
// no password dialog is up — N1's elevated commands time out after 120 s, so the server
// normally ends the job first — and, each time the job enters `waitingForPassword`, at
// least `passwordWait` (120 s elevate timeout + 30 s margin) from then on. `jobHardCap`
// (300 s) bounds it in all cases, so Quit is never disabled for longer than that. The
// poll also stops (with an alert) when another job replaces ours, or when /api/state
// answers 401, 3xx or another non-2xx (5xx is retried once after 1 s, §7).

import Foundation

/// What an action needs from the outside world. The menu bar implements it with AppKit;
/// --self-test implements it with stdout lines (no UI at all).
protocol MenuSurface: AnyObject {
    /// A progress note (self-test prints it; the app ignores it).
    func note(_ line: String)
    /// Opens a URL in the default browser.
    func open(_ url: URL) -> Bool
    /// Shows an alert and returns the title of the chosen button.
    func alert(title: String, info: String, buttons: [String]) -> String
    /// Changes an item's title and enabled state (progress, or back to normal).
    func show(_ item: MenuItemID, title: String, enabled: Bool)
}

enum StopOutcome {
    case stopped
    case alreadyOff
    case failed(String)
}

/// How Quit ended. `quitApp`: the menu app should exit. `ok`: false when the server
/// didn't quit (finding 4), even if the user chose Quit Anyway; self-test exits 0 only
/// when both are true.
struct QuitResult {
    let quitApp: Bool
    let ok: Bool
}

final class Controller {
    let home: URL
    let starter: ServerStarter
    let api = ApiClient()
    weak var ui: MenuSurface?

    /// Seconds to wait for a started server to answer health (node note: ≤ 10 s).
    var startWait: TimeInterval = 10
    /// Seconds to wait for a stop job while no password dialog is up.
    var jobWait: TimeInterval = 120
    /// Seconds a job may take after it enters `waitingForPassword` (N1's elevate timeout
    /// of 120 s plus a 30 s margin).
    var passwordWait: TimeInterval = 150
    /// Absolute bound on any one job wait.
    var jobHardCap: TimeInterval = 300
    /// Seconds to wait for the server to go away after POST /api/quit.
    var quitWait: TimeInterval = 5
    var pollInterval: TimeInterval = 0.25

    private let lock = NSLock()
    private let startLock = NSLock()
    private var busy = false
    /// Last known sharing state: true = on, false = off, nil = unknown.
    private(set) var sharingOn: Bool?
    private(set) var jobRunning = false

    init(home: URL, starter: ServerStarter) {
        self.home = home
        self.starter = starter
    }

    var isBusy: Bool {
        lock.lock(); defer { lock.unlock() }
        return busy
    }

    private func beginBusy() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if busy { return false }
        busy = true
        return true
    }

    private func endBusy() {
        lock.lock(); busy = false; lock.unlock()
    }

    private func note(_ s: String) { ui?.note(s) }

    // MARK: - menu state

    /// Whether "Stop All Services" should be enabled: not while an action or a sharing job
    /// runs, and not while sharing is already off.
    var stopEnabled: Bool {
        lock.lock(); defer { lock.unlock() }
        return !busy && !jobRunning && sharingOn != false
    }

    var quitEnabled: Bool { !isBusy }

    /// Reads the current state without starting anything (used when the menu opens).
    func refreshState() {
        guard let s = readSession(home: home), api.healthy(s) else {
            lock.lock(); sharingOn = nil; jobRunning = false; lock.unlock()
            return
        }
        let r = api.send("GET", port: s.port, path: "/api/state", token: s.token, timeout: 5)
        lock.lock(); defer { lock.unlock() }
        guard r.ok, let proxy = r.json?["proxy"] as? [String: Any] else {
            sharingOn = nil; jobRunning = false
            return
        }
        sharingOn = proxy["running"] as? Bool
        if let job = proxy["job"] as? [String: Any] { jobRunning = !(job["finishedAt"] is String) } else { jobRunning = false }
    }

    /// Puts every item back to its normal title and state.
    func restoreItems() {
        ui?.show(.openDashboard, title: Titles.openDashboard, enabled: true)
        ui?.show(.stopAll, title: Titles.stopAll, enabled: stopEnabled)
        ui?.show(.quit, title: Titles.quit, enabled: quitEnabled)
    }

    // MARK: - reaching the server

    /// A healthy session (§4 pid match). When `start` is set and none answers, starts the
    /// server like the launcher and waits ≤ `startWait` seconds for it.
    func reach(start: Bool, item: MenuItemID) -> Result<Session, StartError> {
        if let s = readSession(home: home), api.healthy(s) {
            note("health: ok (pid \(s.pid))")
            return .success(s)
        }
        guard start else { return .failure(StartError(Titles.stoppedAnswering)) }
        startLock.lock(); defer { startLock.unlock() }
        // Another action may have started it while we waited for the lock.
        if let s = readSession(home: home), api.healthy(s) {
            note("health: ok (pid \(s.pid))")
            return .success(s)
        }
        note("server: not running; starting it")
        let previous = (item == .openDashboard) ? Titles.openDashboard : nil
        ui?.show(item, title: Titles.starting, enabled: false)
        defer { if let p = previous { ui?.show(item, title: p, enabled: true) } }
        switch starter.start() {
        case .failure(let e):
            note("server: start failed: \(e.message)")
            return .failure(e)
        case .success(let pid):
            note("server: started (pid \(pid))")
            let deadline = Date().addingTimeInterval(startWait)
            while Date() < deadline {
                Thread.sleep(forTimeInterval: pollInterval)
                if let s = readSession(home: home), s.pid == pid, api.healthy(s) {
                    note("health: ok (pid \(s.pid))")
                    return .success(s)
                }
            }
            // P3: a server started for Stop or Quit that missed the deadline is stopped, so
            // the next click doesn't start a second one next to it.
            if item != .openDashboard, processAlive(pid) {
                kill(pid_t(pid), SIGTERM)
                note("server: no answer within \(Int(startWait)) s; sent SIGTERM to pid \(pid)")
            }
            return .failure(StartError(Titles.didNotStart))
        }
    }

    // MARK: - Open Dashboard

    @discardableResult
    func openDashboard() -> Bool {
        switch reach(start: true, item: .openDashboard) {
        case .failure(let e):
            _ = ui?.alert(title: Titles.openFailed, info: e.message, buttons: [Titles.ok])
            return false
        case .success(let s):
            if ui?.open(s.dashboardURL) == true { return true }
            _ = ui?.alert(title: Titles.openFailed, info: "The browser couldn't be opened.", buttons: [Titles.ok])
            return false
        }
    }

    // MARK: - Stop All Services

    @discardableResult
    func stopAll() -> Bool {
        guard beginBusy() else {
            note("busy: another action is running")
            return false
        }
        defer { endBusy(); restoreItems() }
        ui?.show(.stopAll, title: Titles.stopping, enabled: false)
        ui?.show(.quit, title: Titles.quit, enabled: false)
        let session: Session
        switch reach(start: true, item: .stopAll) {
        case .failure(let e):
            _ = ui?.alert(title: Titles.stopFailed, info: e.message, buttons: [Titles.ok])
            return false
        case .success(let s):
            session = s
        }
        switch stopSharing(session, item: .stopAll, busyTitle: Titles.stopping) {
        case .stopped, .alreadyOff:
            return true
        case .failed(let message):
            _ = ui?.alert(title: Titles.stopFailed, info: message, buttons: [Titles.ok])
            return false
        }
    }

    /// POST /api/proxy/stop and wait for the job (E3, E12). Shows the password phase on `item`.
    func stopSharing(_ s: Session, item: MenuItemID, busyTitle: String) -> StopOutcome {
        let st = api.send("GET", port: s.port, path: "/api/state", token: s.token, timeout: 8)
        if st.ok, let proxy = st.json?["proxy"] as? [String: Any], proxy["running"] as? Bool == false {
            let job = proxy["job"] as? [String: Any]
            let jobActive = job != nil && !(job?["finishedAt"] is String)
            if !jobActive {
                note("sharing: already off")
                setSharing(false)
                return .alreadyOff
            }
        }
        let r = api.send("POST", port: s.port, path: "/api/proxy/stop", token: s.token, body: [:], timeout: 10)
        guard r.status == 202, let job = r.json?["job"] as? [String: Any], let id = job["id"] as? String else {
            note("stop: refused (HTTP \(r.status)): \(r.errorMessage)")
            return .failed(r.errorMessage)
        }
        let reused = r.json?["reused"] as? Bool == true
        note("job: \(id) \(job["action"] as? String ?? "?")\(reused ? " (already running)" : "")")
        return waitForJob(s, id: id, item: item, busyTitle: busyTitle)
    }

    private func setSharing(_ on: Bool?) {
        lock.lock(); sharingOn = on; jobRunning = false; lock.unlock()
    }

    private func waitForJob(_ s: Session, id: String, item: MenuItemID, busyTitle: String) -> StopOutcome {
        let start = Date()
        let hardDeadline = start.addingTimeInterval(jobHardCap)
        var deadline = start.addingTimeInterval(jobWait)
        var lastPhase = ""
        var misses = 0
        var serverErrors = 0
        while true {
            let now = Date()
            if now >= deadline || now >= hardDeadline {
                note("job: no result within \(Int(now.timeIntervalSince(start))) s; giving up")
                setSharing(nil)
                return .failed(Titles.tooSlow)
            }
            let r = api.send("GET", port: s.port, path: "/api/state", token: s.token, timeout: 8)
            if r.failure != nil && r.status == 0 {
                // No HTTP answer at all: count it, and re-check health and pid.
                misses += 1
                if misses >= 3 && !api.healthy(s) {
                    note("job: server stopped answering")
                    setSharing(nil)
                    return .failed(Titles.stoppedAnswering)
                }
                Thread.sleep(forTimeInterval: pollInterval)
                continue
            }
            misses = 0
            if !r.ok {
                // 401: a different server (new token) now owns the port. 3xx: refused. 5xx:
                // retried once after 1 s (§7), then given up. Anything else: given up.
                if (500..<600).contains(r.status), serverErrors == 0 {
                    serverErrors += 1
                    note("job: /api/state answered HTTP \(r.status); retrying once")
                    Thread.sleep(forTimeInterval: 1)
                    continue
                }
                note("job: /api/state answered HTTP \(r.status); giving up")
                setSharing(nil)
                return .failed(r.status == 401 ? Titles.serverReplaced : r.errorMessage)
            }
            serverErrors = 0
            guard let proxy = r.json?["proxy"] as? [String: Any], let job = proxy["job"] as? [String: Any],
                  let jobId = job["id"] as? String
            else {
                note("job: /api/state has no job; giving up")
                setSharing(nil)
                return .failed(Titles.jobLost)
            }
            if jobId != id {
                note("job: replaced by \(jobId) \(job["action"] as? String ?? "?")")
                setSharing(nil)
                return .failed(Titles.jobReplaced)
            }
            let phase = job["phase"] as? String ?? ""
            if phase != lastPhase {
                lastPhase = phase
                note("job: phase \(phase)")
                ui?.show(item, title: phase == "waitingForPassword" ? Titles.waitingForPassword : busyTitle, enabled: false)
                if phase == "waitingForPassword" {
                    // The dialog may stay up a while: allow N1's elevate timeout plus a margin.
                    deadline = max(deadline, Date().addingTimeInterval(passwordWait))
                }
            }
            if job["finishedAt"] is String {
                if phase == "done" {
                    setSharing(proxy["running"] as? Bool ?? false)
                    if let banners = r.json?["banners"] as? [[String: Any]] {
                        note("banners: \(banners.compactMap { $0["id"] as? String }.joined(separator: ","))")
                    }
                    note("sharing: \((proxy["running"] as? Bool ?? false) ? "on" : "off")")
                    return .stopped
                }
                let err = job["error"] as? [String: Any]
                let message = (err?["message"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Sharing didn't stop."
                note("job: failed (\(err?["code"] as? String ?? "?"))")
                setSharing(proxy["running"] as? Bool)
                return .failed(message)
            }
            Thread.sleep(forTimeInterval: pollInterval)
        }
    }

    // MARK: - Quit

    /// Stops sharing, then quits the server. The caller exits when `quitApp` is set.
    @discardableResult
    func quitAll() -> QuitResult {
        guard beginBusy() else {
            note("busy: another action is running")
            return QuitResult(quitApp: false, ok: false)
        }
        var quitting = false
        defer {
            endBusy()
            if !quitting { restoreItems() }
        }
        ui?.show(.quit, title: Titles.quitting, enabled: false)
        ui?.show(.stopAll, title: Titles.stopAll, enabled: false)
        let session: Session
        switch reach(start: true, item: .quit) {
        case .failure(let e):
            guard askQuitAnyway(Titles.mayStillBeOn, Titles.unreachablePrefix + e.message) else {
                return QuitResult(quitApp: false, ok: false)
            }
            // No server answers, so there is none left to quit.
            quitting = true
            return QuitResult(quitApp: true, ok: true)
        case .success(let s):
            session = s
        }
        var ok = true
        switch stopSharing(session, item: .quit, busyTitle: Titles.quitting) {
        case .stopped, .alreadyOff:
            break
        case .failed(let message):
            // Quit Anyway leaves sharing on by the user's choice; the server still quits.
            guard askQuitAnyway(Titles.stillOn, message) else { return QuitResult(quitApp: false, ok: false) }
            note("quit: quitting anyway with sharing on")
        }
        ui?.show(.quit, title: Titles.quitting, enabled: false)
        if let problem = quitServer(session) {
            guard askQuitAnyway(Titles.didNotQuit, problem) else { return QuitResult(quitApp: false, ok: false) }
            ok = false
        }
        quitting = true
        return QuitResult(quitApp: true, ok: ok)
    }

    /// "Cancel" first, "Quit Anyway" second (destructive). Return and Escape both pick
    /// Cancel, and so does any unexpected response (D55, `AlertPolicy`).
    private func askQuitAnyway(_ title: String, _ info: String) -> Bool {
        let choice = ui?.alert(title: title, info: info, buttons: [Titles.cancel, Titles.quitAnyway]) ?? Titles.cancel
        if choice == Titles.quitAnyway {
            note("quit: quitting anyway")
            return true
        }
        note("quit: cancelled")
        return false
    }

    /// Health (pid match) → POST /api/quit (202) → wait ≤ `quitWait` for the server to go
    /// away. Returns nil when it quit, else a plain-language reason (finding 4).
    private func quitServer(_ s: Session) -> String? {
        guard api.healthy(s) else {
            // Gone already — unless another Nidum Local server took its place.
            if let now = readSession(home: home), now.pid != s.pid, api.healthy(now) {
                note("server: replaced by pid \(now.pid)")
                return Titles.restartedWhileQuitting
            }
            note("server: already gone")
            return nil
        }
        let r = api.send("POST", port: s.port, path: "/api/quit", token: s.token, body: [:], timeout: 5)
        note("quit: HTTP \(r.status)")
        if r.status != 0 && r.status != 202 {
            // The server answered and refused.
            note("quit: refused: \(r.errorMessage)")
            return r.errorMessage
        }
        let deadline = Date().addingTimeInterval(quitWait)
        while Date() < deadline {
            if !api.healthy(s) {
                note("server: stopped")
                return nil
            }
            Thread.sleep(forTimeInterval: pollInterval)
        }
        note("server: still answering after \(Int(quitWait)) s")
        return Titles.stillAnswering
    }
}
