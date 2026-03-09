import SwiftUI
import Combine

enum SortMode: String, CaseIterable {
    case activity = "Activity"
    case alpha = "A–Z"
}

@MainActor
class SessionsViewModel: ObservableObject {
    @Published var sessions: [Session] = []
    @Published var processes: [ProcessInfo] = []
    @Published var sortMode: SortMode = .activity
    @Published var isLoading = false
    @Published var errorMessage: String?
    @Published var expandedHistory: [String: [HistoryEntry]] = [:]

    let relay: KloudRelay
    var demoMode: Bool
    private var refreshTask: Task<Void, Never>?
    private var serverOnlineSub: AnyCancellable?

    var unmanagedProcesses: [ProcessInfo] {
        processes.filter { !$0.managed }
    }

    var sortedSessions: [Session] {
        let sorted: [Session]
        switch sortMode {
        case .activity:
            sorted = sessions.sorted { a, b in
                if a.statusOrder != b.statusOrder { return a.statusOrder < b.statusOrder }
                return (a.lastActivity ?? 0) > (b.lastActivity ?? 0)
            }
        case .alpha:
            sorted = sessions.sorted { a, b in
                if a.statusOrder != b.statusOrder { return a.statusOrder < b.statusOrder }
                return a.project.localizedCaseInsensitiveCompare(b.project) == .orderedAscending
            }
        }
        return sorted
    }

    init(relay: KloudRelay, demoMode: Bool = false) {
        self.relay = relay
        self.demoMode = demoMode

        // Configure the connection manager with the relay
        ChatConnectionManager.shared.configure(relay: relay)

        // Load cached data immediately so UI isn't empty while connecting
        if !demoMode, let serverId = relay.serverId ?? KeychainService.getLastServerId() {
            let cached = LocalCache.loadSessions(serverId: serverId)
            let cachedProcs = LocalCache.loadProcesses(serverId: serverId)
            if !cached.isEmpty { sessions = cached }
            if !cachedProcs.isEmpty { processes = cachedProcs }
        }

        // Immediately refresh when server comes online
        serverOnlineSub = relay.$serverOnline
            .removeDuplicates()
            .filter { $0 }
            .sink { [weak self] _ in
                Task { [weak self] in
                    await self?.refresh()
                }
            }
    }

    func startAutoRefresh() {
        stopAutoRefresh()
        refreshTask = Task {
            while !Task.isCancelled {
                await refresh()
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    func stopAutoRefresh() {
        refreshTask?.cancel()
        refreshTask = nil
    }

    func refresh() async {
        if demoMode {
            if sessions.isEmpty {
                sessions = Self.loadDemoState() ?? Self.mockSessions
                processes = Self.processesForRunningSessions(sessions)
            }
            return
        }
        guard relay.isConnected, relay.serverOnline else { return }

        do {
            async let sessionsData = fetchSessions()
            async let processesData = fetchProcesses()

            let (s, p) = try await (sessionsData, processesData)
            sessions = s
            processes = p
            errorMessage = nil
            if let serverId = relay.serverId {
                LocalCache.saveSessions(s, serverId: serverId)
                LocalCache.saveProcesses(p, serverId: serverId)
            }
        } catch {
            // Don't overwrite sessions on transient errors
            if sessions.isEmpty {
                errorMessage = error.localizedDescription
            }
        }
    }

    // MARK: - Actions

    func start(project: String) async {
        if demoMode { demoSetStatus(project, to: "running"); return }
        await postAction("/api/sessions/start", body: ["project": project])
    }

    func continueSession(project: String) async {
        if demoMode { demoSetStatus(project, to: "running"); return }
        await postAction("/api/sessions/start", body: ["project": project, "continueSession": true])
    }

    func stop(project: String) async {
        if demoMode { demoSetStatus(project, to: "exited"); return }
        await postAction("/api/sessions/stop", body: ["project": project])
    }

    func restart(project: String) async {
        if demoMode { demoSetStatus(project, to: "running"); return }
        await postAction("/api/sessions/restart", body: ["project": project])
    }

    func resume(project: String, sessionId: String) async {
        if demoMode { demoSetStatus(project, to: "running"); return }
        await postAction("/api/sessions/start", body: ["project": project, "resumeSessionId": sessionId])
    }

    func setPermission(project: String, mode: String) async {
        if demoMode {
            if let idx = sessions.firstIndex(where: { $0.project == project }) {
                sessions[idx].permissionMode = mode
                saveDemoState()
            }
            return
        }
        await postAction("/api/projects/permission", body: ["project": project, "mode": mode])
    }

    func remove(project: String, force: Bool = false) async {
        if demoMode {
            sessions.removeAll { $0.project == project }
            processes.removeAll { $0.project == project }
            saveDemoState()
            return
        }
        await postAction("/api/projects/remove", body: ["project": project, "force": force])
    }

    func killProcess(pid: Int) async {
        guard !demoMode else { return }
        await postAction("/api/processes/kill", body: ["pid": pid])
    }

    func loadHistory(project: String) async {
        guard !demoMode else {
            expandedHistory[project] = []
            return
        }
        do {
            let raw = try await relay.getArray("/api/history?project=\(project.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? project)")
            let data = try JSONSerialization.data(withJSONObject: raw)
            let entries = try JSONDecoder().decode([HistoryEntry].self, from: data)
            expandedHistory[project] = entries
        } catch {
            expandedHistory[project] = []
        }
    }

    func openClaudeUrl(_ urlString: String) {
        guard let url = URL(string: urlString) else { return }
        UIApplication.shared.open(url)
    }

    // MARK: - Workspace Creation

    func fetchGitHubRepos() async throws -> [GitHubRepo] {
        let raw = try await relay.getArray("/api/github/repos")
        let data = try JSONSerialization.data(withJSONObject: raw)
        return try JSONDecoder().decode([GitHubRepo].self, from: data)
    }

    func createRepo(name: String, remoteUrl: String?) async throws {
        var body: [String: Any] = ["name": name]
        if let remote = remoteUrl { body["remoteUrl"] = remote }
        _ = try await relay.apiCall(method: "POST", path: "/api/repos/create", body: body)
    }

    func createNewSession(repo: String, branch: String) async throws {
        _ = try await relay.apiCall(method: "POST", path: "/api/sessions/new", body: [
            "repo": repo,
            "branch": branch,
        ])
        try? await Task.sleep(for: .milliseconds(500))
        await refresh()
    }

    // MARK: - Private

    private func fetchSessions() async throws -> [Session] {
        let raw = try await relay.getArray("/api/sessions")
        let data = try JSONSerialization.data(withJSONObject: raw)
        return try JSONDecoder().decode([Session].self, from: data)
    }

    private func fetchProcesses() async throws -> [ProcessInfo] {
        let raw = try await relay.getArray("/api/processes")
        let data = try JSONSerialization.data(withJSONObject: raw)
        return try JSONDecoder().decode([ProcessInfo].self, from: data)
    }

    private func postAction(_ path: String, body: [String: Any]) async {
        guard !demoMode else { return }
        do {
            _ = try await relay.apiCall(method: "POST", path: path, body: body)
            // Small delay then refresh
            try? await Task.sleep(for: .milliseconds(500))
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Demo State Management

    private func demoSetStatus(_ project: String, to status: String) {
        guard let idx = sessions.firstIndex(where: { $0.project == project }) else { return }
        sessions[idx].status = status
        sessions[idx].running = status == "running"
        sessions[idx].lastActivity = Date().timeIntervalSince1970

        if status == "running" {
            if !processes.contains(where: { $0.project == project }) {
                let proc = ProcessInfo(
                    pid: Int.random(in: 40000...50000),
                    ppid: 1,
                    cwd: sessions[idx].projectPath,
                    project: project,
                    type: "claude",
                    managed: true,
                    uptime: "0m",
                    cpu: 5.0,
                    memMB: 180.0,
                    launchedBy: "klaudii",
                    command: sessions[idx].permissionMode == "yolo" ? "claude --dangerously-skip-permissions" : "claude"
                )
                processes.append(proc)
            }
        } else {
            processes.removeAll { $0.project == project }
        }

        saveDemoState()
    }

    private func saveDemoState() {
        if let data = try? JSONEncoder().encode(sessions) {
            UserDefaults.standard.set(data, forKey: "demoSessions")
        }
    }

    private static func loadDemoState() -> [Session]? {
        guard let data = UserDefaults.standard.data(forKey: "demoSessions") else { return nil }
        return try? JSONDecoder().decode([Session].self, from: data)
    }

    static func clearDemoState() {
        UserDefaults.standard.removeObject(forKey: "demoSessions")
    }

    /// Generate mock processes for whichever sessions are currently running
    private static func processesForRunningSessions(_ sessions: [Session]) -> [ProcessInfo] {
        sessions.filter(\.isRunning).enumerated().map { idx, session in
            ProcessInfo(
                pid: 42187 + idx,
                ppid: 1,
                cwd: session.projectPath,
                project: session.project,
                type: "claude",
                managed: true,
                uptime: ["2h 15m", "47m", "1h 03m", "12m"][idx % 4],
                cpu: [12.0, 4.0, 8.0, 6.0][idx % 4],
                memMB: [245.0, 189.0, 210.0, 175.0][idx % 4],
                launchedBy: "klaudii",
                command: session.permissionMode == "yolo" ? "claude --dangerously-skip-permissions" : "claude"
            )
        }
    }

    // MARK: - Demo Mode Mock Data

    static let mockSessions: [Session] = [
        Session(
            project: "nova-frontend",
            projectPath: "/Users/demo/repos/nova-frontend",
            permissionMode: "ask",
            running: true,
            status: "running",
            claudeUrl: nil,
            git: GitStatus(branch: "feature/dark-mode", dirtyFiles: 0, unpushed: 0, files: nil),
            remoteUrl: "https://github.com/demo/nova-frontend.git",
            sessionCount: 2,
            lastActivity: Date().timeIntervalSince1970,
            ttyd: nil
        ),
        Session(
            project: "aurora-api",
            projectPath: "/Users/demo/repos/aurora-api",
            permissionMode: "yolo",
            running: true,
            status: "running",
            claudeUrl: nil,
            git: GitStatus(branch: "main", dirtyFiles: 3, unpushed: 1, files: [
                GitFile(status: "M", path: "src/routes/auth.ts"),
                GitFile(status: "M", path: "src/middleware/cors.ts"),
                GitFile(status: "A", path: "src/utils/jwt.ts"),
            ]),
            remoteUrl: "https://github.com/demo/aurora-api.git",
            sessionCount: 1,
            lastActivity: Date().timeIntervalSince1970 - 600,
            ttyd: nil
        ),
        Session(
            project: "stellar-ml",
            projectPath: "/Users/demo/repos/stellar-ml",
            permissionMode: "strict",
            running: false,
            status: "exited",
            claudeUrl: nil,
            git: GitStatus(branch: "develop", dirtyFiles: 7, unpushed: 2, files: [
                GitFile(status: "M", path: "app/page.tsx"),
                GitFile(status: "M", path: "app/layout.tsx"),
                GitFile(status: "A", path: "components/Hero.tsx"),
                GitFile(status: "A", path: "components/Nav.tsx"),
                GitFile(status: "M", path: "styles/globals.css"),
                GitFile(status: "D", path: "components/OldHeader.tsx"),
                GitFile(status: "M", path: "package.json"),
            ]),
            remoteUrl: "https://github.com/demo/stellar-ml.git",
            sessionCount: 1,
            lastActivity: Date().timeIntervalSince1970 - 1800,
            ttyd: nil
        ),
        Session(
            project: "orbit-docs",
            projectPath: "/Users/demo/repos/orbit-docs",
            permissionMode: "ask",
            running: false,
            status: "stopped",
            claudeUrl: nil,
            git: GitStatus(branch: "main", dirtyFiles: 0, unpushed: 0, files: nil),
            remoteUrl: "https://github.com/demo/orbit-docs.git",
            sessionCount: 3,
            lastActivity: Date().timeIntervalSince1970 - 7200,
            ttyd: nil
        ),
    ]

    static let mockProcesses: [ProcessInfo] = [
        ProcessInfo(
            pid: 42187,
            ppid: 1,
            cwd: "/Users/demo/repos/nova-frontend",
            project: "nova-frontend",
            type: "claude",
            managed: true,
            uptime: "47m",
            cpu: 4.0,
            memMB: 189.0,
            launchedBy: "klaudii",
            command: "claude"
        ),
        ProcessInfo(
            pid: 42203,
            ppid: 1,
            cwd: "/Users/demo/repos/aurora-api",
            project: "aurora-api",
            type: "claude",
            managed: true,
            uptime: "2h 15m",
            cpu: 12.0,
            memMB: 245.0,
            launchedBy: "klaudii",
            command: "claude --dangerously-skip-permissions"
        ),
    ]
}
