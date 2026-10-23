import DisplaydCore
import XCTest

final class ProtocolTests: XCTestCase {
  func testDecodesAnInputRequest() throws {
    let line = #"{"id":7,"op":"input","slot":2,"events":[{"t":"p","x":10,"y":20,"m":1},{"t":"k","s":65293,"d":true},{"t":"text","s":"João"}]}"#
    let request = try JSONDecoder().decode(Request.self, from: Data(line.utf8))
    XCTAssertEqual(request.id, 7)
    XCTAssertEqual(request.op, .input)
    XCTAssertEqual(request.slot, 2)
    XCTAssertEqual(request.events, [.pointer(x: 10, y: 20, mask: 1), .key(keysym: 0xff0d, down: true), .text("João")])
  }

  func testDecodesAnOverlayRequest() throws {
    let line = #"{"op":"overlay","slot":0,"cursor":{"x":12.5,"y":40},"click":{"x":12.5,"y":40},"typing":true}"#
    let request = try JSONDecoder().decode(Request.self, from: Data(line.utf8))
    XCTAssertEqual(request.cursor, Point(x: 12.5, y: 40))
    XCTAssertEqual(request.click, Point(x: 12.5, y: 40))
    XCTAssertEqual(request.typing, true)
    XCTAssertNil(request.cursorHidden)
  }

  func testDecodesARaiseRequest() throws {
    let request = try JSONDecoder().decode(Request.self, from: Data(#"{"op":"raise","pid":8,"window":568}"#.utf8))
    XCTAssertEqual(request.op, .raise)
    XCTAssertEqual(request.pid, 8)
    XCTAssertEqual(request.window, 568)
  }

  func testRejectsUnknownOperationsAndEvents() {
    XCTAssertThrowsError(try JSONDecoder().decode(Request.self, from: Data(#"{"op":"reboot"}"#.utf8)))
    XCTAssertThrowsError(try JSONDecoder().decode(Request.self, from: Data(#"{"op":"input","events":[{"t":"z"}]}"#.utf8)))
  }

  func testResponseLineOmitsMissingFields() throws {
    let line = Response(id: 3, screen: ScreenInfo(
      slot: 1,
      displayID: 9,
      bounds: Rect(x: -1280, y: 0, width: 1280, height: 800),
      awake: true,
      displayAsleep: false,
      adopted: false,
      viewers: 2
    )).line()
    XCTAssertEqual(line.last, 0x0A)
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: line) as? [String: Any])
    XCTAssertEqual(Set(object.keys), ["id", "ok", "screen"])
    let screen = try XCTUnwrap(object["screen"] as? [String: Any])
    XCTAssertEqual(screen["displayID"] as? Int, 9)
    XCTAssertEqual((screen["bounds"] as? [String: Any])?["x"] as? Int, -1280)
  }

  func testFailureCarriesTheError() throws {
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Response.failure("slot 3 is not open", id: 4).line()) as? [String: Any])
    XCTAssertEqual(object["ok"] as? Bool, false)
    XCTAssertEqual(object["error"] as? String, "slot 3 is not open")
    XCTAssertEqual(object["id"] as? Int, 4)
  }

  func testLineBufferSplitsAndKeepsPartialLines() {
    var buffer = LineBuffer()
    XCTAssertEqual(buffer.append(Data("{\"a\":1}\n{\"b\"".utf8)), [Data("{\"a\":1}".utf8)])
    XCTAssertEqual(buffer.append(Data(":2}\n\n".utf8)), [Data("{\"b\":2}".utf8), Data()])
  }

  func testFrameMessagesCarryALengthPrefixedHeader() throws {
    let header = FrameHeader(seq: 4, width: 1280, height: 800, full: false, rects: [FrameRect(x: 16, y: 32, width: 64, height: 48, size: 3)])
    let message = try FrameCodec.encode(header, payload: Data([1, 2, 3]))
    let length = Int(message[0]) << 24 | Int(message[1]) << 16 | Int(message[2]) << 8 | Int(message[3])
    XCTAssertEqual(message.count, 4 + length + 3)
    XCTAssertEqual(FrameCodec.header(of: message), header)
    XCTAssertEqual(Array(message.suffix(3)), [1, 2, 3])
  }

  func testScreenPoolSerials() {
    XCTAssertEqual(ScreenPool.serial(0), 0x5400)
    XCTAssertEqual(ScreenPool.serial(8), 0x5408)
    XCTAssertEqual(ScreenPool.slot(serial: 0x5408), 8)
    XCTAssertNil(ScreenPool.slot(serial: ScreenPool.reservedSerial))
    XCTAssertNil(ScreenPool.slot(serial: 0x53FF))
    XCTAssertTrue(ScreenPool.isValid(15))
    XCTAssertFalse(ScreenPool.isValid(16))
    XCTAssertFalse(ScreenPool.isValid(-1))
  }
}
