import SwiftUI

struct AddWorkspaceView: View {
    @ObservedObject var sessionsVM: SessionsViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var step: Step = .repo
    @State private var repos: [GitHubRepo] = []
    @State private var searchText = ""
    @State private var selectedRepo: GitHubRepo?
    @State private var branchName = ""
    @State private var isLoading = false
    @State private var errorMessage: String?

    // New repo fields
    @State private var newRepoName = ""
    @State private var newRepoRemote = ""

    enum Step {
        case repo
        case newRepo
        case branch
    }

    var filteredRepos: [GitHubRepo] {
        if searchText.isEmpty { return repos }
        return repos.filter { $0.name.localizedCaseInsensitiveContains(searchText) }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                KTheme.background.ignoresSafeArea()

                ScrollView {
                    VStack(spacing: 16) {
                        switch step {
                        case .repo:
                            repoStep
                        case .newRepo:
                            newRepoStep
                        case .branch:
                            branchStep
                        }

                        if let error = errorMessage {
                            Text(error)
                                .font(.system(size: 12))
                                .foregroundColor(KTheme.danger)
                                .padding(.horizontal)
                        }
                    }
                    .padding(.top, 16)
                }
            }
            .navigationTitle("Add Workspace")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(KTheme.background, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                        .foregroundColor(KTheme.accent)
                }
            }
        }
        .task {
            await loadRepos()
        }
    }

    // MARK: - Step 1: Select Repo

    private var repoStep: some View {
        VStack(spacing: 12) {
            // Search
            TextField("Search repos...", text: $searchText)
                .font(.system(size: 14))
                .foregroundColor(KTheme.textPrimary)
                .padding(10)
                .background(KTheme.cardBackgroundDeep)
                .cornerRadius(8)
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(KTheme.border, lineWidth: 1)
                )
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .padding(.horizontal)

            if isLoading {
                ProgressView()
                    .tint(KTheme.textSecondary)
                    .padding(.top, 20)
            } else if filteredRepos.isEmpty {
                Text("No repos found")
                    .font(.system(size: 13))
                    .foregroundColor(KTheme.textTertiary)
                    .padding(.top, 20)
            } else {
                LazyVStack(spacing: 0) {
                    ForEach(filteredRepos) { repo in
                        Button {
                            selectedRepo = repo
                            step = .branch
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: repo.isPrivate ? "lock.fill" : "globe")
                                    .font(.system(size: 12))
                                    .foregroundColor(KTheme.textTertiary)
                                    .frame(width: 16)

                                Text(repo.name)
                                    .font(.system(size: 14))
                                    .foregroundColor(KTheme.textPrimary)
                                    .lineLimit(1)

                                Spacer()

                                if repo.cloned {
                                    Text("cloned")
                                        .font(.system(size: KTheme.microSize))
                                        .foregroundColor(KTheme.success)
                                        .padding(.horizontal, 5)
                                        .padding(.vertical, 1)
                                        .background(KTheme.successBg)
                                        .clipShape(Capsule())
                                }

                                Image(systemName: "chevron.right")
                                    .font(.system(size: 11))
                                    .foregroundColor(KTheme.textTertiary)
                            }
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                        }
                        .buttonStyle(.plain)

                        Divider()
                            .background(KTheme.border)
                    }
                }
                .background(KTheme.cardBackground)
                .cornerRadius(8)
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(KTheme.border, lineWidth: 1)
                )
                .padding(.horizontal)
            }

            // New repo button
            Button {
                step = .newRepo
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "plus")
                        .font(.system(size: 12))
                    Text("New repo")
                        .font(.system(size: 13, weight: .medium))
                }
                .foregroundColor(KTheme.accent)
            }
            .padding(.top, 4)
        }
    }

    // MARK: - Step 1b: New Repo

    private var newRepoStep: some View {
        VStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text("REPO NAME")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(KTheme.textSecondary)
                    .tracking(0.5)

                TextField("my-project", text: $newRepoName)
                    .font(.system(size: 14))
                    .foregroundColor(KTheme.textPrimary)
                    .padding(10)
                    .background(KTheme.cardBackgroundDeep)
                    .cornerRadius(8)
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .stroke(KTheme.border, lineWidth: 1)
                    )
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
            }
            .padding(.horizontal)

            VStack(alignment: .leading, spacing: 6) {
                Text("REMOTE URL (OPTIONAL)")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(KTheme.textSecondary)
                    .tracking(0.5)

                TextField("git@github.com:user/repo.git", text: $newRepoRemote)
                    .font(.system(size: 14))
                    .foregroundColor(KTheme.textPrimary)
                    .padding(10)
                    .background(KTheme.cardBackgroundDeep)
                    .cornerRadius(8)
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .stroke(KTheme.border, lineWidth: 1)
                    )
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
            }
            .padding(.horizontal)

            HStack(spacing: 12) {
                Button("Back") {
                    step = .repo
                }
                .font(.system(size: 14))
                .foregroundColor(KTheme.textSecondary)

                Button {
                    Task { await createNewRepo() }
                } label: {
                    Text("Create")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(newRepoName.isEmpty ? KTheme.accent.opacity(0.4) : KTheme.accent)
                        .cornerRadius(8)
                }
                .disabled(newRepoName.isEmpty || isLoading)
            }
            .padding(.horizontal)
        }
    }

    // MARK: - Step 2: Branch Name

    private var branchStep: some View {
        VStack(spacing: 12) {
            if let repo = selectedRepo {
                HStack(spacing: 6) {
                    Image(systemName: "folder.fill")
                        .font(.system(size: 12))
                        .foregroundColor(KTheme.accent)
                    Text(repo.name)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundColor(KTheme.textPrimary)
                }
                .padding(.horizontal)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("BRANCH NAME")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(KTheme.textSecondary)
                    .tracking(0.5)

                TextField("e.g. fix-auth-bug", text: $branchName)
                    .font(.system(size: 14))
                    .foregroundColor(KTheme.textPrimary)
                    .padding(10)
                    .background(KTheme.cardBackgroundDeep)
                    .cornerRadius(8)
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .stroke(KTheme.border, lineWidth: 1)
                    )
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
            }
            .padding(.horizontal)

            HStack(spacing: 12) {
                Button("Back") {
                    step = .repo
                    branchName = ""
                }
                .font(.system(size: 14))
                .foregroundColor(KTheme.textSecondary)

                Button {
                    Task { await startSession() }
                } label: {
                    HStack(spacing: 6) {
                        if isLoading {
                            ProgressView()
                                .tint(.white)
                                .scaleEffect(0.8)
                        }
                        Text("Start Session")
                            .font(.system(size: 14, weight: .semibold))
                    }
                    .foregroundColor(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(branchName.isEmpty ? KTheme.accent.opacity(0.4) : KTheme.accent)
                    .cornerRadius(8)
                }
                .disabled(branchName.isEmpty || isLoading)
            }
            .padding(.horizontal)
        }
    }

    // MARK: - Actions

    private func loadRepos() async {
        isLoading = true
        errorMessage = nil
        do {
            repos = try await sessionsVM.fetchGitHubRepos()
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func createNewRepo() async {
        isLoading = true
        errorMessage = nil
        do {
            try await sessionsVM.createRepo(
                name: newRepoName,
                remoteUrl: newRepoRemote.isEmpty ? nil : newRepoRemote
            )
            // Select the newly created repo and go to branch step
            selectedRepo = GitHubRepo(name: newRepoName, isPrivate: false, cloned: true)
            step = .branch
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func startSession() async {
        guard let repo = selectedRepo else { return }
        isLoading = true
        errorMessage = nil
        do {
            try await sessionsVM.createNewSession(repo: repo.name, branch: branchName)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}

// MARK: - GitHub Repo Model

struct GitHubRepo: Codable, Identifiable {
    var id: String { name }
    let name: String
    let isPrivate: Bool
    let cloned: Bool

    enum CodingKeys: String, CodingKey {
        case name
        case isPrivate = "private"
        case cloned
    }

    init(name: String, isPrivate: Bool, cloned: Bool) {
        self.name = name
        self.isPrivate = isPrivate
        self.cloned = cloned
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        isPrivate = try container.decodeIfPresent(Bool.self, forKey: .isPrivate) ?? false
        cloned = try container.decodeIfPresent(Bool.self, forKey: .cloned) ?? false
    }
}
