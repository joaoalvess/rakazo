import Foundation

public struct FrameRect: Codable, Equatable, Sendable {
  public var x: Int
  public var y: Int
  public var width: Int
  public var height: Int
  public var size: Int

  public init(x: Int, y: Int, width: Int, height: Int, size: Int) {
    self.x = x
    self.y = y
    self.width = width
    self.height = height
    self.size = size
  }
}

public struct FrameHeader: Codable, Equatable, Sendable {
  public var seq: Int
  public var width: Int
  public var height: Int
  public var full: Bool
  public var rects: [FrameRect]

  public init(seq: Int, width: Int, height: Int, full: Bool, rects: [FrameRect]) {
    self.seq = seq
    self.width = width
    self.height = height
    self.full = full
    self.rects = rects
  }
}

public enum FrameCodec {
  public static func encode(_ header: FrameHeader, payload: Data) throws -> Data {
    let json = try JSONEncoder().encode(header)
    var data = Data(capacity: 4 + json.count + payload.count)
    withUnsafeBytes(of: UInt32(json.count).bigEndian) { data.append(contentsOf: $0) }
    data.append(json)
    data.append(payload)
    return data
  }

  public static func header(of message: Data) -> FrameHeader? {
    guard message.count >= 4 else { return nil }
    let bytes = [UInt8](message.prefix(4))
    let length = Int(bytes[0]) << 24 | Int(bytes[1]) << 16 | Int(bytes[2]) << 8 | Int(bytes[3])
    guard message.count >= 4 + length else { return nil }
    let start = message.startIndex + 4
    return try? JSONDecoder().decode(FrameHeader.self, from: message[start..<(start + length)])
  }
}
