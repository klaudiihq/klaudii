import SwiftUI

struct ContentView: View {
    @StateObject private var appVM = AppViewModel()
    @AppStorage("appearanceMode") private var appearanceMode = "system"

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
        .preferredColorScheme(
            appearanceMode == "light" ? .light :
            appearanceMode == "dark" ? .dark : nil
        )
        .task {
            await appVM.onAppear()
        }
    }
}
