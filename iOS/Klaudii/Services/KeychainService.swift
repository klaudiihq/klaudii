import Foundation
import Security

enum KeychainService {
    private static let service = "com.klaudii"

    /// Store data for a given key.
    static func set(_ data: Data, forKey key: String) {
        delete(key: key)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        SecItemAdd(query as CFDictionary, nil)
    }

    /// Store a string for a given key.
    static func setString(_ value: String, forKey key: String) {
        if let data = value.data(using: .utf8) {
            set(data, forKey: key)
        }
    }

    /// Retrieve data for a given key.
    static func get(key: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess else { return nil }
        return result as? Data
    }

    /// Retrieve a string for a given key.
    static func getString(key: String) -> String? {
        guard let data = get(key: key) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Delete a key.
    static func delete(key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
    }

    // MARK: - Convenience for connection keys

    static func saveConnectionKey(_ keyData: Data, forServer serverId: String) {
        set(keyData, forKey: "connectionKey-\(serverId)")
    }

    static func getConnectionKey(forServer serverId: String) -> Data? {
        get(key: "connectionKey-\(serverId)")
    }

    static func deleteConnectionKey(forServer serverId: String) {
        delete(key: "connectionKey-\(serverId)")
    }

    // MARK: - Auth session

    static func saveSessionCookie(_ cookie: String) {
        setString(cookie, forKey: "sessionCookie")
    }

    static func getSessionCookie() -> String? {
        getString(key: "sessionCookie")
    }

    static func saveUserId(_ userId: String) {
        setString(userId, forKey: "userId")
    }

    static func getUserId() -> String? {
        getString(key: "userId")
    }

    static func clearAuth() {
        delete(key: "sessionCookie")
        delete(key: "userId")
    }

    // MARK: - Last selected server

    static func saveLastServerId(_ serverId: String) {
        setString(serverId, forKey: "lastServerId")
    }

    static func getLastServerId() -> String? {
        getString(key: "lastServerId")
    }

    static func saveLastServerName(_ name: String) {
        setString(name, forKey: "lastServerName")
    }

    static func getLastServerName() -> String? {
        getString(key: "lastServerName")
    }

    static func saveLastServerPlatform(_ platform: String) {
        setString(platform, forKey: "lastServerPlatform")
    }

    static func getLastServerPlatform() -> String? {
        getString(key: "lastServerPlatform")
    }

    static func clearLastServerId() {
        delete(key: "lastServerId")
        delete(key: "lastServerName")
        delete(key: "lastServerPlatform")
    }
}
