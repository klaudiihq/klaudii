import SwiftUI

struct ProcessesView: View {
    let processes: [ProcessInfo]
    let onKill: (Int) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("FREE RANGE CLAUDES")
                .font(.system(size: KTheme.captionSize, weight: .medium))
                .foregroundColor(KTheme.textMuted)
                .tracking(0.5)
                .padding(.horizontal, 12)
                .padding(.top, 16)
                .padding(.bottom, 4)

            LazyVStack(spacing: KTheme.cardSpacing) {
                ForEach(processes) { proc in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            HStack(spacing: 4) {
                                Text("PID \(proc.pid)")
                                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                                    .foregroundColor(KTheme.textWhite)

                                if let launchedBy = proc.launchedBy {
                                    Text("from \(launchedBy)")
                                        .font(.system(size: 12))
                                        .foregroundColor(KTheme.textMuted)
                                }
                            }

                            Spacer()

                            Button {
                                onKill(proc.pid)
                            } label: {
                                Text("Kill")
                                    .font(.system(size: KTheme.microSize, weight: .medium))
                                    .foregroundColor(KTheme.danger)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(KTheme.dangerBg)
                                    .cornerRadius(4)
                            }
                            .buttonStyle(.plain)
                        }

                        if let cwd = proc.cwd {
                            Text(cwd)
                                .font(.system(size: KTheme.captionSize))
                                .foregroundColor(KTheme.textTertiary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }

                        HStack(spacing: 8) {
                            if let cpu = proc.cpu {
                                Text(String(format: "%.0f%% CPU", cpu))
                                    .font(.system(size: KTheme.captionSize))
                                    .foregroundColor(KTheme.textSecondary)
                            }
                            if let mem = proc.memMB {
                                Text(String(format: "%.0f MB", mem))
                                    .font(.system(size: KTheme.captionSize))
                                    .foregroundColor(KTheme.textSecondary)
                            }
                            if let uptime = proc.uptime {
                                Text(uptime)
                                    .font(.system(size: KTheme.captionSize))
                                    .foregroundColor(KTheme.textSecondary)
                            }
                        }
                    }
                    .padding(KTheme.cardPadding)
                    .background(KTheme.cardBackground)
                    .cornerRadius(KTheme.cardRadius)
                    .overlay(
                        RoundedRectangle(cornerRadius: KTheme.cardRadius)
                            .stroke(KTheme.border, lineWidth: 1)
                    )
                }
            }
            .padding(.horizontal, KTheme.sectionPadding)
        }
    }
}
