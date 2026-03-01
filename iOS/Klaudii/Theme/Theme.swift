import SwiftUI
import UIKit

// MARK: - UIColor hex convenience

private extension UIColor {
    convenience init(h: UInt32) {
        self.init(
            red: CGFloat((h >> 16) & 0xFF) / 255,
            green: CGFloat((h >> 8) & 0xFF) / 255,
            blue: CGFloat(h & 0xFF) / 255,
            alpha: 1
        )
    }
}

/// Shorthand for a dynamic color that resolves based on dark/light mode.
private func dynamic(dark: UInt32, light: UInt32) -> Color {
    Color(uiColor: UIColor { t in
        t.userInterfaceStyle == .dark ? UIColor(h: dark) : UIColor(h: light)
    })
}

enum KTheme {
    // MARK: - Background
    static let background        = dynamic(dark: 0x0F1117, light: 0xF5F5F7)
    static let cardBackground    = dynamic(dark: 0x1A1D25, light: 0xFFFFFF)
    static let cardBackgroundDeep = dynamic(dark: 0x0D1019, light: 0xF0F0F2)
    static let menuBackground    = dynamic(dark: 0x13151C, light: 0xFFFFFF)
    static let border            = dynamic(dark: 0x2A2D35, light: 0xD1D5DB)
    static let borderHover       = dynamic(dark: 0x3A3D45, light: 0xB0B5BD)

    // MARK: - Text
    static let textPrimary   = dynamic(dark: 0xE0E0E0, light: 0x1A1A1A)
    static let textWhite     = dynamic(dark: 0xFFFFFF, light: 0x000000)
    static let textSecondary = dynamic(dark: 0x888888, light: 0x6B7280)
    static let textTertiary  = dynamic(dark: 0x555555, light: 0x9CA3AF)
    static let textMuted     = dynamic(dark: 0x666666, light: 0x6B7280)
    static let textLink      = dynamic(dark: 0xAAAAAA, light: 0x4B5563)

    // MARK: - Accent
    static let accent      = Color(hex: 0x2563EB) // same in both modes
    static let accentHover = Color(hex: 0x1D4ED8)
    static let accentBg    = dynamic(dark: 0x1E3A5F, light: 0xDBEAFE)

    // MARK: - Status
    static let success       = dynamic(dark: 0x4ADE80, light: 0x16A34A)
    static let successBg     = dynamic(dark: 0x1A3A2A, light: 0xDCFCE7)
    static let successBorder = dynamic(dark: 0x2A5A3A, light: 0xBBF7D0)

    static let warning       = dynamic(dark: 0xFBBF24, light: 0xD97706)
    static let warningBg     = dynamic(dark: 0x3A2A10, light: 0xFEF3C7)
    static let warningBorder = dynamic(dark: 0x5A3A10, light: 0xFDE68A)

    static let danger       = dynamic(dark: 0xF87171, light: 0xDC2626)
    static let dangerBg     = dynamic(dark: 0x3A1A1A, light: 0xFEE2E2)
    static let dangerBorder = dynamic(dark: 0x5A2A2A, light: 0xFECACA)

    static let askBlue   = dynamic(dark: 0x60A5FA, light: 0x2563EB)
    static let askBg     = dynamic(dark: 0x1E3A5F, light: 0xDBEAFE)
    static let askBorder = dynamic(dark: 0x2A4A7F, light: 0xBFDBFE)

    // MARK: - Gradients

    /// Brand gradient for "running" status badges (green glow)
    static let runningGradient = LinearGradient(
        colors: [Color(hex: 0x86EFAC), Color(hex: 0x4ADE80), Color(hex: 0x22C55E)],
        startPoint: .leading,
        endPoint: .trailing
    )

    /// Status gradient for badge backgrounds
    static func statusGradient(_ status: String) -> LinearGradient {
        switch status {
        case "running":
            return runningGradient
        case "exited":
            return LinearGradient(
                colors: [Color(hex: 0xFDE68A), Color(hex: 0xFBBF24), Color(hex: 0xF59E0B)],
                startPoint: .leading,
                endPoint: .trailing
            )
        default:
            return LinearGradient(colors: [textSecondary], startPoint: .leading, endPoint: .trailing)
        }
    }

    /// Accent color for left stripe on cards
    static func statusAccent(_ status: String) -> Color {
        switch status {
        case "running": return success
        case "exited": return warning
        default: return border
        }
    }

    /// Light-mode card shadow (adapts to status)
    static func cardShadow(_ status: String) -> Color {
        switch status {
        case "running": return success.opacity(0.12)
        case "exited": return warning.opacity(0.08)
        default: return Color.black.opacity(0.06)
        }
    }

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
        default: return border
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
        default: return border
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
