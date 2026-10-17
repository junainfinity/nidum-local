// Single instance: an exclusive flock on NIDUM_HOME/menubar.lock, held for the life of
// the process (released by the OS when it exits, even on a crash).
//
// The lock file is opened with O_NOFOLLOW (a symlink is refused, never followed) and must
// be a regular file owned by this user with a single link (a hard link to some other file
// is refused: N7 validation 2 finding 3). Nothing is truncated or written until all of
// these checks pass and the lock is held (N7 validation 1 finding 7).

import Foundation

enum LockResult: Equatable {
    /// This process holds the lock.
    case acquired
    /// Another instance holds it.
    case heldElsewhere
    /// The lock file can't be used (a symlink, a hard link, not a regular file, someone
    /// else's, or the folder can't hold one). Nothing was written.
    case unusable(String)
}

final class InstanceLock {
    private var fd: Int32 = -1

    var path: String

    init(home: URL) {
        path = home.appendingPathComponent("menubar.lock").path
    }

    func acquire() -> LockResult {
        Paths.ensureDirectory(URL(fileURLWithPath: path).deletingLastPathComponent())
        let f = open(path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK, mode_t(0o600))
        if f < 0 {
            let e = errno
            return .unusable(e == ELOOP ? "menubar.lock is a symbolic link" : "menubar.lock can't be opened (\(String(cString: strerror(e))))")
        }
        var st = stat()
        guard fstat(f, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, st.st_uid == getuid() else {
            close(f)
            return .unusable("menubar.lock isn't a regular file owned by this user")
        }
        guard st.st_nlink == 1 else {
            close(f)
            return .unusable("menubar.lock is a hard link (\(st.st_nlink) links)")
        }
        if flock(f, LOCK_EX | LOCK_NB) != 0 {
            close(f)
            return .heldElsewhere
        }
        // A link may have been added since the check: look again now that it is held.
        guard fstat(f, &st) == 0, st.st_nlink == 1 else {
            flock(f, LOCK_UN)
            close(f)
            return .unusable("menubar.lock is a hard link")
        }
        // Held: now the pid (informational only) may replace the old contents.
        _ = ftruncate(f, 0)
        let pid = "\(getpid())\n"
        _ = pid.withCString { write(f, $0, strlen($0)) }
        fd = f
        return .acquired
    }

    func release() {
        if fd >= 0 {
            flock(fd, LOCK_UN)
            close(fd)
            fd = -1
        }
    }
}
