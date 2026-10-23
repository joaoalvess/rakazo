import AppKit
import CGVirtualDisplayPrivate
import DisplaydCore

private let displaysReconfigured: CGDisplayReconfigurationCallBack = { _, flags, info in
  guard let info, !flags.contains(.beginConfigurationFlag) else { return }
  let displays = Unmanaged<Displays>.fromOpaque(info).takeUnretainedValue()
  DispatchQueue.main.async { MainActor.assumeIsolated { displays.scheduleReconcile() } }
}

@MainActor
final class Displays {
  private struct Entry {
    var display: CGVirtualDisplay?
    var id: CGDirectDisplayID
    var awake: Bool
  }

  private var entries: [Int: Entry] = [:]
  private var reserved: CGVirtualDisplay?
  private var lastMainChange: (id: CGDirectDisplayID, at: Date)?
  private var reconcileScheduled = false
  var onReconfigure: (() -> Void)?

  init() {
    CGDisplayRegisterReconfigurationCallback(displaysReconfigured, Unmanaged.passUnretained(self).toOpaque())
    scheduleReconcile()
  }

  deinit {
    CGDisplayRemoveReconfigurationCallback(displaysReconfigured, Unmanaged.passUnretained(self).toOpaque())
  }

  var openSlots: [Int] { entries.keys.sorted() }
  var anyAwake: Bool { entries.values.contains { $0.awake } }

  func displayID(_ slot: Int) -> CGDirectDisplayID? {
    entries[slot]?.id
  }

  func open(_ slot: Int) throws -> CGDirectDisplayID {
    guard ScreenPool.isValid(slot) else { throw DisplaydError.invalidSlot(slot) }
    if let entry = entries[slot], Self.isOnline(entry.id) {
      entries[slot]?.awake = true
      return entry.id
    }
    let serial = ScreenPool.serial(slot)
    if let id = Self.online().first(where: { Self.isPoolDisplay($0, serial: serial) }) {
      entries[slot] = Entry(display: nil, id: id, awake: true)
      log("slot \(slot) adopted display \(id)")
      return id
    }
    let display = try Self.makeDisplay(serial: serial, name: "Rakazo Screen \(slot + 1)")
    entries[slot] = Entry(display: display, id: display.displayID, awake: true)
    log("slot \(slot) created display \(display.displayID)")
    return display.displayID
  }

  private static func makeDisplay(serial: UInt32, name: String) throws -> CGVirtualDisplay {
    let descriptor = CGVirtualDisplayDescriptor()
    descriptor.queue = .main
    descriptor.name = name
    descriptor.maxPixelsWide = UInt32(ScreenPool.width)
    descriptor.maxPixelsHigh = UInt32(ScreenPool.height)
    descriptor.sizeInMillimeters = CGSize(width: 338, height: 211)
    descriptor.serialNum = serial
    descriptor.productID = ScreenPool.productID
    descriptor.vendorID = ScreenPool.vendorID
    descriptor.terminationHandler = { _, _ in log("\(name) terminated") }
    guard let display = CGVirtualDisplay(descriptor: descriptor) else { throw DisplaydError.createFailed(name) }
    let settings = CGVirtualDisplaySettings()
    settings.hiDPI = 0
    settings.modes = [
      CGVirtualDisplayMode(width: UInt32(ScreenPool.width), height: UInt32(ScreenPool.height), refreshRate: ScreenPool.refreshRate)
    ]
    guard display.apply(settings), display.displayID != 0 else { throw DisplaydError.createFailed(name) }
    return display
  }

  func close(_ slot: Int) {
    guard entries.removeValue(forKey: slot) != nil else { return }
    log("slot \(slot) closed")
  }

  func setAwake(_ slot: Int, _ awake: Bool) {
    entries[slot]?.awake = awake
  }

  func info(_ slot: Int, viewers: Int) -> ScreenInfo? {
    guard let entry = entries[slot] else { return nil }
    let bounds = CGDisplayBounds(entry.id)
    return ScreenInfo(
      slot: slot,
      displayID: entry.id,
      bounds: Rect.enclosing(x: bounds.minX, y: bounds.minY, width: bounds.width, height: bounds.height),
      awake: entry.awake,
      displayAsleep: CGDisplayIsAsleep(entry.id) != 0,
      adopted: entry.display == nil,
      viewers: viewers
    )
  }

  fileprivate func scheduleReconcile() {
    guard !reconcileScheduled else { return }
    reconcileScheduled = true
    Task { @MainActor in
      try? await Task.sleep(for: .milliseconds(300))
      reconcileScheduled = false
      reconcile()
    }
  }

  private func reconcile() {
    for slot in openSlots {
      guard let entry = entries[slot], !Self.isOnline(entry.id) else { continue }
      log("slot \(slot) display \(entry.id) went offline")
      entries[slot] = nil
      do {
        _ = try open(slot)
        entries[slot]?.awake = entry.awake
      } catch {
        log("slot \(slot) could not come back: \(error)")
      }
    }
    keepMainOffScreens()
    onReconfigure?()
  }

  private func keepMainOffScreens() {
    let active = Self.active()
    if MainDisplay.needsReserved(active) {
      if reserved == nil, !active.contains(where: { $0.kind == .reserved }) {
        do {
          reserved = try Self.makeDisplay(serial: ScreenPool.reservedSerial, name: "Rakazo Main")
          log("reserved main display \(reserved?.displayID ?? 0) created")
        } catch {
          log("reserved main display failed: \(error)")
        }
        return
      }
    } else if let display = reserved {
      reserved = nil
      log("reserved main display \(display.displayID) released")
    }
    guard let main = MainDisplay.preferred(active), CGMainDisplayID() != main else { return }
    if let last = lastMainChange, last.id == main, Date().timeIntervalSince(last.at) < 5 { return }
    lastMainChange = (main, Date())
    var config: CGDisplayConfigRef?
    guard CGBeginDisplayConfiguration(&config) == .success, let config else { return }
    for (id, x) in MainDisplay.arrangement(active, main: main) {
      CGConfigureDisplayOrigin(config, id, Int32(x), 0)
    }
    let result = CGCompleteDisplayConfiguration(config, .forSession)
    log("main display \(main): \(result == .success ? "set" : "failed \(result.rawValue)")")
  }

  static func active() -> [ActiveDisplay] {
    var ids = [CGDirectDisplayID](repeating: 0, count: 32)
    var count: UInt32 = 0
    CGGetActiveDisplayList(32, &ids, &count)
    return ids.prefix(Int(count)).map { id in
      let bounds = CGDisplayBounds(id)
      return ActiveDisplay(id: id, kind: kind(of: id), x: Int(bounds.minX), width: Int(bounds.width))
    }
  }

  static func kind(of id: CGDirectDisplayID) -> ActiveDisplay.Kind {
    if CGDisplayIsBuiltin(id) != 0 { return .builtin }
    guard CGDisplayVendorNumber(id) == ScreenPool.vendorID, CGDisplayModelNumber(id) == ScreenPool.productID else { return .other }
    let serial = CGDisplaySerialNumber(id)
    if serial == ScreenPool.reservedSerial { return .reserved }
    return ScreenPool.slot(serial: serial) == nil ? .other : .screen
  }

  static func online() -> [CGDirectDisplayID] {
    var ids = [CGDirectDisplayID](repeating: 0, count: 32)
    var count: UInt32 = 0
    CGGetOnlineDisplayList(32, &ids, &count)
    return Array(ids.prefix(Int(count)))
  }

  static func isOnline(_ id: CGDirectDisplayID) -> Bool {
    online().contains(id)
  }

  static func isPoolDisplay(_ id: CGDirectDisplayID, serial: UInt32) -> Bool {
    CGDisplayVendorNumber(id) == ScreenPool.vendorID && CGDisplayModelNumber(id) == ScreenPool.productID
      && CGDisplaySerialNumber(id) == serial
  }
}
