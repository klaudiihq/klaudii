import Foundation
import SwiftUI

// MARK: - Launch Mode

enum LaunchMode: String, CaseIterable {
    case claude     = "claude-local"
    case claudeRC   = "claude-remote"
    case gemini     = "gemini"

    var displayName: String {
        switch self {
        case .claude:   return "Claude"
        case .claudeRC: return "Claude RC"
        case .gemini:   return "Gemini"
        }
    }

    var cli: String {
        switch self {
        case .claude, .claudeRC: return "claude"
        case .gemini:            return "gemini"
        }
    }

    var permissionMode: String? {
        switch self {
        case .claude:   return "bypassPermissions"
        case .claudeRC: return "plan"
        case .gemini:   return nil
        }
    }

    var historyEndpoint: String {
        switch self {
        case .claude, .claudeRC: return "/api/claude-chat"
        case .gemini:            return "/api/gemini"
        }
    }
}

// MARK: - ChatViewModel

@MainActor
class ChatViewModel: ObservableObject {
    @Published var messages: [ChatMessage] = []
    @Published var isStreaming = false
    @Published var isConnected = false
    @Published var connectionError: String?
    @Published var launchMode: LaunchMode = .claude

    let relay: KloudRelay
    let workspace: String

    private var channel: KloudRelay.RelayChannel?
    private var streamingMessageId: UUID?
    private var connectTask: Task<Void, Never>?
    private var isManualDisconnect = false
    private var reconnectDelay: Double = 2.0

    init(relay: KloudRelay, workspace: String) {
        self.relay = relay
        self.workspace = workspace
        connectTask = Task { await connect() }
    }

    func disconnect() {
        isManualDisconnect = true
        connectTask?.cancel()
        channel?.close()
        channel = nil
        isConnected = false
    }

    func setMode(_ mode: LaunchMode) {
        guard mode != launchMode else { return }
        launchMode = mode
        messages = []
        // Persist to server and reload history for the new mode
        Task {
            await saveWorkspaceMode(mode)
            await loadHistory()
        }
    }

    func sendMessage(_ text: String, model: String? = nil) {
        guard isConnected, let channel = channel else { return }

        messages.append(.user(text))
        let streamMsg = ChatMessage.assistantStreaming()
        streamingMessageId = streamMsg.id
        messages.append(streamMsg)
        isStreaming = true

        var payload: [String: Any] = [
            "type": "send",
            "workspace": workspace,
            "message": text,
            "cli": launchMode.cli,
        ]
        if let pm = launchMode.permissionMode { payload["permissionMode"] = pm }
        if let model = model { payload["model"] = model }

        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        channel.send(json)
    }

    func stop() {
        guard let channel = channel else { return }
        let payload: [String: Any] = ["type": "stop", "workspace": workspace, "cli": launchMode.cli]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        channel.send(json)
    }

    // MARK: - Private

    private func connect() async {
        await fetchWorkspaceMode()
        await loadHistory()
        await openChannel()
    }

    private func openChannel() async {
        guard !isManualDisconnect else { return }
        do {
            let ch = try await relay.openChannel(path: "/ws/gemini")
            channel = ch
            isConnected = true
            connectionError = nil
            reconnectDelay = 2.0

            ch.onMessage = { [weak self] text in
                Task { @MainActor [weak self] in self?.handleRawMessage(text) }
            }
            ch.onClose = { [weak self] in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    self.channel = nil
                    self.isConnected = false
                    self.isStreaming = false
                    self.streamingMessageId = nil
                    guard !self.isManualDisconnect else { return }
                    self.scheduleChannelReconnect()
                }
            }
        } catch {
            connectionError = error.localizedDescription
            guard !isManualDisconnect else { return }
            scheduleChannelReconnect()
        }
    }

    private func scheduleChannelReconnect() {
        let delay = reconnectDelay
        reconnectDelay = min(reconnectDelay * 2, 30)
        connectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self else { return }
            await self.loadHistory()
            await self.openChannel()
        }
    }

    private func fetchWorkspaceMode() async {
        let encoded = workspace.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? workspace
        guard let result = try? await relay.apiCall(path: "/api/workspace-state/\(encoded)"),
              let modeStr = result["mode"] as? String,
              let mode = LaunchMode(rawValue: modeStr) else { return }
        launchMode = mode
    }

    private func saveWorkspaceMode(_ mode: LaunchMode) async {
        let encoded = workspace.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? workspace
        _ = try? await relay.apiCall(method: "PATCH", path: "/api/workspace-state/\(encoded)",
                                     body: ["mode": mode.rawValue])
    }

    private func loadHistory() async {
        let encoded = workspace.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? workspace
        let path = "\(launchMode.historyEndpoint)/history/\(encoded)"
        guard let raw = try? await relay.getArray(path) else { return }

        messages = raw.compactMap { item -> ChatMessage? in
            guard let role = item["role"] as? String,
                  let content = item["content"] as? String else { return nil }
            let ts = (item["ts"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) } ?? Date()
            switch role {
            case "user":
                return ChatMessage(id: UUID(), role: .user, content: content,
                                   toolStatus: .none, isStreaming: false, timestamp: ts)
            case "assistant":
                return ChatMessage(id: UUID(), role: .assistant, content: content,
                                   toolStatus: .none, isStreaming: false, timestamp: ts)
            default:
                return nil
            }
        }
    }

    // MARK: - Event handling

    private func handleRawMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return }

        if let evtWorkspace = json["workspace"] as? String, evtWorkspace != workspace { return }

        switch type {
        case "message":
            let role = json["role"] as? String
            guard role == "assistant" || role == nil else { return }
            appendOrUpdateStreaming(json["content"] as? String ?? "")

        case "tool_use":
            let name = json["tool_name"] as? String ?? json["name"] as? String ?? "tool"
            let toolId = json["tool_id"] as? String ?? ""
            let params: String? = json["parameters"].flatMap { p -> String? in
                guard let d = try? JSONSerialization.data(withJSONObject: p) else { return nil }
                return String(data: d, encoding: .utf8)
            }
            finalizeStreaming()
            messages.append(.toolUse(name: name, id: toolId, params: params))

        case "tool_result":
            let toolId = json["tool_id"] as? String ?? ""
            let output = json["output"] as? String ?? json["content"] as? String ?? ""
            let status = json["status"] as? String ?? "success"
            updateToolResult(toolId: toolId, output: output, status: status)

        case "done":
            finalizeStreaming()
            isStreaming = false
            streamingMessageId = nil
            if let last = messages.last, last.role == .assistant, last.content.isEmpty {
                messages.removeLast()
            }

        case "error":
            finalizeStreaming()
            isStreaming = false
            streamingMessageId = nil
            messages.append(.errorMessage(json["message"] as? String ?? "Unknown error"))

        case "status":
            let msg = json["message"] as? String ?? ""
            guard !msg.isEmpty else { break }
            if let lastIdx = messages.indices.last, messages[lastIdx].role == .status {
                messages[lastIdx].content = msg
            } else {
                messages.append(.statusMessage(msg))
            }

        case "result", "init":
            break

        case "streaming_start":
            if !isStreaming {
                let streamMsg = ChatMessage.assistantStreaming()
                streamingMessageId = streamMsg.id
                messages.append(streamMsg)
                isStreaming = true
            }

        case "user_message":
            if let content = json["content"] as? String {
                let ts = (json["ts"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) } ?? Date()
                messages.append(ChatMessage(id: UUID(), role: .user, content: content,
                                            toolStatus: .none, isStreaming: false, timestamp: ts))
            }

        case "permission_request":
            finalizeStreaming()
            isStreaming = false

        default:
            break
        }
    }

    private func appendOrUpdateStreaming(_ delta: String) {
        if let id = streamingMessageId,
           let idx = messages.firstIndex(where: { $0.id == id }) {
            messages[idx].content += delta
        } else {
            var msg = ChatMessage.assistantStreaming()
            msg.content = delta
            streamingMessageId = msg.id
            messages.append(msg)
        }
    }

    private func finalizeStreaming() {
        guard let id = streamingMessageId,
              let idx = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[idx].isStreaming = false
        streamingMessageId = nil
    }

    private func updateToolResult(toolId: String, output: String, status: String) {
        guard let idx = messages.lastIndex(where: { $0.toolId == toolId }) else { return }
        messages[idx].toolOutput = output
        messages[idx].toolStatus = status == "error" ? .failure : .success
    }
}
