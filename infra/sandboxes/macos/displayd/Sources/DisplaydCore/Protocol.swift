import Foundation

public enum Operation: String, Decodable, Sendable {
  case status, permissions, open, close, wake, sleep, screenshot, overlay, input, takeover, windows
}

public enum ImageFormat: String, Decodable, Sendable {
  case png, jpeg
}

public enum InputEvent: Equatable, Sendable {
  case pointer(x: Int, y: Int, mask: Int)
  case key(keysym: UInt32, down: Bool)
  case text(String)
}

extension InputEvent: Decodable {
  private enum CodingKeys: String, CodingKey {
    case t, x, y, m, s, d
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    switch try container.decode(String.self, forKey: .t) {
    case "p":
      self = .pointer(
        x: try container.decode(Int.self, forKey: .x),
        y: try container.decode(Int.self, forKey: .y),
        mask: try container.decodeIfPresent(Int.self, forKey: .m) ?? 0
      )
    case "k":
      self = .key(keysym: try container.decode(UInt32.self, forKey: .s), down: try container.decode(Bool.self, forKey: .d))
    case "text":
      self = .text(try container.decode(String.self, forKey: .s))
    case let other:
      throw DecodingError.dataCorruptedError(forKey: .t, in: container, debugDescription: "unknown input event \(other)")
    }
  }
}

public struct Request: Decodable, Sendable {
  public var id: Int?
  public var op: Operation
  public var slot: Int?
  public var cursor: Point?
  public var click: Point?
  public var typing: Bool?
  public var cursorHidden: Bool?
  public var events: [InputEvent]?
  public var active: Bool?
  public var overlays: Bool?
  public var format: ImageFormat?
  public var quality: Double?
  public var prompt: Bool?
}

public struct FrameSubscription: Decodable, Sendable {
  public var slot: Int?
  public var fps: Int?
  public var quality: Double?
  public var full: Bool?
}

public struct ScreenInfo: Encodable, Equatable, Sendable {
  public var slot: Int
  public var displayID: UInt32
  public var bounds: Rect
  public var awake: Bool
  public var displayAsleep: Bool
  public var adopted: Bool
  public var viewers: Int

  public init(slot: Int, displayID: UInt32, bounds: Rect, awake: Bool, displayAsleep: Bool, adopted: Bool, viewers: Int) {
    self.slot = slot
    self.displayID = displayID
    self.bounds = bounds
    self.awake = awake
    self.displayAsleep = displayAsleep
    self.adopted = adopted
    self.viewers = viewers
  }
}

public struct Permissions: Codable, Equatable, Sendable {
  public var screenCapture: Bool
  public var postEvents: Bool
  public var accessibility: Bool

  public init(screenCapture: Bool, postEvents: Bool, accessibility: Bool) {
    self.screenCapture = screenCapture
    self.postEvents = postEvents
    self.accessibility = accessibility
  }
}

public struct Response: Encodable, Sendable {
  public var id: Int?
  public var ok: Bool
  public var error: String?
  public var screens: [ScreenInfo]?
  public var screen: ScreenInfo?
  public var permissions: Permissions?
  public var image: String?
  public var mimeType: String?
  public var windows: [WindowInfo]?

  public init(
    id: Int? = nil,
    ok: Bool = true,
    error: String? = nil,
    screens: [ScreenInfo]? = nil,
    screen: ScreenInfo? = nil,
    permissions: Permissions? = nil,
    image: String? = nil,
    mimeType: String? = nil,
    windows: [WindowInfo]? = nil
  ) {
    self.id = id
    self.ok = ok
    self.error = error
    self.screens = screens
    self.screen = screen
    self.permissions = permissions
    self.image = image
    self.mimeType = mimeType
    self.windows = windows
  }

  public static func failure(_ message: String, id: Int? = nil) -> Response {
    Response(id: id, ok: false, error: message)
  }

  public func line() -> Data {
    var data = (try? JSONEncoder().encode(self)) ?? Data(#"{"ok":false,"error":"response encoding failed"}"#.utf8)
    data.append(0x0A)
    return data
  }
}
