// Nidum Local menu bar app (node N7). Every user-visible string lives here.
//
// The menu has exactly three items, in this order (D40). Nothing else is ever added;
// while an action runs an item's title may show progress (for example "Stopping…")
// and the item is disabled.

import Foundation

enum MenuItemID: Int, CaseIterable {
    case openDashboard = 0
    case stopAll = 1
    case quit = 2

    /// The item's normal title.
    var title: String {
        switch self {
        case .openDashboard: return Titles.openDashboard
        case .stopAll: return Titles.stopAll
        case .quit: return Titles.quit
        }
    }
}

enum Titles {
    // The three menu items (D40, D41, D42).
    static let openDashboard = "Open Dashboard"
    static let stopAll = "Stop All Services"
    static let quit = "Quit"
    /// The whole menu, in order.
    static let menu = MenuItemID.allCases.map { $0.title }

    // Progress titles (shown on a disabled item while an action runs).
    static let starting = "Starting Nidum Local…"
    static let stopping = "Stopping…"
    static let waitingForPassword = "Waiting for your password…"
    static let quitting = "Quitting…"

    // Alerts.
    static let ok = "OK"
    static let quitAnyway = "Quit Anyway"
    static let cancel = "Cancel"
    static let openFailed = "Couldn't open Nidum Local."
    static let stopFailed = "Couldn't stop sharing."
    static let stillOn = "Sharing is still on."
    static let mayStillBeOn = "Sharing may still be on."
    static let didNotQuit = "Nidum Local didn't quit."
    static let badHome = "Nidum Local's folder setting isn't valid."

    // Messages used as alert details.
    static let notInstalledHere = "Nidum Local's files weren't found. Open Nidum Local from its folder once, then try again."
    // Node.js lookup (N7 validation 3 finding 2). The message is a summary, then what
    // each Node that was checked did ("Checked: <path> <what happened>; …."), then the
    // advice. See nodeProblem.
    static let nodeMissing = "Node.js wasn't found on this Mac."
    static let nodeTooOld = "Nidum Local needs Node.js 18 or newer, and only an older version was found."
    static let nodeNoAnswer = "Node.js didn't answer in time when Nidum Local checked its version."
    /// The Node the launcher chose (`--node`) can't be run.
    static let givenNodeMissing = "The Node.js that Nidum Local was set up with wasn't found."
    /// The Node the launcher chose ran, but didn't answer like Node.js.
    static let givenNodeBroken = "The Node.js that Nidum Local was set up with didn't work."
    static let nodeAdvice = "Open Nidum Local from its folder once, then try again."
    /// "<summary> Checked: <note>; <note>. <advice>" (at most four notes are listed).
    static func nodeProblem(_ summary: String, _ notes: [String]) -> String {
        guard !notes.isEmpty else { return "\(summary) \(nodeAdvice)" }
        var shown = Array(notes.prefix(4))
        if notes.count > 4 { shown.append("\(notes.count - 4) more") }
        return "\(summary) Checked: \(shown.joined(separator: "; ")). \(nodeAdvice)"
    }
    /// One checked Node: "<path> <what happened>".
    static func nodeNote(_ path: String, _ what: String) -> String { "\(path) \(what)" }
    static func seconds(_ t: TimeInterval) -> String { String(format: "%.1f s", t) }
    static let nodeNotExecutable = "isn't a file that can be run"
    static func nodeIsVersion(_ v: String) -> String { "is \(v)" }
    static func nodeNoAnswerWithin(_ t: TimeInterval) -> String { "didn't answer within \(seconds(t))" }
    static func nodeNoAnswerTwice(_ t1: TimeInterval, _ t2: TimeInterval) -> String {
        "didn't answer within \(seconds(t1)), nor within \(seconds(t2)) when asked again"
    }
    static func nodeExited(_ status: Int32, printed: String) -> String {
        printed.isEmpty ? "exited with status \(status) without printing a version"
            : "exited with status \(status) after printing \"\(printed)\""
    }
    static func nodeSignalled(_ sig: Int32) -> String { "was stopped by signal \(sig)" }
    static func nodePrinted(_ printed: String) -> String {
        printed.isEmpty ? "printed nothing" : "printed \"\(printed)\", not a Node.js version"
    }
    static func nodeCouldNotRun(_ why: String) -> String { "couldn't be run (\(why))" }
    static func nodeSearchRanOut(_ t: TimeInterval) -> String { "the search stopped at its \(String(format: "%.0f", t)) s limit" }
    static func nodeShell(_ shell: String, _ what: String) -> String { "a login shell (\(shell) -l) \(what)" }
    static let nodeShellFoundNone = "found no node"
    static let didNotStart = "Nidum Local didn't start within 10 seconds. See server.log in the Nidum Local folder for details."
    static let stoppedAnswering = "Nidum Local stopped answering."
    static let tooSlow = "This is taking longer than expected."
    static let unreachablePrefix = "Nidum Local couldn't be reached: "
    static let jobReplaced = "Another sharing change started before this one finished. Open the dashboard to see whether sharing is on."
    static let jobLost = "Nidum Local lost track of this sharing change. Open the dashboard to see whether sharing is on."
    static let serverReplaced = "Nidum Local was restarted while this was running. Open the dashboard to see whether sharing is on."
    static let stillAnswering = "Nidum Local is still running after it was asked to quit."
    static let restartedWhileQuitting = "Nidum Local was restarted while quitting. Try Quit again."

    static let accessibilityLabel = "Nidum Local"
}
