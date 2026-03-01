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

    var authService = AuthService()
    let relay = CloudRelay()

    init() {
        if authService.isAuthenticated {
            screen = .serverPicker
        }
    }

    func onAppear() async {
        await authService.checkAuth()
        if authService.isAuthenticated {
            screen = .serverPicker
            await loadServers()
        } else {
            screen = .login
        }
    }

    func login() async {
        do {
            try await authService.login()
            screen = .serverPicker
            await loadServers()
        } catch {
            errorMessage = error.localizedDescription
        }
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

    func disconnectServer() {
        relay.disconnect()
        selectedServer = nil
        screen = .serverPicker
    }

    func unpairServer(_ server: Server) {
        KeychainService.deleteConnectionKey(forServer: server.id)
        if selectedServer?.id == server.id {
            disconnectServer()
        }
    }

    func logout() async {
        relay.disconnect()
        selectedServer = nil
        await authService.logout()
        servers = []
        screen = .login
    }
}
