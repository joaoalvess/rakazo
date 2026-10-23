public struct Point: Codable, Equatable, Sendable {
  public var x: Double
  public var y: Double

  public init(x: Double, y: Double) {
    self.x = x
    self.y = y
  }
}

public struct Rect: Codable, Equatable, Sendable {
  public var x: Int
  public var y: Int
  public var width: Int
  public var height: Int

  public init(x: Int, y: Int, width: Int, height: Int) {
    self.x = x
    self.y = y
    self.width = width
    self.height = height
  }

  public static func enclosing(x: Double, y: Double, width: Double, height: Double) -> Rect {
    let minX = Int(x.rounded(.down))
    let minY = Int(y.rounded(.down))
    return Rect(x: minX, y: minY, width: Int((x + width).rounded(.up)) - minX, height: Int((y + height).rounded(.up)) - minY)
  }

  public var maxX: Int { x + width }
  public var maxY: Int { y + height }
  public var area: Int { width * height }
  public var isEmpty: Bool { width <= 0 || height <= 0 }

  public func touches(_ other: Rect) -> Bool {
    x <= other.maxX && other.x <= maxX && y <= other.maxY && other.y <= maxY
  }

  public func union(_ other: Rect) -> Rect {
    let minX = min(x, other.x)
    let minY = min(y, other.y)
    return Rect(x: minX, y: minY, width: max(maxX, other.maxX) - minX, height: max(maxY, other.maxY) - minY)
  }

  public func aligned(to step: Int, within bounds: Rect) -> Rect {
    let minX = max(bounds.x, Int((Double(x) / Double(step)).rounded(.down)) * step)
    let minY = max(bounds.y, Int((Double(y) / Double(step)).rounded(.down)) * step)
    let alignedMaxX = min(bounds.maxX, Int((Double(maxX) / Double(step)).rounded(.up)) * step)
    let alignedMaxY = min(bounds.maxY, Int((Double(maxY) / Double(step)).rounded(.up)) * step)
    return Rect(x: minX, y: minY, width: alignedMaxX - minX, height: alignedMaxY - minY)
  }
}
