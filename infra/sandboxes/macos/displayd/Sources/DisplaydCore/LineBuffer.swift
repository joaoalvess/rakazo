import Foundation

public struct LineBuffer: Sendable {
  public static let maxLineLength = 1 << 20

  private var pending = Data()

  public init() {}

  public mutating func append(_ data: Data) -> [Data] {
    pending.append(data)
    var lines: [Data] = []
    while let newline = pending.firstIndex(of: 0x0A) {
      lines.append(Data(pending[pending.startIndex..<newline]))
      pending = Data(pending[pending.index(after: newline)...])
    }
    if pending.count > Self.maxLineLength { pending.removeAll() }
    return lines
  }
}
