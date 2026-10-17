// Starting the dashboard server when it isn't running (Open Dashboard, and before
// Stop / Quit so sharing can be stopped through the API).
//
// Only with an explicit `--app-root` (the launcher always passes it). The app never
// looks for an app root next to its bundle, so a self-test can't reach a real install
// (N7 validation 1 finding 1).
//
// Same way as the launcher (Contracts §4, launchers/lib/nidum-launcher.sh): a tiny
// `node -e` helper spawns `node src/server.js` detached (its own session), cwd = the
// app root, stdout/stderr appended to NIDUM_HOME/server.log, and prints "pid <n>".

import Foundation

/// Copy of the launcher's NIDUM_SPAWN_JS.
private let spawnJS = """
const fail = (e) => { process.stdout.write("error " + (e && e.message ? e.message : String(e)) + "\\n"); process.exit(1); };
try {
  const { spawn } = require("child_process"), fs = require("fs");
  const [node, log, root] = process.argv.slice(1);
  const fd = fs.openSync(log, "a", 0o600);
  const child = spawn(node, ["src/server.js"], { cwd: root, detached: true, stdio: ["ignore", fd, fd] });
  child.on("error", fail);
  if (child.pid) { child.unref(); process.stdout.write("pid " + child.pid + "\\n"); process.exit(0); }
} catch (e) { fail(e); }
"""

final class ServerStarter {
    let home: URL
    let appRootOverride: String?
    let nodeOverride: String?
    /// Told which `src/server.js` and which Node are about to start (self-test prints it).
    var onStart: ((String, String) -> Void)?

    init(home: URL, appRoot: String?, node: String?) {
        self.home = home
        self.appRootOverride = appRoot
        self.nodeOverride = node
    }

    private static func isExecutable(_ path: String) -> Bool {
        var dir: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &dir) && !dir.boolValue
            && FileManager.default.isExecutableFile(atPath: path)
    }

    private static func hasServer(_ root: URL) -> Bool {
        FileManager.default.fileExists(atPath: root.appendingPathComponent("src/server.js").path)
    }

    /// The explicit `--app-root` when it is an absolute path ("~" is never expanded, like
    /// the home) that holds `src/server.js`; nil otherwise. Nothing is ever discovered
    /// from the bundle's location.
    func appRoot() -> URL? {
        guard let o = appRootOverride, o.hasPrefix("/") else { return nil }
        let u = URL(fileURLWithPath: o).standardizedFileURL
        return Self.hasServer(u) ? u : nil
    }

    /// The launcher's rule (NIDUM_MIN_NODE): Node 18 or newer.
    static let minNodeMajor = 18
    /// Each `node --version` check may take this long (seconds): enough for the first,
    /// cold run of a freshly installed or upgraded Node (N7 validation 3 finding 2) …
    static let versionTimeout: TimeInterval = 4
    /// … and the whole lookup this long, so Stop and Quit are never held up for long by
    /// a candidate that hangs (N7 validation 2 finding 5). The launcher's `--node` has
    /// this budget to itself.
    static let lookupBudget: TimeInterval = 5
    /// The launcher's `--node` is asked a second time after a time-out (a cold first run
    /// is often the cause) when at least this much of its budget is left.
    static let minRetry: TimeInterval = 0.25

    /// What `node --version` said.
    enum NodeProbe: Equatable {
        /// Answered like Node: the major version and the version line.
        case version(Int, String)
        /// Didn't finish within this many seconds (it was killed).
        case noAnswer(TimeInterval)
        /// Finished without a Node version; says what happened instead.
        case notNode(String)

        /// What happened, for the failure message ("<path> <this>").
        var note: String {
            switch self {
            case .version(_, let v): return Titles.nodeIsVersion(v)
            case .noAnswer(let t): return Titles.nodeNoAnswerWithin(t)
            case .notNode(let why): return why
            }
        }
    }

    /// Asks `path --version`. Only the first line that looks like a version counts, and it
    /// is read as soon as it arrives: a child that keeps the output open can't hide it.
    static func probeNode(_ path: String, timeout: TimeInterval) -> NodeProbe {
        let r = runProcess(path, ["--version"], environment: nil, timeout: timeout, firstLine: true)
        if r.timedOut { return .noAnswer(timeout) }
        if let e = r.launchError { return .notNode(Titles.nodeCouldNotRun(e)) }
        let lines = r.output.split(whereSeparator: { $0 == "\n" || $0 == "\r" })
            .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let shown = String((lines.first ?? "").prefix(60))
        if r.signalled { return .notNode(Titles.nodeSignalled(r.status)) }
        guard r.status == 0 else { return .notNode(Titles.nodeExited(r.status, printed: shown)) }
        for line in lines {
            let digits = line.hasPrefix("v") ? line.dropFirst() : Substring(line)
            if let dot = digits.firstIndex(of: "."), let major = Int(digits[..<dot]) {
                return .version(major, String(line.prefix(40)))
            }
        }
        return .notNode(Titles.nodePrinted(shown))
    }

    /// `--node`, NIDUM_NODE, PATH, the usual install folders, then a login shell
    /// (apps opened from Finder get a minimal PATH). Each candidate must answer
    /// `--version` with Node 18 or newer (like the launcher's nidum_find_node) within
    /// `versionTimeout`; older, silent or non-Node ones are skipped. The whole lookup
    /// stops after `lookupBudget`. An explicit `--node` is refused rather than replaced.
    /// The failure says why (too old, no answer, not found) and what each Node that was
    /// checked did.
    func nodePath() -> Result<String, StartError> {
        if let o = nodeOverride, !o.isEmpty { return Self.givenNode(o) }
        let deadline = Date().addingTimeInterval(Self.lookupBudget)
        var sawOld = false
        var sawHang = false
        var ranOut = false
        var notes: [String] = []
        /// Seconds left in the lookup (at most `cap`); nil when it has run out.
        func left(_ cap: TimeInterval) -> TimeInterval? {
            let l = deadline.timeIntervalSinceNow
            if l < 0.1 { ranOut = true; return nil }
            return min(cap, l)
        }
        func check(_ p: String) -> Bool {
            // Folders without a node are the usual case; they aren't worth a note.
            guard Self.isExecutable(p), let t = left(Self.versionTimeout) else { return false }
            let probe = Self.probeNode(p, timeout: t)
            switch probe {
            case .version(let major, _) where major >= Self.minNodeMajor: return true
            case .version: sawOld = true
            case .noAnswer: sawHang = true
            case .notNode: break
            }
            notes.append(Titles.nodeNote(p, probe.note))
            return false
        }
        func failure() -> Result<String, StartError> {
            if ranOut { notes.append(Titles.nodeSearchRanOut(Self.lookupBudget)) }
            let summary = sawHang || ranOut ? Titles.nodeNoAnswer : sawOld ? Titles.nodeTooOld : Titles.nodeMissing
            return .failure(StartError(Titles.nodeProblem(summary, notes)))
        }
        let env = ProcessInfo.processInfo.environment
        if let n = env["NIDUM_NODE"], !n.isEmpty, check(n) { return .success(n) }
        var dirs = (env["PATH"] ?? "").split(separator: ":").map(String.init)
        let userHome = Paths.userHome.path
        dirs += ["/opt/homebrew/bin", "/usr/local/bin", "\(userHome)/.volta/bin", "\(userHome)/.local/bin", "/opt/local/bin"]
        var seen = Set<String>()
        for d in dirs where !d.isEmpty {
            let p = (d as NSString).appendingPathComponent("node")
            if !seen.insert(p).inserted { continue }
            if check(p) { return .success(p) }
            if deadline.timeIntervalSinceNow < 0.1 { ranOut = true; return failure() }
        }
        let shell = Self.isExecutable("/bin/zsh") ? "/bin/zsh" : "/bin/bash"
        guard let t = left(3) else { return failure() }
        let r = runProcess(shell, ["-lc", "command -v node"], environment: nil, timeout: t)
        if r.timedOut {
            sawHang = true
            notes.append(Titles.nodeShell(shell, Titles.nodeNoAnswerWithin(t)))
        } else {
            let p = r.status == 0 ? (r.output.split(separator: "\n").last.map { String($0).trimmingCharacters(in: .whitespaces) } ?? "") : ""
            if p.hasPrefix("/") {
                if !seen.contains(p), check(p) { return .success(p) }
            } else {
                notes.append(Titles.nodeShell(shell, Titles.nodeShellFoundNone))
            }
        }
        return failure()
    }

    /// The launcher's `--node`: it is used or refused, never replaced. It has the whole
    /// lookup budget to itself: a first check of up to `versionTimeout`, then, after a
    /// time-out, one more with what is left (a cold first run after an install or
    /// upgrade is the usual reason for a slow answer).
    static func givenNode(_ path: String) -> Result<String, StartError> {
        guard isExecutable(path) else {
            return .failure(StartError(Titles.nodeProblem(Titles.givenNodeMissing, [Titles.nodeNote(path, Titles.nodeNotExecutable)])))
        }
        let deadline = Date().addingTimeInterval(lookupBudget)
        var probe = probeNode(path, timeout: min(versionTimeout, lookupBudget))
        var note = probe.note
        if case .noAnswer(let first) = probe {
            let l = deadline.timeIntervalSinceNow
            if l >= minRetry {
                probe = probeNode(path, timeout: l)
                if case .noAnswer(let second) = probe { note = Titles.nodeNoAnswerTwice(first, second) } else { note = probe.note }
            }
        }
        let notes = [Titles.nodeNote(path, note)]
        switch probe {
        case .version(let major, _) where major >= minNodeMajor: return .success(path)
        case .version: return .failure(StartError(Titles.nodeProblem(Titles.nodeTooOld, notes)))
        case .noAnswer: return .failure(StartError(Titles.nodeProblem(Titles.nodeNoAnswer, notes)))
        case .notNode: return .failure(StartError(Titles.nodeProblem(Titles.givenNodeBroken, notes)))
        }
    }

    /// Starts the server detached. Returns its pid, or a plain-language reason.
    func start() -> Result<Int, StartError> {
        guard let root = appRoot() else { return .failure(StartError(Titles.notInstalledHere)) }
        let node: String
        switch nodePath() {
        case .failure(let e): return .failure(e)
        case .success(let p): node = p
        }
        onStart?(root.appendingPathComponent("src/server.js").path, node)
        Paths.ensureDirectory(home)
        let log = home.appendingPathComponent("server.log").path
        var env = ProcessInfo.processInfo.environment
        env["NIDUM_HOME"] = home.path
        // The server runs `portless`; give it the folder Node came from and the usual ones.
        var path = (env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(separator: ":").map(String.init)
        for d in [(node as NSString).deletingLastPathComponent, "/opt/homebrew/bin", "/usr/local/bin"].reversed() where !path.contains(d) {
            path.insert(d, at: 0)
        }
        env["PATH"] = path.joined(separator: ":")
        let r = runProcess(node, ["-e", spawnJS, "--", node, log, root.path], environment: env, timeout: 15)
        for line in r.output.split(separator: "\n").reversed() {
            if line.hasPrefix("pid "), let pid = Int(line.dropFirst(4).trimmingCharacters(in: .whitespaces)) { return .success(pid) }
        }
        let last = r.output.split(separator: "\n").last.map { String($0) } ?? ""
        let why = last.hasPrefix("error ") ? String(last.dropFirst(6)) : (last.isEmpty ? "Node.js could not start it." : last)
        return .failure(StartError("Nidum Local couldn't start: \(why)"))
    }
}

struct StartError: Error {
    let message: String
    init(_ message: String) { self.message = message }
}

struct ProcessResult {
    /// Exit status, or the signal number when `signalled` (-1 when it couldn't run or
    /// didn't exit).
    let status: Int32
    /// stdout and stderr together.
    let output: String
    /// It was still running at the deadline and was killed.
    let timedOut: Bool
    /// It ended because of a signal it didn't handle.
    var signalled = false
    /// Why it couldn't be started at all.
    var launchError: String? = nil
}

/// Runs a short helper with a deadline; returns its exit status and output (stdout + stderr).
///
/// The output is read on the calling thread with poll(2) as it arrives, so nothing waits
/// for end-of-file: once the helper has exited, what it wrote is in the pipe, and only
/// min(0.3 s, what's left of the deadline) more is waited for, since a child it left
/// behind may keep the pipe open (N7 validation 3 finding 2). With `firstLine`, a
/// complete line is enough and nothing more is waited for.
///
/// At the deadline the helper's whole process group gets SIGTERM, then SIGKILL after
/// `killGrace`, so a helper that ignores SIGTERM, or a child it started, isn't left
/// running (N7 validation 2 finding 5). Process starts each helper in its own process
/// group (pgid = its pid); the group is signalled only when that holds, never ours.
/// A server started by the spawn helper runs in its own session, so it is never hit.
func runProcess(_ path: String, _ args: [String], environment: [String: String]?, timeout: TimeInterval,
                killGrace: TimeInterval = 0.3, firstLine: Bool = false) -> ProcessResult {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    if let e = environment { p.environment = e }
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = pipe
    p.standardInput = FileHandle.nullDevice
    let exited = DispatchSemaphore(value: 0)
    p.terminationHandler = { _ in exited.signal() }
    let deadline = Date().addingTimeInterval(timeout)
    do {
        try p.run()
    } catch {
        try? pipe.fileHandleForWriting.close()
        try? pipe.fileHandleForReading.close()
        return ProcessResult(status: -1, output: "", timedOut: false, launchError: error.localizedDescription)
    }
    try? pipe.fileHandleForWriting.close()
    let reading = pipe.fileHandleForReading
    defer { try? reading.close() }
    let fd = reading.fileDescriptor
    let pid = p.processIdentifier
    let ownGroup = pid > 0 && getpgid(pid) == pid && pid != getpgrp()

    var data = Data()
    var eof = false
    var hasExited = false
    /// Whether the helper has exited, waiting up to `wait` seconds for it.
    func waitExit(_ wait: TimeInterval) -> Bool {
        if !hasExited, exited.wait(timeout: .now() + max(0, wait)) == .success { hasExited = true }
        return hasExited
    }
    /// One poll of up to `wait` seconds, then one read of what is there. Output past
    /// 1 MB is read and dropped, so a chatty helper can't block on a full pipe.
    func readSome(_ wait: TimeInterval) {
        guard !eof else { return }
        var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        let n = poll(&pfd, 1, Int32(max(0, min(wait, 60)) * 1000))
        if n < 0 { if errno != EINTR { eof = true }; return }
        if n == 0 { return }
        var buf = [UInt8](repeating: 0, count: 16384)
        let r = read(fd, &buf, buf.count)
        if r > 0 {
            if data.count < 1 << 20 { data.append(contentsOf: buf[0..<r]) }
        } else if r == 0 || (errno != EINTR && errno != EAGAIN) {
            eof = true
        }
    }
    func haveLine() -> Bool { firstLine && data.contains(0x0A) }

    // Until it exits or the deadline passes: read in slices of at most 50 ms.
    while !waitExit(0) {
        let l = deadline.timeIntervalSinceNow
        if l <= 0 { break }
        if eof { _ = waitExit(min(0.05, l)) } else { readSome(min(0.05, l)) }
    }
    var timedOut = false
    if !hasExited {
        timedOut = true
        func signal(_ sig: Int32) {
            if ownGroup { _ = kill(-pid, sig) }
            _ = kill(pid, sig)
        }
        signal(SIGTERM)
        _ = waitExit(killGrace)
        // Always, even if the helper itself is gone: a child of it may ignore SIGTERM.
        signal(SIGKILL)
        _ = waitExit(1)
    }
    // What is already in the pipe is read at once; more is waited for only briefly, and
    // not at all once a first line is there.
    let grace = haveLine() ? 0 : min(0.3, max(0, timedOut ? 0.3 : deadline.timeIntervalSinceNow))
    let drainUntil = Date().addingTimeInterval(grace)
    while !eof {
        let before = data.count
        readSome(haveLine() ? 0 : max(0, drainUntil.timeIntervalSinceNow))
        if data.count == before && !eof && drainUntil.timeIntervalSinceNow <= 0 { break }
    }
    let output = String(decoding: data, as: UTF8.self)
    guard hasExited, !timedOut else { return ProcessResult(status: -1, output: output, timedOut: timedOut) }
    let signalled = p.terminationReason == .uncaughtSignal
    return ProcessResult(status: p.terminationStatus, output: output, timedOut: false, signalled: signalled)
}
