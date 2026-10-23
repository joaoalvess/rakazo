public enum MouseButton: Sendable {
  case left, right
}

public enum MouseAction: Equatable, Sendable {
  case move(Point)
  case down(MouseButton, Point, clicks: Int)
  case up(MouseButton, Point, clicks: Int)
  case drag(MouseButton, Point)
  case scroll(Point, lines: Int)
}

public struct PointerTracker: Sendable {
  public let doubleClickInterval: Double

  private var mask = 0
  private var position = Point(x: -1, y: -1)
  private var lastDown = -Double.infinity
  private var lastDownPoint = Point(x: -100, y: -100)
  private var clicks = 1

  public init(doubleClickInterval: Double = 0.5) {
    self.doubleClickInterval = doubleClickInterval
  }

  public mutating func update(x: Int, y: Int, mask newMask: Int, at time: Double) -> [MouseAction] {
    let point = Point(x: Double(x), y: Double(y))
    var actions: [MouseAction] = []
    for (bit, lines) in [(8, 3), (16, -3)] where newMask & bit != 0 && mask & bit == 0 {
      actions.append(.scroll(point, lines: lines))
    }
    for (bit, button) in [(1, MouseButton.left), (4, MouseButton.right)] where (newMask & bit != 0) != (mask & bit != 0) {
      if newMask & bit != 0 {
        if button == .left {
          let near = abs(point.x - lastDownPoint.x) < 5 && abs(point.y - lastDownPoint.y) < 5
          clicks = time - lastDown < doubleClickInterval && near ? clicks + 1 : 1
          lastDown = time
          lastDownPoint = point
        }
        actions.append(.down(button, point, clicks: button == .left ? clicks : 1))
      } else {
        actions.append(.up(button, point, clicks: button == .left ? clicks : 1))
      }
    }
    if actions.isEmpty {
      if newMask & 1 != 0 {
        actions.append(.drag(.left, point))
      } else if newMask & 4 != 0 {
        actions.append(.drag(.right, point))
      } else if point != position {
        actions.append(.move(point))
      }
    }
    mask = newMask
    position = point
    return actions
  }

  public mutating func releaseAll() -> [MouseAction] {
    var actions: [MouseAction] = []
    if mask & 1 != 0 { actions.append(.up(.left, position, clicks: clicks)) }
    if mask & 4 != 0 { actions.append(.up(.right, position, clicks: 1)) }
    mask = 0
    return actions
  }
}
