public enum FramePlan: Equatable, Sendable {
  case unchanged
  case full
  case rects([Rect])
}

public enum DirtyRegions {
  public static func plan(
    _ dirty: [Rect],
    width: Int,
    height: Int,
    alignment: Int = 16,
    maxRects: Int = 24,
    fullCoverage: Double = 0.5
  ) -> FramePlan {
    let bounds = Rect(x: 0, y: 0, width: width, height: height)
    var merged: [Rect] = []
    for rect in dirty {
      var current = rect.aligned(to: alignment, within: bounds)
      if current.isEmpty { continue }
      var index = 0
      while index < merged.count {
        if merged[index].touches(current) {
          current = current.union(merged.remove(at: index))
          index = 0
        } else {
          index += 1
        }
      }
      merged.append(current)
    }
    if merged.isEmpty { return .unchanged }
    let covered = merged.reduce(0) { $0 + $1.area }
    if merged.count > maxRects || Double(covered) >= fullCoverage * Double(bounds.area) { return .full }
    return .rects(merged)
  }
}
