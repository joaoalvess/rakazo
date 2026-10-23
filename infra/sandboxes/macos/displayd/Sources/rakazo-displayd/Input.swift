import AppKit
import DisplaydCore

@MainActor
final class Input {
  private struct Session {
    var keys = KeyMapper()
    var pointer = PointerTracker(doubleClickInterval: NSEvent.doubleClickInterval)
    let cursor: CGPoint
    let frontmost: NSRunningApplication?
  }

  private var sessions: [Int: Session] = [:]

  var activeSlots: [Int] { sessions.keys.sorted() }

  func begin(_ slot: Int) {
    guard sessions[slot] == nil else { return }
    sessions[slot] = Session(cursor: CGEvent(source: nil)?.location ?? .zero, frontmost: NSWorkspace.shared.frontmostApplication)
    log("slot \(slot) takeover input started")
  }

  func end(_ slot: Int, origin: CGPoint) {
    guard var session = sessions.removeValue(forKey: slot) else { return }
    post(session.pointer.releaseAll(), origin: origin, modifiers: [])
    CGWarpMouseCursorPosition(session.cursor)
    CGAssociateMouseAndMouseCursorPosition(1)
    session.frontmost?.activate()
    log("slot \(slot) takeover input ended")
  }

  func apply(_ events: [InputEvent], slot: Int, origin: CGPoint) {
    begin(slot)
    guard var session = sessions[slot] else { return }
    for event in events {
      switch event {
      case let .pointer(x, y, mask):
        let actions = session.pointer.update(x: x, y: y, mask: mask, at: ProcessInfo.processInfo.systemUptime)
        post(actions, origin: origin, modifiers: session.keys.modifiers)
      case let .key(keysym, down):
        post(session.keys.map(keysym: keysym, down: down))
      case let .text(text):
        type(text)
      }
    }
    sessions[slot] = session
  }

  private func post(_ actions: [MouseAction], origin: CGPoint, modifiers: Set<Modifier>) {
    for action in actions {
      switch action {
      case let .move(point):
        mouse(.mouseMoved, point, .left, origin, modifiers)
      case let .down(button, point, clicks):
        mouse(button == .left ? .leftMouseDown : .rightMouseDown, point, button.cg, origin, modifiers, clicks: clicks)
      case let .up(button, point, clicks):
        mouse(button == .left ? .leftMouseUp : .rightMouseUp, point, button.cg, origin, modifiers, clicks: clicks)
      case let .drag(button, point):
        mouse(button == .left ? .leftMouseDragged : .rightMouseDragged, point, button.cg, origin, modifiers)
      case let .scroll(point, lines):
        mouse(.mouseMoved, point, .left, origin, modifiers)
        let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: Int32(lines), wheel2: 0, wheel3: 0)
        event?.location = global(point, origin)
        event?.post(tap: .cghidEventTap)
      }
    }
  }

  private func mouse(
    _ type: CGEventType,
    _ point: Point,
    _ button: CGMouseButton,
    _ origin: CGPoint,
    _ modifiers: Set<Modifier>,
    clicks: Int? = nil
  ) {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: global(point, origin), mouseButton: button) else {
      return
    }
    event.flags = flags(modifiers)
    if let clicks { event.setIntegerValueField(.mouseEventClickState, value: Int64(clicks)) }
    event.post(tap: .cghidEventTap)
  }

  private func post(_ action: KeyAction) {
    switch action {
    case .none:
      break
    case let .keyCode(code, down, modifiers):
      let event = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(code), keyDown: down)
      event?.flags = flags(modifiers)
      event?.post(tap: .cghidEventTap)
    case let .text(text):
      type(text)
    }
  }

  private func type(_ text: String) {
    for character in text {
      if character == "\n" || character == "\r\n" || character == "\r" {
        for down in [true, false] { CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: down)?.post(tap: .cghidEventTap) }
        continue
      }
      var units = Array(String(character).utf16)
      for down in [true, false] {
        let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
        event?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
        event?.post(tap: .cghidEventTap)
      }
    }
  }

  private func global(_ point: Point, _ origin: CGPoint) -> CGPoint {
    CGPoint(x: origin.x + point.x, y: origin.y + point.y)
  }

  private func flags(_ modifiers: Set<Modifier>) -> CGEventFlags {
    var flags: CGEventFlags = []
    if modifiers.contains(.shift) { flags.insert(.maskShift) }
    if modifiers.contains(.control) { flags.insert(.maskControl) }
    if modifiers.contains(.option) { flags.insert(.maskAlternate) }
    if modifiers.contains(.command) { flags.insert(.maskCommand) }
    return flags
  }
}

extension MouseButton {
  fileprivate var cg: CGMouseButton { self == .left ? .left : .right }
}
