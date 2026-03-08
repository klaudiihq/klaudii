import SwiftUI
import PhotosUI

// MARK: - Chat View

struct ChatView: View {
    @StateObject private var vm: ChatViewModel
    @State private var input = ""
    @State private var selectedPhotos: [PhotosPickerItem] = []
    @State private var showModelPicker = false
    private let bottomId = "chat-bottom"

    let session: Session

    init(session: Session, relay: KloudRelay) {
        self.session = session
        _vm = StateObject(wrappedValue: ChatViewModel(relay: relay, workspace: session.project))
    }

    var body: some View {
        VStack(spacing: 0) {
            // Session bar
            sessionBar

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(vm.messages) { msg in
                            ChatBubbleView(message: msg, vm: vm)
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
                HStack(spacing: 8) {
                    modelPickerButton
                    connectionIndicator
                }
            }
        }
        .sheet(isPresented: $showModelPicker) {
            modelPickerSheet
        }
        .background(KTheme.background.ignoresSafeArea())
        .onDisappear { vm.disconnect() }
    }

    // MARK: - Session Bar

    private var sessionBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(1...vm.sessionCount, id: \.self) { num in
                    Button {
                        Haptics.light()
                        vm.switchSession(num)
                    } label: {
                        Text("Chat \(num)")
                            .font(.system(size: 11, weight: vm.currentSession == num ? .semibold : .regular))
                            .foregroundColor(vm.currentSession == num ? KTheme.accent : KTheme.textTertiary)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 4)
                            .background(vm.currentSession == num ? KTheme.accentBg : Color.clear)
                            .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }

                Button {
                    Haptics.light()
                    vm.newSession()
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(KTheme.textTertiary)
                        .frame(width: 22, height: 22)
                        .background(KTheme.cardBackground)
                        .clipShape(Circle())
                        .overlay(Circle().stroke(KTheme.border, lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
        }
        .background(KTheme.background)
        .overlay(Rectangle().fill(KTheme.border).frame(height: 1), alignment: .bottom)
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

    // MARK: - Model Picker

    private var modelPickerButton: some View {
        Button {
            showModelPicker = true
        } label: {
            HStack(spacing: 3) {
                Image(systemName: "cpu")
                    .font(.system(size: 10))
                Text(modelDisplayName)
                    .font(.system(size: 10, weight: .medium))
                    .lineLimit(1)
            }
            .foregroundColor(KTheme.textSecondary)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(KTheme.cardBackground)
            .clipShape(Capsule())
            .overlay(Capsule().stroke(KTheme.border, lineWidth: 1))
        }
    }

    private var modelDisplayName: String {
        if vm.selectedModel.isEmpty { return "Auto" }
        return vm.availableModels.first(where: { $0.id == vm.selectedModel })?.name ?? vm.selectedModel
    }

    private var modelPickerSheet: some View {
        NavigationView {
            List {
                if vm.launchMode.cli != "claude" {
                    Button {
                        vm.setModel("")
                        showModelPicker = false
                    } label: {
                        HStack {
                            Text("Auto")
                                .foregroundColor(KTheme.textPrimary)
                            Spacer()
                            if vm.selectedModel.isEmpty {
                                Image(systemName: "checkmark")
                                    .foregroundColor(KTheme.accent)
                            }
                        }
                    }
                }

                ForEach(vm.availableModels) { model in
                    Button {
                        vm.setModel(model.id)
                        showModelPicker = false
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(model.name)
                                    .foregroundColor(KTheme.textPrimary)
                                Text(model.id)
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundColor(KTheme.textTertiary)
                            }
                            Spacer()
                            if vm.selectedModel == model.id {
                                Image(systemName: "checkmark")
                                    .foregroundColor(KTheme.accent)
                            }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") { showModelPicker = false }
                }
            }
        }
        .presentationDetents([.medium])
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
        VStack(spacing: 0) {
            // Image preview strip
            if !vm.pendingImages.isEmpty {
                imageStrip
            }

            HStack(alignment: .bottom, spacing: 8) {
                // Attach image button
                PhotosPicker(selection: $selectedPhotos, maxSelectionCount: 5, matching: .images) {
                    Image(systemName: "paperclip")
                        .font(.system(size: 15))
                        .foregroundColor(vm.pendingImages.isEmpty ? KTheme.textTertiary : KTheme.accent)
                        .frame(width: 34, height: 34)
                }
                .onChange(of: selectedPhotos) { _, newItems in
                    for item in newItems {
                        vm.loadPhotoPickerItem(item)
                    }
                    selectedPhotos = []
                }

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
        }
        .background(KTheme.background)
        .overlay(Rectangle().fill(KTheme.border).frame(height: 1), alignment: .top)
    }

    // MARK: - Image Strip

    private var imageStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(vm.pendingImages, id: \.id) { img in
                    ZStack(alignment: .topTrailing) {
                        if let uiImage = imageFromDataUrl(img.dataUrl) {
                            Image(uiImage: uiImage)
                                .resizable()
                                .aspectRatio(contentMode: .fill)
                                .frame(width: 56, height: 56)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                        } else {
                            RoundedRectangle(cornerRadius: 8)
                                .fill(KTheme.cardBackground)
                                .frame(width: 56, height: 56)
                                .overlay(
                                    Image(systemName: "photo")
                                        .font(.system(size: 16))
                                        .foregroundColor(KTheme.textTertiary)
                                )
                        }

                        Button {
                            vm.removeImage(id: img.id)
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 16))
                                .foregroundColor(.white)
                                .background(Circle().fill(Color.black.opacity(0.6)).frame(width: 14, height: 14))
                        }
                        .offset(x: 4, y: -4)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
        }
    }

    private func imageFromDataUrl(_ dataUrl: String) -> UIImage? {
        guard let commaIndex = dataUrl.firstIndex(of: ",") else { return nil }
        let base64 = String(dataUrl[dataUrl.index(after: commaIndex)...])
        guard let data = Data(base64Encoded: base64) else { return nil }
        return UIImage(data: data)
    }

    private var canSend: Bool {
        (!input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !vm.pendingImages.isEmpty) && vm.isConnected && !vm.isStreaming
    }

    private func sendIfReady() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (!text.isEmpty || !vm.pendingImages.isEmpty), vm.isConnected, !vm.isStreaming else { return }
        input = ""
        Haptics.light()
        vm.sendMessage(text)
    }
}

// MARK: - Chat Bubble

struct ChatBubbleView: View {
    let message: ChatMessage
    @ObservedObject var vm: ChatViewModel

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
        case .permissionRequest:
            PermissionRequestView(message: message, vm: vm)
                .padding(.leading, 30)
        case .askQuestion:
            AskUserQuestionView(message: message, vm: vm)
                .padding(.leading, 30)
        case .planReview:
            PlanReviewView(message: message, vm: vm)
                .padding(.leading, 30)
        case .thinking:
            ThinkingBlockView(message: message)
                .padding(.leading, 30)
        case .usageResult:
            UsageResultView(message: message)
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
                    MarkdownTextView(text: message.content)

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

// MARK: - Markdown Text View

struct MarkdownTextView: View {
    let text: String

    var body: some View {
        if let attributed = try? AttributedString(markdown: text,
                                                   options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            Text(attributed)
                .font(.system(size: 15))
                .foregroundColor(KTheme.textWhite)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            Text(text)
                .font(.system(size: 15))
                .foregroundColor(KTheme.textWhite)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

// MARK: - Permission Request View

struct PermissionRequestView: View {
    let message: ChatMessage
    @ObservedObject var vm: ChatViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Header
            HStack(spacing: 6) {
                Image(systemName: "lock.shield")
                    .font(.system(size: 12))
                    .foregroundColor(KTheme.warning)
                Text("Permission Required")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(KTheme.warning)
            }

            // Tool name
            if let toolName = message.permissionToolName {
                Text(toolName)
                    .font(.system(size: 13, weight: .medium, design: .monospaced))
                    .foregroundColor(KTheme.textPrimary)
            }

            // Description
            if let desc = message.permissionDescription, !desc.isEmpty {
                Text(desc)
                    .font(.system(size: 12))
                    .foregroundColor(KTheme.textSecondary)
            }

            // Parameters (collapsible)
            if let params = message.toolParameters, !params.isEmpty {
                DisclosureGroup {
                    Text(params)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(KTheme.textMuted)
                        .textSelection(.enabled)
                        .padding(6)
                } label: {
                    Text("Parameters")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(KTheme.textTertiary)
                }
            }

            // Action buttons
            if message.permissionResolved {
                resolvedBadge
            } else {
                actionButtons
            }
        }
        .padding(12)
        .background(KTheme.warningBg)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(KTheme.warningBorder, lineWidth: 1)
        )
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var actionButtons: some View {
        HStack(spacing: 8) {
            Button {
                Haptics.light()
                vm.approvePermission(requestId: message.requestId ?? "")
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "checkmark")
                        .font(.system(size: 10, weight: .bold))
                    Text("Allow")
                        .font(.system(size: 12, weight: .semibold))
                }
                .foregroundColor(.white)
                .padding(.horizontal, 14)
                .padding(.vertical, 6)
                .background(KTheme.success)
                .clipShape(Capsule())
            }

            Button {
                Haptics.light()
                vm.denyPermission(requestId: message.requestId ?? "")
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .bold))
                    Text("Deny")
                        .font(.system(size: 12, weight: .semibold))
                }
                .foregroundColor(KTheme.danger)
                .padding(.horizontal, 14)
                .padding(.vertical, 6)
                .background(KTheme.dangerBg)
                .clipShape(Capsule())
                .overlay(Capsule().stroke(KTheme.dangerBorder, lineWidth: 1))
            }
        }
    }

    private var resolvedBadge: some View {
        HStack(spacing: 4) {
            Image(systemName: message.permissionBehavior == "allow" ? "checkmark.circle.fill" : "xmark.circle.fill")
                .font(.system(size: 11))
            Text(message.permissionBehavior == "allow" ? "Allowed" : "Denied")
                .font(.system(size: 11, weight: .medium))
        }
        .foregroundColor(message.permissionBehavior == "allow" ? KTheme.success : KTheme.danger)
    }
}

// MARK: - Ask User Question View

struct AskUserQuestionView: View {
    let message: ChatMessage
    @ObservedObject var vm: ChatViewModel
    @State private var selections: [String: String] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Header
            HStack(spacing: 6) {
                Image(systemName: "questionmark.circle")
                    .font(.system(size: 12))
                    .foregroundColor(KTheme.askBlue)
                Text("Claude is asking")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(KTheme.askBlue)
            }

            if let questions = message.questions {
                ForEach(questions) { q in
                    questionBlock(q)
                }
            }

            // Submit or resolved
            if message.permissionResolved {
                resolvedBadge
            } else if let questions = message.questions, !questions.isEmpty {
                submitButton(questions: questions)
            }
        }
        .padding(12)
        .background(KTheme.askBg)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(KTheme.askBorder, lineWidth: 1)
        )
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func questionBlock(_ q: AskQuestion) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(q.question)
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(KTheme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)

            let key = q.header ?? q.question
            ForEach(q.options) { opt in
                optionButton(opt, key: key, isSelected: selections[key] == opt.label)
            }
        }
    }

    private func optionButton(_ opt: AskOption, key: String, isSelected: Bool) -> some View {
        Button {
            guard !message.permissionResolved else { return }
            Haptics.light()
            selections[key] = opt.label
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                        .font(.system(size: 12))
                        .foregroundColor(isSelected ? KTheme.accent : KTheme.textTertiary)

                    Text(opt.label)
                        .font(.system(size: 13, weight: isSelected ? .semibold : .regular))
                        .foregroundColor(KTheme.textPrimary)
                }

                if let desc = opt.description {
                    Text(desc)
                        .font(.system(size: 11))
                        .foregroundColor(KTheme.textSecondary)
                        .padding(.leading, 18)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(isSelected ? KTheme.accentBg : KTheme.cardBackground)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(isSelected ? KTheme.accent.opacity(0.5) : KTheme.border, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .disabled(message.permissionResolved)
    }

    @ViewBuilder
    private func submitButton(questions: [AskQuestion]) -> some View {
        let allAnswered = questions.allSatisfy { q in
            selections[q.header ?? q.question] != nil
        }

        Button {
            Haptics.success()
            vm.answerQuestion(requestId: message.requestId ?? "", answers: selections)
        } label: {
            Text("Submit")
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .background(allAnswered ? KTheme.accent : KTheme.border)
                .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .disabled(!allAnswered)
    }

    private var resolvedBadge: some View {
        HStack(spacing: 4) {
            Image(systemName: message.permissionBehavior == "allow" ? "checkmark.circle.fill" : "xmark.circle.fill")
                .font(.system(size: 11))
            Text(message.permissionBehavior == "allow" ? "Answered" : "Dismissed")
                .font(.system(size: 11, weight: .medium))
        }
        .foregroundColor(message.permissionBehavior == "allow" ? KTheme.success : KTheme.textTertiary)
    }
}

// MARK: - Plan Review View

struct PlanReviewView: View {
    let message: ChatMessage
    @ObservedObject var vm: ChatViewModel
    @State private var expanded = true

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Header
            HStack(spacing: 6) {
                Image(systemName: "doc.text.magnifyingglass")
                    .font(.system(size: 12))
                    .foregroundColor(KTheme.accent)
                Text("Plan Review")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(KTheme.accent)
                Spacer()
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
                } label: {
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 10))
                        .foregroundColor(KTheme.textTertiary)
                }
            }

            if expanded, let plan = message.planContent {
                ScrollView {
                    MarkdownTextView(text: plan)
                        .padding(8)
                }
                .frame(maxHeight: 300)
                .background(KTheme.cardBackgroundDeep)
                .clipShape(RoundedRectangle(cornerRadius: 6))
            }

            // Action buttons
            if message.permissionResolved {
                resolvedBadge
            } else {
                actionButtons
            }
        }
        .padding(12)
        .background(KTheme.accentBg)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(KTheme.accent.opacity(0.3), lineWidth: 1)
        )
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var actionButtons: some View {
        HStack(spacing: 8) {
            Button {
                Haptics.light()
                vm.approvePlan(requestId: message.requestId ?? "",
                               plan: message.planContent ?? "")
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "checkmark")
                        .font(.system(size: 10, weight: .bold))
                    Text("Approve Plan")
                        .font(.system(size: 12, weight: .semibold))
                }
                .foregroundColor(.white)
                .padding(.horizontal, 14)
                .padding(.vertical, 6)
                .background(KTheme.success)
                .clipShape(Capsule())
            }

            Button {
                Haptics.light()
                vm.denyPermission(requestId: message.requestId ?? "")
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .bold))
                    Text("Reject")
                        .font(.system(size: 12, weight: .semibold))
                }
                .foregroundColor(KTheme.danger)
                .padding(.horizontal, 14)
                .padding(.vertical, 6)
                .background(KTheme.dangerBg)
                .clipShape(Capsule())
                .overlay(Capsule().stroke(KTheme.dangerBorder, lineWidth: 1))
            }
        }
    }

    private var resolvedBadge: some View {
        HStack(spacing: 4) {
            Image(systemName: message.permissionBehavior == "allow" ? "checkmark.circle.fill" : "xmark.circle.fill")
                .font(.system(size: 11))
            Text(message.permissionBehavior == "allow" ? "Plan Approved" : "Plan Rejected")
                .font(.system(size: 11, weight: .medium))
        }
        .foregroundColor(message.permissionBehavior == "allow" ? KTheme.success : KTheme.danger)
    }
}

// MARK: - Thinking Block View

struct ThinkingBlockView: View {
    let message: ChatMessage
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    if message.isStreaming {
                        ProgressView()
                            .scaleEffect(0.55)
                            .frame(width: 14, height: 14)
                    } else {
                        Image(systemName: "brain")
                            .font(.system(size: 11))
                            .foregroundColor(KTheme.textTertiary)
                    }

                    Text(message.isStreaming ? "Thinking..." : "Thinking")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(KTheme.textSecondary)

                    Spacer()

                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 10))
                        .foregroundColor(KTheme.textTertiary)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
            }
            .buttonStyle(.plain)

            if expanded, let content = message.thinkingContent, !content.isEmpty {
                Divider().background(KTheme.border)
                Text(content)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(KTheme.textMuted)
                    .textSelection(.enabled)
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
}

// MARK: - Usage Result View

struct UsageResultView: View {
    let message: ChatMessage

    var body: some View {
        if let stats = message.usageStats {
            HStack(spacing: 12) {
                if stats.totalTokens > 0 {
                    statPill(icon: "text.word.spacing", value: formatTokens(stats.totalTokens))
                }
                if let cost = stats.cost {
                    statPill(icon: "dollarsign", value: String(format: "$%.3f", cost))
                }
                if let duration = stats.durationMs {
                    statPill(icon: "clock", value: formatDuration(duration))
                }
                if let turns = stats.turns, turns > 1 {
                    statPill(icon: "arrow.triangle.2.circlepath", value: "\(turns) turns")
                }
            }
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, 4)
        }
    }

    private func statPill(icon: String, value: String) -> some View {
        HStack(spacing: 3) {
            Image(systemName: icon)
                .font(.system(size: 9))
            Text(value)
                .font(.system(size: 10, weight: .medium, design: .monospaced))
        }
        .foregroundColor(KTheme.textTertiary)
    }

    private func formatTokens(_ count: Int) -> String {
        if count >= 1000 {
            return String(format: "%.1fk", Double(count) / 1000.0)
        }
        return "\(count)"
    }

    private func formatDuration(_ ms: Int) -> String {
        if ms >= 60000 {
            return String(format: "%.1fm", Double(ms) / 60000.0)
        }
        return String(format: "%.1fs", Double(ms) / 1000.0)
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

                    // Elapsed time
                    if let elapsed = message.toolElapsedSeconds, message.toolStatus == .pending {
                        Text("\(elapsed)s")
                            .font(.system(size: 10, weight: .medium, design: .monospaced))
                            .foregroundColor(KTheme.textTertiary)
                    } else if let elapsed = message.toolElapsedSeconds, elapsed > 0 {
                        Text("\(elapsed)s")
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundColor(KTheme.textMuted)
                    }

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
                        let truncated = output.count > 600 ? String(output.prefix(600)) + "\n..." : output
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
