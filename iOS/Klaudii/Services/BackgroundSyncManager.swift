import BackgroundTasks
import Foundation

/// Manages periodic background refresh of session and process data.
/// Uses BGAppRefreshTask (requires Background App Refresh permission in iOS Settings).
@MainActor
enum BackgroundSyncManager {
    static let taskId = "com.klaudii.refresh"

    /// Submit a BGAppRefreshTask request to run ~15 minutes after the app backgrounds.
    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: taskId)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    /// Perform a background sync: connect relay, fetch sessions + processes, save to cache, disconnect.
    static func performSync() async {
        // Reschedule the next refresh
        schedule()

        guard let serverId = KeychainService.getLastServerId(),
              let connectionKey = KeychainService.getConnectionKey(forServer: serverId),
              let userId = KeychainService.getUserId() else { return }

        let cookie = KeychainService.getSessionCookie()
        let relay = KloudRelay()
        relay.connect(serverId: serverId, userId: userId, connectionKey: connectionKey, cookie: cookie)

        // Wait up to 15 seconds for the server to come online through the relay
        for _ in 0..<15 {
            if relay.serverOnline { break }
            try? await Task.sleep(for: .seconds(1))
        }

        guard relay.serverOnline else {
            relay.disconnect()
            return
        }

        do {
            async let sRaw = relay.getArray("/api/sessions")
            async let pRaw = relay.getArray("/api/processes")
            let (sessionsRaw, processesRaw) = try await (sRaw, pRaw)

            let sData = try JSONSerialization.data(withJSONObject: sessionsRaw)
            let pData = try JSONSerialization.data(withJSONObject: processesRaw)
            let sessions = try JSONDecoder().decode([Session].self, from: sData)
            let processes = try JSONDecoder().decode([ProcessInfo].self, from: pData)

            LocalCache.saveSessions(sessions, serverId: serverId)
            LocalCache.saveProcesses(processes, serverId: serverId)
        } catch {}

        relay.disconnect()
    }
}
