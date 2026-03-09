import XCTest
@testable import Klaudii

/// Tests for chat history parsing — the flow that has regressed multiple times.
/// Verifies that server JSON responses are correctly parsed into ChatMessage arrays.
@MainActor
final class ChatHistoryTests: XCTestCase {

    // MARK: - parseHistory

    func testParseHistory_userAndAssistantMessages() {
        let raw: [[String: Any]] = [
            ["role": "user", "content": "Hello", "ts": 1710000000000.0],
            ["role": "assistant", "content": "Hi there!", "ts": 1710000001000.0],
        ]
        let messages = ChatViewModel.parseHistory(raw)
        XCTAssertEqual(messages.count, 2)
        XCTAssertEqual(messages[0].role, .user)
        XCTAssertEqual(messages[0].content, "Hello")
        XCTAssertEqual(messages[1].role, .assistant)
        XCTAssertEqual(messages[1].content, "Hi there!")
    }

    func testParseHistory_toolUseMessages() {
        let raw: [[String: Any]] = [
            [
                "role": "tool_use",
                "content": "Read",
                "tool_name": "Read",
                "tool_id": "tool_123",
                "parameters": ["file_path": "/tmp/test.txt"],
                "ts": 1710000000000.0,
            ],
        ]
        let messages = ChatViewModel.parseHistory(raw)
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages[0].role, .toolUse)
        XCTAssertEqual(messages[0].content, "Read")
        XCTAssertEqual(messages[0].toolName, "Read")
        XCTAssertEqual(messages[0].toolId, "tool_123")
        XCTAssertNotNil(messages[0].toolParameters)
    }

    func testParseHistory_toolResultsAreSkipped() {
        let raw: [[String: Any]] = [
            ["role": "user", "content": "do something", "ts": 1710000000000.0],
            ["role": "tool_result", "content": "result data", "ts": 1710000001000.0],
            ["role": "assistant", "content": "Done!", "ts": 1710000002000.0],
        ]
        let messages = ChatViewModel.parseHistory(raw)
        // tool_result should be skipped
        XCTAssertEqual(messages.count, 2)
        XCTAssertEqual(messages[0].role, .user)
        XCTAssertEqual(messages[1].role, .assistant)
    }

    func testParseHistory_emptyArray() {
        let messages = ChatViewModel.parseHistory([])
        XCTAssertTrue(messages.isEmpty)
    }

    func testParseHistory_missingContentIsSkipped() {
        let raw: [[String: Any]] = [
            ["role": "user"],  // missing content
            ["role": "assistant", "content": "response"],
        ]
        let messages = ChatViewModel.parseHistory(raw)
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages[0].role, .assistant)
    }

    func testParseHistory_timestampParsing() {
        let ts: Double = 1710000000000  // milliseconds
        let raw: [[String: Any]] = [
            ["role": "user", "content": "test", "ts": ts],
        ]
        let messages = ChatViewModel.parseHistory(raw)
        XCTAssertEqual(messages[0].timestamp, Date(timeIntervalSince1970: ts / 1000))
    }

    func testParseHistory_missingTimestampUsesNow() {
        let raw: [[String: Any]] = [
            ["role": "user", "content": "test"],
        ]
        let before = Date()
        let messages = ChatViewModel.parseHistory(raw)
        let after = Date()
        XCTAssertGreaterThanOrEqual(messages[0].timestamp, before)
        XCTAssertLessThanOrEqual(messages[0].timestamp, after)
    }

    // MARK: - History URL construction

    func testHistoryEndpoint_claudeLocal() {
        let mode = LaunchMode.claude
        XCTAssertEqual(mode.historyEndpoint, "/api/claude-chat")
    }

    func testHistoryEndpoint_claudeRemote() {
        let mode = LaunchMode.claudeRC
        XCTAssertEqual(mode.historyEndpoint, "/api/claude-chat")
    }

    func testHistoryEndpoint_gemini() {
        let mode = LaunchMode.gemini
        XCTAssertEqual(mode.historyEndpoint, "/api/gemini")
    }

    func testHistoryPath_includesSessionAndLimit() {
        // This verifies the URL shape that loadHistory() constructs
        let mode = LaunchMode.claude
        let workspace = "klaudii--iosapp"
        let session = 2
        let encoded = workspace.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? workspace
        let path = "\(mode.historyEndpoint)/history/\(encoded)?session=\(session)&limit=200"
        XCTAssertEqual(path, "/api/claude-chat/history/klaudii--iosapp?session=2&limit=200")
    }

    func testHistoryPath_encodesSpecialCharacters() {
        let workspace = "my workspace"
        let encoded = workspace.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? workspace
        let path = "/api/claude-chat/history/\(encoded)?session=1&limit=200"
        XCTAssertEqual(path, "/api/claude-chat/history/my%20workspace?session=1&limit=200")
    }
}
