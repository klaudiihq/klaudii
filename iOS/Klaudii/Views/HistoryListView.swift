import SwiftUI

struct HistoryListView: View {
    let project: String
    @ObservedObject var sessionsVM: SessionsViewModel

    var entries: [HistoryEntry] {
        sessionsVM.expandedHistory[project] ?? []
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Divider()
                .background(KTheme.border)
                .padding(.vertical, 4)

            if entries.isEmpty {
                Text("No history")
                    .font(.system(size: KTheme.captionSize))
                    .foregroundColor(KTheme.textTertiary)
                    .padding(.vertical, 4)
            } else {
                ForEach(entries) { entry in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(entry.display)
                            .font(.system(size: KTheme.captionSize))
                            .foregroundColor(KTheme.textPrimary.opacity(0.8))
                            .lineLimit(1)
                            .truncationMode(.tail)

                        HStack(spacing: 6) {
                            Text(entry.timeText)
                                .font(.system(size: KTheme.microSize))
                                .foregroundColor(KTheme.textMuted)

                            Text(String(entry.sessionId.prefix(12)))
                                .font(.system(size: KTheme.microSize, design: .monospaced))
                                .foregroundColor(KTheme.textTertiary)

                            Spacer()

                            Button {
                                Task {
                                    await sessionsVM.resume(
                                        project: project,
                                        sessionId: entry.sessionId
                                    )
                                }
                            } label: {
                                Text("Resume")
                                    .font(.system(size: KTheme.microSize, weight: .medium))
                                    .foregroundColor(KTheme.accent)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(KTheme.accentBg)
                                    .cornerRadius(4)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.vertical, 4)

                    if entry.id != entries.last?.id {
                        Divider()
                            .background(KTheme.cardBackground)
                    }
                }
            }
        }
        .task {
            if entries.isEmpty {
                await sessionsVM.loadHistory(project: project)
            }
        }
    }
}
