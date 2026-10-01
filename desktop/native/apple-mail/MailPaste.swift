import AppKit
import ApplicationServices

struct PasteRequest: Decodable {
    let action: String
    let title: String?
    let html: String?
    let body: String?
}
enum PasteFailure: String, Error { case accessibility, preparation = "preparation-failed" }
enum PasteTrace { static var stage = "permission" }

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}
func elements(_ element: AXUIElement, _ name: String) -> [AXUIElement] {
    attribute(element, name) as? [AXUIElement] ?? []
}
func text(_ element: AXUIElement, _ name: String) -> String {
    attribute(element, name) as? String ?? ""
}
func bodies(_ element: AXUIElement, depth: Int = 0) -> [AXUIElement] {
    guard depth < 24 else { return [] }
    let role = text(element, kAXRoleAttribute)
    if role == "AXTextArea" || role == "AXWebArea" { return [element] }
    return elements(element, kAXChildrenAttribute).flatMap { bodies($0, depth: depth + 1) }
}
func renderedText(_ element: AXUIElement, depth: Int = 0) -> String {
    guard depth < 48 else { return "" }
    let role = text(element, kAXRoleAttribute)
    if role == "AXStaticText" { return text(element, kAXValueAttribute) }
    // List markers and image descriptions are generated presentation, not authored text.
    if role == "AXListMarker" || role == "AXImage" { return "" }
    if role == "AXTable" {
        // AXChildren exposes both rows and columns for the same cells.
        return elements(element, kAXRowsAttribute).map { renderedText($0, depth: depth + 1) }.joined()
    }
    return elements(element, kAXChildrenAttribute).map { renderedText($0, depth: depth + 1) }.joined()
}
func comparable(_ value: String) -> String {
    value.unicodeScalars.filter { !CharacterSet.whitespacesAndNewlines.contains($0) && $0.value != 0xFFFC && $0.value != 0x200B }.map(String.init).joined()
}
func shortcut(_ key: CGKeyCode, pid: pid_t, shift: Bool = false) throws {
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false) else { throw PasteFailure.preparation }
    down.flags = shift ? [.maskCommand, .maskShift] : .maskCommand
    up.flags = down.flags
    down.postToPid(pid)
    up.postToPid(pid)
}
func pause(_ seconds: TimeInterval) { RunLoop.current.run(until: Date(timeIntervalSinceNow: seconds)) }
func identified(_ element: AXUIElement, _ identifier: String, depth: Int = 0) -> AXUIElement? {
    guard depth < 12 else { return nil }
    if text(element, kAXIdentifierAttribute) == identifier { return element }
    for child in elements(element, kAXChildrenAttribute) {
        if let match = identified(child, identifier, depth: depth + 1) { return match }
    }
    return nil
}
func richTextEnabled(_ root: AXUIElement) throws -> Bool {
    guard let bar = attribute(root, kAXMenuBarAttribute), CFGetTypeID(bar) == AXUIElementGetTypeID() else { throw PasteFailure.preparation }
    let menuBar = unsafeBitCast(bar, to: AXUIElement.self)
    guard let format = identified(menuBar, "Mail.menuBar.formatMenu"),
          AXUIElementPerformAction(format, kAXPressAction as CFString) == .success else { throw PasteFailure.preparation }
    defer { _ = AXUIElementPerformAction(format, "AXCancel" as CFString) }
    pause(0.1)
    guard let bold = identified(format, "Mail.menuBar.formatMenu.style.bold"),
          let enabled = attribute(bold, kAXEnabledAttribute) as? Bool else { throw PasteFailure.preparation }
    return enabled
}

func paste(_ request: PasteRequest) throws {
    PasteTrace.stage = "request"
    guard let title = request.title, title.hasPrefix("Cheshi-"),
          let html = request.html, html.utf8.count <= 8_000_000,
          let body = request.body, body.utf8.count <= 2_000_000,
          let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.mail").first else {
        throw PasteFailure.preparation
    }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    PasteTrace.stage = "window"
    AXUIElementSetMessagingTimeout(root, 3)
    var matches: [AXUIElement] = []
    for _ in 0..<30 {
        matches = elements(root, kAXWindowsAttribute).filter { text($0, kAXTitleAttribute) == title }
        if matches.count == 1 { break }
        pause(0.1)
    }
    guard matches.count == 1, let window = matches.first else { throw PasteFailure.preparation }
    PasteTrace.stage = "body"
    var candidates: [AXUIElement] = []
    for _ in 0..<30 {
        candidates = bodies(window)
        if candidates.count == 1 { break }
        pause(0.1)
    }
    guard candidates.count == 1, let bodyElement = candidates.first else { throw PasteFailure.preparation }
    app.activate(options: [.activateIgnoringOtherApps])
    PasteTrace.stage = "focus"
    var ready = false
    // Mail creates a reply window before its initial recipient-field focus settles.
    for _ in 0..<20 {
        _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        _ = AXUIElementSetAttributeValue(bodyElement, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        pause(0.15)
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier,
           let focused = attribute(root, kAXFocusedUIElementAttribute), CFEqual(focused, bodyElement) {
            ready = true; break
        }
    }
    guard ready else { throw PasteFailure.preparation }
    func checkFocus() throws {
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier,
              let focused = attribute(root, kAXFocusedUIElementAttribute), CFEqual(focused, bodyElement),
              text(window, kAXTitleAttribute) == title else { throw PasteFailure.preparation }
    }
    try checkFocus()
    PasteTrace.stage = "format"
    if try !richTextEnabled(root) {
        try checkFocus()
        try shortcut(17, pid: app.processIdentifier, shift: true) // Make this message rich text, without changing preferences.
        pause(0.2)
        guard try richTextEnabled(root) else { throw PasteFailure.preparation }
    }
    try checkFocus()
    PasteTrace.stage = "clipboard"
    let board = NSPasteboard.general
    let previous = (board.pasteboardItems ?? []).map { item in
        item.types.compactMap { type -> (NSPasteboard.PasteboardType, Data)? in
            guard let data = item.data(forType: type) else { return nil }; return (type, data)
        }
    }
    board.clearContents()
    let item = NSPasteboardItem()
    item.setString(html, forType: .html)
    item.setString(body, forType: .string)
    guard board.writeObjects([item]) else { throw PasteFailure.preparation }
    let ownChange = board.changeCount
    defer {
        if board.changeCount == ownChange {
            board.clearContents()
            let items = previous.map { entries -> NSPasteboardItem in
                let item = NSPasteboardItem(); entries.forEach { item.setData($0.1, forType: $0.0) }; return item
            }
            board.writeObjects(items)
        }
    }
    try checkFocus()
    PasteTrace.stage = "select"
    try shortcut(0, pid: app.processIdentifier) // Select all in the verified body only.
    pause(0.1)
    try checkFocus()
    PasteTrace.stage = "paste"
    try shortcut(9, pid: app.processIdentifier)
    // Mail's scripting `content` stays empty/stale for WebKit edits. Verify the
    // actual accessible document while keeping the pasteboard available.
    PasteTrace.stage = "verify"
    let expected = comparable(body)
    guard !expected.isEmpty else { throw PasteFailure.preparation }
    var verified = false
    for _ in 0..<30 {
        pause(0.1)
        try checkFocus()
        if comparable(renderedText(bodyElement)) == expected { verified = true; break }
    }
    guard verified else { throw PasteFailure.preparation }
}

@main struct MailPaste {
    static func main() {
        var response: [String: Any]
        do {
            let data = FileHandle.standardInput.readDataToEndOfFile()
            guard data.count <= 12_000_000 else { throw PasteFailure.preparation }
            let request = try JSONDecoder().decode(PasteRequest.self, from: data)
            guard AXIsProcessTrusted() else { throw PasteFailure.accessibility }
            if request.action == "paste" { try paste(request) }
            else if request.action != "check" { throw PasteFailure.preparation }
            response = ["ok": true]
        } catch {
            response = ["ok": false, "code": (error as? PasteFailure)?.rawValue ?? "preparation-failed", "stage": PasteTrace.stage]
        }
        if let data = try? JSONSerialization.data(withJSONObject: response) {
            FileHandle.standardOutput.write(data)
        }
    }
}
