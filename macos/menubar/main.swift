// Nidum Local menu bar app (node N7, decisions D40–D43).
//
//   Nidum Local Menu.app [--app-root <dir>] [--home <dir>] [--node <path>]
//   … --dump-menu                 print the menu titles, one per line, and exit
//   … --dump-icon <file.png> [--icon-scale 1|2]   write the menu bar icon (default 2x) and exit
//   … --self-test <scenario> [--alert-response <button>]   headless; see SelfTest.swift
//
// NIDUM_HOME (default ~/.nidum-local) holds session.json; `--home` overrides it. The
// launcher starts the app with `open -g -a … --env NIDUM_HOME=… --args --app-root <root>`.
// The server is started only from an explicit `--app-root`. `--self-test` needs `--home`
// or NIDUM_HOME (exit 2 otherwise), so it never reads the real ~/.nidum-local.
// An explicit home must be an absolute path; "~" is never expanded (the server's rule).
// A relative or "~" home is exit 2 in self-test, and an alert (then quit) in the app.

import AppKit

struct Options {
    var appRoot: String?
    var home: String?
    var node: String?
    var dumpMenu = false
    var dumpIcon: String?
    var iconScale: CGFloat = 2
    var selfTest: String?
    var alertResponse: String?
    /// Self-test only: shorter deadlines (seconds) so tests can reach them quickly.
    var waits: [String: Double] = [:]
}

let usage = """
usage: NidumLocalMenu [--app-root <dir>] [--home <dir>] [--node <path>]
       NidumLocalMenu --dump-menu
       NidumLocalMenu --dump-icon <file.png> [--icon-scale 1|2]
       NidumLocalMenu --self-test <\(SelfTest.scenarios.joined(separator: "|"))> (--home <dir> | NIDUM_HOME=<dir>)
                      [--app-root <dir>] [--node <path>] [--alert-response <button>]
                      [--job-wait|--password-wait|--start-wait|--quit-wait <seconds>]
"""

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("\(message)\n\(usage)\n".utf8))
    exit(2)
}

func parseOptions(_ argv: [String]) -> Options {
    var o = Options()
    var i = 1
    func value(_ flag: String) -> String {
        i += 1
        guard i < argv.count else { fail("\(flag) needs a value") }
        return argv[i]
    }
    while i < argv.count {
        let a = argv[i]
        switch a {
        case "--app-root": o.appRoot = value(a)
        case "--home": o.home = value(a)
        case "--node": o.node = value(a)
        case "--dump-menu": o.dumpMenu = true
        case "--dump-icon": o.dumpIcon = value(a)
        case "--icon-scale":
            switch value(a) {
            case "1": o.iconScale = 1
            case "2": o.iconScale = 2
            default: fail("--icon-scale must be 1 or 2")
            }
        case "--self-test": o.selfTest = value(a)
        case "--alert-response": o.alertResponse = value(a)
        case "--job-wait", "--password-wait", "--start-wait", "--quit-wait":
            guard let v = Double(value(a)), v > 0, v <= 600 else { fail("\(a) needs a number of seconds (0–600)") }
            o.waits[String(a.dropFirst(2).dropLast(5))] = v
        case "-h", "--help":
            print(usage)
            exit(0)
        default:
            // Launch Services may add -psn_… or -NS… arguments; ignore them.
            if a.hasPrefix("-psn_") { break }
            if a.hasPrefix("-NS"), i + 1 < argv.count { i += 1; break }
            fail("unknown argument: \(a)")
        }
        i += 1
    }
    return o
}

let options = parseOptions(CommandLine.arguments)
if !options.waits.isEmpty && options.selfTest == nil { fail("--*-wait flags are for --self-test only") }

if options.dumpMenu {
    for item in MenuBuilder.build(target: nil, action: nil).items {
        print(item.title)
    }
    exit(0)
}

if let path = options.dumpIcon {
    let image = Icon.templateImage()
    guard Icon.writePNG(to: path, scale: options.iconScale) else { fail("couldn't write \(path)") }
    print("icon: \(path) \(Int(image.size.width))x\(Int(image.size.height)) pt @\(Int(options.iconScale))x template=\(image.isTemplate)")
    exit(0)
}

if let scenario = options.selfTest {
    // Never the default ~/.nidum-local in a self-test.
    let testHome: URL
    switch Paths.explicitHome(override: options.home) {
    case .unset: fail("--self-test needs --home <dir> or NIDUM_HOME; it never uses ~/.nidum-local")
    case .invalid(let why): fail(why)
    case .absolute(let u): testHome = u
    }
    let testController = Controller(home: testHome, starter: ServerStarter(home: testHome, appRoot: options.appRoot, node: options.node))
    if let v = options.waits["job"] { testController.jobWait = v }
    if let v = options.waits["password"] { testController.passwordWait = v }
    if let v = options.waits["start"] { testController.startWait = v }
    if let v = options.waits["quit"] { testController.quitWait = v }
    exit(SelfTest.run(scenario, controller: testController, home: testHome, alertResponse: options.alertResponse))
}

let home: URL
switch Paths.home(override: options.home) {
case .success(let u):
    home = u
case .failure(let e):
    // Not guessed: say so and quit, before anything is read or written.
    NSApplication.shared.setActivationPolicy(.accessory)
    _ = StatusMenu.runAlert(title: Titles.badHome, info: e.message, buttons: [Titles.ok])
    FileHandle.standardError.write(Data("\(Titles.badHome) \(e.message)\n".utf8))
    exit(2)
}
let controller = Controller(home: home, starter: ServerStarter(home: home, appRoot: options.appRoot, node: options.node))

let instanceLock = InstanceLock(home: home)
switch instanceLock.acquire() {
case .acquired:
    break
case .heldElsewhere:
    FileHandle.standardError.write(Data("Nidum Local's menu bar app is already running.\n".utf8))
    exit(0)
case .unusable(let why):
    // Better a second icon than none; the file itself is left alone.
    FileHandle.standardError.write(Data("Nidum Local's menu bar app runs without its single-instance lock: \(why).\n".utf8))
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate(controller: controller, lock: instanceLock)
app.delegate = delegate
app.run()
