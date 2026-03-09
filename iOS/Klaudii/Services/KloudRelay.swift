import Foundation

/// WebSocket client for the Klaudii kloud relay.
/// Mirrors the browser's cloud.js: connects as role=browser, sends encrypted API requests,
/// receives encrypted responses. All payloads are E2E encrypted with the connection key.
@MainActor
class KloudRelay: ObservableObject {
    static let relayHost = "konnect.klaudii.com"

    @Published var isConnected = false
    @Published var serverOnline = false
    @Published var serverPlatform: String?

    private var webSocket: URLSessionWebSocketTask?
    private var connectionKey: Data?
    private(set) var serverId: String?
    private var userId: String?
    private var sessionCookie: String?
    private var pendingRequests: [String: CheckedContinuation<[String: Any], Error>] = [:]
    private var pendingTimeouts: [String: Task<Void, Never>] = [:]
    private var pendingChannelOpens: [String: CheckedContinuation<RelayChannel, Error>] = [:]
    private var openChannels: [String: RelayChannel] = [:]
    private var reconnectTask: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?
    private var receiveTask: Task<Void, Never>?
    private var reconnectDelay: TimeInterval = 1.0
    private let maxReconnectDelay: TimeInterval = 60.0
    private var intentionalDisconnect = false
    private var foregroundObserver: Any?

    // Multiplexed chat: per-workspace event handlers
    private var chatHandlers: [String: (String) -> Void] = [:]

    /// Registered workspace names for relay-level routing (persists across reconnects)
    private var chatSubscriptions: Set<String> = []

    func connect(serverId: String, userId: String, connectionKey: Data, cookie: String?) {
        // Listen for app returning to foreground to verify connection health
        if foregroundObserver == nil {
            foregroundObserver = NotificationCenter.default.addObserver(
                forName: .appDidBecomeActive, object: nil, queue: .main
            ) { [weak self] _ in
                self?.checkConnectionOnForeground()
            }
        }
        self.serverId = serverId
        self.userId = userId
        self.connectionKey = connectionKey
        self.sessionCookie = cookie
        self.intentionalDisconnect = false
        doConnect()
    }

    func setDemoMode(_ enabled: Bool) {
        if enabled {
            isConnected = true
            serverOnline = true
            serverPlatform = "darwin"
        } else {
            isConnected = false
            serverOnline = false
            serverPlatform = nil
        }
    }

    // MARK: - Multiplexed Chat

    /// Register a handler for chat events for a specific workspace.
    func subscribeChatEvents(workspace: String, handler: @escaping (String) -> Void) {
        chatHandlers[workspace] = handler
        chatSubscriptions.insert(workspace)
        // Tell the relay to route chat_event messages for this workspace to us
        sendRaw(["type": "chat_subscribe", "workspace": workspace])
    }

    /// Remove the chat event handler for a workspace.
    func unsubscribeChatEvents(workspace: String) {
        chatHandlers.removeValue(forKey: workspace)
        chatSubscriptions.remove(workspace)
        sendRaw(["type": "chat_unsubscribe", "workspace": workspace])
    }

    /// Send a chat message directly over the relay (no channel needed).
    func sendChat(_ jsonPayload: String, workspace: String) {
        guard let connectionKey = connectionKey,
              let encrypted = try? CryptoService.encrypt(jsonPayload, connectionKey: connectionKey) else { return }
        sendRaw([
            "type": "chat_send",
            "workspace": workspace,
            "encrypted": ["salt": encrypted.salt, "data": encrypted.data],
        ])
    }

    /// Send a raw JSON dict over the relay WebSocket.
    private func sendRaw(_ message: [String: Any]) {
        guard let msgData = try? JSONSerialization.data(withJSONObject: message),
              let msgString = String(data: msgData, encoding: .utf8) else { return }
        webSocket?.send(.string(msgString)) { _ in }
    }

    /// Re-subscribe all active workspaces after relay reconnect.
    private func resubscribeChatWorkspaces() {
        for workspace in chatSubscriptions {
            sendRaw(["type": "chat_subscribe", "workspace": workspace])
        }
    }

    func disconnect() {
        intentionalDisconnect = true
        reconnectTask?.cancel()
        reconnectTask = nil
        heartbeatTask?.cancel()
        heartbeatTask = nil
        receiveTask?.cancel()
        receiveTask = nil
        webSocket?.cancel(with: .normalClosure, reason: nil)
        webSocket = nil
        isConnected = false
        serverOnline = false
        chatHandlers.removeAll()
        chatSubscriptions.removeAll()
        if let obs = foregroundObserver {
            NotificationCenter.default.removeObserver(obs)
            foregroundObserver = nil
        }
        failAllPending(error: RelayError.disconnected)
        closeAllChannels()
    }

    /// Send an encrypted API request and wait for the response.
    func apiCall(method: String = "GET", path: String, body: Any? = nil) async throws -> [String: Any] {
        guard isConnected, serverOnline else {
            throw RelayError.notConnected
        }
        guard let connectionKey = connectionKey else {
            throw RelayError.noConnectionKey
        }

        let requestId = UUID().uuidString
        let payload: [String: Any] = [
            "method": method,
            "path": path,
            "body": body as Any,
        ]

        let payloadJSON = try JSONSerialization.data(withJSONObject: payload)
        let payloadString = String(data: payloadJSON, encoding: .utf8)!
        let encrypted = try CryptoService.encrypt(payloadString, connectionKey: connectionKey)

        let message: [String: Any] = [
            "type": "api_request",
            "requestId": requestId,
            "encrypted": [
                "salt": encrypted.salt,
                "data": encrypted.data,
            ],
        ]

        let result: [String: Any] = try await withCheckedThrowingContinuation { continuation in
            pendingRequests[requestId] = continuation

            // 30-second timeout
            pendingTimeouts[requestId] = Task {
                try? await Task.sleep(for: .seconds(30))
                if !Task.isCancelled {
                    await MainActor.run {
                        if let cont = self.pendingRequests.removeValue(forKey: requestId) {
                            self.pendingTimeouts.removeValue(forKey: requestId)
                            cont.resume(throwing: RelayError.timeout)
                        }
                    }
                }
            }

            do {
                let msgData = try JSONSerialization.data(withJSONObject: message)
                let msgString = String(data: msgData, encoding: .utf8)!
                webSocket?.send(.string(msgString)) { error in
                    if let error = error {
                        Task { @MainActor in
                            if let cont = self.pendingRequests.removeValue(forKey: requestId) {
                                self.pendingTimeouts[requestId]?.cancel()
                                self.pendingTimeouts.removeValue(forKey: requestId)
                                cont.resume(throwing: error)
                            }
                        }
                    }
                }
            } catch {
                pendingRequests.removeValue(forKey: requestId)
                pendingTimeouts[requestId]?.cancel()
                pendingTimeouts.removeValue(forKey: requestId)
                continuation.resume(throwing: error)
            }
        }

        // The relay wraps the actual API response in { status, body }
        if let body = result["body"] as? [String: Any] {
            return body
        }
        return result
    }

    /// Open a proxied WebSocket channel to a local path on the Klaudii server.
    /// The returned RelayChannel can send/receive raw string frames (JSON).
    func openChannel(path: String) async throws -> RelayChannel {
        guard isConnected, let connectionKey = connectionKey else {
            throw RelayError.notConnected
        }

        let channelId = UUID().uuidString
        let payload = try JSONSerialization.data(withJSONObject: ["path": path])
        let payloadString = String(data: payload, encoding: .utf8)!
        let encrypted = try CryptoService.encrypt(payloadString, connectionKey: connectionKey)

        let message: [String: Any] = [
            "type": "ws_connect",
            "channelId": channelId,
            "encrypted": ["salt": encrypted.salt, "data": encrypted.data],
        ]

        return try await withCheckedThrowingContinuation { continuation in
            pendingChannelOpens[channelId] = continuation

            // 10-second timeout for the channel to open
            Task {
                try? await Task.sleep(for: .seconds(10))
                await MainActor.run {
                    if let cont = self.pendingChannelOpens.removeValue(forKey: channelId) {
                        cont.resume(throwing: RelayError.timeout)
                    }
                }
            }

            do {
                let msgData = try JSONSerialization.data(withJSONObject: message)
                let msgString = String(data: msgData, encoding: .utf8)!
                webSocket?.send(.string(msgString)) { error in
                    if let error = error {
                        Task { @MainActor in
                            if let cont = self.pendingChannelOpens.removeValue(forKey: channelId) {
                                cont.resume(throwing: error)
                            }
                        }
                    }
                }
            } catch {
                pendingChannelOpens.removeValue(forKey: channelId)
                continuation.resume(throwing: error)
            }
        }
    }

    func sendChannelMessage(channelId: String, text: String) {
        guard let connectionKey = connectionKey,
              let wrapperData = try? JSONSerialization.data(withJSONObject: ["data": text]),
              let wrapperString = String(data: wrapperData, encoding: .utf8),
              let encrypted = try? CryptoService.encrypt(wrapperString, connectionKey: connectionKey)
        else {
            openChannels[channelId]?.deliverSendError("Failed to encrypt message")
            return
        }

        let message: [String: Any] = [
            "type": "ws_message",
            "channelId": channelId,
            "encrypted": ["salt": encrypted.salt, "data": encrypted.data],
        ]
        guard let msgData = try? JSONSerialization.data(withJSONObject: message),
              let msgString = String(data: msgData, encoding: .utf8) else {
            openChannels[channelId]?.deliverSendError("Failed to serialize message")
            return
        }
        webSocket?.send(.string(msgString)) { [weak self] error in
            if let error = error {
                Task { @MainActor [weak self] in
                    self?.openChannels[channelId]?.deliverSendError(error.localizedDescription)
                }
            }
        }
    }

    func closeChannel(channelId: String) {
        openChannels.removeValue(forKey: channelId)
        let message: [String: Any] = ["type": "ws_close", "channelId": channelId]
        guard let msgData = try? JSONSerialization.data(withJSONObject: message),
              let msgString = String(data: msgData, encoding: .utf8) else { return }
        webSocket?.send(.string(msgString)) { _ in }
    }

    /// Convenience: GET request returning decoded type.
    func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        let dict = try await apiCall(path: path)
        let data = try JSONSerialization.data(withJSONObject: dict)
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// Convenience: GET request returning an array.
    func getArray(_ path: String) async throws -> [[String: Any]] {
        guard isConnected, serverOnline else { throw RelayError.notConnected }
        guard let connectionKey = connectionKey else { throw RelayError.noConnectionKey }

        let requestId = UUID().uuidString
        let payload: [String: Any] = ["method": "GET", "path": path, "body": NSNull()]
        let payloadJSON = try JSONSerialization.data(withJSONObject: payload)
        let payloadString = String(data: payloadJSON, encoding: .utf8)!
        let encrypted = try CryptoService.encrypt(payloadString, connectionKey: connectionKey)

        let message: [String: Any] = [
            "type": "api_request",
            "requestId": requestId,
            "encrypted": ["salt": encrypted.salt, "data": encrypted.data],
        ]

        let result: Any = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Any, Error>) in
            // Store a wrapper that handles Any response
            let wrappedContinuation = pendingRequests.count  // just need the requestId

            // We'll use a different storage for array responses
            arrayPendingRequests[requestId] = continuation

            pendingTimeouts[requestId] = Task {
                try? await Task.sleep(for: .seconds(30))
                if !Task.isCancelled {
                    await MainActor.run {
                        if let cont = self.arrayPendingRequests.removeValue(forKey: requestId) {
                            self.pendingTimeouts.removeValue(forKey: requestId)
                            cont.resume(throwing: RelayError.timeout)
                        }
                    }
                }
            }

            do {
                let msgData = try JSONSerialization.data(withJSONObject: message)
                let msgString = String(data: msgData, encoding: .utf8)!
                webSocket?.send(.string(msgString)) { error in
                    if let error = error {
                        Task { @MainActor in
                            if let cont = self.arrayPendingRequests.removeValue(forKey: requestId) {
                                self.pendingTimeouts[requestId]?.cancel()
                                self.pendingTimeouts.removeValue(forKey: requestId)
                                cont.resume(throwing: error)
                            }
                        }
                    }
                }
            } catch {
                arrayPendingRequests.removeValue(forKey: requestId)
                pendingTimeouts[requestId]?.cancel()
                pendingTimeouts.removeValue(forKey: requestId)
                continuation.resume(throwing: error)
            }
            _ = wrappedContinuation
        }

        // The relay wraps in { status, body } where body is the array
        if let dict = result as? [String: Any], let body = dict["body"] {
            if let arr = body as? [[String: Any]] { return arr }
        }
        if let arr = result as? [[String: Any]] { return arr }
        return []
    }

    private var arrayPendingRequests: [String: CheckedContinuation<Any, Error>] = [:]

    /// Call when the app returns to foreground. Verifies the WebSocket is still
    /// alive by sending a ping — if the send fails, tears down and reconnects.
    func checkConnectionOnForeground() {
        guard !intentionalDisconnect, webSocket != nil else { return }
        webSocket?.sendPing { [weak self] error in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if error != nil {
                    // WebSocket died while backgrounded — tear down and reconnect
                    self.webSocket?.cancel(with: .abnormalClosure, reason: nil)
                    self.webSocket = nil
                    self.handleDisconnect()
                }
            }
        }
    }

    // MARK: - Private

    private func doConnect() {
        guard let serverId = serverId, let userId = userId else { return }

        var components = URLComponents()
        components.scheme = "wss"
        components.host = Self.relayHost
        components.path = "/ws"
        components.queryItems = [
            URLQueryItem(name: "role", value: "browser"),
            URLQueryItem(name: "serverId", value: serverId),
            URLQueryItem(name: "userId", value: userId),
        ]
        guard let url = components.url else { return }

        var request = URLRequest(url: url)
        if let cookie = sessionCookie {
            request.setValue("connect.sid=\(cookie)", forHTTPHeaderField: "Cookie")
        }

        let session = URLSession(configuration: .default)
        webSocket = session.webSocketTask(with: request)
        webSocket?.resume()

        // Don't set isConnected here — wait for first successful receive
        // to confirm the WebSocket handshake actually completed.
        reconnectDelay = 1.0
        startReceiving()
        startHeartbeat()
    }

    private func startReceiving() {
        receiveTask?.cancel()
        receiveTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let ws = await self?.webSocket else { break }
                do {
                    let message = try await ws.receive()
                    await self?.handleMessage(message)
                } catch {
                    await self?.handleDisconnect()
                    break
                }
            }
        }
    }

    private func handleMessage(_ message: URLSessionWebSocketTask.Message) {
        guard case .string(let text) = message,
              let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return }

        // First successful receive confirms the WebSocket is alive
        if !isConnected {
            print("[KloudRelay] first message received, setting isConnected=true")
            isConnected = true
            resubscribeChatWorkspaces()
        }

        switch type {
        case "server_status":
            if let online = json["online"] as? Bool {
                print("[KloudRelay] server_status: online=\(online) platform=\(json["platform"] as? String ?? "nil")")
                serverOnline = online
                serverPlatform = json["platform"] as? String
            }

        case "api_response":
            guard let requestId = json["requestId"] as? String else { return }

            // Check for relay-level error
            if let error = json["error"] as? String {
                if let cont = pendingRequests.removeValue(forKey: requestId) {
                    pendingTimeouts[requestId]?.cancel()
                    pendingTimeouts.removeValue(forKey: requestId)
                    cont.resume(throwing: RelayError.serverError(error))
                }
                if let cont = arrayPendingRequests.removeValue(forKey: requestId) {
                    pendingTimeouts[requestId]?.cancel()
                    pendingTimeouts.removeValue(forKey: requestId)
                    cont.resume(throwing: RelayError.serverError(error))
                }
                return
            }

            // Decrypt the response
            guard let encrypted = json["encrypted"] as? [String: String],
                  let salt = encrypted["salt"],
                  let encData = encrypted["data"],
                  let connectionKey = connectionKey else { return }

            let envelope = CryptoService.EncryptedEnvelope(salt: salt, data: encData)
            do {
                let decrypted = try CryptoService.decrypt(envelope, connectionKey: connectionKey)
                let parsed = try JSONSerialization.jsonObject(with: Data(decrypted.utf8))

                if let cont = pendingRequests.removeValue(forKey: requestId) {
                    pendingTimeouts[requestId]?.cancel()
                    pendingTimeouts.removeValue(forKey: requestId)
                    if let dict = parsed as? [String: Any] {
                        cont.resume(returning: dict)
                    } else {
                        cont.resume(throwing: RelayError.invalidResponse)
                    }
                }

                if let cont = arrayPendingRequests.removeValue(forKey: requestId) {
                    pendingTimeouts[requestId]?.cancel()
                    pendingTimeouts.removeValue(forKey: requestId)
                    cont.resume(returning: parsed)
                }
            } catch {
                if let cont = pendingRequests.removeValue(forKey: requestId) {
                    pendingTimeouts[requestId]?.cancel()
                    pendingTimeouts.removeValue(forKey: requestId)
                    cont.resume(throwing: error)
                }
                if let cont = arrayPendingRequests.removeValue(forKey: requestId) {
                    pendingTimeouts[requestId]?.cancel()
                    pendingTimeouts.removeValue(forKey: requestId)
                    cont.resume(throwing: error)
                }
            }

        case "ws_connected":
            guard let channelId = json["channelId"] as? String else { return }
            if let cont = pendingChannelOpens.removeValue(forKey: channelId) {
                let channel = RelayChannel(channelId: channelId, relay: self)
                openChannels[channelId] = channel
                cont.resume(returning: channel)
            }

        case "ws_message":
            guard let channelId = json["channelId"] as? String,
                  let encrypted = json["encrypted"] as? [String: String],
                  let salt = encrypted["salt"],
                  let encData = encrypted["data"],
                  let connectionKey = connectionKey else { return }
            let envelope = CryptoService.EncryptedEnvelope(salt: salt, data: encData)
            guard let decrypted = try? CryptoService.decrypt(envelope, connectionKey: connectionKey),
                  let parsed = try? JSONSerialization.jsonObject(with: Data(decrypted.utf8)) as? [String: Any],
                  let data = parsed["data"] as? String else { return }
            openChannels[channelId]?.deliver(data)

        case "ws_close":
            guard let channelId = json["channelId"] as? String else { return }
            if let cont = pendingChannelOpens.removeValue(forKey: channelId) {
                cont.resume(throwing: RelayError.disconnected)
            }
            if let channel = openChannels.removeValue(forKey: channelId) {
                channel.notifyClosed()
            }

        case "chat_event":
            guard let workspace = json["workspace"] as? String,
                  let encrypted = json["encrypted"] as? [String: String],
                  let salt = encrypted["salt"],
                  let encData = encrypted["data"],
                  let connectionKey = connectionKey else { return }
            let envelope = CryptoService.EncryptedEnvelope(salt: salt, data: encData)
            guard let decrypted = try? CryptoService.decrypt(envelope, connectionKey: connectionKey) else { return }
            chatHandlers[workspace]?(decrypted)

        default:
            break
        }
    }

    private func handleDisconnect() {
        print("[KloudRelay] handleDisconnect called")
        isConnected = false
        serverOnline = false
        serverPlatform = nil
        heartbeatTask?.cancel()
        failAllPending(error: RelayError.disconnected)
        closeAllChannels()

        guard !intentionalDisconnect else { return }
        scheduleReconnect()
    }

    private func startHeartbeat() {
        heartbeatTask?.cancel()
        heartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard !Task.isCancelled else { break }
                let ping = #"{"type":"ping"}"#
                try? await self?.webSocket?.send(.string(ping))
            }
        }
    }

    private func scheduleReconnect() {
        reconnectTask?.cancel()
        let delay = reconnectDelay
        reconnectDelay = min(reconnectDelay * 2, maxReconnectDelay)
        // Add ±25% jitter
        let jitter = delay * 0.25 * (Double.random(in: -1...1))
        let actualDelay = max(0.5, delay + jitter)

        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(actualDelay))
            guard !Task.isCancelled else { return }
            await self?.doConnect()
        }
    }

    private func failAllPending(error: Error) {
        for (id, cont) in pendingRequests {
            pendingTimeouts[id]?.cancel()
            cont.resume(throwing: error)
        }
        pendingRequests.removeAll()
        for (id, cont) in arrayPendingRequests {
            pendingTimeouts[id]?.cancel()
            cont.resume(throwing: error)
        }
        arrayPendingRequests.removeAll()
        pendingTimeouts.removeAll()
        for (_, cont) in pendingChannelOpens {
            cont.resume(throwing: error)
        }
        pendingChannelOpens.removeAll()
    }

    private func closeAllChannels() {
        for (_, channel) in openChannels {
            channel.notifyClosed()
        }
        openChannels.removeAll()
    }

    /// A proxied WebSocket channel through the Konnect relay to a local path on the Klaudii server.
    @MainActor
    class RelayChannel {
        let channelId: String
        private weak var relay: KloudRelay?

        /// Called with each raw string frame received from the local WebSocket.
        var onMessage: ((String) -> Void)?
        /// Called when the channel is closed (by either side or on disconnect).
        var onClose: (() -> Void)?
        /// Called when a send operation fails (encryption or WebSocket write error).
        var onSendError: ((String) -> Void)?

        init(channelId: String, relay: KloudRelay) {
            self.channelId = channelId
            self.relay = relay
        }

        /// Send a raw string frame to the local WebSocket.
        func send(_ text: String) {
            relay?.sendChannelMessage(channelId: channelId, text: text)
        }

        /// Close the channel.
        func close() {
            relay?.closeChannel(channelId: channelId)
            onClose = nil
            onMessage = nil
        }

        // Called by KloudRelay only
        func deliver(_ text: String) { onMessage?(text) }
        func deliverSendError(_ msg: String) { onSendError?(msg) }
        func notifyClosed() {
            onClose?()
            onMessage = nil
            onClose = nil
            onSendError = nil
        }
    }

    enum RelayError: Error, LocalizedError {
        case notConnected
        case noConnectionKey
        case timeout
        case disconnected
        case invalidResponse
        case serverError(String)

        var errorDescription: String? {
            switch self {
            case .notConnected: return "Not konnected to relay"
            case .noConnectionKey: return "No konnection key"
            case .timeout: return "Request timed out"
            case .disconnected: return "Disconnected from relay"
            case .invalidResponse: return "Invalid response from server"
            case .serverError(let msg): return msg
            }
        }
    }
}
