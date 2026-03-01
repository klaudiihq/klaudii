import Foundation

struct Session: Codable, Identifiable {
    var id: String { project }

    let project: String
    let projectPath: String
    let permissionMode: String
    let running: Bool
    let status: String
    let claudeUrl: String?
    let git: GitStatus?
    let remoteUrl: String?
    let sessionCount: Int
    let lastActivity: Double?
    let ttyd: TtydInfo?

    var displayBranch: String {
        if let branch = git?.branch { return branch }
        if let range = project.range(of: "--") {
            return String(project[range.upperBound...])
        }
        return ""
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

struct GitStatus: Codable {
    let branch: String?
    let dirtyFiles: Int?
    let unpushed: Int?
    let files: [GitFile]?
}

struct GitFile: Codable {
    let status: String
    let path: String
}

struct TtydInfo: Codable {
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
