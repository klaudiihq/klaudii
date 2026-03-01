import Foundation

/// WebSocket client for the Klaudii cloud relay.
/// Mirrors the browser's cloud.js: connects as role=browser, sends encrypted API requests,
/// receives encrypted responses. All payloads are E2E encrypted with the connection key.
@MainActor
class CloudRelay: ObservableObject {
    static let relayHost = "konnect.klaudii.com"

    @Published var isConnected = false
    @Published var serverOnline = false

    private var webSocket: URLSessionWebSocketTask?
    private var connectionKey: Data?
    private var serverId: String?
    private var userId: String?
    private var sessionCookie: String?
    private var pendingRequests: [String: CheckedContinuation<[String: Any], Error>] = [:]
    private var pendingTimeouts: [String: Task<Void, Never>] = [:]
    private var reconnectTask: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?
    private var receiveTask: Task<Void, Never>?
    private var reconnectDelay: TimeInterval = 1.0
    private let maxReconnectDelay: TimeInterval = 60.0
    private var intentionalDisconnect = false

    func connect(serverId: String, userId: String, connectionKey: Data, cookie: String?) {
        self.serverId = serverId
        self.userId = userId
        self.connectionKey = connectionKey
        self.sessionCookie = cookie
        self.intentionalDisconnect = false
        doConnect()
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
        failAllPending(error: RelayError.disconnected)
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

        isConnected = true
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

        switch type {
        case "server_status":
            if let online = json["online"] as? Bool {
                serverOnline = online
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

        default:
            break
        }
    }

    private func handleDisconnect() {
        isConnected = false
        serverOnline = false
        heartbeatTask?.cancel()
        failAllPending(error: RelayError.disconnected)

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
            case .notConnected: return "Not connected to relay"
            case .noConnectionKey: return "No connection key"
            case .timeout: return "Request timed out"
            case .disconnected: return "Disconnected from relay"
            case .invalidResponse: return "Invalid response from server"
            case .serverError(let msg): return msg
            }
        }
    }
}
