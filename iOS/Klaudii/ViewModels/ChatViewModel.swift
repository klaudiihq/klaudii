import Foundation
import SwiftUI
import PhotosUI

// MARK: - Model Info

struct ModelInfo: Identifiable {
    let id: String
    let name: String
}

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
    @Published var currentSession: Int = 1
    @Published var sessionCount: Int = 1
    @Published var availableModels: [ModelInfo] = []
    @Published var selectedModel: String = ""  // empty = Auto
    @Published var pendingImages: [(id: UUID, dataUrl: String, name: String)] = []

    let relay: KloudRelay
    let workspace: String

    private var channel: KloudRelay.RelayChannel?
    private var streamingMessageId: UUID?
    private var thinkingMessageId: UUID?
    private var connectTask: Task<Void, Never>?
    private var isManualDisconnect = false
    private var reconnectDelay: Double = 2.0
    private var toolTimers: [String: (start: Date, timer: Timer)] = [:]

    init(relay: KloudRelay, workspace: String) {
        self.relay = relay
        self.workspace = workspace

        // Grab pre-warmed data from the connection manager
        let mgr = ChatConnectionManager.shared
        let cachedMode = mgr.cachedMode(for: workspace)
        let cachedModels = mgr.cachedModels(for: workspace)
        self.launchMode = cachedMode
        self.availableModels = cachedModels
        if !cachedModels.isEmpty && cachedMode.cli == "claude" {
            self.selectedModel = cachedModels[0].id
        }

        // Load cached history synchronously
        let cachedHistory = mgr.cachedHistory(for: workspace)
        self.messages = Self.parseHistory(cachedHistory)

        // Take the pre-warmed channel or open a fresh one
        connectTask = Task {
            if let ch = mgr.takeChannel(for: workspace) {
                self.attachChannel(ch)
            } else {
                await openChannel()
            }
            // Refresh models in background if cache was empty
            if cachedModels.isEmpty { fetchModels() }
        }
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
        Task {
            await saveWorkspaceMode(mode)
            await loadHistory()
        }
    }

    func sendMessage(_ text: String) {
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
        if !selectedModel.isEmpty { payload["model"] = selectedModel }

        // Attach images
        let imageUrls = pendingImages.map { $0.dataUrl }
        if !imageUrls.isEmpty { payload["images"] = imageUrls }

        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        channel.send(json)
        pendingImages.removeAll()
    }

    // MARK: - Image Handling

    func addImage(data: Data, name: String) {
        let base64 = data.base64EncodedString()
        // Detect media type from header bytes
        let mediaType: String
        if data.starts(with: [0x89, 0x50, 0x4E, 0x47]) {
            mediaType = "image/png"
        } else if data.starts(with: [0xFF, 0xD8]) {
            mediaType = "image/jpeg"
        } else if data.starts(with: [0x47, 0x49, 0x46]) {
            mediaType = "image/gif"
        } else {
            mediaType = "image/png" // fallback
        }
        let dataUrl = "data:\(mediaType);base64,\(base64)"
        pendingImages.append((id: UUID(), dataUrl: dataUrl, name: name))
    }

    func removeImage(id: UUID) {
        pendingImages.removeAll { $0.id == id }
    }

    func loadPhotoPickerItem(_ item: PhotosPickerItem) {
        Task {
            guard let data = try? await item.loadTransferable(type: Data.self) else { return }
            await MainActor.run {
                addImage(data: data, name: "photo")
            }
        }
    }

    // MARK: - Model Selection

    func fetchModels() {
        Task {
            let endpoint = launchMode.cli == "claude" ? "/api/claude-chat/models" : "/api/gemini/models"
            guard let arr = try? await relay.getArray(endpoint) else { return }
            let models = arr.compactMap { item -> ModelInfo? in
                guard let id = item["id"] as? String,
                      let name = item["name"] as? String else { return nil }
                return ModelInfo(id: id, name: name)
            }
            await MainActor.run {
                self.availableModels = models
                // If no model selected and this is claude (no Auto), default to first
                if selectedModel.isEmpty && launchMode.cli == "claude" && !models.isEmpty {
                    selectedModel = models[0].id
                }
            }
        }
    }

    func setModel(_ modelId: String) {
        selectedModel = modelId
        // Send runtime model switch
        if !modelId.isEmpty, launchMode.cli == "claude", let channel = channel {
            let payload: [String: Any] = [
                "type": "set_model",
                "workspace": workspace,
                "model": modelId
            ]
            sendJSON(payload, via: channel)
        }
    }

    func stop() {
        guard let channel = channel else { return }
        let payload: [String: Any] = ["type": "stop", "workspace": workspace, "cli": launchMode.cli]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        channel.send(json)
    }

    // MARK: - Permission Actions

    func approvePermission(requestId: String, updatedInput: [String: Any]? = nil) {
        guard let channel = channel else { return }

        var payload: [String: Any] = [
            "type": "permission_response",
            "workspace": workspace,
            "request_id": requestId,
            "behavior": "allow",
        ]
        if let input = updatedInput {
            payload["updatedInput"] = input
        } else {
            payload["updatedInput"] = [String: Any]()
        }

        sendJSON(payload, via: channel)
        resolvePermission(requestId: requestId, behavior: "allow")
    }

    func denyPermission(requestId: String) {
        guard let channel = channel else { return }

        let payload: [String: Any] = [
            "type": "permission_response",
            "workspace": workspace,
            "request_id": requestId,
            "behavior": "deny",
        ]

        sendJSON(payload, via: channel)
        resolvePermission(requestId: requestId, behavior: "deny")
    }

    func answerQuestion(requestId: String, answers: [String: String]) {
        approvePermission(requestId: requestId, updatedInput: ["answers": answers])
    }

    func approvePlan(requestId: String, plan: String) {
        approvePermission(requestId: requestId, updatedInput: ["plan": plan])
    }

    // MARK: - Session Management

    func switchSession(_ sessionNum: Int) {
        guard sessionNum != currentSession else { return }
        currentSession = sessionNum
        messages = []
        Task { await loadHistory() }
    }

    func newSession() {
        sessionCount += 1
        currentSession = sessionCount
        messages = []
        // Server will create the new session on first message
    }

    // MARK: - Private

    private func attachChannel(_ ch: KloudRelay.RelayChannel) {
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
                self.thinkingMessageId = nil
                guard !self.isManualDisconnect else { return }
                self.scheduleChannelReconnect()
            }
        }
        ch.onSendError = { [weak self] errorMsg in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.finalizeStreaming()
                self.finalizeThinking()
                self.isStreaming = false
                self.streamingMessageId = nil
                self.messages.append(.errorMessage("Send failed: \(errorMsg)"))
            }
        }
    }

    private func openChannel() async {
        guard !isManualDisconnect else { return }
        guard relay.isConnected else {
            scheduleChannelReconnect()
            return
        }
        do {
            let ch = try await relay.openChannel(path: "/ws/chat")
            attachChannel(ch)
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

            // Wait for the relay WebSocket to be connected before trying to open a channel.
            // Without this, openChannel fails immediately with .notConnected and we spin
            // in a tight reconnect loop burning backoff budget.
            var waited = 0
            while !relay.isConnected, waited < 30 {
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled else { return }
                waited += 1
            }
            guard relay.isConnected else { return }

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
        messages = Self.parseHistory(raw)
        // Persist to disk for instant load next time
        LocalCache.saveChatHistory(raw, workspace: workspace)
    }

    static func parseHistory(_ raw: [[String: Any]]) -> [ChatMessage] {
        raw.compactMap { item -> ChatMessage? in
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
            case "tool_use":
                let name = item["tool_name"] as? String ?? "tool"
                let toolId = item["tool_id"] as? String ?? ""
                let params: String? = item["parameters"].flatMap { p -> String? in
                    guard let d = try? JSONSerialization.data(withJSONObject: p) else { return nil }
                    return String(data: d, encoding: .utf8)
                }
                return ChatMessage(id: UUID(), role: .toolUse, content: name,
                                   toolName: name, toolId: toolId, toolParameters: params,
                                   toolStatus: .success, isStreaming: false, timestamp: ts)
            case "tool_result":
                return nil
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
            finalizeThinking()
            appendOrUpdateStreaming(json["content"] as? String ?? "")

        case "thinking":
            let content = json["content"] as? String ?? ""
            appendOrUpdateThinking(content)

        case "tool_use":
            let name = json["tool_name"] as? String ?? json["name"] as? String ?? "tool"
            let toolId = json["tool_id"] as? String ?? ""
            // Skip pill for AskUserQuestion — handled via permission_request
            if name == "AskUserQuestion" || name == "ask_followup_question" { return }
            let params: String? = json["parameters"].flatMap { p -> String? in
                guard let d = try? JSONSerialization.data(withJSONObject: p) else { return nil }
                return String(data: d, encoding: .utf8)
            }
            finalizeStreaming()
            finalizeThinking()
            messages.append(.toolUse(name: name, id: toolId, params: params))
            startToolTimer(toolId: toolId)

        case "tool_result":
            let toolId = json["tool_id"] as? String ?? ""
            let toolName = json["tool_name"] as? String
            // Skip results for question tools — already handled
            if toolName == "AskUserQuestion" || toolName == "ask_followup_question" { return }
            let output = json["output"] as? String ?? json["content"] as? String ?? ""
            let status = json["status"] as? String ?? "success"
            updateToolResult(toolId: toolId, output: output, status: status)

        case "permission_request":
            finalizeStreaming()
            finalizeThinking()
            handlePermissionRequest(json)

        case "permission_resolved":
            handlePermissionResolved(json)

        case "done":
            finalizeStreaming()
            finalizeThinking()
            isStreaming = false
            streamingMessageId = nil
            if let last = messages.last, last.role == .assistant, last.content.isEmpty {
                messages.removeLast()
            }

        case "error":
            finalizeStreaming()
            finalizeThinking()
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

        case "result":
            handleResult(json)

        case "usage":
            handleUsage(json)

        case "init":
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

        case "tool_progress":
            let toolId = json["tool_use_id"] as? String ?? ""
            if let elapsed = json["elapsed_time_seconds"] as? Int {
                updateToolElapsed(toolId: toolId, seconds: elapsed)
            } else if let elapsed = json["elapsed_time_seconds"] as? Double {
                updateToolElapsed(toolId: toolId, seconds: Int(elapsed))
            }

        case "ack":
            // Future: update delivery indicators on last user message
            break

        default:
            break
        }
    }

    // MARK: - Permission Request Handling

    private func handlePermissionRequest(_ json: [String: Any]) {
        guard let requestId = json["request_id"] as? String,
              let toolName = json["tool_name"] as? String else { return }

        let toolInput = json["tool_input"] as? [String: Any] ?? [:]
        let description = json["description"] as? String ?? ""

        // Auto-approve EnterPlanMode
        if toolName == "EnterPlanMode" {
            approvePermission(requestId: requestId, updatedInput: [:])
            return
        }

        // ExitPlanMode → show plan review
        if toolName == "ExitPlanMode" {
            let plan = toolInput["plan"] as? String ?? ""
            messages.append(.planReview(requestId: requestId, plan: plan))
            return
        }

        // AskUserQuestion → show question UI
        if toolName == "AskUserQuestion" || toolName == "ask_followup_question" {
            let questions = parseQuestions(from: toolInput)
            if !questions.isEmpty {
                messages.append(.askQuestion(requestId: requestId, questions: questions))
            }
            return
        }

        // Generic permission request → show approve/deny
        let inputStr: String? = {
            guard !toolInput.isEmpty,
                  let d = try? JSONSerialization.data(withJSONObject: toolInput, options: .prettyPrinted),
                  let s = String(data: d, encoding: .utf8) else { return nil }
            return s
        }()

        messages.append(.permissionRequest(requestId: requestId, toolName: toolName,
                                           description: description, input: inputStr))
    }

    private func handlePermissionResolved(_ json: [String: Any]) {
        guard let requestId = json["request_id"] as? String,
              let behavior = json["behavior"] as? String else { return }

        resolvePermission(requestId: requestId, behavior: behavior)
    }

    private func resolvePermission(requestId: String, behavior: String) {
        guard let idx = messages.lastIndex(where: { $0.requestId == requestId }) else { return }
        messages[idx].permissionResolved = true
        messages[idx].permissionBehavior = behavior

        // If it was an ask question with answers from another client, mark them
        if let answers = messages[idx].selectedAnswers {
            messages[idx].selectedAnswers = answers
        }

        // Resume streaming after permission
        if behavior == "allow" {
            isStreaming = true
            if streamingMessageId == nil {
                let streamMsg = ChatMessage.assistantStreaming()
                streamingMessageId = streamMsg.id
                messages.append(streamMsg)
            }
        }
    }

    private func parseQuestions(from input: [String: Any]) -> [AskQuestion] {
        guard let questionsArray = input["questions"] as? [[String: Any]] else { return [] }

        return questionsArray.compactMap { q -> AskQuestion? in
            guard let question = q["question"] as? String else { return nil }
            let header = q["header"] as? String
            let multiSelect = q["multiSelect"] as? Bool ?? false

            var options: [AskOption] = []
            if let opts = q["options"] as? [Any] {
                for opt in opts {
                    if let str = opt as? String {
                        options.append(AskOption(label: str, description: nil))
                    } else if let dict = opt as? [String: Any],
                              let label = dict["label"] as? String {
                        options.append(AskOption(label: label, description: dict["description"] as? String))
                    }
                }
            }

            return AskQuestion(question: question, header: header, options: options, multiSelect: multiSelect)
        }
    }

    // MARK: - Result / Usage

    private func handleResult(_ json: [String: Any]) {
        let stats = json["stats"] as? [String: Any] ?? [:]
        var usage = UsageStats()
        usage.inputTokens = stats["input_tokens"] as? Int ?? 0
        usage.outputTokens = stats["output_tokens"] as? Int ?? 0
        usage.totalTokens = stats["total_tokens"] as? Int ?? 0
        usage.cost = stats["cost"] as? Double
        usage.durationMs = stats["duration_ms"] as? Int
        usage.turns = stats["turns"] as? Int
        usage.subtype = json["subtype"] as? String

        finalizeStreaming()
        finalizeThinking()
        isStreaming = false
        streamingMessageId = nil

        messages.append(.usageResult(stats: usage))
    }

    private func handleUsage(_ json: [String: Any]) {
        // Usage events arrive during streaming — we could track cumulative stats
        // For now just note them; the final `result` event has the complete picture
    }

    // MARK: - Streaming Helpers

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

    private func appendOrUpdateThinking(_ delta: String) {
        if let id = thinkingMessageId,
           let idx = messages.firstIndex(where: { $0.id == id }) {
            messages[idx].thinkingContent = (messages[idx].thinkingContent ?? "") + delta
        } else {
            let msg = ChatMessage.thinking(delta)
            thinkingMessageId = msg.id
            messages.append(msg)
        }
    }

    private func finalizeThinking() {
        guard let id = thinkingMessageId,
              let idx = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[idx].isStreaming = false
        thinkingMessageId = nil
    }

    private func updateToolResult(toolId: String, output: String, status: String) {
        guard let idx = messages.lastIndex(where: { $0.toolId == toolId }) else { return }
        messages[idx].toolOutput = output
        messages[idx].toolStatus = status == "error" ? .failure : .success
        stopToolTimer(toolId: toolId)
    }

    // MARK: - Tool Timer

    private func startToolTimer(toolId: String) {
        let start = Date()
        let timer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                let elapsed = Int(Date().timeIntervalSince(start))
                self.updateToolElapsed(toolId: toolId, seconds: elapsed)
            }
        }
        toolTimers[toolId] = (start: start, timer: timer)
    }

    private func stopToolTimer(toolId: String) {
        if let entry = toolTimers.removeValue(forKey: toolId) {
            entry.timer.invalidate()
        }
    }

    private func updateToolElapsed(toolId: String, seconds: Int) {
        guard let idx = messages.lastIndex(where: { $0.toolId == toolId }) else { return }
        messages[idx].toolElapsedSeconds = seconds
    }

    private func sendJSON(_ payload: [String: Any], via channel: KloudRelay.RelayChannel) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        channel.send(json)
    }
}
