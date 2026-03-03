import Cocoa
import Foundation

class AppDelegate: NSObject, NSApplicationDelegate {

    var statusItem: NSStatusItem!
    var serverProcess: Process?
    var pollTimer: Timer?
    var serverPort: Int = 9876
    var openItem: NSMenuItem!
    var statusMenuItem: NSMenuItem!

    // Port file written by server.js on startup
    let portFile: String = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let dir  = base.appendingPathComponent("com.klaudii.server")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("port").path
    }()

    // MARK: - Launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildStatusItem()
        launchServer()
        startPolling()
    }

    // MARK: - Status item

    func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        if let button = statusItem.button {
            let kFont  = NSFont.systemFont(ofSize: 16, weight: .bold)
            let iiFont = NSFont.systemFont(ofSize: 13, weight: .bold)
            let str    = NSMutableAttributedString()
            str.append(NSAttributedString(string: "K",  attributes: [.font: kFont,  .kern: -1.5]))
            str.append(NSAttributedString(string: "i",  attributes: [.font: iiFont, .baselineOffset: 1.5, .kern: 0.5]))
            str.append(NSAttributedString(string: "i",  attributes: [.font: iiFont, .baselineOffset: 1.5]))
            button.attributedTitle = str
        }

        let menu = NSMenu()

        statusMenuItem = NSMenuItem(title: "Starting…", action: nil, keyEquivalent: "")
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)

        menu.addItem(.separator())

        openItem = NSMenuItem(title: "Open Dashboard", action: #selector(openDashboard), keyEquivalent: "d")
        openItem.isEnabled = false
        menu.addItem(openItem)

        menu.addItem(.separator())

        menu.addItem(NSMenuItem(title: "Restart Server", action: #selector(restartServer), keyEquivalent: "r"))

        menu.addItem(.separator())

        menu.addItem(NSMenuItem(title: "Quit Klaudii", action: #selector(quit), keyEquivalent: "q"))

        statusItem.menu = menu
    }

    // MARK: - Server lifecycle

    func resolvedPaths() -> (node: String, server: String)? {
        // 1. Bundled inside .app
        if let resources = Bundle.main.resourcePath {
            let node   = "\(resources)/node"
            let server = "\(resources)/server/server.js"
            if FileManager.default.fileExists(atPath: node) &&
               FileManager.default.fileExists(atPath: server) {
                return (node, server)
            }
        }

        // 2. Dev fallback: system node + server.js next to the .app
        let nodeCandidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
        let appDir = (Bundle.main.bundlePath as NSString).deletingLastPathComponent
        let devServer = "\(appDir)/server.js"

        if FileManager.default.fileExists(atPath: devServer) {
            for node in nodeCandidates {
                if FileManager.default.fileExists(atPath: node) {
                    return (node, devServer)
                }
            }
        }

        return nil
    }

    func launchServer() {
        guard let (node, serverJS) = resolvedPaths() else {
            setStatus("server not found")
            return
        }

        // Remove stale port file
        try? FileManager.default.removeItem(atPath: portFile)

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: node)
        proc.arguments     = [serverJS]
        proc.environment   = [
            "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": NSHomeDirectory(),
        ]
        proc.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { self?.setStatus("server stopped") }
        }

        do {
            try proc.run()
            serverProcess = proc
        } catch {
            setStatus("failed to start")
        }
    }

    // MARK: - Port polling

    func startPolling() {
        pollTimer = Timer.scheduledTimer(withTimeInterval: 0.75, repeats: true) { [weak self] _ in
            self?.checkPortFile()
        }
    }

    func checkPortFile() {
        guard let raw = try? String(contentsOfFile: portFile, encoding: .utf8),
              let port = Int(raw.trimmingCharacters(in: .whitespacesAndNewlines)) else { return }

        serverPort = port
        pollTimer?.invalidate()
        pollTimer = nil

        DispatchQueue.main.async {
            self.openItem.isEnabled = true
            self.setStatus("http://localhost:\(port)")
        }
    }

    // MARK: - Menu helpers

    func setStatus(_ text: String) {
        statusMenuItem.title = text
    }

    // MARK: - Actions

    @objc func openDashboard() {
        NSWorkspace.shared.open(URL(string: "http://localhost:\(serverPort)")!)
    }

    @objc func restartServer() {
        pollTimer?.invalidate()
        pollTimer = nil
        serverProcess?.terminate()
        serverProcess = nil
        openItem.isEnabled = false
        setStatus("Restarting…")

        DispatchQueue.global().asyncAfter(deadline: .now() + 1.0) {
            self.launchServer()
            DispatchQueue.main.async { self.startPolling() }
        }
    }

    @objc func quit() {
        serverProcess?.terminate()
        NSApp.terminate(nil)
    }
}

let app      = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
