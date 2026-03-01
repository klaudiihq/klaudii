import SwiftUI

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

    private let relay: CloudRelay
    private var refreshTask: Task<Void, Never>?

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

    init(relay: CloudRelay) {
        self.relay = relay
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
        guard relay.isConnected, relay.serverOnline else { return }

        do {
            async let sessionsData = fetchSessions()
            async let processesData = fetchProcesses()

            let (s, p) = try await (sessionsData, processesData)
            sessions = s
            processes = p
            errorMessage = nil
        } catch {
            // Don't overwrite sessions on transient errors
            if sessions.isEmpty {
                errorMessage = error.localizedDescription
            }
        }
    }

    // MARK: - Actions

    func start(project: String) async {
        await postAction("/api/sessions/start", body: ["project": project])
    }

    func continueSession(project: String) async {
        await postAction("/api/sessions/start", body: ["project": project, "continueSession": true])
    }

    func stop(project: String) async {
        await postAction("/api/sessions/stop", body: ["project": project])
    }

    func restart(project: String) async {
        await postAction("/api/sessions/restart", body: ["project": project])
    }

    func resume(project: String, sessionId: String) async {
        await postAction("/api/sessions/start", body: ["project": project, "resumeSessionId": sessionId])
    }

    func setPermission(project: String, mode: String) async {
        await postAction("/api/projects/permission", body: ["project": project, "mode": mode])
    }

    func remove(project: String, force: Bool = false) async {
        await postAction("/api/projects/remove", body: ["project": project, "force": force])
    }

    func killProcess(pid: Int) async {
        await postAction("/api/processes/kill", body: ["pid": pid])
    }

    func loadHistory(project: String) async {
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
        do {
            _ = try await relay.apiCall(method: "POST", path: path, body: body)
            // Small delay then refresh
            try? await Task.sleep(for: .milliseconds(500))
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
