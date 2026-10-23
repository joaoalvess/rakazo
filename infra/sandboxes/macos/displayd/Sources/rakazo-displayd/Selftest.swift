import AppKit
import DisplaydCore

private struct SelftestReport: Encodable {
  struct Shot: Encodable {
    let slot: Int
    let displayID: UInt32
    let adopted: Bool
    let file: String
    let width: Int
    let height: Int
  }

  struct Frames: Encodable {
    let slot: Int
    let seconds: Double
    let frames: Int
    let fullFrames: Int
    let rects: Int
    let bytes: Int
  }

  var ok = false
  var distinct = false
  var screenshots: [Shot] = []
  var frames: Frames?
  var error: String?
}

private final class CountingSink: FrameSink, @unchecked Sendable {
  private let lock = NSLock()
  private var frames = 0
  private var fullFrames = 0
  private var rects = 0
  private var bytes = 0

  var isOpen: Bool { true }

  func send(_ data: Data) -> Bool {
    let header = FrameCodec.header(of: data)
    lock.withLock {
      frames += 1
      fullFrames += header?.full == true ? 1 : 0
      rects += header?.rects.count ?? 0
      bytes += data.count
    }
    return true
  }

  func close() {}

  func counts() -> (frames: Int, fullFrames: Int, rects: Int, bytes: Int) {
    lock.withLock { (frames, fullFrames, rects, bytes) }
  }
}

@MainActor
func selftest(output: String, slots: [Int]) async -> Int32 {
  var report = SelftestReport()
  if isListening(Server.defaultDirectory + "/control.sock") {
    report.error = "rakazo-displayd is already serving the screens; stop it first"
  } else {
    let displays = Displays()
    let awake = Awake()
    var windows: [NSWindow] = []
    do {
      try FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)
      awake.declareActivity()
      awake.hold(true)
      let ids = try slots.map { try displays.open($0) }
      var labels: [NSTextField] = []
      for (index, id) in ids.enumerated() {
        let screen = try await waitForScreen(id)
        let (window, label) = patternWindow(on: screen, slot: slots[index])
        windows.append(window)
        labels.append(label)
      }
      try await Task.sleep(for: .milliseconds(800))
      var images: [Data] = []
      for (index, id) in ids.enumerated() {
        let image = try await screenshot(id, excludingWindows: [])
        let file = "\(output)/selftest-slot-\(slots[index]).png"
        try encode(image, as: .png, quality: 1).write(to: URL(fileURLWithPath: file))
        images.append((image.dataProvider?.data as Data?) ?? Data())
        let info = displays.info(slots[index], viewers: 0)
        report.screenshots.append(
          .init(slot: slots[index], displayID: id, adopted: info?.adopted ?? false, file: file, width: image.width, height: image.height)
        )
      }
      report.distinct = images.count == slots.count && Set(images).count == images.count && !images.contains(Data())
      if let first = slots.first, let label = labels.first {
        let hub = FrameHub(displays: displays)
        let sink = CountingSink()
        try await hub.subscribe(sink, slot: first, fps: 30, quality: 0.6)
        let started = Date()
        while Date().timeIntervalSince(started) < 3 {
          label.stringValue = "Rakazo Screen \(first + 1) · \(Int(Date().timeIntervalSince(started) * 1000))"
          try await Task.sleep(for: .milliseconds(33))
        }
        await hub.unsubscribe(sink)
        let counts = sink.counts()
        report.frames = .init(
          slot: first,
          seconds: Date().timeIntervalSince(started),
          frames: counts.frames,
          fullFrames: counts.fullFrames,
          rects: counts.rects,
          bytes: counts.bytes
        )
      }
      report.ok = report.distinct && (report.frames?.frames ?? 0) > 0
    } catch {
      report.error = "\(error)"
    }
    windows.forEach { $0.orderOut(nil) }
    slots.forEach { displays.close($0) }
    awake.hold(false)
  }
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
  if let data = try? encoder.encode(report), let text = String(data: data, encoding: .utf8) { print(text) }
  return report.ok ? 0 : 1
}

@MainActor
private func waitForScreen(_ id: CGDirectDisplayID) async throws -> NSScreen {
  for _ in 0..<30 {
    if let screen = nsScreen(for: id) { return screen }
    try await Task.sleep(for: .milliseconds(100))
  }
  throw DisplaydError.notShareable(id)
}

@MainActor
private func patternWindow(on screen: NSScreen, slot: Int) -> (NSWindow, NSTextField) {
  let colors: [NSColor] = [.systemRed, .systemBlue, .systemGreen, .systemOrange, .systemPurple, .systemTeal]
  let window = NSWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
  window.isReleasedWhenClosed = false
  window.level = .floating
  window.backgroundColor = colors[slot % colors.count]
  let label = NSTextField(labelWithString: "Rakazo Screen \(slot + 1)")
  label.font = .monospacedSystemFont(ofSize: 48, weight: .bold)
  label.textColor = .white
  label.frame = NSRect(x: 80, y: screen.frame.height / 2 - 40, width: screen.frame.width - 160, height: 80)
  window.contentView?.addSubview(label)
  window.setFrame(screen.frame, display: true)
  window.orderFrontRegardless()
  return (window, label)
}
