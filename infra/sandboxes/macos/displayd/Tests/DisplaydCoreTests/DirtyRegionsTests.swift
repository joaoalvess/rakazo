import DisplaydCore
import XCTest

final class DirtyRegionsTests: XCTestCase {
  func testNoDirtyRectsMeansUnchanged() {
    XCTAssertEqual(DirtyRegions.plan([], width: 1280, height: 800), .unchanged)
  }

  func testAlignsOutwardAndClampsToTheScreen() {
    let plan = DirtyRegions.plan([Rect(x: 1270, y: 5, width: 20, height: 3)], width: 1280, height: 800)
    XCTAssertEqual(plan, .rects([Rect(x: 1264, y: 0, width: 16, height: 16)]))
  }

  func testMergesTouchingRects() {
    let plan = DirtyRegions.plan(
      [Rect(x: 0, y: 0, width: 10, height: 10), Rect(x: 20, y: 0, width: 10, height: 10), Rect(x: 600, y: 600, width: 4, height: 4)],
      width: 1280,
      height: 800
    )
    XCTAssertEqual(plan, .rects([Rect(x: 0, y: 0, width: 32, height: 16), Rect(x: 592, y: 592, width: 16, height: 16)]))
  }

  func testMergeChainsThroughEarlierRects() {
    let plan = DirtyRegions.plan(
      [Rect(x: 0, y: 0, width: 16, height: 16), Rect(x: 64, y: 0, width: 16, height: 16), Rect(x: 16, y: 0, width: 48, height: 16)],
      width: 1280,
      height: 800
    )
    XCTAssertEqual(plan, .rects([Rect(x: 0, y: 0, width: 80, height: 16)]))
  }

  func testLargeChangesSendAFullFrame() {
    XCTAssertEqual(DirtyRegions.plan([Rect(x: 0, y: 0, width: 1280, height: 400)], width: 1280, height: 800), .full)
  }

  func testTooManyRectsSendAFullFrame() {
    let rects = (0..<30).map { Rect(x: $0 * 40, y: ($0 % 2) * 200, width: 4, height: 4) }
    XCTAssertEqual(DirtyRegions.plan(rects, width: 1280, height: 800), .full)
  }

  func testRectsOutsideTheScreenAreIgnored() {
    XCTAssertEqual(DirtyRegions.plan([Rect(x: 1300, y: 900, width: 10, height: 10)], width: 1280, height: 800), .unchanged)
  }

  func testEnclosingRoundsOutward() {
    XCTAssertEqual(Rect.enclosing(x: 1.5, y: 2.2, width: 3.1, height: 0.5), Rect(x: 1, y: 2, width: 4, height: 1))
  }
}
