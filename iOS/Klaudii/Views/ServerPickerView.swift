import SwiftUI

struct ServerPickerView: View {
    @ObservedObject var appVM: AppViewModel
    @State private var isRefreshing = false

    var body: some View {
        NavigationStack {
            ZStack {
                KTheme.background.ignoresSafeArea()

                if appVM.servers.isEmpty && !isRefreshing {
                    emptyState
                } else {
                    serverList
                }
            }
            .navigationTitle("Servers")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(KTheme.background, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await appVM.logout() }
                    } label: {
                        Image(systemName: "rectangle.portrait.and.arrow.right")
                            .foregroundColor(KTheme.textSecondary)
                    }
                }
            }
        }
    }

    private var serverList: some View {
        List {
            Section {
                ForEach(appVM.servers) { server in
                    Button {
                        appVM.selectServer(server)
                    } label: {
                        HStack(spacing: 12) {
                            Circle()
                                .fill(server.online ? KTheme.success : KTheme.textTertiary)
                                .frame(width: 10, height: 10)

                            VStack(alignment: .leading, spacing: 2) {
                                Text(server.name)
                                    .font(.system(size: 15, weight: .medium))
                                    .foregroundColor(KTheme.textWhite)

                                Text(server.online ? "Online" : "Last seen \(server.lastSeenText)")
                                    .font(.system(size: 12))
                                    .foregroundColor(KTheme.textSecondary)
                            }

                            Spacer()

                            if KeychainService.getConnectionKey(forServer: server.id) != nil {
                                Image(systemName: "checkmark.shield.fill")
                                    .font(.system(size: 14))
                                    .foregroundColor(KTheme.success.opacity(0.6))
                            }

                            Image(systemName: "chevron.right")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundColor(KTheme.textTertiary)
                        }
                        .padding(.vertical, 4)
                    }
                    .listRowBackground(KTheme.cardBackground)
                }
            } header: {
                Text("Your Machines")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(KTheme.textMuted)
                    .textCase(.uppercase)
            }

            if let email = appVM.authService.user?.email {
                Section {
                    HStack {
                        Text("Signed in as")
                            .foregroundColor(KTheme.textSecondary)
                        Spacer()
                        Text(email)
                            .foregroundColor(KTheme.textMuted)
                    }
                    .font(.system(size: 12))
                    .listRowBackground(KTheme.cardBackground)
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .refreshable {
            isRefreshing = true
            await appVM.loadServers()
            isRefreshing = false
        }
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "server.rack")
                .font(.system(size: 40))
                .foregroundColor(KTheme.textTertiary)

            Text("No servers found")
                .font(.system(size: 15, weight: .medium))
                .foregroundColor(KTheme.textSecondary)

            Text("Pair your local Klaudii instance\nvia Cloud Connect first")
                .font(.system(size: 13))
                .foregroundColor(KTheme.textTertiary)
                .multilineTextAlignment(.center)

            Button {
                Task { await appVM.loadServers() }
            } label: {
                Text("Refresh")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(KTheme.accent)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(KTheme.accentBg)
                    .cornerRadius(8)
            }
        }
    }
}
