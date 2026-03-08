import Foundation

struct ChatMessage: Identifiable {
    let id: UUID
    let role: ChatRole
    var content: String
    var toolName: String?
    var toolId: String?
    var toolParameters: String?   // JSON-formatted string for display
    var toolOutput: String?
    var toolStatus: ToolStatus
    var isStreaming: Bool
    let timestamp: Date

    // Permission request fields
    var requestId: String?
    var permissionToolName: String?
    var permissionDescription: String?
    var permissionResolved: Bool = false
    var permissionBehavior: String?  // "allow" or "deny" after resolution

    // AskUserQuestion fields
    var questions: [AskQuestion]?
    var selectedAnswers: [String: String]?

    // Plan review fields
    var planContent: String?

    // Thinking fields
    var thinkingContent: String?

    // Usage/result fields
    var usageStats: UsageStats?

    // Image attachment fields (data URLs for sending)
    var imageDataUrls: [String]?

    // Tool progress elapsed time (seconds)
    var toolElapsedSeconds: Int?

    enum ChatRole: Equatable {
        case user, assistant, toolUse, error, status
        case permissionRequest   // tool wants approval
        case askQuestion         // agent asking user a question
        case planReview          // ExitPlanMode plan approval
        case thinking            // extended thinking block
        case usageResult         // token usage / turn result
    }

    enum ToolStatus {
        case none, pending, success, failure
    }

    static func user(_ content: String) -> ChatMessage {
        ChatMessage(id: UUID(), role: .user, content: content,
                    toolStatus: .none, isStreaming: false, timestamp: Date())
    }

    static func assistantStreaming() -> ChatMessage {
        ChatMessage(id: UUID(), role: .assistant, content: "",
                    toolStatus: .none, isStreaming: true, timestamp: Date())
    }

    static func toolUse(name: String, id: String, params: String?) -> ChatMessage {
        ChatMessage(id: UUID(), role: .toolUse, content: name,
                    toolName: name, toolId: id, toolParameters: params,
                    toolStatus: .pending, isStreaming: false, timestamp: Date())
    }

    static func errorMessage(_ msg: String) -> ChatMessage {
        ChatMessage(id: UUID(), role: .error, content: msg,
                    toolStatus: .none, isStreaming: false, timestamp: Date())
    }

    static func statusMessage(_ msg: String) -> ChatMessage {
        ChatMessage(id: UUID(), role: .status, content: msg,
                    toolStatus: .none, isStreaming: false, timestamp: Date())
    }

    static func permissionRequest(requestId: String, toolName: String, description: String, input: String?) -> ChatMessage {
        ChatMessage(id: UUID(), role: .permissionRequest, content: description,
                    toolParameters: input, toolStatus: .none, isStreaming: false,
                    timestamp: Date(), requestId: requestId, permissionToolName: toolName,
                    permissionDescription: description)
    }

    static func askQuestion(requestId: String, questions: [AskQuestion]) -> ChatMessage {
        let summary = questions.first?.question ?? "Question"
        return ChatMessage(id: UUID(), role: .askQuestion, content: summary,
                           toolStatus: .none, isStreaming: false, timestamp: Date(),
                           requestId: requestId, questions: questions)
    }

    static func planReview(requestId: String, plan: String) -> ChatMessage {
        ChatMessage(id: UUID(), role: .planReview, content: "Plan Review",
                    toolStatus: .none, isStreaming: false, timestamp: Date(),
                    requestId: requestId, planContent: plan)
    }

    static func thinking(_ content: String) -> ChatMessage {
        ChatMessage(id: UUID(), role: .thinking, content: "",
                    toolStatus: .none, isStreaming: true, timestamp: Date(),
                    thinkingContent: content)
    }

    static func usageResult(stats: UsageStats) -> ChatMessage {
        ChatMessage(id: UUID(), role: .usageResult, content: "",
                    toolStatus: .none, isStreaming: false, timestamp: Date(),
                    usageStats: stats)
    }
}

// MARK: - Supporting Types

struct AskQuestion: Identifiable {
    let id = UUID()
    let question: String
    let header: String?
    let options: [AskOption]
    let multiSelect: Bool
}

struct AskOption: Identifiable {
    let id = UUID()
    let label: String
    let description: String?
}

struct UsageStats {
    var inputTokens: Int = 0
    var outputTokens: Int = 0
    var totalTokens: Int = 0
    var cost: Double?
    var durationMs: Int?
    var turns: Int?
    var subtype: String?  // "success", "max_turns", "budget", "execution_error"
}

/// A history entry loaded from the server's REST history endpoint.
struct HistoryMessageEntry: Decodable {
    let role: String
    let content: String
    let ts: Double?
}
