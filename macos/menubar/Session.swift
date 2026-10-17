// Session discovery and the HTTP client (Contracts §4).
//
// session.json lives in NIDUM_HOME (default ~/.nidum-local). A session counts only when
// its pid is alive and ours (kill(pid, 0) == 0; EPERM means another user's process, which
// is never trusted — N7 validation 2 finding 2) and GET /api/health answers app
// "nidum-local" with the same pid (§4). Pid reuse by this same user is caught by that pid
// match. The token is sent
// (as X-Nidum-Token) only after that check, and only to 127.0.0.1. Redirects are never
// followed: a 3xx answer is a failed request (N7 validation 1 finding 3).

import Foundation

struct Session {
    let port: Int
    let token: String
    let pid: Int

    var dashboardURL: URL { URL(string: "http://127.0.0.1:\(port)/?t=\(token)")! }
}

/// An explicit home (`--home`, else NIDUM_HOME), checked by the server's rule.
enum HomeSetting: Equatable {
    /// Neither is given.
    case unset
    /// An absolute path.
    case absolute(URL)
    /// Given but not usable (relative, or starting with "~"); the message says why.
    case invalid(String)
}

enum Paths {
    /// `--home`, else NIDUM_HOME (an empty value counts as not given).
    ///
    /// The server's rule (src/state.js `nidumHome`: `path.resolve(NIDUM_HOME)`) never
    /// expands "~", so neither does the app (N7 validation 2 finding 1). A home must be
    /// an absolute path: the server resolves "~/x" or "x" against its working folder
    /// (for example "<cwd>/~/x"), so both are refused rather than guessed. Self-test then exits 2, and the app
    /// shows an alert and quits, touching nothing.
    static func explicitHome(override: String?) -> HomeSetting {
        let given: (value: String, name: String)?
        if let o = override, !o.isEmpty {
            given = (o, "--home")
        } else if let e = ProcessInfo.processInfo.environment["NIDUM_HOME"], !e.isEmpty {
            given = (e, "NIDUM_HOME")
        } else {
            given = nil
        }
        guard let g = given else { return .unset }
        guard g.value.hasPrefix("/") else {
            return .invalid("\(g.name) must be a full path that starts with \"/\" (it is \"\(g.value)\"; \"~\" is not expanded).")
        }
        return .absolute(URL(fileURLWithPath: g.value).standardizedFileURL)
    }

    /// `--home`, else NIDUM_HOME, else ~/.nidum-local (the app only; never self-test).
    /// A failure with the reason when the explicit home is invalid.
    static func home(override: String?) -> Result<URL, StartError> {
        switch explicitHome(override: override) {
        case .unset: return .success(userHome.appendingPathComponent(".nidum-local"))
        case .absolute(let u): return .success(u)
        case .invalid(let why): return .failure(StartError(why))
        }
    }

    /// The user's home folder: $HOME when set, else the account's.
    static var userHome: URL {
        if let h = ProcessInfo.processInfo.environment["HOME"], h.hasPrefix("/") {
            return URL(fileURLWithPath: h).standardizedFileURL
        }
        return FileManager.default.homeDirectoryForCurrentUser
    }

    static func ensureDirectory(_ dir: URL) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }
}

private func isToken(_ s: String) -> Bool {
    s.count == 64 && s.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
}

/// Reads session.json once and parses that copy. nil when missing or malformed.
func readSession(home: URL) -> Session? {
    guard let data = try? Data(contentsOf: home.appendingPathComponent("session.json")),
          let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let port = obj["port"] as? Int, (1...65535).contains(port),
          let token = obj["token"] as? String, isToken(token),
          let pid = obj["pid"] as? Int, pid > 0
    else { return nil }
    return Session(port: port, token: token, pid: pid)
}

struct HttpReply {
    let status: Int
    let json: [String: Any]?
    /// Set when no HTTP answer arrived (refused, timed out, …).
    let failure: String?

    var ok: Bool { failure == nil && (200..<300).contains(status) }

    /// The server's §7 error message, else a plain description.
    var errorMessage: String {
        if let e = json?["error"] as? [String: Any], let m = e["message"] as? String, !m.isEmpty { return m }
        if let f = failure { return f }
        return "Nidum Local answered with an error (HTTP \(status))."
    }
}

private final class Box<T> {
    var value: T
    init(_ value: T) { self.value = value }
}

/// true only when a process with this pid exists and this user may signal it. EPERM
/// (another user's process) is false: the server always runs as this user, so a session
/// pid owned by someone else is never ours (N7 validation 2 finding 2).
func processAlive(_ pid: Int) -> Bool {
    guard pid > 0, pid <= Int(Int32.max) else { return false }
    return kill(pid_t(pid), 0) == 0
}

/// Refuses every redirect, so the token never follows a 3xx anywhere (finding 3).
private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Small blocking HTTP client for 127.0.0.1 (call it off the main thread in the app).
final class ApiClient {
    private let session: URLSession

    init() {
        let c = URLSessionConfiguration.ephemeral
        c.connectionProxyDictionary = [:]
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.urlCache = nil
        c.httpCookieStorage = nil
        c.httpShouldSetCookies = false
        c.waitsForConnectivity = false
        c.httpShouldUsePipelining = false
        session = URLSession(configuration: c, delegate: NoRedirects(), delegateQueue: nil)
    }

    func send(_ method: String, port: Int, path: String, token: String?, body: [String: Any]? = nil, timeout: TimeInterval = 10) -> HttpReply {
        guard let url = URL(string: "http://127.0.0.1:\(port)\(path)") else {
            return HttpReply(status: 0, json: nil, failure: "Bad address.")
        }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let t = token { req.setValue(t, forHTTPHeaderField: "X-Nidum-Token") }
        if method != "GET" {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = (try? JSONSerialization.data(withJSONObject: body ?? [:])) ?? Data("{}".utf8)
        }
        let result = Box(HttpReply(status: 0, json: nil, failure: Titles.tooSlow))
        let done = DispatchSemaphore(value: 0)
        let task = session.dataTask(with: req) { data, response, error in
            if let error = error {
                result.value = HttpReply(status: 0, json: nil, failure: error.localizedDescription)
            } else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                if (300..<400).contains(status) {
                    // Never followed (NoRedirects); a redirect is a failed request.
                    result.value = HttpReply(status: status, json: nil, failure: "Nidum Local answered with a redirect (HTTP \(status)).")
                } else {
                    let json = data.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }
                    result.value = HttpReply(status: status, json: json, failure: nil)
                }
            }
            done.signal()
        }
        task.resume()
        if done.wait(timeout: .now() + timeout + 2) == .timedOut {
            task.cancel()
            return HttpReply(status: 0, json: nil, failure: Titles.tooSlow)
        }
        return result.value
    }

    /// §4: the server counts only when its pid is alive and /api/health says app
    /// "nidum-local" with the session's pid.
    func healthy(_ s: Session) -> Bool {
        guard processAlive(s.pid) else { return false }
        let r = send("GET", port: s.port, path: "/api/health", token: nil, timeout: 3)
        guard r.status == 200, let j = r.json,
              j["ok"] as? Bool == true,
              j["app"] as? String == "nidum-local",
              let pid = j["pid"] as? Int
        else { return false }
        return pid == s.pid
    }
}
