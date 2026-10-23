import DisplaydCore
import XCTest

final class WindowStackTests: XCTestCase {
  private let display = Rect(x: 1280, y: 0, width: 1280, height: 800)

  func testKeepsTheWindowsOnTheDisplayFrontToBack() {
    let windows = [
      WindowInfo(owner: "Finder", pid: 11, layer: 101, bounds: Rect(x: 1500, y: 120, width: 200, height: 300)),
      WindowInfo(owner: "universalAccessAuthWarn", pid: 10, layer: 0, bounds: Rect(x: 1700, y: 150, width: 460, height: 200)),
      WindowInfo(owner: "Finder", pid: 11, layer: 0, bounds: Rect(x: 1460, y: 100, width: 920, height: 430)),
      WindowInfo(owner: "Google Chrome", pid: 12, layer: 0, bounds: Rect(x: 1280, y: 30, width: 1280, height: 770)),
      WindowInfo(owner: "Google Chrome", pid: 12, layer: 0, bounds: Rect(x: 0, y: 30, width: 1280, height: 770)),
    ]
    XCTAssertEqual(WindowStack.onDisplay(windows, display: display, excludingPID: 99), Array(windows.prefix(4)))
  }

  func testDropsOverlaysTheDockTheMenuBarNotificationsWidgetsAndShields() {
    let windows = [
      WindowInfo(owner: "rakazo-displayd", pid: 99, layer: 3, bounds: display),
      WindowInfo(owner: "Central de Notificações", pid: 24, layer: 21, bounds: display),
      WindowInfo(owner: "Central de Notificações", pid: 24, layer: -2_147_483_601, bounds: Rect(x: 1288, y: 218, width: 360, height: 180)),
      WindowInfo(owner: "Dock", pid: 20, layer: 20, bounds: display),
      WindowInfo(owner: "Window Server", pid: 21, layer: 24, bounds: Rect(x: 1280, y: 0, width: 1280, height: 30)),
      WindowInfo(owner: "Control Center", pid: 22, layer: 25, bounds: Rect(x: 2400, y: 0, width: 40, height: 30)),
      WindowInfo(owner: "loginwindow", pid: 23, layer: 2_147_483_628, bounds: display),
    ]
    XCTAssertEqual(WindowStack.onDisplay(windows, display: display, excludingPID: 99), [])
  }

  func testEncodesTheWindowsInAResponse() throws {
    let window = WindowInfo(owner: "Finder", pid: 11, layer: 0, bounds: Rect(x: 1460, y: 100, width: 920, height: 430))
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Response(windows: [window]).line()) as? [String: Any])
    let windows = try XCTUnwrap(object["windows"] as? [[String: Any]])
    XCTAssertEqual(windows.first?["owner"] as? String, "Finder")
    XCTAssertEqual(windows.first?["pid"] as? Int, 11)
  }
}
