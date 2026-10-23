import DisplaydCore
import XCTest

final class PointerTrackerTests: XCTestCase {
  func testMoveClickAndRelease() {
    var pointer = PointerTracker()
    XCTAssertEqual(pointer.update(x: 10, y: 20, mask: 0, at: 0), [.move(Point(x: 10, y: 20))])
    XCTAssertEqual(pointer.update(x: 10, y: 20, mask: 1, at: 1), [.down(.left, Point(x: 10, y: 20), clicks: 1)])
    XCTAssertEqual(pointer.update(x: 10, y: 20, mask: 0, at: 1.1), [.up(.left, Point(x: 10, y: 20), clicks: 1)])
    XCTAssertEqual(pointer.update(x: 10, y: 20, mask: 0, at: 1.2), [])
  }

  func testDoubleClickCountsNearbyQuickPresses() {
    var pointer = PointerTracker(doubleClickInterval: 0.5)
    _ = pointer.update(x: 10, y: 10, mask: 1, at: 1)
    _ = pointer.update(x: 10, y: 10, mask: 0, at: 1.05)
    XCTAssertEqual(pointer.update(x: 12, y: 11, mask: 1, at: 1.2), [.down(.left, Point(x: 12, y: 11), clicks: 2)])
    XCTAssertEqual(pointer.update(x: 12, y: 11, mask: 0, at: 1.25), [.up(.left, Point(x: 12, y: 11), clicks: 2)])
    XCTAssertEqual(pointer.update(x: 12, y: 11, mask: 1, at: 2), [.down(.left, Point(x: 12, y: 11), clicks: 1)])
  }

  func testFarPressesAreSingleClicks() {
    var pointer = PointerTracker(doubleClickInterval: 0.5)
    _ = pointer.update(x: 10, y: 10, mask: 1, at: 1)
    _ = pointer.update(x: 10, y: 10, mask: 0, at: 1.05)
    XCTAssertEqual(pointer.update(x: 40, y: 10, mask: 1, at: 1.1), [.down(.left, Point(x: 40, y: 10), clicks: 1)])
  }

  func testDragAndRightClick() {
    var pointer = PointerTracker()
    _ = pointer.update(x: 0, y: 0, mask: 1, at: 0)
    XCTAssertEqual(pointer.update(x: 5, y: 5, mask: 1, at: 0.1), [.drag(.left, Point(x: 5, y: 5))])
    _ = pointer.update(x: 5, y: 5, mask: 0, at: 0.2)
    XCTAssertEqual(pointer.update(x: 5, y: 5, mask: 4, at: 0.3), [.down(.right, Point(x: 5, y: 5), clicks: 1)])
    XCTAssertEqual(pointer.update(x: 5, y: 5, mask: 0, at: 0.4), [.up(.right, Point(x: 5, y: 5), clicks: 1)])
  }

  func testWheelButtonsScrollOnPress() {
    var pointer = PointerTracker()
    XCTAssertEqual(pointer.update(x: 3, y: 4, mask: 8, at: 0), [.scroll(Point(x: 3, y: 4), lines: 3)])
    XCTAssertEqual(pointer.update(x: 3, y: 4, mask: 0, at: 0.01), [])
    XCTAssertEqual(pointer.update(x: 3, y: 4, mask: 16, at: 0.02), [.scroll(Point(x: 3, y: 4), lines: -3)])
  }

  func testReleaseAllLiftsHeldButtons() {
    var pointer = PointerTracker()
    _ = pointer.update(x: 7, y: 8, mask: 5, at: 0)
    XCTAssertEqual(pointer.releaseAll(), [.up(.left, Point(x: 7, y: 8), clicks: 1), .up(.right, Point(x: 7, y: 8), clicks: 1)])
    XCTAssertEqual(pointer.releaseAll(), [])
  }
}
