import AppKit
import ApplicationServices
import DisplaydCore
import ImageIO
import UniformTypeIdentifiers

func log(_ message: String) {
  print("[\(Date().ISO8601Format())] \(message)")
}

enum DisplaydError: Error, CustomStringConvertible {
  case invalidSlot(Int?)
  case createFailed(String)
  case notOpen(Int)
  case notShareable(CGDirectDisplayID)
  case encodingFailed
  case socket(String)

  var description: String {
    switch self {
    case let .invalidSlot(slot): "invalid slot \(slot.map(String.init) ?? "missing")"
    case let .createFailed(name): "could not create the display \(name)"
    case let .notOpen(slot): "slot \(slot) is not open"
    case let .notShareable(id): "display \(id) is not available for capture"
    case .encodingFailed: "image encoding failed"
    case let .socket(message): message
    }
  }
}

func isSessionLocked() -> Bool {
  guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
  return session["CGSSessionScreenIsLocked"] as? Bool ?? false
}

func onScreenWindows() -> [WindowInfo] {
  let entries = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  return entries.compactMap { entry in
    guard
      let pid = entry[kCGWindowOwnerPID as String] as? Int,
      let layer = entry[kCGWindowLayer as String] as? Int,
      let dictionary = entry[kCGWindowBounds as String] as? NSDictionary,
      let bounds = CGRect(dictionaryRepresentation: dictionary as CFDictionary),
      (entry[kCGWindowAlpha as String] as? Double ?? 1) > 0
    else { return nil }
    return WindowInfo(
      owner: entry[kCGWindowOwnerName as String] as? String ?? "",
      pid: pid,
      layer: layer,
      bounds: .enclosing(x: bounds.minX, y: bounds.minY, width: bounds.width, height: bounds.height)
    )
  }
}

func nsScreen(for id: CGDirectDisplayID) -> NSScreen? {
  NSScreen.screens.first { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == id }
}

func encode(_ image: CGImage, as format: ImageFormat, quality: Double) throws -> Data {
  let data = NSMutableData()
  let type = format == .png ? UTType.png : UTType.jpeg
  guard let destination = CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil) else {
    throw DisplaydError.encodingFailed
  }
  let options = [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary
  CGImageDestinationAddImage(destination, image, format == .jpeg ? options : nil)
  guard CGImageDestinationFinalize(destination) else { throw DisplaydError.encodingFailed }
  return data as Data
}

extension Permissions {
  static func current(prompt: Bool) -> Permissions {
    if prompt {
      _ = CGRequestScreenCaptureAccess()
      _ = CGRequestPostEventAccess()
    }
    let options = ["AXTrustedCheckOptionPrompt": prompt] as CFDictionary
    return Permissions(
      screenCapture: CGPreflightScreenCaptureAccess(),
      postEvents: CGPreflightPostEventAccess(),
      accessibility: AXIsProcessTrustedWithOptions(options)
    )
  }
}
