import Foundation

struct HistoryEntry: Codable, Identifiable {
    var id: String { sessionId }

    let sessionId: String
    let timestamp: Double
    let display: String

    var date: Date {
        Date(timeIntervalSince1970: timestamp / 1000)
    }

    var timeText: String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
