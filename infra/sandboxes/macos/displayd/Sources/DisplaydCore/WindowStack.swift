public struct WindowInfo: Encodable, Equatable, Sendable {
  public var owner: String
  public var pid: Int
  public var layer: Int
  public var bounds: Rect

  public init(owner: String, pid: Int, layer: Int, bounds: Rect) {
    self.owner = owner
    self.pid = pid
    self.layer = layer
    self.bounds = bounds
  }
}

public enum WindowStack {
  private static let ignoredOwners: Set<String> = ["Dock", "Window Server"]
  private static let dockLayer = 20
  private static let popUpMenuLayer = 101

  public static func onDisplay(_ windows: [WindowInfo], display: Rect, excludingPID pid: Int) -> [WindowInfo] {
    windows.filter { window in
      window.pid != pid
        && !ignoredOwners.contains(window.owner)
        && ((0..<dockLayer).contains(window.layer) || window.layer == popUpMenuLayer)
        && window.bounds.intersects(display)
    }
  }
}
