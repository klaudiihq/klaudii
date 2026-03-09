import Foundation

/// Pre-warms WebSocket channels and caches workspace state so ChatView opens instantly.
/// Loads from disk cache first for instant display, then fetches fresh data in background.
@MainActor
final class ChatConnectionManager {
    static let shared = ChatConnectionManager()

    struct CachedWorkspace {
        var channel: KloudRelay.RelayChannel?
        var mode: LaunchMode = .claude
        var history: [[String: Any]] = []
        var models: [ModelInfo] = []
        var lastFetched: Date = .distantPast
        var isConnecting = false
        var diskLoaded = false
    }

    private(set) var cache: [String: CachedWorkspace] = [:]
    private weak var relay: KloudRelay?

    private init() {}

    /// Set the relay instance (call once from AppViewModel or SessionsViewModel init)
    func configure(relay: KloudRelay) {
        self.relay = relay
    }

    /// Called from SessionsViewModel.refresh() with the list of known workspace names.
    /// Loads disk caches synchronously, then fetches fresh data serially in background.
    func syncWorkspaces(_ workspaces: [String]) {
        guard let relay else { return }

        // Remove stale entries
        let workspaceSet = Set(workspaces)
        for key in cache.keys where !workspaceSet.contains(key) {
            cache.removeValue(forKey: key)
        }

        // Load disk caches synchronously for any new workspaces
        for ws in workspaces where cache[ws] == nil {
            var entry = CachedWorkspace()
            if let diskHistory = LocalCache.loadChatHistory(workspace: ws) {
                entry.history = diskHistory
            }
            if let modeStr = LocalCache.loadWorkspaceMode(workspace: ws),
               let mode = LaunchMode(rawValue: modeStr) {
                entry.mode = mode
            }
            entry.diskLoaded = true
            cache[ws] = entry
        }

        // Warm workspaces serially in background (one at a time to avoid relay contention)
        Task {
            for ws in workspaces {
                await warmWorkspace(ws, relay: relay)
            }
        }
    }

    /// Get the pre-warmed channel for a workspace, detaching it from the cache
    /// so ChatViewModel owns it. Returns nil if not ready yet.
    func takeChannel(for workspace: String) -> KloudRelay.RelayChannel? {
        let ch = cache[workspace]?.channel
        cache[workspace]?.channel = nil
        return ch
    }

    /// Get cached workspace mode (in-memory or disk-backed)
    func cachedMode(for workspace: String) -> LaunchMode {
        if let mode = cache[workspace]?.mode { return mode }
        // Fallback to disk if not yet synced
        if let modeStr = LocalCache.loadWorkspaceMode(workspace: workspace),
           let mode = LaunchMode(rawValue: modeStr) { return mode }
        return .claude
    }

    /// Get cached history (in-memory or disk-backed)
    func cachedHistory(for workspace: String) -> [[String: Any]] {
        if let hist = cache[workspace]?.history, !hist.isEmpty { return hist }
        // Fallback to disk if not yet synced
        return LocalCache.loadChatHistory(workspace: workspace) ?? []
    }

    /// Get cached models
    func cachedModels(for workspace: String) -> [ModelInfo] {
        cache[workspace]?.models ?? []
    }

    // MARK: - Private

    private func warmWorkspace(_ workspace: String, relay: KloudRelay) async {
        guard !(cache[workspace]?.isConnecting ?? false) else { return }

        let stale = Date().timeIntervalSince(cache[workspace]?.lastFetched ?? .distantPast) > 30
        guard stale else { return }

        cache[workspace]?.isConnecting = true

        // Fetch serially to avoid concurrent relay calls
        await fetchMode(workspace, relay: relay)
        await fetchHistory(workspace, relay: relay)
        await fetchModels(workspace, relay: relay)

        cache[workspace]?.lastFetched = Date()
        cache[workspace]?.isConnecting = false
    }

    private func fetchMode(_ workspace: String, relay: KloudRelay) async {
        let encoded = workspace.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? workspace
        guard let result = try? await relay.apiCall(path: "/api/workspace-state/\(encoded)"),
              let modeStr = result["mode"] as? String,
              let mode = LaunchMode(rawValue: modeStr) else { return }
        cache[workspace]?.mode = mode
        LocalCache.saveWorkspaceMode(modeStr, workspace: workspace)
    }

    private func fetchHistory(_ workspace: String, relay: KloudRelay) async {
        let encoded = workspace.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? workspace
        let mode = cache[workspace]?.mode ?? .claude
        let path = "\(mode.historyEndpoint)/history/\(encoded)"
        guard let raw = try? await relay.getArray(path) else { return }
        cache[workspace]?.history = raw
        LocalCache.saveChatHistory(raw, workspace: workspace)
    }

    private func fetchModels(_ workspace: String, relay: KloudRelay) async {
        let mode = cache[workspace]?.mode ?? .claude
        let endpoint = mode.cli == "claude" ? "/api/claude-chat/models" : "/api/gemini/models"
        guard let arr = try? await relay.getArray(endpoint) else { return }
        let models = arr.compactMap { item -> ModelInfo? in
            guard let id = item["id"] as? String,
                  let name = item["name"] as? String else { return nil }
            return ModelInfo(id: id, name: name)
        }
        cache[workspace]?.models = models
    }

    private func openChannel(_ workspace: String, relay: KloudRelay) async {
        guard let ch = try? await relay.openChannel(path: "/ws/chat") else { return }

        ch.onClose = { [weak self] in
            Task { @MainActor [weak self] in
                // Channel died — mark it nil so next sync re-opens it
                self?.cache[workspace]?.channel = nil
            }
        }

        cache[workspace]?.channel = ch
    }
}
