import AppKit
import DisplaydCore

@MainActor
final class Server {
  static let defaultDirectory = NSHomeDirectory() + "/Library/Application Support/Rakazo/displayd"

  private let displays = Displays()
  private let awake = Awake()
  private let input = Input()
  private let frames: FrameHub
  private var overlays: [Int: Overlay] = [:]
  private var listeners: [UnixListener] = []
  private let io = DispatchQueue(label: "rakazo-displayd.io")

  init() {
    frames = FrameHub(displays: displays)
    displays.onReconfigure = { [unowned self] in
      placeOverlays()
      Task { await frames.displaysChanged() }
    }
    NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) {
      [weak self] _ in
      MainActor.assumeIsolated { self?.placeOverlays() }
    }
  }

  func start(directory: String) throws {
    try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let controlPath = directory + "/control.sock"
    if isListening(controlPath) { throw DisplaydError.socket("another rakazo-displayd is listening on \(controlPath)") }
    awake.declareActivity()
    listeners.append(
      try UnixListener(path: controlPath, queue: io) { [unowned self] connection in
        connection.start(
          onLine: { connection, line in
            guard let request = try? JSONDecoder().decode(Request.self, from: line) else {
              _ = connection.send(Response.failure("invalid request").line())
              return
            }
            DispatchQueue.main.async { MainActor.assumeIsolated { self.handle(request, from: connection) } }
          },
          onClose: { _ in }
        )
      }
    )
    listeners.append(
      try UnixListener(path: directory + "/frames.sock", queue: io) { [unowned self] connection in
        connection.start(
          onLine: { connection, line in
            guard let message = try? JSONDecoder().decode(FrameSubscription.self, from: line) else { return }
            DispatchQueue.main.async { MainActor.assumeIsolated { self.handleFrames(message, from: connection) } }
          },
          onClose: { connection in
            Task { @MainActor in await self.frames.unsubscribe(connection) }
          }
        )
      }
    )
    log("listening on \(directory)")
  }

  private func handle(_ request: Request, from connection: Connection) {
    let id = request.id
    let reply: (Response) -> Void = { response in
      var response = response
      response.id = id
      _ = connection.send(response.line())
    }
    do {
      switch request.op {
      case .status:
        reply(Response(screens: displays.openSlots.compactMap { info($0) }))
      case .permissions:
        reply(Response(permissions: .current(prompt: request.prompt ?? false)))
      case .open, .wake:
        let slot = try slot(request)
        try open(slot)
        Task { reply(Response(screen: await settledInfo(slot))) }
      case .sleep:
        let slot = try slot(request)
        guard displays.displayID(slot) != nil else { throw DisplaydError.notOpen(slot) }
        displays.setAwake(slot, false)
        refreshAssertion()
        reply(Response(screen: info(slot)))
      case .close:
        close(try slot(request))
        reply(Response())
      case .overlay:
        let slot = try activate(request)
        overlay(slot).update(cursor: request.cursor, click: request.click, typing: request.typing, cursorHidden: request.cursorHidden)
        reply(Response())
      case .input:
        let slot = try activate(request)
        input.apply(request.events ?? [], slot: slot, origin: origin(slot))
        reply(Response())
      case .takeover:
        let slot = try activate(request)
        if request.active == false {
          input.end(slot, origin: origin(slot))
        } else {
          input.begin(slot)
        }
        reply(Response())
      case .windows:
        let slot = try slot(request)
        guard let displayID = displays.displayID(slot) else { throw DisplaydError.notOpen(slot) }
        let bounds = CGDisplayBounds(displayID)
        let display = Rect.enclosing(x: bounds.minX, y: bounds.minY, width: bounds.width, height: bounds.height)
        reply(Response(windows: WindowStack.onDisplay(onScreenWindows(), display: display, excludingPID: Int(getpid()))))
      case .raise:
        guard let pid = request.pid, let window = request.window, raiseWindow(pid: pid, window: window) else {
          throw DisplaydError.windowNotRaised(request.window)
        }
        Task {
          for _ in 0..<20 where !isFocused(pid: pid, window: window) {
            try? await Task.sleep(for: .milliseconds(25))
          }
          reply(Response())
        }
      case .screenshot:
        let slot = try activate(request)
        guard let displayID = displays.displayID(slot) else { throw DisplaydError.notOpen(slot) }
        let excluded = request.overlays == true ? [] : overlays.values.map { $0.window.windowNumber }
        let format = request.format ?? .png
        let quality = request.quality ?? 0.8
        Task {
          do {
            let image = try await screenshot(displayID, excludingWindows: excluded)
            let data = try encode(image, as: format, quality: quality)
            reply(Response(image: data.base64EncodedString(), mimeType: format == .png ? "image/png" : "image/jpeg"))
          } catch {
            reply(.failure("\(error)"))
          }
        }
      }
    } catch {
      reply(.failure("\(error)"))
    }
  }

  private func handleFrames(_ message: FrameSubscription, from connection: Connection) {
    guard let slot = message.slot else {
      if message.full == true { frames.requestFull(connection) }
      return
    }
    do {
      _ = try activate(slot)
    } catch {
      log("slot \(slot) viewer refused: \(error)")
      connection.close()
      return
    }
    Task {
      do {
        try await frames.subscribe(connection, slot: slot, fps: message.fps ?? 30, quality: message.quality ?? 0.6)
      } catch {
        log("slot \(slot) viewer refused: \(error)")
        connection.close()
      }
    }
  }

  @discardableResult
  private func open(_ slot: Int) throws -> ScreenInfo {
    let id = try displays.open(slot)
    if CGDisplayIsAsleep(id) != 0 || isSessionLocked() { awake.declareActivity() }
    refreshAssertion()
    _ = overlay(slot)
    placeOverlays()
    guard let info = info(slot) else { throw DisplaydError.notOpen(slot) }
    return info
  }

  private func close(_ slot: Int) {
    input.end(slot, origin: origin(slot))
    Task { await frames.stop(slot) }
    overlays.removeValue(forKey: slot)?.hide()
    displays.close(slot)
    refreshAssertion()
  }

  private func slot(_ request: Request) throws -> Int {
    guard let slot = request.slot, ScreenPool.isValid(slot) else { throw DisplaydError.invalidSlot(request.slot) }
    return slot
  }

  private func activate(_ request: Request) throws -> Int {
    try activate(try slot(request))
  }

  private func activate(_ slot: Int) throws -> Int {
    guard let info = info(slot) else { throw DisplaydError.notOpen(slot) }
    if !info.awake || info.displayAsleep || isSessionLocked() { try open(slot) }
    return slot
  }

  private func settledInfo(_ slot: Int) async -> ScreenInfo? {
    for _ in 0..<40 {
      if let info = info(slot), info.bounds.width > 0, !info.displayAsleep, nsScreen(for: info.displayID) != nil {
        placeOverlays()
        return info
      }
      try? await Task.sleep(for: .milliseconds(50))
    }
    return info(slot)
  }

  private func overlay(_ slot: Int) -> Overlay {
    if let overlay = overlays[slot] { return overlay }
    let overlay = Overlay()
    overlays[slot] = overlay
    return overlay
  }

  private func placeOverlays() {
    for (slot, overlay) in overlays {
      if let id = displays.displayID(slot), let screen = nsScreen(for: id) {
        overlay.place(on: screen.frame)
      } else {
        overlay.hide()
      }
    }
  }

  private func origin(_ slot: Int) -> CGPoint {
    displays.displayID(slot).map { CGDisplayBounds($0).origin } ?? .zero
  }

  private func info(_ slot: Int) -> ScreenInfo? {
    displays.info(slot, viewers: frames.viewers(slot))
  }

  private func refreshAssertion() {
    awake.hold(displays.anyAwake)
  }
}
