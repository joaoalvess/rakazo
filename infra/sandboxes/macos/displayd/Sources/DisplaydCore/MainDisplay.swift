public struct ActiveDisplay: Equatable, Sendable {
  public enum Kind: Equatable, Sendable {
    case builtin
    case screen
    case reserved
    case other
  }

  public var id: UInt32
  public var kind: Kind
  public var x: Int
  public var width: Int

  public init(id: UInt32, kind: Kind, x: Int, width: Int) {
    self.id = id
    self.kind = kind
    self.x = x
    self.width = width
  }
}

public enum MainDisplay {
  public static func needsReserved(_ displays: [ActiveDisplay]) -> Bool {
    displays.contains { $0.kind == .screen } && !displays.contains { $0.kind == .builtin || $0.kind == .other }
  }

  public static func preferred(_ displays: [ActiveDisplay]) -> UInt32? {
    for kind in [ActiveDisplay.Kind.builtin, .other, .reserved] {
      if let display = displays.first(where: { $0.kind == kind }) { return display.id }
    }
    return nil
  }

  public static func arrangement(_ displays: [ActiveDisplay], main: UInt32) -> [UInt32: Int] {
    guard let first = displays.first(where: { $0.id == main }) else { return [:] }
    var origins = [main: 0]
    var x = first.width
    for display in displays.filter({ $0.id != main }).sorted(by: { $0.x < $1.x }) {
      origins[display.id] = x
      x += display.width
    }
    return origins
  }
}
