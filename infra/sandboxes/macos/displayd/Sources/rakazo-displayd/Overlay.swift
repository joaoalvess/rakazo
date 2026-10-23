import AppKit
import DisplaydCore

@MainActor
final class Overlay {
  private static let ink = NSColor(white: 0.07, alpha: 1)

  let window: NSWindow
  private let root = CALayer()
  private let canvas = CALayer()
  private let cursor = CAShapeLayer()
  private let badge = CALayer()
  private let badgeText = CATextLayer()
  private var position = CGPoint.zero

  init() {
    window = NSWindow(contentRect: .zero, styleMask: .borderless, backing: .buffered, defer: false)
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = false
    window.ignoresMouseEvents = true
    window.isReleasedWhenClosed = false
    window.level = .screenSaver
    window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]

    let view = NSView()
    view.layer = root
    view.wantsLayer = true
    window.contentView = view
    canvas.isGeometryFlipped = true
    root.addSublayer(canvas)

    let path = CGMutablePath()
    path.addLines(between: [CGPoint(x: 0, y: 0), CGPoint(x: 6, y: 19), CGPoint(x: 9, y: 11), CGPoint(x: 18, y: 7)])
    path.closeSubpath()
    cursor.path = path
    cursor.fillColor = Self.ink.cgColor
    cursor.strokeColor = NSColor.white.cgColor
    cursor.lineWidth = 1.5
    cursor.lineJoin = .round
    cursor.isHidden = true
    canvas.addSublayer(cursor)

    badgeText.string = "Typing…"
    badgeText.fontSize = 12
    badgeText.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
    badgeText.foregroundColor = NSColor.white.cgColor
    badgeText.alignmentMode = .center
    badgeText.contentsScale = 1
    badgeText.frame = CGRect(x: 0, y: 3, width: 64, height: 16)
    badge.backgroundColor = Self.ink.cgColor
    badge.cornerRadius = 10
    badge.bounds = CGRect(x: 0, y: 0, width: 64, height: 20)
    badge.anchorPoint = .zero
    badge.addSublayer(badgeText)
    badge.isHidden = true
    canvas.addSublayer(badge)
  }

  func place(on frame: NSRect) {
    window.setFrame(frame, display: true)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    canvas.frame = CGRect(origin: .zero, size: frame.size)
    CATransaction.commit()
    window.orderFrontRegardless()
  }

  func hide() {
    window.orderOut(nil)
  }

  func update(cursor point: Point?, click: Point?, typing: Bool?, cursorHidden: Bool?) {
    CATransaction.begin()
    CATransaction.setAnimationDuration(0.18)
    if let point {
      position = CGPoint(x: point.x, y: point.y)
      cursor.position = position
      cursor.isHidden = false
    }
    if let cursorHidden { cursor.isHidden = cursorHidden }
    if let typing { badge.isHidden = !typing }
    badge.position = CGPoint(x: position.x + 14, y: position.y + 22)
    CATransaction.commit()
    if let click { ripple(at: CGPoint(x: click.x, y: click.y)) }
  }

  private func ripple(at point: CGPoint) {
    let ripple = CAShapeLayer()
    ripple.path = CGPath(ellipseIn: CGRect(x: -18, y: -18, width: 36, height: 36), transform: nil)
    ripple.position = point
    ripple.fillColor = Self.ink.withAlphaComponent(0.18).cgColor
    ripple.strokeColor = Self.ink.cgColor
    ripple.lineWidth = 2
    ripple.opacity = 0
    canvas.insertSublayer(ripple, below: cursor)
    let scale = CABasicAnimation(keyPath: "transform.scale")
    scale.fromValue = 0.3
    scale.toValue = 1.4
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = 1
    fade.toValue = 0
    let group = CAAnimationGroup()
    group.animations = [scale, fade]
    group.duration = 0.5
    ripple.add(group, forKey: "ripple")
    Task { @MainActor in
      try? await Task.sleep(for: .milliseconds(600))
      ripple.removeFromSuperlayer()
    }
  }
}
