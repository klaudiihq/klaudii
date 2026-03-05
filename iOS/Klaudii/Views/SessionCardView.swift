import SwiftUI

struct SessionCardView: View {
    let session: Session
    let process: ProcessInfo?
    @ObservedObject var sessionsVM: SessionsViewModel
    @AppStorage("branchFirst") private var branchFirst = false
    @State private var showHistory = false
    @State private var isPressed = false
    @Environment(\.colorScheme) private var colorScheme

    private var matchingProcess: ProcessInfo? {
        process
    }

    var body: some View {
        HStack(spacing: 0) {
            // Status accent stripe
            RoundedRectangle(cornerRadius: 2)
                .fill(KTheme.statusAccent(session.status))
                .frame(width: 3)
                .padding(.vertical, 4)

            VStack(alignment: .leading, spacing: 6) {
                // Header: name + branch + badges
                HStack(alignment: .top, spacing: 6) {
                    VStack(alignment: .leading, spacing: 2) {
                        // Primary line (big)
                        Text(branchFirst ? session.displayBranch : session.displayName)
                            .font(.system(size: KTheme.bodySize, weight: .semibold))
                            .foregroundColor(KTheme.textWhite)
                            .lineLimit(1)
                            .truncationMode(.tail)

                        // Secondary line (smaller, grayer)
                        let secondary = branchFirst ? session.displayName : session.displayBranch
                        if !secondary.isEmpty {
                            Text(secondary)
                                .font(.system(size: KTheme.captionSize, design: .monospaced))
                                .foregroundColor(KTheme.textMuted)
                                .lineLimit(1)
                        }
                    }

                    Spacer()

                    // Badges
                    HStack(spacing: 4) {
                        // Permission badge (when running)
                        if session.isRunning {
                            Text(session.permissionMode.uppercased())
                                .font(.system(size: KTheme.badgeSize, weight: .medium))
                                .foregroundColor(KTheme.permColor(session.permissionMode))
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1)
                                .background(KTheme.permBg(session.permissionMode))
                                .clipShape(Capsule())
                        }

                        // Status badge with gradient for running
                        if session.isRunning {
                            Text(session.status)
                                .font(.system(size: KTheme.microSize, weight: .medium))
                                .foregroundColor(.white)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(KTheme.statusGradient(session.status))
                                .clipShape(Capsule())
                        } else {
                            Text(session.status)
                                .font(.system(size: KTheme.microSize))
                                .foregroundColor(KTheme.statusColor(session.status))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(KTheme.statusBg(session.status))
                                .clipShape(Capsule())
                        }
                    }
                }

                // Git status (playful copy)
                if let git = session.git {
                    HStack(spacing: 8) {
                        if let dirty = git.dirtyFiles, dirty > 0 {
                            Text("\(dirty) file\(dirty == 1 ? "" : "s") touched")
                                .font(.system(size: KTheme.captionSize))
                                .foregroundColor(KTheme.warning)
                        } else {
                            Text(cleanPhrase(for: session.project))
                                .font(.system(size: KTheme.captionSize))
                                .foregroundColor(KTheme.success)
                        }

                        if let unpushed = git.unpushed, unpushed > 0 {
                            Text("\(unpushed) unpushed")
                                .font(.system(size: KTheme.captionSize))
                                .foregroundColor(KTheme.danger)
                        }

                        Spacer()
                    }
                }

                // Process stats
                if let proc = matchingProcess {
                    HStack(spacing: 8) {
                        if let cpu = proc.cpu {
                            Label(String(format: "%.0f%%", cpu), systemImage: "cpu")
                                .font(.system(size: KTheme.captionSize))
                                .foregroundColor(KTheme.textMuted)
                        }
                        if let mem = proc.memMB {
                            Label(String(format: "%.0f MB", mem), systemImage: "memorychip")
                                .font(.system(size: KTheme.captionSize))
                                .foregroundColor(KTheme.textMuted)
                        }
                        if let uptime = proc.uptime {
                            Label(uptime, systemImage: "clock")
                                .font(.system(size: KTheme.captionSize))
                                .foregroundColor(KTheme.textMuted)
                        }
                    }
                    .labelStyle(.titleAndIcon)
                }

                // Permission toggle (when stopped)
                if session.isStopped {
                    PermissionToggle(
                        current: session.permissionMode,
                        onChange: { mode in
                            Haptics.light()
                            Task { await sessionsVM.setPermission(project: session.project, mode: mode) }
                        }
                    )
                }

                // Action row: chat button (always visible)
                HStack(spacing: 0) {
                    NavigationLink(value: session) {
                        HStack(spacing: 4) {
                            Image(systemName: "bubble.left.and.bubble.right")
                                .font(.system(size: 11))
                            Text("Chat")
                                .font(.system(size: KTheme.captionSize, weight: .medium))
                        }
                        .foregroundColor(KTheme.accent)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(KTheme.successBg)
                        .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)

                    Spacer()
                }
                .padding(.top, 2)

                // History section (expandable)
                if showHistory {
                    HistoryListView(
                        project: session.project,
                        sessionsVM: sessionsVM
                    )
                }
            }
            .padding(KTheme.cardPadding)
        }
        .background(KTheme.cardBackground)
        .cornerRadius(KTheme.cardRadius)
        .overlay(
            RoundedRectangle(cornerRadius: KTheme.cardRadius)
                .stroke(KTheme.border, lineWidth: 1)
        )
        .shadow(
            color: colorScheme == .light ? KTheme.cardShadow(session.status) : .clear,
            radius: 6, x: 0, y: 2
        )
        .scaleEffect(isPressed ? 0.98 : 1.0)
        .animation(.spring(response: 0.25, dampingFraction: 0.7), value: isPressed)
        .contentShape(Rectangle())
        .onTapGesture {
            handleTap()
        }
        .onLongPressGesture(minimumDuration: .infinity, pressing: { pressing in
            isPressed = pressing
        }, perform: {})
        .contextMenu {
            contextMenuItems
        }
    }

    // MARK: - Clean Phrases

    private static let cleanPhrases = [
        "squeaky clean",
        "pristine",
        "untouched",
        "clean as a whistle",
        "spotless",
        "mint condition",
        "not a scratch",
        "fresh",
        "zero diff",
        "nothing to see here",
        "all clear",
        "clean slate",
        "immaculate",
        "tidy",
        "ship-shape",
    ]

    /// Stable phrase per project — consistent across refreshes
    private func cleanPhrase(for project: String) -> String {
        let hash = project.utf8.reduce(0) { $0 &+ Int($1) }
        return Self.cleanPhrases[abs(hash) % Self.cleanPhrases.count]
    }

    // MARK: - Actions

    private func handleTap() {
        Haptics.light()
        if session.isRunning, let url = session.claudeUrl {
            sessionsVM.openClaudeUrl(url)
        } else if session.isStopped {
            Task { await sessionsVM.start(project: session.project) }
        }
    }

    @ViewBuilder
    private var contextMenuItems: some View {
        if session.isStopped {
            Button {
                Task { await sessionsVM.start(project: session.project) }
            } label: {
                Label("Start", systemImage: "play.fill")
            }

            Button {
                Task { await sessionsVM.continueSession(project: session.project) }
            } label: {
                Label("Continue", systemImage: "play.circle")
            }
        }

        if session.isRunning {
            if let url = session.claudeUrl {
                Button {
                    sessionsVM.openClaudeUrl(url)
                } label: {
                    Label("Open in Claude", systemImage: "arrow.up.forward.app")
                }
            }

            Button {
                Task { await sessionsVM.stop(project: session.project) }
            } label: {
                Label("Stop", systemImage: "stop.fill")
            }

            Button {
                Task { await sessionsVM.restart(project: session.project) }
            } label: {
                Label("Restart", systemImage: "arrow.clockwise")
            }
        }

        if session.isExited {
            Button {
                Task { await sessionsVM.continueSession(project: session.project) }
            } label: {
                Label("Continue", systemImage: "play.circle")
            }

            Button {
                Task { await sessionsVM.start(project: session.project) }
            } label: {
                Label("New Session", systemImage: "plus.circle")
            }
        }

        Divider()

        Button {
            showHistory.toggle()
            if showHistory {
                Task { await sessionsVM.loadHistory(project: session.project) }
            }
        } label: {
            Label(showHistory ? "Hide History" : "History", systemImage: "clock.arrow.circlepath")
        }

        if let remoteUrl = session.remoteUrl, let url = URL(string: remoteUrl) {
            Link(destination: url) {
                Label("View on GitHub", systemImage: "safari")
            }
        }

        Divider()

        Button(role: .destructive) {
            Task { await sessionsVM.remove(project: session.project) }
        } label: {
            Label("Remove", systemImage: "trash")
        }
    }
}

// MARK: - Permission Toggle

struct PermissionToggle: View {
    let current: String
    let onChange: (String) -> Void
    private let modes = ["yolo", "ask", "strict"]

    var body: some View {
        HStack(spacing: 2) {
            ForEach(modes, id: \.self) { mode in
                Button {
                    if mode != current {
                        onChange(mode)
                    }
                } label: {
                    Text(mode)
                        .font(.system(size: KTheme.microSize))
                        .foregroundColor(mode == current ? KTheme.permColor(mode) : KTheme.textTertiary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 3)
                        .background(mode == current ? KTheme.permBg(mode) : Color.clear)
                        .cornerRadius(4)
                        .overlay(
                            RoundedRectangle(cornerRadius: 4)
                                .stroke(
                                    mode == current ? KTheme.permBorder(mode) : KTheme.border,
                                    lineWidth: 1
                                )
                        )
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.top, 2)
    }
}

// MARK: - Haptics

enum Haptics {
    static func light() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred(intensity: 0.5)
    }

    static func success() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }
}

// MARK: - Pulsing Dot

struct PulsingDot: View {
    let color: Color
    @State private var isPulsing = false

    var body: some View {
        ZStack {
            Circle()
                .fill(color.opacity(0.3))
                .frame(width: 12, height: 12)
                .scaleEffect(isPulsing ? 1.8 : 1.0)
                .opacity(isPulsing ? 0 : 0.6)

            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 1.5).repeatForever(autoreverses: false)) {
                isPulsing = true
            }
        }
    }
}

// MARK: - K Logo Spinner

struct KLogoSpinner: View {
    @State private var rotation: Double = 0
    @State private var glowOpacity: Double = 0.4

    var body: some View {
        ZStack {
            // Glow ring
            Circle()
                .stroke(
                    AngularGradient(
                        colors: [
                            Color(hex: 0x86EFAC).opacity(0),
                            Color(hex: 0x4ADE80),
                            Color(hex: 0x22C55E),
                            Color(hex: 0x86EFAC).opacity(0),
                        ],
                        center: .center
                    ),
                    lineWidth: 2
                )
                .frame(width: 36, height: 36)
                .rotationEffect(.degrees(rotation))

            // K letter
            Text("K")
                .font(.system(size: 18, weight: .black, design: .rounded))
                .foregroundStyle(
                    LinearGradient(
                        colors: [Color(hex: 0x86EFAC), Color(hex: 0x4ADE80), Color(hex: 0x22C55E)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .shadow(color: Color(hex: 0x4ADE80).opacity(glowOpacity), radius: 8)
        }
        .onAppear {
            withAnimation(.linear(duration: 1.2).repeatForever(autoreverses: false)) {
                rotation = 360
            }
            withAnimation(.easeInOut(duration: 1.0).repeatForever()) {
                glowOpacity = 0.8
            }
        }
    }
}
