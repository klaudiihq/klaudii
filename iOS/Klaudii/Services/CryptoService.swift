import Foundation
import CryptoKit

/// E2E encryption compatible with Klaudii's Node.js (shared/crypto.js) and Web Crypto (cloud.js) implementations.
/// Wire format for `data` field: base64(iv[12] || ciphertext || tag[16])
/// Envelope: { salt: base64(salt[16]), data: base64(iv || ciphertext || tag) }
enum CryptoService {

    struct EncryptedEnvelope: Codable {
        let salt: String   // base64-encoded 16-byte salt
        let data: String   // base64-encoded iv+ciphertext+tag
    }

    /// Encrypt a plaintext string with the connection key.
    /// Returns an envelope with base64-encoded salt and data.
    static func encrypt(_ plaintext: String, connectionKey: Data) throws -> EncryptedEnvelope {
        let salt = randomBytes(16)
        let derivedKey = try deriveKey(sharedSecret: connectionKey, salt: salt)
        let symmetricKey = SymmetricKey(data: derivedKey)

        let nonce = try AES.GCM.Nonce(data: randomBytes(12))
        let sealedBox = try AES.GCM.seal(
            Data(plaintext.utf8),
            using: symmetricKey,
            nonce: nonce
        )

        // Pack as: nonce(12) + ciphertext + tag(16)
        // sealedBox.combined is nonce + ciphertext + tag already
        guard let combined = sealedBox.combined else {
            throw CryptoError.sealFailed
        }

        return EncryptedEnvelope(
            salt: salt.base64EncodedString(),
            data: combined.base64EncodedString()
        )
    }

    /// Decrypt an envelope using the connection key.
    /// Returns the decrypted plaintext string.
    static func decrypt(_ envelope: EncryptedEnvelope, connectionKey: Data) throws -> String {
        guard let salt = Data(base64Encoded: envelope.salt),
              let combined = Data(base64Encoded: envelope.data) else {
            throw CryptoError.invalidBase64
        }

        let derivedKey = try deriveKey(sharedSecret: connectionKey, salt: salt)
        let symmetricKey = SymmetricKey(data: derivedKey)

        // combined is: nonce(12) + ciphertext + tag(16)
        let sealedBox = try AES.GCM.SealedBox(combined: combined)
        let decrypted = try AES.GCM.open(sealedBox, using: symmetricKey)

        guard let text = String(data: decrypted, encoding: .utf8) else {
            throw CryptoError.invalidUTF8
        }
        return text
    }

    /// HKDF-SHA256 key derivation matching Node.js crypto.hkdfSync("sha256", secret, salt, "klaudii-e2e", 32)
    static func deriveKey(sharedSecret: Data, salt: Data) throws -> Data {
        let inputKey = SymmetricKey(data: sharedSecret)
        let info = Data("klaudii-e2e".utf8)

        let derived = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: inputKey,
            salt: salt,
            info: info,
            outputByteCount: 32
        )

        return derived.withUnsafeBytes { Data($0) }
    }

    /// Parse a hex connection key string (with optional dashes) into raw bytes.
    static func connectionKeyFromHex(_ hex: String) -> Data? {
        let clean = hex.replacingOccurrences(of: "-", with: "")
            .replacingOccurrences(of: " ", with: "")
            .lowercased()
        guard clean.count == 64 else { return nil }

        var data = Data(capacity: 32)
        var index = clean.startIndex
        for _ in 0..<32 {
            let next = clean.index(index, offsetBy: 2)
            guard let byte = UInt8(clean[index..<next], radix: 16) else { return nil }
            data.append(byte)
            index = next
        }
        return data
    }

    /// Convert raw connection key to hex with dashes (XXXX-XXXX-...) for display.
    static func connectionKeyToHex(_ key: Data) -> String {
        let hex = key.map { String(format: "%02x", $0) }.joined()
        return hex.enumerated().map { (i, c) in
            (i > 0 && i % 4 == 0) ? "-\(c)" : "\(c)"
        }.joined()
    }

    // MARK: - Private

    private static func randomBytes(_ count: Int) -> Data {
        var bytes = Data(count: count)
        bytes.withUnsafeMutableBytes { ptr in
            _ = SecRandomCopyBytes(kSecRandomDefault, count, ptr.baseAddress!)
        }
        return bytes
    }

    enum CryptoError: Error, LocalizedError {
        case sealFailed
        case invalidBase64
        case invalidUTF8

        var errorDescription: String? {
            switch self {
            case .sealFailed: return "AES-GCM seal failed"
            case .invalidBase64: return "Invalid base64 encoding"
            case .invalidUTF8: return "Decrypted data is not valid UTF-8"
            }
        }
    }
}
