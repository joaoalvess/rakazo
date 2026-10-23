public enum Modifier: Hashable, Sendable {
  case shift, control, option, command
}

public enum KeyAction: Equatable, Sendable {
  case none
  case keyCode(UInt16, down: Bool, modifiers: Set<Modifier>)
  case text(String)
}

public struct KeyMapper: Sendable {
  public private(set) var modifiers: Set<Modifier> = []

  public init() {}

  public mutating func map(keysym: UInt32, down: Bool) -> KeyAction {
    if let modifier = Self.modifierKeys[keysym] {
      if down {
        modifiers.insert(modifier)
      } else {
        modifiers.remove(modifier)
      }
      return .none
    }
    if let code = Self.specialKeys[keysym] {
      return .keyCode(code, down: down, modifiers: modifiers)
    }
    guard let character = Self.character(keysym) else { return .none }
    if !modifiers.isDisjoint(with: [.command, .control]), let lower = character.lowercased().first, let code = Self.ansiKeys[lower] {
      return .keyCode(code, down: down, modifiers: modifiers)
    }
    return down ? .text(String(character)) : .none
  }

  public mutating func reset() {
    modifiers.removeAll()
  }

  static func character(_ keysym: UInt32) -> Character? {
    let value = keysym >= 0x0100_0000 ? keysym - 0x0100_0000 : keysym
    guard keysym >= 0x0100_0000 || (0x20...0x7e).contains(value) || (0xa0...0xff).contains(value),
      let scalar = Unicode.Scalar(value)
    else { return nil }
    return Character(scalar)
  }

  static let modifierKeys: [UInt32: Modifier] = [
    0xffe1: .shift, 0xffe2: .shift, 0xffe3: .control, 0xffe4: .control, 0xffe7: .command, 0xffe8: .command,
    0xffeb: .command, 0xffec: .command, 0xffe9: .option, 0xffea: .option,
  ]

  static let specialKeys: [UInt32: UInt16] = [
    0xff0d: 36, 0xff8d: 76, 0xff08: 51, 0xff09: 48, 0xfe20: 48, 0xff1b: 53, 0xffff: 117, 0xff51: 123, 0xff52: 126,
    0xff53: 124, 0xff54: 125, 0xff50: 115, 0xff57: 119, 0xff55: 116, 0xff56: 121, 0xffbe: 122, 0xffbf: 120,
    0xffc0: 99, 0xffc1: 118, 0xffc2: 96, 0xffc3: 97, 0xffc4: 98, 0xffc5: 100, 0xffc6: 101, 0xffc7: 109,
    0xffc8: 103, 0xffc9: 111,
  ]

  static let ansiKeys: [Character: UInt16] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
    "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
    "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38,
    "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50, " ": 49,
  ]
}
