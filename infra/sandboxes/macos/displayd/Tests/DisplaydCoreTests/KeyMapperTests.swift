import DisplaydCore
import XCTest

final class KeyMapperTests: XCTestCase {
  func testPrintableKeysTypeTextOnKeyDownOnly() {
    var keys = KeyMapper()
    XCTAssertEqual(keys.map(keysym: 0x61, down: true), .text("a"))
    XCTAssertEqual(keys.map(keysym: 0x61, down: false), .none)
  }

  func testLatin1AndUnicodeKeysymsTypeTheirCharacter() {
    var keys = KeyMapper()
    XCTAssertEqual(keys.map(keysym: 0xe7, down: true), .text("ç"))
    XCTAssertEqual(keys.map(keysym: 0x0100_20ac, down: true), .text("€"))
  }

  func testSpecialKeysPostKeyCodes() {
    var keys = KeyMapper()
    XCTAssertEqual(keys.map(keysym: 0xff0d, down: true), .keyCode(36, down: true, modifiers: []))
    XCTAssertEqual(keys.map(keysym: 0xff08, down: false), .keyCode(51, down: false, modifiers: []))
  }

  func testModifiersAreTrackedAndApplied() {
    var keys = KeyMapper()
    XCTAssertEqual(keys.map(keysym: 0xffe1, down: true), .none)
    XCTAssertEqual(keys.map(keysym: 0xff09, down: true), .keyCode(48, down: true, modifiers: [.shift]))
    XCTAssertEqual(keys.map(keysym: 0x41, down: true), .text("A"))
    XCTAssertEqual(keys.map(keysym: 0xffe1, down: false), .none)
    XCTAssertEqual(keys.modifiers, [])
  }

  func testCommandShortcutsUseTheLetterKeyCode() {
    var keys = KeyMapper()
    _ = keys.map(keysym: 0xffeb, down: true)
    XCTAssertEqual(keys.map(keysym: 0x76, down: true), .keyCode(9, down: true, modifiers: [.command]))
    _ = keys.map(keysym: 0xffe1, down: true)
    XCTAssertEqual(keys.map(keysym: 0x5a, down: true), .keyCode(6, down: true, modifiers: [.command, .shift]))
  }

  func testControlAndMetaMapToMacModifiers() {
    var keys = KeyMapper()
    _ = keys.map(keysym: 0xffe3, down: true)
    _ = keys.map(keysym: 0xffe7, down: true)
    _ = keys.map(keysym: 0xffe9, down: true)
    XCTAssertEqual(keys.modifiers, [.control, .command, .option])
    keys.reset()
    XCTAssertEqual(keys.modifiers, [])
  }

  func testUnknownKeysymsAreIgnored() {
    var keys = KeyMapper()
    XCTAssertEqual(keys.map(keysym: 0xff13, down: true), .none)
  }
}
