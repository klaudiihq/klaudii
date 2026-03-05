import Foundation

/// Disk-backed cache for sessions, processes, and chat messages.
/// Stored in Caches (system can purge under pressure; all data is re-fetchable from server).
enum LocalCache {
    private static let decoder = JSONDecoder()
    private static let encoder = JSONEncoder()

    private static var cacheDir: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("klaudii", isDirectory: true)
    }

    private static func url(for key: String) -> URL {
        cacheDir.appendingPathComponent("\(key).json")
    }

    private static func ensureDir() {
        try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
    }

    static func save<T: Encodable>(_ value: T, key: String) {
        ensureDir()
        guard let data = try? encoder.encode(value) else { return }
        try? data.write(to: url(for: key), options: .atomic)
    }

    static func load<T: Decodable>(_ type: T.Type, key: String) -> T? {
        guard let data = try? Data(contentsOf: url(for: key)) else { return nil }
        return try? decoder.decode(T.self, from: data)
    }

    // MARK: - Sessions & Processes (namespaced by serverId)

    static func saveSessions(_ sessions: [Session], serverId: String) {
        save(sessions, key: "sessions-\(serverId)")
    }

    static func loadSessions(serverId: String) -> [Session] {
        load([Session].self, key: "sessions-\(serverId)") ?? []
    }

    static func saveProcesses(_ processes: [ProcessInfo], serverId: String) {
        save(processes, key: "processes-\(serverId)")
    }

    static func loadProcesses(serverId: String) -> [ProcessInfo] {
        load([ProcessInfo].self, key: "processes-\(serverId)") ?? []
    }

    // MARK: - Chat Messages (namespaced by workspace, added when ChatViewModel is built)

    // saveChatMessages / loadChatMessages will be added here alongside ChatViewModel.

    // MARK: - Housekeeping

    static func clearAll() {
        try? FileManager.default.removeItem(at: cacheDir)
    }
}
