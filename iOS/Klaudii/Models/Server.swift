import Foundation

struct Server: Codable, Identifiable {
    let id: String
    let name: String
    let online: Bool
    let platform: String?
    let lastSeen: Double?
    let createdAt: Double?

    var lastSeenText: String {
        guard let ts = lastSeen else { return "Never" }
        let date = Date(timeIntervalSince1970: ts)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}

struct AuthUser: Codable {
    let id: String
    let email: String
    let name: String?
}
