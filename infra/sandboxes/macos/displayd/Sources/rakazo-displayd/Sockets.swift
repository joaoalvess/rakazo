import DisplaydCore
import Foundation

final class Connection: FrameSink, @unchecked Sendable {
  private let fd: Int32
  private let source: DispatchSourceRead
  private let lock = NSLock()
  private var lines = LineBuffer()
  private var closed = false

  init(fd: Int32, queue: DispatchQueue) {
    self.fd = fd
    var on: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    var timeout = timeval(tv_sec: 2, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
  }

  var isOpen: Bool {
    lock.withLock { !closed }
  }

  func start(onLine: @escaping @Sendable (Connection, Data) -> Void, onClose: @escaping @Sendable (Connection) -> Void) {
    source.setEventHandler { [self] in
      var buffer = [UInt8](repeating: 0, count: 65536)
      let count = read(fd, &buffer, buffer.count)
      guard count > 0 else {
        close()
        onClose(self)
        return
      }
      for line in lines.append(Data(buffer[0..<count])) {
        onLine(self, line)
      }
    }
    source.setCancelHandler { [fd] in Darwin.close(fd) }
    source.resume()
  }

  func send(_ data: Data) -> Bool {
    lock.withLock {
      guard !closed else { return false }
      return data.withUnsafeBytes { raw -> Bool in
        guard let base = raw.baseAddress else { return true }
        var offset = 0
        while offset < raw.count {
          let written = write(fd, base + offset, raw.count - offset)
          if written < 0, errno == EINTR { continue }
          if written <= 0 { return false }
          offset += written
        }
        return true
      }
    }
  }

  func close() {
    lock.withLock {
      guard !closed else { return }
      closed = true
      source.cancel()
    }
  }
}

final class UnixListener {
  private let source: DispatchSourceRead

  init(path: String, queue: DispatchQueue, onAccept: @escaping @Sendable (Connection) -> Void) throws {
    unlink(path)
    var address = try unixAddress(path)
    let listening = socket(AF_UNIX, SOCK_STREAM, 0)
    guard listening >= 0 else { throw DisplaydError.socket("socket failed: \(errno)") }
    let bound = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listening, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    guard bound == 0, chmod(path, 0o600) == 0, listen(listening, 16) == 0 else {
      Darwin.close(listening)
      throw DisplaydError.socket("could not listen on \(path): \(errno)")
    }
    source = DispatchSource.makeReadSource(fileDescriptor: listening, queue: queue)
    source.setEventHandler {
      let client = accept(listening, nil, nil)
      guard client >= 0 else { return }
      onAccept(Connection(fd: client, queue: queue))
    }
    source.resume()
  }
}

func unixAddress(_ path: String) throws -> sockaddr_un {
  var address = sockaddr_un()
  address.sun_family = sa_family_t(AF_UNIX)
  let bytes = Array(path.utf8)
  guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { throw DisplaydError.socket("socket path too long: \(path)") }
  withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
  return address
}

func isListening(_ path: String) -> Bool {
  guard var address = try? unixAddress(path) else { return false }
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  guard fd >= 0 else { return false }
  defer { Darwin.close(fd) }
  let result = withUnsafePointer(to: &address) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
  }
  return result == 0
}
