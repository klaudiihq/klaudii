import Foundation
import AuthenticationServices

/// Handles authentication with the Klaudii cloud relay.
/// Uses ASWebAuthenticationSession for Google OAuth (system browser, Google-approved).
/// The relay redirects to klaudii://auth/callback?token=X after OAuth completes.
/// We then exchange that one-time token for a session cookie via /auth/token-exchange.
@MainActor
class AuthService: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
    static let relayBaseURL = "https://konnect.klaudii.com"
    static let cookieName = "klaudii_session"

    @Published var user: AuthUser?
    @Published var isAuthenticated = false

    private var sessionCookie: String?

    override init() {
        super.init()
        if let cookie = KeychainService.getSessionCookie() {
            self.sessionCookie = cookie
            self.isAuthenticated = true
        }
    }

    // MARK: - ASWebAuthenticationPresentationContextProviding

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }

    // MARK: - Login

    /// Opens system browser for Google OAuth, then exchanges the one-time token for a session cookie.
    func login() async throws {
        let authURL = URL(string: "\(Self.relayBaseURL)/auth/google?mobile=1")!
        let callbackScheme = "klaudii"

        let callbackURL: URL = try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: authURL, callbackURLScheme: callbackScheme) { url, error in
                if let error = error {
                    if (error as NSError).code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                        continuation.resume(throwing: AuthError.cancelled)
                    } else {
                        continuation.resume(throwing: error)
                    }
                    return
                }
                guard let url = url else {
                    continuation.resume(throwing: AuthError.noCookie)
                    return
                }
                continuation.resume(returning: url)
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = true
            session.start()
        }

        // Extract the one-time token from the callback URL
        guard let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
              let token = components.queryItems?.first(where: { $0.name == "token" })?.value else {
            throw AuthError.noCookie
        }

        // Exchange the token for a session cookie
        try await exchangeToken(token)

        // Fetch user info
        await checkAuth()
    }

    /// Exchange a one-time mobile auth token for a session cookie.
    private func exchangeToken(_ token: String) async throws {
        guard let url = URL(string: "\(Self.relayBaseURL)/auth/token-exchange") else {
            throw AuthError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["token": token])

        let (_, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            throw AuthError.notAuthenticated
        }

        // Extract the session cookie from the Set-Cookie response header
        guard let headerFields = httpResponse.allHeaderFields as? [String: String],
              let responseURL = httpResponse.url else {
            throw AuthError.noCookie
        }

        let cookies = HTTPCookie.cookies(withResponseHeaderFields: headerFields, for: responseURL)
        guard let sessionCookie = cookies.first(where: { $0.name == Self.cookieName }) else {
            throw AuthError.noCookie
        }

        self.sessionCookie = sessionCookie.value
        KeychainService.saveSessionCookie(sessionCookie.value)
        self.isAuthenticated = true
    }

    // MARK: - Auth State

    /// Check if current session is still valid.
    func checkAuth() async {
        guard let cookie = sessionCookie ?? KeychainService.getSessionCookie() else {
            isAuthenticated = false
            return
        }
        self.sessionCookie = cookie

        guard let url = URL(string: "\(Self.relayBaseURL)/auth/me") else { return }
        var request = URLRequest(url: url)
        request.setValue("\(Self.cookieName)=\(cookie)", forHTTPHeaderField: "Cookie")

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 {
                let decoded = try JSONDecoder().decode(AuthUser.self, from: data)
                self.user = decoded
                self.isAuthenticated = true
                KeychainService.saveUserId(decoded.id)
            } else {
                self.isAuthenticated = false
                KeychainService.clearAuth()
            }
        } catch {
            // Keep existing auth state on network errors
        }
    }

    /// Fetch servers for the authenticated user.
    func fetchServers() async throws -> [Server] {
        let data = try await authenticatedRequest(path: "/api/servers")
        return try JSONDecoder().decode([Server].self, from: data)
    }

    func logout() async {
        if let cookie = sessionCookie {
            var request = URLRequest(url: URL(string: "\(Self.relayBaseURL)/auth/logout")!)
            request.httpMethod = "POST"
            request.setValue("\(Self.cookieName)=\(cookie)", forHTTPHeaderField: "Cookie")
            try? await URLSession.shared.data(for: request)
        }
        sessionCookie = nil
        user = nil
        isAuthenticated = false
        KeychainService.clearAuth()
    }

    var cookie: String? { sessionCookie ?? KeychainService.getSessionCookie() }

    // MARK: - Private

    func authenticatedRequest(path: String, method: String = "GET", body: Data? = nil) async throws -> Data {
        guard let cookie = sessionCookie else { throw AuthError.notAuthenticated }
        guard let url = URL(string: "\(Self.relayBaseURL)\(path)") else { throw AuthError.invalidURL }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("\(Self.cookieName)=\(cookie)", forHTTPHeaderField: "Cookie")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body = body { request.httpBody = body }

        let (data, response) = try await URLSession.shared.data(for: request)
        if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 401 {
            await logout()
            throw AuthError.notAuthenticated
        }
        return data
    }

    enum AuthError: Error, LocalizedError {
        case noCookie
        case notAuthenticated
        case invalidURL
        case cancelled

        var errorDescription: String? {
            switch self {
            case .noCookie: return "No session cookie received"
            case .notAuthenticated: return "Not authenticated"
            case .invalidURL: return "Invalid URL"
            case .cancelled: return "Login cancelled"
            }
        }
    }
}
