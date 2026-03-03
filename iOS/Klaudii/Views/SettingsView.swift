import SwiftUI

struct SettingsView: View {
    @ObservedObject var appVM: AppViewModel
    @AppStorage("appearanceMode") private var appearanceMode = "system"
    @AppStorage("branchFirst") private var branchFirst = false
    @State private var showUnpairConfirm = false
    @State private var showLogoutConfirm = false

    var body: some View {
        ZStack {
            KTheme.background.ignoresSafeArea()

            List {
                // Server info
                if let server = appVM.selectedServer {
                    Section {
                        HStack {
                            Text("Server")
                                .foregroundColor(KTheme.textSecondary)
                            Spacer()
                            Text(server.name)
                                .foregroundColor(KTheme.textPrimary)
                        }
                        .font(.system(size: 14))

                        HStack {
                            Text("Status")
                                .foregroundColor(KTheme.textSecondary)
                            Spacer()
                            HStack(spacing: 6) {
                                Circle()
                                    .fill(appVM.relay.serverOnline ? KTheme.success : KTheme.textTertiary)
                                    .frame(width: 8, height: 8)
                                Text(appVM.relay.serverOnline ? "Online" : "Offline")
                                    .foregroundColor(appVM.relay.serverOnline ? KTheme.success : KTheme.textSecondary)
                            }
                        }
                        .font(.system(size: 14))

                        HStack {
                            Text("Konnection")
                                .foregroundColor(KTheme.textSecondary)
                            Spacer()
                            Text(appVM.relay.isConnected ? "Konnected" : "Diskonnected")
                                .foregroundColor(appVM.relay.isConnected ? KTheme.success : KTheme.warning)
                        }
                        .font(.system(size: 14))
                    } header: {
                        Text("Server")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(KTheme.textMuted)
                    }
                    .listRowBackground(KTheme.cardBackground)
                }

                // Actions (hidden in demo mode)
                if !appVM.isDemoMode {
                    Section {
                        Button {
                            appVM.disconnectServer()
                        } label: {
                            HStack {
                                Image(systemName: "arrow.left.arrow.right")
                                    .foregroundColor(KTheme.accent)
                                Text("Switch Server")
                                    .foregroundColor(KTheme.textPrimary)
                            }
                            .font(.system(size: 14))
                        }

                        if let server = appVM.selectedServer {
                            Button {
                                showUnpairConfirm = true
                            } label: {
                                HStack {
                                    Image(systemName: "link.badge.plus")
                                        .foregroundColor(KTheme.warning)
                                    Text("Unpair \(server.name)")
                                        .foregroundColor(KTheme.textPrimary)
                                }
                                .font(.system(size: 14))
                            }
                        }
                    } header: {
                        Text("Konnection")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(KTheme.textMuted)
                    }
                    .listRowBackground(KTheme.cardBackground)
                }

                // Account
                Section {
                    if let user = appVM.authService.user {
                        HStack {
                            Text("Account")
                                .foregroundColor(KTheme.textSecondary)
                            Spacer()
                            Text(user.email)
                                .foregroundColor(KTheme.textMuted)
                        }
                        .font(.system(size: 14))
                    }

                    Button {
                        showLogoutConfirm = true
                    } label: {
                        HStack {
                            Image(systemName: "rectangle.portrait.and.arrow.right")
                                .foregroundColor(KTheme.danger)
                            Text("Sign Out")
                                .foregroundColor(KTheme.danger)
                        }
                        .font(.system(size: 14))
                    }
                } header: {
                    Text("Account")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(KTheme.textMuted)
                }
                .listRowBackground(KTheme.cardBackground)

                // Appearance
                Section {
                    ForEach(["system", "light", "dark"], id: \.self) { mode in
                        Button {
                            appearanceMode = mode
                        } label: {
                            HStack {
                                Text(mode.capitalized)
                                    .foregroundColor(KTheme.textPrimary)
                                Spacer()
                                if appearanceMode == mode {
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 13, weight: .medium))
                                        .foregroundColor(KTheme.accent)
                                }
                            }
                            .font(.system(size: 14))
                        }
                    }
                } header: {
                    Text("Appearance")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(KTheme.textMuted)
                }
                .listRowBackground(KTheme.cardBackground)

                // Display
                Section {
                    Toggle(isOn: $branchFirst) {
                        Text("Branch names first")
                            .foregroundColor(KTheme.textPrimary)
                            .font(.system(size: 14))
                    }
                    .tint(KTheme.accent)
                } header: {
                    Text("Display")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(KTheme.textMuted)
                }
                .listRowBackground(KTheme.cardBackground)

                // Demo Mode
                if appVM.isDemoMode {
                    Section {
                        Button {
                            appVM.exitDemoMode()
                        } label: {
                            HStack {
                                Image(systemName: "xmark.circle")
                                    .foregroundColor(KTheme.warning)
                                Text("Exit Demo Mode")
                                    .foregroundColor(KTheme.textPrimary)
                            }
                            .font(.system(size: 14))
                        }
                    } header: {
                        Text("Demo Mode")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(KTheme.textMuted)
                    }
                    .listRowBackground(KTheme.cardBackground)
                } else if appVM.canPreviewDemoMode {
                    Section {
                        Button {
                            appVM.enterDemoMode()
                        } label: {
                            HStack {
                                Image(systemName: "play.display")
                                    .foregroundColor(KTheme.accent)
                                Text("Preview Demo Mode")
                                    .foregroundColor(KTheme.textPrimary)
                            }
                            .font(.system(size: 14))
                        }
                    } header: {
                        Text("Demo Mode")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(KTheme.textMuted)
                    }
                    .listRowBackground(KTheme.cardBackground)
                }

                // About
                Section {
                    HStack {
                        Text("Version")
                            .foregroundColor(KTheme.textSecondary)
                        Spacer()
                        Text(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0")
                            .foregroundColor(KTheme.textTertiary)
                    }
                    .font(.system(size: 14))

                    HStack {
                        Text("Encryption")
                            .foregroundColor(KTheme.textSecondary)
                        Spacer()
                        Text("AES-256-GCM E2E")
                            .foregroundColor(KTheme.textTertiary)
                    }
                    .font(.system(size: 14))
                    Link(destination: URL(string: "https://konnect.klaudii.com/privacy")!) {
                        HStack {
                            Text("Privacy Policy")
                                .foregroundColor(KTheme.textPrimary)
                            Spacer()
                            Image(systemName: "arrow.up.right")
                                .font(.system(size: 11))
                                .foregroundColor(KTheme.textTertiary)
                        }
                        .font(.system(size: 14))
                    }

                    Link(destination: URL(string: "https://konnect.klaudii.com/tos")!) {
                        HStack {
                            Text("Terms of Service")
                                .foregroundColor(KTheme.textPrimary)
                            Spacer()
                            Image(systemName: "arrow.up.right")
                                .font(.system(size: 11))
                                .foregroundColor(KTheme.textTertiary)
                        }
                        .font(.system(size: 14))
                    }
                } header: {
                    Text("About")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(KTheme.textMuted)
                }
                .listRowBackground(KTheme.cardBackground)
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(KTheme.background, for: .navigationBar)
        .alert("Unpair Server?", isPresented: $showUnpairConfirm) {
            Button("Unpair", role: .destructive) {
                if let server = appVM.selectedServer {
                    appVM.unpairServer(server)
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will remove the connection key. You'll need to pair again from the local Klaudii dashboard.")
        }
        .alert("Sign Out?", isPresented: $showLogoutConfirm) {
            Button("Sign Out", role: .destructive) {
                Task { await appVM.logout() }
            }
            Button("Cancel", role: .cancel) {}
        }
    }
}
