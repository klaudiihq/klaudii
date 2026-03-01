import SwiftUI

struct LoginView: View {
    @ObservedObject var appVM: AppViewModel
    @State private var isLoggingIn = false

    var body: some View {
        ZStack {
            KTheme.background.ignoresSafeArea()

            VStack(spacing: 32) {
                Spacer()

                // Logo
                VStack(spacing: 8) {
                    HStack(spacing: 0) {
                        Text("K")
                            .font(.system(size: 56, weight: .bold, design: .rounded))
                            .foregroundColor(KTheme.success)
                        Text("laudii")
                            .font(.system(size: 56, weight: .bold, design: .rounded))
                            .foregroundColor(KTheme.textWhite)
                    }

                    Text("Manage your Claude sessions")
                        .font(.system(size: 14))
                        .foregroundColor(KTheme.textSecondary)
                }

                Spacer()

                // Sign in button
                VStack(spacing: 12) {
                    Button {
                        isLoggingIn = true
                        Task {
                            await appVM.login()
                            isLoggingIn = false
                        }
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "person.crop.circle.fill")
                                .font(.system(size: 18))
                            Text("Sign in with Google")
                                .font(.system(size: 15, weight: .semibold))
                        }
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(KTheme.accent)
                        .cornerRadius(12)
                    }
                    .disabled(isLoggingIn)
                    .opacity(isLoggingIn ? 0.6 : 1)

                    if let error = appVM.errorMessage {
                        Text(error)
                            .font(.system(size: 12))
                            .foregroundColor(KTheme.danger)
                            .multilineTextAlignment(.center)
                    }
                }
                .padding(.horizontal, 32)

                Spacer()

                Text("Konnects via kloud relay with E2E encryption")
                    .font(.system(size: 11))
                    .foregroundColor(KTheme.textTertiary)
                    .padding(.bottom, 16)
            }
        }
    }
}
