import SwiftUI
import AVFoundation

@MainActor
class PairingViewModel: ObservableObject {
    @Published var manualKey = ""
    @Published var errorMessage: String?
    @Published var isPaired = false
    @Published var isScanning = false

    let server: Server
    private let onPaired: (Data) -> Void

    init(server: Server, onPaired: @escaping (Data) -> Void) {
        self.server = server
        self.onPaired = onPaired
    }

    func submitManualKey() {
        let clean = manualKey
            .replacingOccurrences(of: "-", with: "")
            .replacingOccurrences(of: " ", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        // Check for klaudii:// URL format
        if let range = clean.range(of: #"klaudii://[^/]+/([0-9a-fA-F]{64})"#, options: .regularExpression) {
            let match = String(clean[range])
            if let slashRange = match.lastIndex(of: "/") {
                let hex = String(match[match.index(after: slashRange)...])
                if let keyData = CryptoService.connectionKeyFromHex(hex) {
                    completeWithKey(keyData)
                    return
                }
            }
        }

        // Raw hex key
        guard let keyData = CryptoService.connectionKeyFromHex(clean) else {
            errorMessage = "Invalid key format. Should be 64 hex characters."
            return
        }
        completeWithKey(keyData)
    }

    func handleQRCode(_ code: String) {
        // Expected: klaudii://<serverId>/<connectionKeyHex>
        guard let match = code.range(of: #"klaudii://([^/]+)/([0-9a-fA-F]{64})"#, options: .regularExpression) else {
            errorMessage = "Invalid QR code"
            return
        }

        let matched = String(code[match])
        let parts = matched.replacingOccurrences(of: "klaudii://", with: "").split(separator: "/")
        guard parts.count == 2 else {
            errorMessage = "Invalid QR code format"
            return
        }

        let keyHex = String(parts[1])
        guard let keyData = CryptoService.connectionKeyFromHex(keyHex) else {
            errorMessage = "Invalid key in QR code"
            return
        }
        completeWithKey(keyData)
    }

    private func completeWithKey(_ keyData: Data) {
        isPaired = true
        errorMessage = nil
        onPaired(keyData)
    }
}
