import SwiftUI

struct ContentView: View {
    @StateObject private var appVM = AppViewModel()

    var body: some View {
        Group {
            switch appVM.screen {
            case .login:
                LoginView(appVM: appVM)

            case .serverPicker:
                ServerPickerView(appVM: appVM)

            case .pairing(let server):
                PairingView(server: server, appVM: appVM)

            case .dashboard:
                DashboardView(appVM: appVM)
            }
        }
        .preferredColorScheme(.dark)
        .task {
            await appVM.onAppear()
        }
    }
}
