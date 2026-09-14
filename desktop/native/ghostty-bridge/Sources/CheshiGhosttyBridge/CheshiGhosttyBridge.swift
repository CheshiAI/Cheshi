import AppKit
import Foundation
import GhosttyTerminal

public typealias CheshiGhosttyEventCallback = @convention(c) (
  Int32,
  UnsafePointer<CChar>?,
  UnsafePointer<CChar>?
) -> Void

private enum SplitDirection: String {
  case right
  case left
  case down
  case up
}

private enum GhosttyBridgeEvent {
  static let title = "set-title"
  static let bell = "bell"
  static let close = "surface-exit"
  static let focus = "focus"
  static let split = "split-request"
}

private nonisolated(unsafe) var eventCallback: CheshiGhosttyEventCallback?

private func emit(_ surfaceID: Int32, type: String, value: String = "") {
  guard let callback = eventCallback else { return }
  type.withCString { typePointer in
    value.withCString { valuePointer in
      callback(surfaceID, typePointer, valuePointer)
    }
  }
}

private func onMain<T>(_ operation: @escaping @MainActor () -> T) -> T {
  if Thread.isMainThread {
    return MainActor.assumeIsolated(operation)
  }
  return DispatchQueue.main.sync {
    MainActor.assumeIsolated(operation)
  }
}

@MainActor
private func cheshiTerminalAppearance(dark: Bool) -> NSAppearance? {
  NSAppearance(named: dark ? .darkAqua : .aqua)
}

@MainActor
private final class SurfaceDelegate: NSObject,
  TerminalSurfaceTitleDelegate,
  TerminalSurfaceBellDelegate,
  TerminalSurfaceFocusDelegate,
  TerminalSurfaceCloseDelegate
{
  let surfaceID: Int32

  init(surfaceID: Int32) {
    self.surfaceID = surfaceID
  }

  func terminalDidChangeTitle(_ title: String) {
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmed.isEmpty {
      emit(surfaceID, type: GhosttyBridgeEvent.title, value: trimmed)
    }
  }

  func terminalDidRingBell() {
    emit(surfaceID, type: GhosttyBridgeEvent.bell)
  }

  func terminalDidChangeFocus(_ focused: Bool) {
    if focused {
      emit(surfaceID, type: GhosttyBridgeEvent.focus)
    }
  }

  func terminalDidClose(processAlive: Bool) {
    emit(surfaceID, type: GhosttyBridgeEvent.close, value: processAlive ? "alive" : "exited")
  }
}

@MainActor
private final class CheshiTerminalView: TerminalView {
  let surfaceID: Int32

  override var layer: CALayer? {
    didSet {
      makeTerminalLayerTreeTransparent()
    }
  }

  init(frame: NSRect, surfaceID: Int32) {
    self.surfaceID = surfaceID
    super.init(frame: frame)
    makeTerminalLayerTreeTransparent()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func mouseDown(with event: NSEvent) {
    window?.makeFirstResponder(self)
    super.mouseDown(with: event)
  }

  override func layout() {
    super.layout()
    makeTerminalLayerTreeTransparent()
  }

  override func rightMouseDown(with event: NSEvent) {
    window?.makeFirstResponder(self)
    let localPoint = convert(event.locationInWindow, from: nil)
    let terminalPoint = CGPoint(x: localPoint.x, y: bounds.height - localPoint.y)
    let menu: NSMenu

    if selectionMenuPoint(at: terminalPoint) != nil {
      menu = selectionContextMenu()
      menu.addItem(.separator())
    } else {
      menu = NSMenu()
    }

    addSplitItem(title: "Split Pane Right", direction: .right, to: menu)
    addSplitItem(title: "Split Pane Left", direction: .left, to: menu)
    menu.addItem(.separator())
    addSplitItem(title: "Split Pane Down", direction: .down, to: menu)
    addSplitItem(title: "Split Pane Up", direction: .up, to: menu)
    NSMenu.popUpContextMenu(menu, with: event, for: self)
  }

  override func rightMouseUp(with _: NSEvent) {}

  private func makeTerminalLayerTreeTransparent() {
    makeLayerTreeTransparent(layer)
  }

  private func makeLayerTreeTransparent(_ currentLayer: CALayer?) {
    guard let currentLayer else { return }
    currentLayer.isOpaque = false
    currentLayer.backgroundColor = NSColor.clear.cgColor
    currentLayer.sublayers?.forEach(makeLayerTreeTransparent)
  }

  private func addSplitItem(title: String, direction: SplitDirection, to menu: NSMenu) {
    let item = NSMenuItem(title: title, action: #selector(handleSplitMenuItem(_:)), keyEquivalent: "")
    item.target = self
    item.representedObject = direction.rawValue
    menu.addItem(item)
  }

  @objc private func handleSplitMenuItem(_ sender: NSMenuItem) {
    guard let direction = sender.representedObject as? String else { return }
    emit(surfaceID, type: GhosttyBridgeEvent.split, value: direction)
  }
}

@MainActor
private final class SurfaceEntry {
  weak var rootView: NSView?
  let view: CheshiTerminalView
  let controller: TerminalController
  let delegate: SurfaceDelegate

  init(
    rootView: NSView,
    view: CheshiTerminalView,
    controller: TerminalController,
    delegate: SurfaceDelegate
  ) {
    self.rootView = rootView
    self.view = view
    self.controller = controller
    self.delegate = delegate
  }
}

@MainActor
private final class SurfaceStore {
  static let shared = SurfaceStore()

  private var nextSurfaceID: Int32 = 1
  private var surfaces: [Int32: SurfaceEntry] = [:]

  func initialize() -> Bool {
    true
  }

  func create(
    rootView: NSView,
    frame: CGRect,
    workingDirectory: String,
    dark: Bool
  ) -> Int32 {
    let surfaceID = nextSurfaceID
    nextSurfaceID += 1

    let configuration = TerminalConfiguration { builder in
      builder.withFontFamily("Menlo")
      builder.withFontFamily("Apple SD Gothic Neo")
      builder.withFontSize(11)
      builder.withFontThicken(false)
      builder.withCursorStyle(.block)
      builder.withCursorStyleBlink(true)
      builder.withBackgroundOpacity(0)
      builder.withCustom("unfocused-split-opacity", "1")
      builder.withWindowPaddingX(10)
      builder.withWindowPaddingY(8)
    }
    let controller = TerminalController(configuration: configuration)
    controller.setColorScheme(dark ? .dark : .light)

    let view = CheshiTerminalView(frame: frame, surfaceID: surfaceID)
    let delegate = SurfaceDelegate(surfaceID: surfaceID)
    view.appearance = cheshiTerminalAppearance(dark: dark)
    view.autoresizingMask = []
    view.translatesAutoresizingMaskIntoConstraints = true
    view.delegate = delegate
    view.configuration = TerminalSurfaceOptions(
      backend: .exec,
      workingDirectory: workingDirectory,
      envVars: ["CHESHI_TERMINAL_PANE": String(surfaceID)],
      context: .split
    )
    view.controller = controller
    rootView.addSubview(view, positioned: .above, relativeTo: nil)
    view.setSurfaceVisible(true)

    surfaces[surfaceID] = SurfaceEntry(
      rootView: rootView,
      view: view,
      controller: controller,
      delegate: delegate
    )
    return surfaceID
  }

  func resize(
    surfaceID: Int32,
    x: Double,
    y: Double,
    width: Double,
    height: Double
  ) -> Bool {
    guard let entry = surfaces[surfaceID], let rootView = entry.rootView else { return false }
    let frame = frameForRootView(rootView, x: x, y: y, width: width, height: height)
    if entry.view.frame.equalTo(frame) { return true }
    entry.view.frame = frame
    entry.view.needsLayout = true
    entry.view.layoutSubtreeIfNeeded()
    return true
  }

  func destroy(surfaceID: Int32) -> Bool {
    guard let entry = surfaces.removeValue(forKey: surfaceID) else { return false }
    entry.view.setSurfaceVisible(false)
    entry.view.delegate = nil
    entry.view.controller = nil
    entry.view.removeFromSuperview()
    return true
  }

  func setFocus(surfaceID: Int32, focused: Bool) -> Bool {
    guard let entry = surfaces[surfaceID] else { return false }
    if focused {
      if entry.view.window?.firstResponder !== entry.view {
        entry.view.window?.makeFirstResponder(entry.view)
      }
    } else if entry.view.window?.firstResponder === entry.view {
      entry.view.window?.makeFirstResponder(nil)
    }
    return true
  }

  func setOccluded(surfaceID: Int32, occluded: Bool) -> Bool {
    guard let entry = surfaces[surfaceID] else { return false }
    if entry.view.isHidden == occluded { return true }
    entry.view.isHidden = occluded
    entry.view.setSurfaceVisible(!occluded)
    return true
  }

  func setDark(_ dark: Bool) {
    for entry in surfaces.values {
      entry.view.appearance = cheshiTerminalAppearance(dark: dark)
      entry.controller.setColorScheme(dark ? .dark : .light)
    }
  }
}

private func frameForRootView(
  _ rootView: NSView,
  x: Double,
  y: Double,
  width: Double,
  height: Double
) -> CGRect {
  let effectiveY = rootView.isFlipped
    ? CGFloat(y)
    : rootView.bounds.height - CGFloat(y) - CGFloat(height)
  return CGRect(x: CGFloat(x), y: effectiveY, width: CGFloat(width), height: CGFloat(height))
}

@_cdecl("cheshi_ghostty_set_event_callback")
public func cheshiGhosttySetEventCallback(_ callback: CheshiGhosttyEventCallback?) {
  eventCallback = callback
}

@_cdecl("cheshi_ghostty_initialize")
public func cheshiGhosttyInitialize(_: UnsafePointer<CChar>?) -> Bool {
  onMain {
    SurfaceStore.shared.initialize()
  }
}

@_cdecl("cheshi_ghostty_surface_create")
public func cheshiGhosttySurfaceCreate(
  _ rootViewPointer: UnsafeMutableRawPointer?,
  _ x: Double,
  _ y: Double,
  _ width: Double,
  _ height: Double,
  _ workingDirectory: UnsafePointer<CChar>?,
  _ dark: Bool
) -> Int32 {
  guard let rootViewPointer, let workingDirectory else { return -1 }
  let directory = String(cString: workingDirectory)
  return onMain {
    let rootView = Unmanaged<NSView>.fromOpaque(rootViewPointer).takeUnretainedValue()
    return SurfaceStore.shared.create(
      rootView: rootView,
      frame: frameForRootView(rootView, x: x, y: y, width: width, height: height),
      workingDirectory: directory,
      dark: dark
    )
  }
}

@_cdecl("cheshi_ghostty_surface_resize")
public func cheshiGhosttySurfaceResize(
  _ surfaceID: Int32,
  _ x: Double,
  _ y: Double,
  _ width: Double,
  _ height: Double
) -> Bool {
  onMain {
    SurfaceStore.shared.resize(
      surfaceID: surfaceID,
      x: x,
      y: y,
      width: width,
      height: height
    )
  }
}

@_cdecl("cheshi_ghostty_surface_destroy")
public func cheshiGhosttySurfaceDestroy(_ surfaceID: Int32) -> Bool {
  onMain {
    SurfaceStore.shared.destroy(surfaceID: surfaceID)
  }
}

@_cdecl("cheshi_ghostty_surface_set_focus")
public func cheshiGhosttySurfaceSetFocus(_ surfaceID: Int32, _ focused: Bool) -> Bool {
  onMain {
    SurfaceStore.shared.setFocus(surfaceID: surfaceID, focused: focused)
  }
}

@_cdecl("cheshi_ghostty_surface_set_occluded")
public func cheshiGhosttySurfaceSetOccluded(_ surfaceID: Int32, _ occluded: Bool) -> Bool {
  onMain {
    SurfaceStore.shared.setOccluded(surfaceID: surfaceID, occluded: occluded)
  }
}

@_cdecl("cheshi_ghostty_set_dark")
public func cheshiGhosttySetDark(_ dark: Bool) {
  onMain {
    SurfaceStore.shared.setDark(dark)
  }
}
