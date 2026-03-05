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

    enum ChatRole {
        case user, assistant, toolUse, error, status
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
}

/// A history entry loaded from the server's REST history endpoint.
struct HistoryMessageEntry: Decodable {
    let role: String
    let content: String
    let ts: Double?
}
