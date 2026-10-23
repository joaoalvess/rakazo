import AppKit
import DisplaydCore

setvbuf(stdout, nil, _IOLBF, 0)
signal(SIGPIPE, SIG_IGN)

let arguments = Array(CommandLine.arguments.dropFirst())

func option(_ name: String) -> String? {
  guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
  return arguments[index + 1]
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
var server: Server?

Task { @MainActor in
  switch arguments.first ?? "serve" {
  case "serve":
    do {
      let running = Server()
      try running.start(directory: option("--dir") ?? Server.defaultDirectory)
      server = running
    } catch {
      log("\(error)")
      exit(1)
    }
  case "selftest":
    let slots = (option("--slots") ?? "0,1").split(separator: ",").compactMap { Int($0) }
    exit(await selftest(output: option("--out") ?? FileManager.default.currentDirectoryPath, slots: slots))
  case "permissions":
    let permissions = Permissions.current(prompt: arguments.contains("--prompt"))
    if let data = try? JSONEncoder().encode(permissions) { print(String(decoding: data, as: UTF8.self)) }
    exit(0)
  default:
    print("usage: rakazo-displayd serve [--dir <path>] | selftest [--out <dir>] [--slots 0,1] | permissions [--prompt]")
    exit(2)
  }
}
app.run()
