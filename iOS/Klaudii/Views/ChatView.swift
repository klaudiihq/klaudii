import SwiftUI

// MARK: - Chat View

struct ChatView: View {
    @StateObject private var vm: ChatViewModel
    @State private var input = ""
    private let bottomId = "chat-bottom"

    let session: Session

    init(session: Session, relay: KloudRelay) {
        self.session = session
        _vm = StateObject(wrappedValue: ChatViewModel(relay: relay, workspace: session.project))
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(vm.messages) { msg in
                            ChatBubbleView(message: msg)
                        }
                        Color.clear.frame(height: 1).id(bottomId)
                    }
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
                    .padding(.bottom, 4)
                }
                .onAppear {
                    proxy.scrollTo(bottomId, anchor: .bottom)
                }
                .onChange(of: vm.messages.count) { _, _ in
                    withAnimation(.easeOut(duration: 0.15)) {
                        proxy.scrollTo(bottomId, anchor: .bottom)
                    }
                }
            }

            if let err = vm.connectionError {
                Text(err)
                    .font(.system(size: 11))
                    .foregroundColor(KTheme.danger)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 4)
            }

            inputBar
        }
        .navigationTitle(session.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                modePicker
            }
            ToolbarItem(placement: .navigationBarTrailing) {
                connectionIndicator
            }
        }
        .background(KTheme.background.ignoresSafeArea())
        .onDisappear { vm.disconnect() }
    }

    // MARK: - Mode Picker

    private var modePicker: some View {
        HStack(spacing: 2) {
            ForEach(LaunchMode.allCases, id: \.self) { mode in
                Button {
                    guard !vm.isStreaming else { return }
                    Haptics.light()
                    vm.setMode(mode)
                } label: {
                    Text(mode.displayName)
                        .font(.system(size: 11, weight: vm.launchMode == mode ? .semibold : .regular))
                        .foregroundColor(vm.launchMode == mode ? modeAccent(mode) : KTheme.textTertiary)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(vm.launchMode == mode ? modeAccentBg(mode) : Color.clear)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
                .disabled(vm.isStreaming)
            }
        }
        .padding(3)
        .background(KTheme.cardBackground)
        .clipShape(Capsule())
        .overlay(Capsule().stroke(KTheme.border, lineWidth: 1))
        .opacity(vm.isStreaming ? 0.5 : 1)
    }

    private func modeAccent(_ mode: LaunchMode) -> Color {
        switch mode {
        case .claude:   return KTheme.accent
        case .claudeRC: return KTheme.warning
        case .gemini:   return Color(hex: 0x60A5FA)
        }
    }

    private func modeAccentBg(_ mode: LaunchMode) -> Color {
        switch mode {
        case .claude:   return KTheme.successBg
        case .claudeRC: return KTheme.warningBg
        case .gemini:   return Color(hex: 0x1E3A5F)
        }
    }

    // MARK: - Connection Indicator

    private var connectionIndicator: some View {
        Group {
            if vm.isConnected {
                PulsingDot(color: KTheme.success)
            } else {
                ProgressView()
                    .scaleEffect(0.7)
                    .frame(width: 16, height: 16)
            }
        }
    }

    // MARK: - Input Bar

    private var inputBar: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message", text: $input, axis: .vertical)
                .lineLimit(1...5)
                .font(.system(size: 15))
                .foregroundColor(KTheme.textWhite)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(KTheme.cardBackground)
                .clipShape(RoundedRectangle(cornerRadius: 18))
                .overlay(
                    RoundedRectangle(cornerRadius: 18)
                        .stroke(KTheme.border, lineWidth: 1)
                )
                .onSubmit { sendIfReady() }

            if vm.isStreaming {
                Button(action: { vm.stop() }) {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(.white)
                        .frame(width: 34, height: 34)
                        .background(KTheme.danger)
                        .clipShape(Circle())
                }
            } else {
                Button(action: sendIfReady) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(.white)
                        .frame(width: 34, height: 34)
                        .background(canSend ? KTheme.accent : KTheme.border)
                        .clipShape(Circle())
                }
                .disabled(!canSend)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(KTheme.background)
        .overlay(Rectangle().fill(KTheme.border).frame(height: 1), alignment: .top)
    }

    private var canSend: Bool {
        !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && vm.isConnected && !vm.isStreaming
    }

    private func sendIfReady() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, vm.isConnected, !vm.isStreaming else { return }
        input = ""
        Haptics.light()
        vm.sendMessage(text)
    }
}

// MARK: - Chat Bubble

struct ChatBubbleView: View {
    let message: ChatMessage

    var body: some View {
        switch message.role {
        case .user:
            userBubble
        case .assistant:
            assistantBubble
        case .toolUse:
            ToolPillView(message: message)
                .padding(.leading, 30)
        case .error:
            errorRow
        case .status:
            statusRow
        }
    }

    private var userBubble: some View {
        HStack {
            Spacer(minLength: 60)
            Text(message.content)
                .font(.system(size: 15))
                .foregroundColor(.white)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(KTheme.accent)
                .clipShape(RoundedRectangle(cornerRadius: 16))
        }
    }

    private var assistantBubble: some View {
        HStack(alignment: .top, spacing: 8) {
            Text("K")
                .font(.system(size: 10, weight: .black, design: .rounded))
                .foregroundColor(KTheme.accent)
                .frame(width: 20, height: 20)
                .background(KTheme.successBg)
                .clipShape(Circle())
                .padding(.top, 4)

            if message.content.isEmpty && message.isStreaming {
                ThinkingDotsView()
                    .padding(.top, 12)
                Spacer(minLength: 40)
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    Text(message.content)
                        .font(.system(size: 15))
                        .foregroundColor(KTheme.textWhite)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)

                    if message.isStreaming {
                        ThinkingDotsView()
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(KTheme.cardBackground)
                .clipShape(RoundedRectangle(cornerRadius: 16))

                Spacer(minLength: 40)
            }
        }
    }

    private var errorRow: some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 11))
            Text(message.content)
                .font(.system(size: 12))
        }
        .foregroundColor(KTheme.danger)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(KTheme.dangerBg)
        .cornerRadius(8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var statusRow: some View {
        Text(message.content)
            .font(.system(size: 11))
            .foregroundColor(KTheme.textTertiary)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, 2)
    }
}

// MARK: - Tool Pill

struct ToolPillView: View {
    let message: ChatMessage
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    toolStatusIcon
                        .frame(width: 14, height: 14)

                    Text(message.content)
                        .font(.system(size: 12, weight: .medium, design: .monospaced))
                        .foregroundColor(KTheme.textSecondary)
                        .lineLimit(1)

                    Spacer()

                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 10))
                        .foregroundColor(KTheme.textTertiary)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
            }
            .buttonStyle(.plain)

            if expanded {
                Divider()
                    .background(KTheme.border)

                VStack(alignment: .leading, spacing: 6) {
                    if let params = message.toolParameters, !params.isEmpty {
                        Text(params)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundColor(KTheme.textMuted)
                            .textSelection(.enabled)
                    }

                    if let output = message.toolOutput, !output.isEmpty {
                        Divider().background(KTheme.border)
                        let truncated = output.count > 600 ? String(output.prefix(600)) + "\n…" : output
                        Text(truncated)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundColor(KTheme.textTertiary)
                            .textSelection(.enabled)
                    }
                }
                .padding(10)
            }
        }
        .background(KTheme.cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(KTheme.border, lineWidth: 1)
        )
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var toolStatusIcon: some View {
        switch message.toolStatus {
        case .pending:
            ProgressView()
                .scaleEffect(0.55)
        case .success:
            Image(systemName: "checkmark")
                .font(.system(size: 9, weight: .bold))
                .foregroundColor(KTheme.success)
        case .failure:
            Image(systemName: "xmark")
                .font(.system(size: 9, weight: .bold))
                .foregroundColor(KTheme.danger)
        case .none:
            EmptyView()
        }
    }
}

// MARK: - Thinking Dots

struct ThinkingDotsView: View {
    @State private var phase: Double = 0

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .fill(KTheme.textMuted)
                    .frame(width: 5, height: 5)
                    .opacity(dotOpacity(index: i))
            }
        }
        .onAppear {
            withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) {
                phase = 1
            }
        }
    }

    private func dotOpacity(index: Int) -> Double {
        let offset = Double(index) / 3.0
        let raw = sin((phase - offset) * .pi * 2)
        return 0.3 + 0.7 * max(0, raw)
    }
}
