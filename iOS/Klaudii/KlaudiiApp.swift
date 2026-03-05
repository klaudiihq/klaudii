import BackgroundTasks
import SwiftUI

@main
struct KlaudiiApp: App {
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .onChange(of: scenePhase) { phase in
            if phase == .background {
                Task { @MainActor in BackgroundSyncManager.schedule() }
            }
        }
        .backgroundTask(.appRefresh(BackgroundSyncManager.taskId)) {
            await BackgroundSyncManager.performSync()
        }
    }
}
