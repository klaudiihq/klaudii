import SwiftUI

enum KTheme {
    // MARK: - Background
    static let background = Color(hex: 0x0F1117)
    static let cardBackground = Color(hex: 0x1A1D25)
    static let cardBackgroundDeep = Color(hex: 0x0D1019)
    static let menuBackground = Color(hex: 0x13151C)
    static let border = Color(hex: 0x2A2D35)
    static let borderHover = Color(hex: 0x3A3D45)

    // MARK: - Text
    static let textPrimary = Color(hex: 0xE0E0E0)
    static let textWhite = Color.white
    static let textSecondary = Color(hex: 0x888888)
    static let textTertiary = Color(hex: 0x555555)
    static let textMuted = Color(hex: 0x666666)
    static let textLink = Color(hex: 0xAAAAAA)

    // MARK: - Accent
    static let accent = Color(hex: 0x2563EB)
    static let accentHover = Color(hex: 0x1D4ED8)
    static let accentBg = Color(hex: 0x1E3A5F)

    // MARK: - Status
    static let success = Color(hex: 0x4ADE80)
    static let successBg = Color(hex: 0x1A3A2A)
    static let successBorder = Color(hex: 0x2A5A3A)

    static let warning = Color(hex: 0xFBBF24)
    static let warningBg = Color(hex: 0x3A2A10)
    static let warningBorder = Color(hex: 0x5A3A10)

    static let danger = Color(hex: 0xF87171)
    static let dangerBg = Color(hex: 0x3A1A1A)
    static let dangerBorder = Color(hex: 0x5A2A2A)

    static let askBlue = Color(hex: 0x60A5FA)
    static let askBg = Color(hex: 0x1E3A5F)
    static let askBorder = Color(hex: 0x2A4A7F)

    // MARK: - Typography
    static let titleSize: CGFloat = 15
    static let bodySize: CGFloat = 13
    static let captionSize: CGFloat = 11
    static let microSize: CGFloat = 10
    static let badgeSize: CGFloat = 9

    // MARK: - Spacing
    static let cardPadding: CGFloat = 12
    static let cardRadius: CGFloat = 8
    static let badgeRadius: CGFloat = 999
    static let cardSpacing: CGFloat = 6
    static let sectionPadding: CGFloat = 8

    // MARK: - Status Helpers

    static func statusColor(_ status: String) -> Color {
        switch status {
        case "running": return success
        case "exited": return warning
        default: return textSecondary
        }
    }

    static func statusBg(_ status: String) -> Color {
        switch status {
        case "running": return successBg
        case "exited": return warningBg
        default: return Color(hex: 0x2A2D35)
        }
    }

    static func permColor(_ mode: String) -> Color {
        switch mode {
        case "yolo": return success
        case "ask": return askBlue
        case "strict": return warning
        default: return textSecondary
        }
    }

    static func permBg(_ mode: String) -> Color {
        switch mode {
        case "yolo": return successBg
        case "ask": return askBg
        case "strict": return warningBg
        default: return Color(hex: 0x2A2D35)
        }
    }

    static func permBorder(_ mode: String) -> Color {
        switch mode {
        case "yolo": return successBorder
        case "ask": return askBorder
        case "strict": return warningBorder
        default: return borderHover
        }
    }
}

extension Color {
    init(hex: UInt32, opacity: Double = 1.0) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}
