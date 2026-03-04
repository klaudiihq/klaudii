import SwiftUI
import Combine

struct AddServerView: View {
    @ObservedObject var appVM: AppViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var pairingCode = ""
    @State private var remainingSeconds = 0
    @State private var isLoading = true
    @State private var fetchError: String?
    @State private var expiresAt: Date = .distantFuture

    // Timer for the mm:ss countdown
    private let ticker = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    // Polling task — cancelled on dismiss
    @State private var pollTask: Task<Void, Never>?

    var body: some View {
        NavigationStack {
            ZStack {
                KTheme.background.ignoresSafeArea()

                if isLoading {
                    ProgressView()
                        .tint(KTheme.accent)
                } else if let err = fetchError {
                    errorView(err)
                } else {
                    content
                }
            }
            .navigationTitle("Add Server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(KTheme.background, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismissView() }
                        .foregroundColor(KTheme.accent)
                }
            }
        }
        .task { await fetchCode() }
        .onDisappear { pollTask?.cancel() }
        .onReceive(ticker) { _ in
            guard !isLoading, fetchError == nil else { return }
            remainingSeconds = max(0, Int(expiresAt.timeIntervalSinceNow))
            if remainingSeconds == 0 {
                Task { await fetchCode() }
            }
        }
    }

    // MARK: - Main content

    private var content: some View {
        ScrollView {
            VStack(spacing: 28) {
                codeCard
                stepsCard
                downloadCTA
            }
            .padding(20)
        }
    }

    private var codeCard: some View {
        VStack(spacing: 10) {
            Text("Pairing Code")
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(KTheme.textSecondary)
                .tracking(1)
                .textCase(.uppercase)

            Text(pairingCode)
                .font(.system(size: 46, weight: .bold, design: .monospaced))
                .foregroundColor(KTheme.textWhite)
                .kerning(4)
                .monospacedDigit()

            let mm = String(format: "%02d", remainingSeconds / 60)
            let ss = String(format: "%02d", remainingSeconds % 60)
            Text("Refreshes in \(mm):\(ss)")
                .font(.system(size: 12, design: .monospaced))
                .foregroundColor(remainingSeconds < 60 ? KTheme.warning : KTheme.textTertiary)
                .monospacedDigit()
        }
        .padding(.vertical, 28)
        .padding(.horizontal, 20)
        .frame(maxWidth: .infinity)
        .background(KTheme.cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(KTheme.border, lineWidth: 1)
        )
    }

    private var stepsCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("How to connect your Mac")
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(KTheme.textSecondary)

            stepRow(num: 1, text: "Open **Klaudii** on your Mac")
            stepRow(num: 2, text: "Click **Kloud Konnect** in the toolbar")
            stepRow(num: 3, text: "Enter the code above and tap **Pair**")
            stepRow(num: 4, text: "Scan the QR code shown to complete setup")
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(KTheme.cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(KTheme.border, lineWidth: 1)
        )
    }

    private var downloadCTA: some View {
        VStack(spacing: 10) {
            Text("Don't have Klaudii for Mac yet?")
                .font(.system(size: 13))
                .foregroundColor(KTheme.textMuted)

            Link(destination: URL(string: "https://klaudii.com/download")!) {
                HStack(spacing: 8) {
                    Image(systemName: "arrow.down.circle")
                        .font(.system(size: 15))
                    Text("Get Klaudii for Mac")
                        .font(.system(size: 15, weight: .semibold))
                }
                .foregroundColor(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(KTheme.accent)
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
        }
    }

    private func errorView(_ message: String) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 32))
                .foregroundColor(KTheme.warning)

            Text(message)
                .font(.system(size: 14))
                .foregroundColor(KTheme.textSecondary)
                .multilineTextAlignment(.center)

            Button {
                Task { await fetchCode() }
            } label: {
                Text("Try Again")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundColor(.white)
                    .padding(.horizontal, 24)
                    .padding(.vertical, 10)
                    .background(KTheme.accent)
                    .clipShape(Capsule())
            }
        }
        .padding(32)
    }

    private func stepRow(num: Int, text: LocalizedStringKey) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text("\(num)")
                .font(.system(size: 11, weight: .bold))
                .foregroundColor(.white)
                .frame(width: 22, height: 22)
                .background(KTheme.accent)
                .clipShape(Circle())

            Text(text)
                .font(.system(size: 14))
                .foregroundColor(KTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Logic

    private func fetchCode() async {
        isLoading = true
        fetchError = nil
        pollTask?.cancel()

        do {
            let data = try await appVM.authService.authenticatedRequest(
                path: "/api/pairing/create", method: "POST"
            )
            struct Response: Decodable { let code: String; let expiresIn: Int }
            let resp = try JSONDecoder().decode(Response.self, from: data)

            pairingCode = resp.code
            expiresAt = Date().addingTimeInterval(Double(resp.expiresIn))
            remainingSeconds = resp.expiresIn
            isLoading = false

            startPolling()
        } catch {
            fetchError = "Couldn't generate a pairing code.\nCheck your connection and try again."
            isLoading = false
        }
    }

    private func startPolling() {
        let knownIds = Set(appVM.servers.map(\.id))
        pollTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                guard !Task.isCancelled else { return }
                await appVM.loadServers()
                if let newServer = appVM.servers.first(where: { !knownIds.contains($0.id) }) {
                    dismissView()
                    appVM.selectServer(newServer)
                    return
                }
            }
        }
    }

    private func dismissView() {
        pollTask?.cancel()
        dismiss()
    }
}
