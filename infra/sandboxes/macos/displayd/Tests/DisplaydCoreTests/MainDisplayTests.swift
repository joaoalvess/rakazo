import DisplaydCore
import XCTest

final class MainDisplayTests: XCTestCase {
  private let builtin = ActiveDisplay(id: 1, kind: .builtin, x: 0, width: 1440)
  private let screen = ActiveDisplay(id: 20, kind: .screen, x: -1280, width: 1280)
  private let otherScreen = ActiveDisplay(id: 21, kind: .screen, x: -2560, width: 1280)
  private let reserved = ActiveDisplay(id: 30, kind: .reserved, x: 1280, width: 1280)

  func testOnlyBotScreensNeedTheReservedDisplay() {
    XCTAssertTrue(MainDisplay.needsReserved([screen, otherScreen]))
    XCTAssertTrue(MainDisplay.needsReserved([screen, reserved]))
    XCTAssertFalse(MainDisplay.needsReserved([builtin, screen]))
    XCTAssertFalse(MainDisplay.needsReserved([ActiveDisplay(id: 5, kind: .other, x: 0, width: 1920), screen]))
    XCTAssertFalse(MainDisplay.needsReserved([reserved]))
    XCTAssertFalse(MainDisplay.needsReserved([]))
  }

  func testPrefersTheBuiltInThenAnotherDisplayThenTheReservedOne() {
    XCTAssertEqual(MainDisplay.preferred([screen, reserved, builtin]), 1)
    XCTAssertEqual(MainDisplay.preferred([screen, ActiveDisplay(id: 5, kind: .other, x: 0, width: 1920), reserved]), 5)
    XCTAssertEqual(MainDisplay.preferred([screen, reserved]), 30)
    XCTAssertNil(MainDisplay.preferred([screen, otherScreen]))
  }

  func testArrangesTheMainDisplayAtTheOriginAndTheRestToItsRight() {
    let origins = MainDisplay.arrangement([screen, otherScreen, reserved], main: 30)
    XCTAssertEqual(origins, [30: 0, 21: 1280, 20: 2560])
  }

  func testArrangementNeedsTheMainDisplay() {
    XCTAssertEqual(MainDisplay.arrangement([screen], main: 30), [:])
  }
}
