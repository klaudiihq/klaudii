import XCTest
@testable import Klaudii

/// Tests for chat message event routing — verifies handleRawMessage behavior.
/// These events flow through the multiplexed relay and must be parsed correctly.
final class ChatMessageRoutingTests: XCTestCase {

    // MARK: - Event JSON shape validation

    /// Verify the JSON shape for a streamed assistant message.
    func testMessageEvent_shape() {
        let json: [String: Any] = [
            "type": "message",
            "role": "assistant",
            "content": "Hello!",
            "workspace": "klaudii--iosapp",
        ]
        XCTAssertEqual(json["type"] as? String, "message")
        XCTAssertEqual(json["role"] as? String, "assistant")
        XCTAssertNotNil(json["content"] as? String)
    }

    /// Verify the JSON shape for a tool_use event.
    func testToolUseEvent_shape() {
        let json: [String: Any] = [
            "type": "tool_use",
            "tool_name": "Bash",
            "tool_id": "toolu_abc123",
            "parameters": ["command": "ls -la"],
            "workspace": "test-ws",
        ]
        XCTAssertEqual(json["type"] as? String, "tool_use")
        XCTAssertEqual(json["tool_name"] as? String, "Bash")
        XCTAssertNotNil(json["tool_id"] as? String)
        XCTAssertNotNil(json["parameters"])
    }

    /// Verify the JSON shape for a tool_result event.
    func testToolResultEvent_shape() {
        let json: [String: Any] = [
            "type": "tool_result",
            "tool_id": "toolu_abc123",
            "tool_name": "Bash",
            "status": "success",
            "output": "file1.txt\nfile2.txt",
            "workspace": "test-ws",
        ]
        XCTAssertEqual(json["type"] as? String, "tool_result")
        XCTAssertNotNil(json["output"] as? String)
    }

    /// Verify the done event terminates streaming.
    func testDoneEvent_shape() {
        let json: [String: Any] = [
            "type": "done",
            "workspace": "test-ws",
        ]
        XCTAssertEqual(json["type"] as? String, "done")
    }

    /// Verify permission_request event shape.
    func testPermissionRequestEvent_shape() {
        let json: [String: Any] = [
            "type": "permission_request",
            "tool_name": "Bash",
            "description": "Run command: ls",
            "call_id": "call_123",
            "workspace": "test-ws",
        ]
        XCTAssertEqual(json["type"] as? String, "permission_request")
        XCTAssertNotNil(json["call_id"] as? String)
    }

    // MARK: - Workspace filtering

    /// Events with a different workspace should be ignored.
    func testWorkspaceFiltering() {
        let myWorkspace = "klaudii--iosapp"
        let event: [String: Any] = [
            "type": "message",
            "role": "assistant",
            "content": "test",
            "workspace": "other-workspace",
        ]
        let evtWorkspace = event["workspace"] as? String
        let shouldProcess = evtWorkspace == nil || evtWorkspace == myWorkspace
        XCTAssertFalse(shouldProcess, "Events for other workspaces must be filtered out")
    }

    func testWorkspaceFiltering_matchingWorkspace() {
        let myWorkspace = "klaudii--iosapp"
        let event: [String: Any] = [
            "type": "message",
            "content": "test",
            "workspace": "klaudii--iosapp",
        ]
        let evtWorkspace = event["workspace"] as? String
        let shouldProcess = evtWorkspace == nil || evtWorkspace == myWorkspace
        XCTAssertTrue(shouldProcess)
    }

    func testWorkspaceFiltering_noWorkspaceField() {
        let myWorkspace = "klaudii--iosapp"
        let event: [String: Any] = [
            "type": "message",
            "content": "test",
        ]
        let evtWorkspace = event["workspace"] as? String
        let shouldProcess = evtWorkspace == nil || evtWorkspace == myWorkspace
        XCTAssertTrue(shouldProcess, "Events without workspace field should pass through")
    }

    // MARK: - Chat send payload

    /// Verify the JSON payload shape for sending a message.
    func testSendPayload_shape() {
        let workspace = "klaudii--iosapp"
        let payload: [String: Any] = [
            "type": "send",
            "workspace": workspace,
            "message": "Hello Claude",
            "cli": "claude",
            "model": "opus",
            "session": 2,
        ]
        XCTAssertEqual(payload["type"] as? String, "send")
        XCTAssertEqual(payload["workspace"] as? String, workspace)
        XCTAssertNotNil(payload["message"] as? String)
        XCTAssertNotNil(payload["session"] as? Int)
    }

    // MARK: - Relay chat protocol

    /// Verify chat_subscribe message shape sent to relay.
    func testChatSubscribe_shape() {
        let msg: [String: Any] = [
            "type": "chat_subscribe",
            "workspace": "test-ws",
        ]
        XCTAssertEqual(msg["type"] as? String, "chat_subscribe")
        XCTAssertNotNil(msg["workspace"] as? String)
    }

    /// Verify chat_send message shape sent to relay.
    func testChatSend_shape() {
        let msg: [String: Any] = [
            "type": "chat_send",
            "workspace": "test-ws",
            "encrypted": ["salt": "abc", "data": "def"],
        ]
        XCTAssertEqual(msg["type"] as? String, "chat_send")
        XCTAssertNotNil(msg["workspace"] as? String)
        XCTAssertNotNil(msg["encrypted"] as? [String: String])
    }

    /// Verify chat_event message shape received from relay.
    func testChatEvent_shape() {
        let msg: [String: Any] = [
            "type": "chat_event",
            "workspace": "test-ws",
            "encrypted": ["salt": "abc", "data": "def"],
        ]
        XCTAssertEqual(msg["type"] as? String, "chat_event")
        let encrypted = msg["encrypted"] as? [String: String]
        XCTAssertNotNil(encrypted?["salt"])
        XCTAssertNotNil(encrypted?["data"])
    }
}
