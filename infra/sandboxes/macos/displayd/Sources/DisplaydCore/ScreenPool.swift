public enum ScreenPool {
  public static let vendorID: UInt32 = 0x3456
  public static let productID: UInt32 = 0x1234
  public static let firstSerial: UInt32 = 0x5400
  public static let slotCount = 16
  public static let width = 1280
  public static let height = 800
  public static let refreshRate = 60.0

  public static func isValid(_ slot: Int) -> Bool {
    (0..<slotCount).contains(slot)
  }

  public static func serial(_ slot: Int) -> UInt32 {
    firstSerial + UInt32(slot)
  }
}
