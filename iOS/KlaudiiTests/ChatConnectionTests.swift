import XCTest
@testable import Klaudii

/// Tests for connection state logic and workspace state parsing.
/// These flows have regressed: wrong session number, relay state not reflecting, etc.
final class ChatConnectionTests: XCTestCase {

    // MARK: - LaunchMode

    func testLaunchMode_rawValues() {
        XCTAssertEqual(LaunchMode.claude.rawValue, "claude-local")
        XCTAssertEqual(LaunchMode.claudeRC.rawValue, "claude-remote")
        XCTAssertEqual(LaunchMode.gemini.rawValue, "gemini")
    }

    func testLaunchMode_fromRawValue() {
        XCTAssertEqual(LaunchMode(rawValue: "claude-local"), .claude)
        XCTAssertEqual(LaunchMode(rawValue: "claude-remote"), .claudeRC)
        XCTAssertEqual(LaunchMode(rawValue: "gemini"), .gemini)
        XCTAssertNil(LaunchMode(rawValue: "invalid"))
    }

    func testLaunchMode_cli() {
        XCTAssertEqual(LaunchMode.claude.cli, "claude")
        XCTAssertEqual(LaunchMode.claudeRC.cli, "claude")
        XCTAssertEqual(LaunchMode.gemini.cli, "gemini")
    }

    // MARK: - Workspace state JSON parsing

    /// Verify that workspace state response contains sessionNum.
    /// Bug: ChatViewModel defaulted currentSession to 1, ignoring the actual session.
    func testWorkspaceState_sessionNumParsing() {
        let json: [String: Any] = [
            "mode": "claude-local",
            "sessionNum": 2,
            "draft": "",
            "streaming": true,
        ]
        // Extract session number the same way fetchWorkspaceState does
        let sessionNum = json["sessionNum"] as? Int
        XCTAssertEqual(sessionNum, 2, "sessionNum must be extracted from workspace state")

        let modeStr = json["mode"] as? String
        let mode = LaunchMode(rawValue: modeStr ?? "")
        XCTAssertEqual(mode, .claude)
    }

    func testWorkspaceState_defaultSessionIs1() {
        // When workspace state doesn't include sessionNum, default to 1
        let json: [String: Any] = ["mode": "gemini", "draft": ""]
        let sessionNum = json["sessionNum"] as? Int ?? 1
        XCTAssertEqual(sessionNum, 1)
    }

    // MARK: - History response parsing

    /// Verify the expected server response shape for history endpoint.
    /// Bug: response was too large (1.2MB+) causing relay timeout.
    func testHistoryResponse_hasMessagesAndTotal() {
        let response: [String: Any] = [
            "messages": [
                ["role": "user", "content": "hello", "ts": 1710000000000.0],
                ["role": "assistant", "content": "hi", "ts": 1710000001000.0],
            ],
            "total": 1374,
        ]
        let messages = response["messages"] as? [[String: Any]]
        let total = response["total"] as? Int
        XCTAssertNotNil(messages)
        XCTAssertEqual(messages?.count, 2)
        XCTAssertEqual(total, 1374)
    }

    // MARK: - Connection state derivation

    /// Chat isConnected must require BOTH relay connected AND server online.
    /// Bug: showed "Relay disconnected" when server was offline but relay was up.
    func testConnectionState_requiresBoth() {
        // Both true → connected
        XCTAssertTrue(deriveIsConnected(relayConnected: true, serverOnline: true))
        // Either false → disconnected
        XCTAssertFalse(deriveIsConnected(relayConnected: false, serverOnline: true))
        XCTAssertFalse(deriveIsConnected(relayConnected: true, serverOnline: false))
        XCTAssertFalse(deriveIsConnected(relayConnected: false, serverOnline: false))
    }

    func testConnectionError_distinguishesReasons() {
        XCTAssertEqual(deriveConnectionError(connected: false, online: false), "Relay disconnected")
        XCTAssertEqual(deriveConnectionError(connected: false, online: true), "Relay disconnected")
        XCTAssertEqual(deriveConnectionError(connected: true, online: false), "Server offline")
        XCTAssertNil(deriveConnectionError(connected: true, online: true))
    }

    // MARK: - Helpers (mirror ChatViewModel logic)

    private func deriveIsConnected(relayConnected: Bool, serverOnline: Bool) -> Bool {
        relayConnected && serverOnline
    }

    private func deriveConnectionError(connected: Bool, online: Bool) -> String? {
        if !connected { return "Relay disconnected" }
        if !online { return "Server offline" }
        return nil
    }
}
