import Foundation
import IOKit.pwr_mgt

@MainActor
final class Awake {
  private let name = "Rakazo screens" as CFString
  private var assertion: IOPMAssertionID = 0
  private var activity: IOPMAssertionID = 0

  func hold(_ on: Bool) {
    if on, assertion == 0 {
      let result = IOPMAssertionCreateWithName(
        "PreventUserIdleDisplaySleep" as CFString,
        IOPMAssertionLevel(kIOPMAssertionLevelOn),
        name,
        &assertion
      )
      log("display sleep assertion \(result == kIOReturnSuccess ? "held" : "failed \(result)")")
    } else if !on, assertion != 0 {
      IOPMAssertionRelease(assertion)
      assertion = 0
      log("display sleep assertion released")
    }
  }

  func declareActivity() {
    let result = IOPMAssertionDeclareUserActivity(name, kIOPMUserActiveLocal, &activity)
    if result != kIOReturnSuccess { log("declare user activity failed \(result)") }
  }
}
