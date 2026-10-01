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
          let bold = identified(format, "Mail.menuBar.formatMenu.style.bold"),
          let enabled = attribute(bold, kAXEnabledAttribute) as? Bool else { throw PasteFailure.preparation }
    return enabled
}

// Mail ignores keyboard events while AppKit considers its window inactive.
// These records change only Mail's input routing, never WindowServer's front
// application or window order. Keep the private protocol behind one boundary.
final class MailBackgroundInput {
    private let windowID: UInt32
    private let post: ([UInt8]) throws -> Void
    private let isFrontmost: () -> Bool
    private var needsRestore = false

    init(windowID: UInt32, post: @escaping ([UInt8]) throws -> Void, isFrontmost: @escaping () -> Bool) {
        self.windowID = windowID
        self.post = post
        self.isFrontmost = isFrontmost
    }

    private func record(type: UInt8, state: UInt8 = 0) -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: 248)
        bytes[4] = 248
        bytes[8] = type
        for index in 0..<4 { bytes[60 + index] = UInt8(truncatingIfNeeded: windowID >> (index * 8)) }
        if type == 13 { bytes[138] = state }
        else {
            bytes[58] = 16
            for index in 32..<48 { bytes[index] = 255 }
        }
        return bytes
    }

    private func restore() throws {
        guard needsRestore else { return }
        needsRestore = false
        // A user may have activated Mail during preparation. Do not deactivate it.
        if !isFrontmost() { try post(record(type: 13, state: 2)) }
    }

    func perform<T>(_ operation: () throws -> T) throws -> T {
        if isFrontmost() { return try operation() }
        do {
            // Treat a failed post as uncertain and restore even after partial setup.
            needsRestore = true
            try post(record(type: 13, state: 1))
            try post(record(type: 1))
            try post(record(type: 2))
            let result = try operation()
            try restore()
            return result
        } catch {
            try? restore()
            throw error
        }
    }
}

func windowFrame(_ window: AXUIElement) -> CGRect? {
    var origin = CGPoint.zero
    var size = CGSize.zero
    guard let position = attribute(window, kAXPositionAttribute), let dimensions = attribute(window, kAXSizeAttribute),
          CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(dimensions) == AXValueGetTypeID(),
          AXValueGetValue(unsafeBitCast(position, to: AXValue.self), .cgPoint, &origin),
          AXValueGetValue(unsafeBitCast(dimensions, to: AXValue.self), .cgSize, &size) else { return nil }
    return CGRect(origin: origin, size: size)
}

func matchingWindowID(_ entries: [[String: Any]], frame: CGRect, title: String, pid: pid_t) -> UInt32? {
    let matches = entries.filter { entry in
        guard entry[kCGWindowOwnerPID as String] as? Int32 == pid,
              entry[kCGWindowLayer as String] as? Int == 0,
              let bounds = entry[kCGWindowBounds as String] as? NSDictionary,
              let rect = CGRect(dictionaryRepresentation: bounds), rect == frame else { return false }
        // Window names may be unavailable without screen-recording permission.
        let name = entry[kCGWindowName as String] as? String ?? ""
        return name.isEmpty || name == title
    }
    guard matches.count == 1, let identifier = matches.first?[kCGWindowNumber as String] as? UInt32,
          identifier != 0 else { return nil }
    return identifier
}

func mailWindowID(_ window: AXUIElement, pid: pid_t) throws -> UInt32 {
    // AX can expose a newly created compose window before WindowServer has
    // published its final bounds. Wait for that same window to settle.
    for _ in 0..<30 {
        if let frame = windowFrame(window) {
            let entries = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
            if let identifier = matchingWindowID(entries, frame: frame, title: text(window, kAXTitleAttribute), pid: pid) {
                return identifier
            }
        }
        pause(0.05)
    }
    throw PasteFailure.preparation
}

func withMailBackgroundInput<T>(_ window: AXUIElement, pid: pid_t, operation: () throws -> T) throws -> T {
    let isFrontmost = { NSWorkspace.shared.frontmostApplication?.processIdentifier == pid }
    if isFrontmost() { return try operation() }
    guard let library = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY | RTLD_LOCAL) else {
        throw PasteFailure.preparation
    }
    defer { dlclose(library) }
    guard let processLibrary = dlopen(nil, RTLD_LAZY) else { throw PasteFailure.preparation }
    defer { dlclose(processLibrary) }
    guard let postSymbol = dlsym(library, "SLPSPostEventRecordTo"),
          let resolveSymbol = dlsym(processLibrary, "GetProcessForPID") else { throw PasteFailure.preparation }
    typealias Resolve = @convention(c) (Int32, UnsafeMutableRawPointer) -> Int32
    typealias Post = @convention(c) (UnsafeMutableRawPointer, UnsafeMutableRawPointer) -> Int32
    let resolve = unsafeBitCast(resolveSymbol, to: Resolve.self)
    let post = unsafeBitCast(postSymbol, to: Post.self)
    // ProcessSerialNumber's two UInt32 fields. Resolve dynamically so absence
    // of this legacy API fails preparation instead of preventing helper startup.
    var processNumber = [UInt32](repeating: 0, count: 2)
    let resolved = processNumber.withUnsafeMutableBytes { resolve(pid, $0.baseAddress!) }
    guard resolved == 0 else { throw PasteFailure.preparation }
    let session = MailBackgroundInput(windowID: try mailWindowID(window, pid: pid), post: { event in
        var bytes = event
        let status = bytes.withUnsafeMutableBytes { record in
            processNumber.withUnsafeMutableBytes { post($0.baseAddress!, record.baseAddress!) }
        }
        guard status == 0 else { throw PasteFailure.preparation }
    }, isFrontmost: isFrontmost)
    return try session.perform(operation)
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
    PasteTrace.stage = "focus"
    let foregroundPID = NSWorkspace.shared.frontmostApplication?.processIdentifier
    try withMailBackgroundInput(window, pid: app.processIdentifier) {
        try pasteDocument(app: app, root: root, window: window, bodyElement: bodyElement,
                          foregroundPID: foregroundPID, title: title, html: html, body: body)
    }
}

func pasteDocument(app: NSRunningApplication, root: AXUIElement, window: AXUIElement,
                   bodyElement: AXUIElement, foregroundPID: pid_t?, title: String, html: String, body: String) throws {
    func targetMatches() -> Bool {
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == foregroundPID,
              let main = attribute(root, kAXMainWindowAttribute), CFEqual(main, window),
              let focusedWindow = attribute(root, kAXFocusedWindowAttribute), CFEqual(focusedWindow, window),
              text(window, kAXTitleAttribute) == title,
              let focused = attribute(root, kAXFocusedUIElementAttribute) else { return false }
        return CFEqual(focused, bodyElement)
    }
    PasteTrace.stage = "focus"
    var ready = false
    // Mail creates a reply window before its initial recipient-field focus settles.
    for _ in 0..<20 {
        let mainSet = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
        let focusSet = AXUIElementSetAttributeValue(bodyElement, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        pause(0.15)
        if mainSet == .success, focusSet == .success, targetMatches() {
            ready = true; break
        }
    }
    guard ready else { throw PasteFailure.preparation }
    func checkFocus() throws {
        guard targetMatches() else { throw PasteFailure.preparation }
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

#if !MAIL_BACKGROUND_INPUT_TESTS
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
#endif
