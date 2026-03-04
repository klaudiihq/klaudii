import SwiftUI

enum AppScreen {
    case login
    case serverPicker
    case pairing(Server)
    case dashboard
}

@MainActor
class AppViewModel: ObservableObject {
    @Published var screen: AppScreen = .login
    @Published var selectedServer: Server?
    @Published var servers: [Server] = []
    @Published var errorMessage: String?
    @Published var isDemoMode = false

    private static let demoAutoEmails = ["demo@klaudii.com"]
    private static let demoPreviewEmails = ["bryan@tinsley.me"]

    var canPreviewDemoMode: Bool {
        guard let email = authService.user?.email else { return false }
        return Self.demoPreviewEmails.contains(email)
    }

    var authService = AuthService()
    let relay = KloudRelay()

    init() {
        if authService.isAuthenticated {
            screen = .serverPicker
        }
    }

    func onAppear() async {
        // Fast path: if we have all cached credentials, connect WebSocket immediately
        // without waiting for checkAuth/loadServers network calls
        if authService.isAuthenticated,
           let lastServerId = KeychainService.getLastServerId(),
           let key = KeychainService.getConnectionKey(forServer: lastServerId),
           let userId = KeychainService.getUserId() {
            let name = KeychainService.getLastServerName() ?? "Server"
            let platform = KeychainService.getLastServerPlatform()
            let cachedServer = Server(id: lastServerId, name: name, online: true, platform: platform, lastSeen: nil, createdAt: nil)
            selectedServer = cachedServer
            relay.connect(
                serverId: lastServerId,
                userId: userId,
                connectionKey: key,
                cookie: authService.cookie
            )
            screen = .dashboard

            // Validate auth + update server list in background
            Task {
                await authService.checkAuth()
                if !authService.isAuthenticated {
                    relay.disconnect()
                    screen = .login
                    return
                }
                await loadServers()
                if let updated = servers.first(where: { $0.id == lastServerId }) {
                    selectedServer = updated
                    if let platform = updated.platform {
                        KeychainService.saveLastServerPlatform(platform)
                    }
                }
            }
            return
        }

        // Slow path: no cached server, do full auth flow
        await authService.checkAuth()
        if authService.isAuthenticated {
            if let email = authService.user?.email,
               Self.demoAutoEmails.contains(email) {
                enterDemoMode()
                return
            }
            await loadServers()
            // If exactly one server has a connection key, auto-select it
            let paired = servers.filter { KeychainService.getConnectionKey(forServer: $0.id) != nil }
            if paired.count == 1, let server = paired.first,
               let key = KeychainService.getConnectionKey(forServer: server.id) {
                connectToServer(server, connectionKey: key)
            } else {
                screen = .serverPicker
            }
        } else {
            screen = .login
        }
    }

    func enterDemoMode() {
        relay.disconnect()
        isDemoMode = true
        selectedServer = Server(
            id: "demo-server",
            name: "Demo Server",
            online: true,
            platform: "darwin",
            lastSeen: Date().timeIntervalSince1970,
            createdAt: Date().timeIntervalSince1970 - 86400 * 30
        )
        relay.setDemoMode(true)
        screen = .dashboard
    }

    func exitDemoMode() {
        isDemoMode = false
        relay.setDemoMode(false)
        selectedServer = nil
        screen = .serverPicker
    }

    func login() async {
        do {
            try await authService.login()
            await didSignIn()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loginWithApple() async {
        do {
            try await authService.loginWithApple()
            await didSignIn()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func didSignIn() async {
        if let email = authService.user?.email,
           Self.demoAutoEmails.contains(email) {
            enterDemoMode()
            return
        }
        screen = .serverPicker
        await loadServers()
    }

    func loadServers() async {
        do {
            servers = try await authService.fetchServers()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func selectServer(_ server: Server) {
        selectedServer = server
        // Check if we have a connection key for this server
        if let key = KeychainService.getConnectionKey(forServer: server.id) {
            connectToServer(server, connectionKey: key)
        } else {
            screen = .pairing(server)
        }
    }

    func connectToServer(_ server: Server, connectionKey: Data) {
        selectedServer = server
        KeychainService.saveConnectionKey(connectionKey, forServer: server.id)
        KeychainService.saveLastServerId(server.id)
        KeychainService.saveLastServerName(server.name)
        if let platform = server.platform {
            KeychainService.saveLastServerPlatform(platform)
        }

        guard let userId = KeychainService.getUserId() else {
            errorMessage = "No user ID found"
            return
        }

        relay.connect(
            serverId: server.id,
            userId: userId,
            connectionKey: connectionKey,
            cookie: authService.cookie
        )
        screen = .dashboard
    }

    /// Switch to a different paired server without leaving the dashboard.
    func switchToServer(_ server: Server) {
        guard server.id != selectedServer?.id else { return }
        relay.disconnect()
        if let key = KeychainService.getConnectionKey(forServer: server.id) {
            connectToServer(server, connectionKey: key)
        } else {
            selectedServer = server
            screen = .pairing(server)
        }
    }

    func disconnectServer() {
        relay.disconnect()
        selectedServer = nil
        KeychainService.clearLastServerId()
        screen = .serverPicker
    }

    func unpairServer(_ server: Server) {
        KeychainService.deleteConnectionKey(forServer: server.id)
        if selectedServer?.id == server.id {
            disconnectServer()
        }
    }

    func logout() async {
        isDemoMode = false
        relay.setDemoMode(false)
        SessionsViewModel.clearDemoState()
        relay.disconnect()
        selectedServer = nil
        await authService.logout()
        servers = []
        screen = .login
    }
}
