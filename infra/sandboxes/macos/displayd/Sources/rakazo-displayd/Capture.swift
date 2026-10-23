import CoreImage
import CoreMedia
import DisplaydCore
@preconcurrency import ScreenCaptureKit

protocol FrameSink: AnyObject, Sendable {
  var isOpen: Bool { get }
  func send(_ data: Data) -> Bool
  func close()
}

final class FrameStream: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  let slot: Int
  let queue: DispatchQueue
  var onStop: (@Sendable (Error) -> Void)?

  private let quality: Double
  private let context = CIContext(options: [.cacheIntermediates: false])
  private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
  private var sinks: [ObjectIdentifier: any FrameSink] = [:]
  private var latest: CVPixelBuffer?
  private var needsFull = true
  private var seq = 0

  init(slot: Int, quality: Double) {
    self.slot = slot
    self.quality = quality
    queue = DispatchQueue(label: "rakazo-displayd.frames.\(slot)")
  }

  func add(_ sink: any FrameSink) {
    queue.async {
      self.sinks[ObjectIdentifier(sink)] = sink
      self.sendFull()
    }
  }

  func remove(_ sink: any FrameSink) {
    queue.async { self.sinks[ObjectIdentifier(sink)] = nil }
  }

  func requestFull() {
    queue.async { self.sendFull() }
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen,
      let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
      let info = attachments.first,
      let status = info[.status] as? Int, SCFrameStatus(rawValue: status) == .complete,
      let buffer = CMSampleBufferGetImageBuffer(sampleBuffer)
    else { return }
    latest = buffer
    if needsFull {
      send(.full, buffer)
      return
    }
    let dirty = (info[.dirtyRects] as? [NSDictionary] ?? [])
      .compactMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) }
      .map { Rect.enclosing(x: $0.minX, y: $0.minY, width: $0.width, height: $0.height) }
    send(DirtyRegions.plan(dirty, width: CVPixelBufferGetWidth(buffer), height: CVPixelBufferGetHeight(buffer)), buffer)
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    onStop?(error)
  }

  private func sendFull() {
    needsFull = true
    if let latest { send(.full, latest) }
  }

  private func send(_ plan: FramePlan, _ buffer: CVPixelBuffer) {
    guard !sinks.isEmpty else { return }
    let width = CVPixelBufferGetWidth(buffer)
    let height = CVPixelBufferGetHeight(buffer)
    let rects: [Rect]
    switch plan {
    case .unchanged: return
    case .full: rects = [Rect(x: 0, y: 0, width: width, height: height)]
    case let .rects(list): rects = list
    }
    let image = CIImage(cvPixelBuffer: buffer)
    var payload = Data()
    var frameRects: [FrameRect] = []
    for rect in rects {
      guard let jpeg = jpeg(image, rect, height: height) else { return }
      frameRects.append(FrameRect(x: rect.x, y: rect.y, width: rect.width, height: rect.height, size: jpeg.count))
      payload.append(jpeg)
    }
    seq += 1
    let header = FrameHeader(seq: seq, width: width, height: height, full: plan == .full, rects: frameRects)
    guard let message = try? FrameCodec.encode(header, payload: payload) else { return }
    if plan == .full { needsFull = false }
    for (key, sink) in sinks where !sink.send(message) {
      sinks[key] = nil
    }
  }

  private func jpeg(_ image: CIImage, _ rect: Rect, height: Int) -> Data? {
    let area = CGRect(x: rect.x, y: height - rect.maxY, width: rect.width, height: rect.height)
    let cropped = image.cropped(to: area).transformed(by: CGAffineTransform(translationX: -area.minX, y: -area.minY))
    let options = [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): quality]
    return context.jpegRepresentation(of: cropped, colorSpace: colorSpace, options: options)
  }
}

@MainActor
final class FrameHub {
  private struct Capture {
    let frames: FrameStream
    var stream: SCStream?
    var displayID: CGDirectDisplayID
    let fps: Int
  }

  private let displays: Displays
  private var captures: [Int: Capture] = [:]
  private var subscriptions: [ObjectIdentifier: (slot: Int, sink: any FrameSink)] = [:]

  init(displays: Displays) {
    self.displays = displays
  }

  func viewers(_ slot: Int) -> Int {
    subscriptions.values.filter { $0.slot == slot }.count
  }

  func subscribe(_ sink: any FrameSink, slot: Int, fps: Int, quality: Double) async throws {
    await unsubscribe(sink)
    guard let displayID = displays.displayID(slot) else { throw DisplaydError.notOpen(slot) }
    guard sink.isOpen else { return }
    subscriptions[ObjectIdentifier(sink)] = (slot, sink)
    if let capture = captures[slot] {
      capture.frames.add(sink)
      return
    }
    let frames = FrameStream(slot: slot, quality: quality)
    frames.onStop = { [weak self] error in
      Task { @MainActor in
        log("slot \(slot) capture stopped: \(error)")
        await self?.restart(slot)
      }
    }
    captures[slot] = Capture(frames: frames, stream: nil, displayID: displayID, fps: fps)
    frames.add(sink)
    do {
      let stream = try await startStream(frames, displayID: displayID, fps: fps)
      if captures[slot]?.frames === frames {
        captures[slot]?.stream = stream
        log("slot \(slot) capture started on display \(displayID)")
      } else {
        try? await stream.stopCapture()
      }
    } catch {
      if captures[slot]?.frames === frames { captures[slot] = nil }
      subscriptions = subscriptions.filter { $0.value.slot != slot }
      throw error
    }
  }

  func unsubscribe(_ sink: any FrameSink) async {
    guard let subscription = subscriptions.removeValue(forKey: ObjectIdentifier(sink)) else { return }
    let slot = subscription.slot
    captures[slot]?.frames.remove(sink)
    guard viewers(slot) == 0, let capture = captures.removeValue(forKey: slot) else { return }
    try? await capture.stream?.stopCapture()
    log("slot \(slot) capture stopped, no viewers")
  }

  func requestFull(_ sink: any FrameSink) {
    guard let slot = subscriptions[ObjectIdentifier(sink)]?.slot else { return }
    captures[slot]?.frames.requestFull()
  }

  func stop(_ slot: Int) async {
    for (key, subscription) in subscriptions where subscription.slot == slot {
      subscriptions[key] = nil
      subscription.sink.close()
    }
    guard let capture = captures.removeValue(forKey: slot) else { return }
    try? await capture.stream?.stopCapture()
  }

  func displaysChanged() async {
    for slot in captures.keys.sorted() where captures[slot]?.displayID != displays.displayID(slot) {
      await restart(slot)
    }
  }

  private func restart(_ slot: Int) async {
    guard let capture = captures[slot] else { return }
    try? await capture.stream?.stopCapture()
    captures[slot]?.stream = nil
    guard let displayID = displays.displayID(slot) else { return }
    captures[slot]?.displayID = displayID
    do {
      let stream = try await startStream(capture.frames, displayID: displayID, fps: capture.fps)
      guard captures[slot]?.frames === capture.frames else {
        try? await stream.stopCapture()
        return
      }
      captures[slot]?.stream = stream
      capture.frames.requestFull()
      log("slot \(slot) capture restarted on display \(displayID)")
    } catch {
      log("slot \(slot) capture restart failed: \(error)")
      try? await Task.sleep(for: .seconds(2))
      if captures[slot]?.frames === capture.frames, captures[slot]?.stream == nil { await restart(slot) }
    }
  }

  private func startStream(_ frames: FrameStream, displayID: CGDirectDisplayID, fps: Int) async throws -> SCStream {
    let display = try await shareableDisplay(displayID)
    let config = SCStreamConfiguration()
    config.width = display.width
    config.height = display.height
    config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, min(fps, 60))))
    config.pixelFormat = kCVPixelFormatType_32BGRA
    config.colorSpaceName = CGColorSpace.sRGB
    config.showsCursor = false
    config.queueDepth = 5
    let stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: config, delegate: frames)
    try stream.addStreamOutput(frames, type: .screen, sampleHandlerQueue: frames.queue)
    try await stream.startCapture()
    return stream
  }
}

func shareableDisplay(_ id: CGDirectDisplayID) async throws -> SCDisplay {
  try await shareable(id).display
}

func shareable(_ id: CGDirectDisplayID) async throws -> (display: SCDisplay, content: SCShareableContent) {
  for _ in 0..<20 {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    if let display = content.displays.first(where: { $0.displayID == id }) { return (display, content) }
    try await Task.sleep(for: .milliseconds(250))
  }
  throw DisplaydError.notShareable(id)
}

func screenshot(_ id: CGDirectDisplayID, excludingWindows windowNumbers: [Int]) async throws -> CGImage {
  let (display, content) = try await shareable(id)
  let excluded = content.windows.filter { windowNumbers.contains(Int($0.windowID)) }
  let config = SCStreamConfiguration()
  config.width = display.width
  config.height = display.height
  config.colorSpaceName = CGColorSpace.sRGB
  config.showsCursor = false
  return try await SCScreenshotManager.captureImage(
    contentFilter: SCContentFilter(display: display, excludingWindows: excluded),
    configuration: config
  )
}
