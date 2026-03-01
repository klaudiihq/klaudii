import SwiftUI

struct DashboardView: View {
    @ObservedObject var appVM: AppViewModel
    @StateObject private var sessionsVM: SessionsViewModel
    @State private var showingAddWorkspace = false
    @State private var hasAppeared = false
    @Environment(\.colorScheme) private var colorScheme

    init(appVM: AppViewModel) {
        self.appVM = appVM
        self._sessionsVM = StateObject(wrappedValue: SessionsViewModel(relay: appVM.relay, demoMode: appVM.isDemoMode))
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Header: server name + connection pill + sort
                header

                // Connection banners
                if !appVM.relay.serverOnline && appVM.relay.isConnected {
                    serverOfflineBanner
                }
                if !appVM.relay.isConnected {
                    connectionErrorBanner
                }

                // Session list
                ScrollView {
                    LazyVStack(spacing: KTheme.cardSpacing) {
                        ForEach(Array(sessionsVM.sortedSessions.enumerated()), id: \.element.id) { index, session in
                            let proc = sessionsVM.processes.first { $0.project == session.project && $0.managed }
                            SessionCardView(
                                session: session,
                                process: proc,
                                sessionsVM: sessionsVM
                            )
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                            .animation(
                                .spring(response: 0.4, dampingFraction: 0.8)
                                    .delay(hasAppeared ? 0 : Double(index) * 0.05),
                                value: sessionsVM.sortedSessions.map(\.id)
                            )
                        }
                    }
                    .padding(.horizontal, KTheme.sectionPadding)
                    .padding(.top, KTheme.sectionPadding)
                    .padding(.bottom, 12)

                    // Loading / empty state
                    if sessionsVM.sortedSessions.isEmpty {
                        if !appVM.relay.isConnected || !appVM.relay.serverOnline || sessionsVM.isLoading {
                            connectingState
                        } else {
                            emptyState
                        }
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
                .refreshable {
                    Haptics.success()
                    await sessionsVM.refresh()
                }

                // Bottom bar: settings gear
                bottomBar
            }
            .navigationBarHidden(true)
        }
        .background(backgroundGradient.ignoresSafeArea())
        .onAppear {
            sessionsVM.startAutoRefresh()
            // Mark stagger animation as done after initial load
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                hasAppeared = true
            }
        }
        .onDisappear {
            sessionsVM.stopAutoRefresh()
        }
        .onChange(of: appVM.isDemoMode) { _, newValue in
            sessionsVM.demoMode = newValue
            if newValue {
                sessionsVM.sessions = SessionsViewModel.mockSessions
                sessionsVM.processes = SessionsViewModel.mockProcesses
            } else {
                sessionsVM.sessions = []
                sessionsVM.processes = []
            }
        }
        .sheet(isPresented: $showingAddWorkspace) {
            AddWorkspaceView(sessionsVM: sessionsVM)
        }
    }

    /// Platform from live WebSocket or cached server model
    private var serverPlatform: String? {
        appVM.relay.serverPlatform ?? appVM.selectedServer?.platform
    }

    private var serverNameLabel: some View {
        HStack(spacing: 8) {
            if serverPlatform == "darwin" {
                Image(systemName: "apple.logo")
                    .font(.system(size: 13))
                    .foregroundColor(KTheme.textMuted)
            }
            Text(appVM.selectedServer?.name ?? "Klaudii")
                .font(.system(size: 17, weight: .semibold))
                .foregroundColor(KTheme.textWhite)
            connectionPill
        }
    }

    // MARK: - Background Gradient

    private var backgroundGradient: some View {
        ZStack {
            KTheme.background

            // Subtle radial glow behind the header area
            if colorScheme == .dark {
                RadialGradient(
                    colors: [
                        Color(hex: 0x4ADE80).opacity(0.03),
                        Color.clear,
                    ],
                    center: .top,
                    startRadius: 0,
                    endRadius: 300
                )
            } else {
                RadialGradient(
                    colors: [
                        Color(hex: 0x2563EB).opacity(0.03),
                        Color.clear,
                    ],
                    center: .top,
                    startRadius: 0,
                    endRadius: 300
                )
            }
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack {
            // Invisible spacer matching sort button width for centering
            Color.clear.frame(width: 28, height: 28)

            Spacer()

            // Server name + connection pill, centered
            if appVM.servers.count > 1 {
                Menu {
                    ForEach(appVM.servers) { server in
                        Button {
                            Haptics.light()
                            appVM.switchToServer(server)
                        } label: {
                            Label(
                                server.name,
                                systemImage: server.id == appVM.selectedServer?.id ? "checkmark" : ""
                            )
                        }
                    }
                } label: {
                    serverNameLabel
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundColor(KTheme.textSecondary)
                }
            } else {
                serverNameLabel
            }

            Spacer()

            // Sort menu
            sortMenuButton
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private var sortMenuButton: some View {
        Menu {
            ForEach(SortMode.allCases, id: \.self) { mode in
                Button {
                    Haptics.light()
                    withAnimation(.easeInOut(duration: 0.2)) {
                        sessionsVM.sortMode = mode
                    }
                } label: {
                    Label(mode.rawValue, systemImage: sessionsVM.sortMode == mode ? "checkmark" : "")
                }
            }
        } label: {
            Image(systemName: "arrow.up.arrow.down")
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(KTheme.textSecondary)
                .frame(width: 28, height: 28)
        }
    }

    private var connectionPill: some View {
        HStack(spacing: 4) {
            if appVM.relay.isConnected && appVM.relay.serverOnline {
                PulsingDot(color: KTheme.success)
            } else {
                Circle()
                    .fill(pillColor)
                    .frame(width: 6, height: 6)
            }
            Text(pillText)
                .font(.system(size: KTheme.microSize))
                .foregroundColor(pillColor)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(pillBg)
        .clipShape(Capsule())
    }

    private var pillColor: Color {
        if appVM.relay.isConnected && appVM.relay.serverOnline {
            return KTheme.success
        } else if appVM.relay.isConnected {
            return KTheme.warning
        }
        return KTheme.textSecondary
    }

    private var pillBg: Color {
        if appVM.relay.isConnected && appVM.relay.serverOnline {
            return KTheme.successBg
        } else if appVM.relay.isConnected {
            return KTheme.warningBg
        }
        return KTheme.border
    }

    private var pillText: String {
        if appVM.relay.isConnected && appVM.relay.serverOnline {
            return "connected"
        } else if appVM.relay.isConnected {
            return "server offline"
        }
        return "connecting..."
    }

    // MARK: - Banners

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
            Text("Can't reach relay")
                .font(.system(size: 12))
            Spacer()
            Button("Switch Server") {
                appVM.disconnectServer()
            }
            .font(.system(size: 11, weight: .medium))
            .foregroundColor(KTheme.textPrimary)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(KTheme.border)
            .cornerRadius(4)
        }
        .foregroundColor(KTheme.danger)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(KTheme.dangerBg)
    }

    // MARK: - Bottom Bar

    private var bottomBar: some View {
        HStack {
            // Add workspace
            Button {
                Haptics.light()
                showingAddWorkspace = true
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundColor(KTheme.accent)
            }
            .frame(width: 44)

            Spacer()

            // Settings
            NavigationLink {
                SettingsView(appVM: appVM)
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "gearshape")
                        .font(.system(size: 13))
                    Text("Settings")
                        .font(.system(size: 12))
                }
                .foregroundColor(KTheme.textSecondary)
            }

            Spacer()

            // Refresh
            Button {
                Haptics.light()
                Task { await sessionsVM.refresh() }
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 14))
                    .foregroundColor(KTheme.textSecondary)
            }
            .frame(width: 44)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(KTheme.background)
        .overlay(
            Rectangle()
                .fill(KTheme.border)
                .frame(height: 1),
            alignment: .top
        )
    }

    // MARK: - Loading & Empty States

    private var connectingState: some View {
        VStack(spacing: 12) {
            KLogoSpinner()
            Text("Waking up...")
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(KTheme.textSecondary)
        }
        .padding(.vertical, 40)
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            // K logo mark
            Text("K")
                .font(.system(size: 32, weight: .black, design: .rounded))
                .foregroundStyle(
                    LinearGradient(
                        colors: [Color(hex: 0x86EFAC), Color(hex: 0x4ADE80), Color(hex: 0x22C55E)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .shadow(color: Color(hex: 0x4ADE80).opacity(0.3), radius: 12)

            Text("It's quiet... too quiet")
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(KTheme.textSecondary)

            Text("Tap + to unleash a claude")
                .font(.system(size: 12))
                .foregroundColor(KTheme.textTertiary)
        }
        .padding(.vertical, 40)
    }
}
