import Foundation

struct Session: Codable, Identifiable, Hashable {
    var id: String { project }

    let project: String
    let projectPath: String
    var permissionMode: String
    var running: Bool
    var status: String
    let claudeUrl: String?
    let git: GitStatus?
    let remoteUrl: String?
    let sessionCount: Int
    var lastActivity: Double?
    let ttyd: TtydInfo?

    /// Repo name from git remote URL, falling back to project name
    var displayName: String {
        if let remoteUrl = remoteUrl,
           let url = URL(string: remoteUrl) {
            // "https://github.com/user/klaudii.git" → "klaudii"
            let last = url.lastPathComponent
            if last.hasSuffix(".git") {
                return String(last.dropLast(4))
            }
            return last
        }
        return project
    }

    var displayBranch: String {
        git?.branch ?? ""
    }

    var isRunning: Bool { status == "running" }
    var isExited: Bool { status == "exited" }
    var isStopped: Bool { status == "stopped" }

    var statusOrder: Int {
        switch status {
        case "running": return 0
        case "exited": return 1
        default: return 2
        }
    }
}

struct GitStatus: Codable, Hashable {
    let branch: String?
    let dirtyFiles: Int?
    let unpushed: Int?
    let files: [GitFile]?
}

struct GitFile: Codable, Hashable {
    let status: String
    let path: String
}

struct TtydInfo: Codable, Hashable {
    let project: String?
    let port: Int?
    let pid: Int?
}

struct ProcessInfo: Codable, Identifiable {
    var id: Int { pid }

    let pid: Int
    let ppid: Int?
    let cwd: String?
    let project: String?
    let type: String?
    let managed: Bool
    let uptime: String?
    let cpu: Double?
    let memMB: Double?
    let launchedBy: String?
    let command: String?
}
