import SwiftUI

struct DashboardView: View {
    @ObservedObject var appVM: AppViewModel
    @StateObject private var sessionsVM: SessionsViewModel

    init(appVM: AppViewModel) {
        self.appVM = appVM
        self._sessionsVM = StateObject(wrappedValue: SessionsViewModel(relay: appVM.relay))
    }

    var body: some View {
        NavigationStack {
            ZStack {
                KTheme.background.ignoresSafeArea()

                ScrollView {
                    VStack(spacing: 0) {
                        // Sort bar
                        sortBar

                        // Connection status
                        if !appVM.relay.serverOnline && appVM.relay.isConnected {
                            serverOfflineBanner
                        }

                        if !appVM.relay.isConnected {
                            connectionErrorBanner
                        }

                        // Sessions
                        LazyVStack(spacing: KTheme.cardSpacing) {
                            ForEach(sessionsVM.sortedSessions) { session in
                                let proc = sessionsVM.processes.first { $0.project == session.project && $0.managed }
                                SessionCardView(
                                    session: session,
                                    process: proc,
                                    sessionsVM: sessionsVM
                                )
                            }
                        }
                        .padding(.horizontal, KTheme.sectionPadding)
                        .padding(.top, KTheme.sectionPadding)

                        // Empty state
                        if sessionsVM.sortedSessions.isEmpty && !sessionsVM.isLoading {
                            emptyState
                        }

                        // Unmanaged processes
                        if !sessionsVM.unmanagedProcesses.isEmpty {
                            ProcessesView(
                                processes: sessionsVM.unmanagedProcesses,
                                onKill: { pid in
                                    Task { await sessionsVM.killProcess(pid: pid) }
                                }
                            )
                        }
                    }
                }
                .refreshable {
                    await sessionsVM.refresh()
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(KTheme.background, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    connectionBadge
                }
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 4) {
                        Button {
                            Task { await sessionsVM.refresh() }
                        } label: {
                            Image(systemName: "arrow.clockwise")
                                .font(.system(size: 14))
                                .foregroundColor(KTheme.textSecondary)
                        }

                        NavigationLink {
                            SettingsView(appVM: appVM)
                        } label: {
                            Image(systemName: "gearshape")
                                .font(.system(size: 14))
                                .foregroundColor(KTheme.textSecondary)
                        }
                    }
                }
            }
        }
        .onAppear {
            sessionsVM.startAutoRefresh()
        }
        .onDisappear {
            sessionsVM.stopAutoRefresh()
        }
    }

    // MARK: - Subviews

    private var connectionBadge: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(badgeColor)
                .frame(width: 6, height: 6)
            Text(badgeText)
                .font(.system(size: KTheme.microSize))
                .foregroundColor(badgeColor)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(badgeBg)
        .clipShape(Capsule())
    }

    private var badgeColor: Color {
        if appVM.relay.isConnected && appVM.relay.serverOnline {
            return KTheme.success
        } else if appVM.relay.isConnected {
            return KTheme.warning
        }
        return KTheme.textSecondary
    }

    private var badgeBg: Color {
        if appVM.relay.isConnected && appVM.relay.serverOnline {
            return KTheme.successBg
        } else if appVM.relay.isConnected {
            return KTheme.warningBg
        }
        return Color(hex: 0x2A2D35)
    }

    private var badgeText: String {
        if appVM.relay.isConnected && appVM.relay.serverOnline {
            return "connected"
        } else if appVM.relay.isConnected {
            return "server offline"
        }
        return "connecting..."
    }

    private var sortBar: some View {
        HStack(spacing: 4) {
            Text("SORT")
                .font(.system(size: KTheme.microSize, weight: .medium))
                .foregroundColor(KTheme.textTertiary)
                .tracking(0.5)

            ForEach(SortMode.allCases, id: \.self) { mode in
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) {
                        sessionsVM.sortMode = mode
                    }
                } label: {
                    Text(mode.rawValue)
                        .font(.system(size: KTheme.microSize))
                        .foregroundColor(sessionsVM.sortMode == mode ? KTheme.textPrimary : KTheme.textMuted)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(sessionsVM.sortMode == mode ? Color(hex: 0x2A2D35) : Color.clear)
                        .cornerRadius(4)
                        .overlay(
                            RoundedRectangle(cornerRadius: 4)
                                .stroke(
                                    sessionsVM.sortMode == mode ? KTheme.borderHover : KTheme.border,
                                    lineWidth: 1
                                )
                        )
                }
                .buttonStyle(.plain)
            }

            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 5)
        .background(KTheme.background)
        .overlay(
            Rectangle()
                .fill(KTheme.border)
                .frame(height: 1),
            alignment: .bottom
        )
    }

    private var serverOfflineBanner: some View {
        HStack {
            Image(systemName: "wifi.slash")
                .font(.system(size: 12))
            Text("Server is offline")
                .font(.system(size: 12))
            Spacer()
        }
        .foregroundColor(KTheme.warning)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(KTheme.warningBg)
    }

    private var connectionErrorBanner: some View {
        HStack {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 12))
            Text("Cannot reach relay")
                .font(.system(size: 12))
            Spacer()
            Button("Switch Server") {
                appVM.disconnectServer()
            }
            .font(.system(size: 11, weight: .medium))
            .foregroundColor(KTheme.textPrimary)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Color(hex: 0x2A2D35))
            .cornerRadius(4)
        }
        .foregroundColor(KTheme.danger)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(KTheme.dangerBg)
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "tray")
                .font(.system(size: 28))
                .foregroundColor(KTheme.textTertiary)
            Text("No sessions")
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(KTheme.textSecondary)
            Text("Add workspaces from the Klaudii dashboard")
                .font(.system(size: 12))
                .foregroundColor(KTheme.textTertiary)
        }
        .padding(.vertical, 40)
    }
}
