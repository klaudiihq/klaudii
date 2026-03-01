import SwiftUI

struct SessionCardView: View {
    let session: Session
    let process: ProcessInfo?
    @ObservedObject var sessionsVM: SessionsViewModel
    @State private var showHistory = false

    private var matchingProcess: ProcessInfo? {
        process
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Header row: git link + name + badges
            HStack(spacing: 6) {
                // Git repo link
                if let remoteUrl = session.remoteUrl, let url = URL(string: remoteUrl) {
                    Link(destination: url) {
                        Image(systemName: "link")
                            .font(.system(size: 11))
                            .foregroundColor(KTheme.textSecondary)
                    }
                }

                // Project name
                Text(session.project)
                    .font(.system(size: KTheme.bodySize, weight: .semibold))
                    .foregroundColor(KTheme.textWhite)
                    .lineLimit(1)
                    .truncationMode(.tail)

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

                    // Status badge
                    Text(session.status)
                        .font(.system(size: KTheme.microSize))
                        .foregroundColor(KTheme.statusColor(session.status))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(KTheme.statusBg(session.status))
                        .clipShape(Capsule())
                }
            }

            // Git bar
            if let git = session.git {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.triangle.branch")
                        .font(.system(size: 10))
                        .foregroundColor(KTheme.textSecondary)

                    Text(session.displayBranch)
                        .font(.system(size: KTheme.captionSize, design: .monospaced))
                        .foregroundColor(KTheme.textSecondary)
                        .lineLimit(1)

                    Spacer()

                    if let dirty = git.dirtyFiles, dirty > 0 {
                        HStack(spacing: 2) {
                            Image(systemName: "pencil")
                                .font(.system(size: 9))
                            Text("\(dirty)")
                                .font(.system(size: KTheme.captionSize))
                        }
                        .foregroundColor(KTheme.warning)
                    } else {
                        HStack(spacing: 2) {
                            Image(systemName: "checkmark")
                                .font(.system(size: 9))
                            Text("clean")
                                .font(.system(size: KTheme.captionSize))
                        }
                        .foregroundColor(KTheme.success)
                    }

                    if let unpushed = git.unpushed, unpushed > 0 {
                        HStack(spacing: 2) {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 9))
                            Text("\(unpushed)")
                                .font(.system(size: KTheme.captionSize, weight: .medium))
                        }
                        .foregroundColor(KTheme.danger)
                    }
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
                        Task { await sessionsVM.setPermission(project: session.project, mode: mode) }
                    }
                )
            }

            // History section (expandable)
            if showHistory {
                HistoryListView(
                    project: session.project,
                    sessionsVM: sessionsVM
                )
            }
        }
        .padding(KTheme.cardPadding)
        .background(KTheme.cardBackground)
        .cornerRadius(KTheme.cardRadius)
        .overlay(
            RoundedRectangle(cornerRadius: KTheme.cardRadius)
                .stroke(KTheme.border, lineWidth: 1)
        )
        .contentShape(Rectangle())
        .onTapGesture {
            handleTap()
        }
        .contextMenu {
            contextMenuItems
        }
    }

    // MARK: - Actions

    private func handleTap() {
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
