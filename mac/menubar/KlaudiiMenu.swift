import Cocoa

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    let dashboardURL = "http://localhost:9876"

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        if let button = statusItem.button {
            let kFont = NSFont.systemFont(ofSize: 16, weight: .bold)
            let iiFont = NSFont.systemFont(ofSize: 13, weight: .bold)

            let str = NSMutableAttributedString()

            // K
            str.append(NSAttributedString(string: "K", attributes: [
                .font: kFont,
                .kern: -1.5,  // tight leading to first i
            ]))

            // first i — raise to center against K
            str.append(NSAttributedString(string: "i", attributes: [
                .font: iiFont,
                .baselineOffset: 1.5,
                .kern: 0.5,  // normal spacing to second i
            ]))

            // second i
            str.append(NSAttributedString(string: "i", attributes: [
                .font: iiFont,
                .baselineOffset: 1.5,
            ]))

            button.attributedTitle = str
        }

        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Open Dashboard", action: #selector(openDashboard), keyEquivalent: "d"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q"))

        statusItem.menu = menu
    }

    @objc func openDashboard() {
        if let url = URL(string: dashboardURL) {
            NSWorkspace.shared.open(url)
        }
    }

    @objc func quit() {
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
