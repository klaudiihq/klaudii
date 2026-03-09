import BackgroundTasks
import SwiftUI

extension Notification.Name {
    static let appDidBecomeActive = Notification.Name("appDidBecomeActive")
}

@main
struct KlaudiiApp: App {
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .onChange(of: scenePhase) { phase in
            switch phase {
            case .background:
                Task { @MainActor in BackgroundSyncManager.schedule() }
            case .active:
                NotificationCenter.default.post(name: .appDidBecomeActive, object: nil)
            default:
                break
            }
        }
        .backgroundTask(.appRefresh(BackgroundSyncManager.taskId)) {
            await BackgroundSyncManager.performSync()
        }
    }
}
