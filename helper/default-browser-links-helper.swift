// Default Browser Links' native helper (Chrome native messaging).
// Opens web links in the macOS default browser and reports which app that is.
//
//   {"type":"ping"}             -> {"ok":true, "defaultBrowser":{…}, "host":{…}, "defaultIsHost":false}
//   {"type":"open","url":"…"}   -> {"ok":true} or {"ok":false,"error":"…"}
//
// Set DBL_DRY_RUN=<file> to append URLs to that file instead of opening them (tests).
import AppKit
import Foundation

let version = 1

func readMessage() -> [String: Any]? {
  let header = FileHandle.standardInput.readData(ofLength: 4)
  guard header.count == 4 else { return nil }
  let length = header.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
  let body = FileHandle.standardInput.readData(ofLength: Int(length))
  guard body.count == Int(length) else { return nil }
  return (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
}

func send(_ object: [String: Any]) {
  let body = try! JSONSerialization.data(withJSONObject: object)
  var length = UInt32(body.count)
  FileHandle.standardOutput.write(Data(bytes: &length, count: 4))
  FileHandle.standardOutput.write(body)
}

func defaultBrowser() -> URL? {
  NSWorkspace.shared.urlForApplication(toOpen: URL(string: "https://example.com/")!)
}

// The browser that launched this helper is its parent process.
func hostBrowser() -> URL? {
  NSRunningApplication(processIdentifier: getppid())?.bundleURL
}

func sameApp(_ a: URL?, _ b: URL?) -> Bool {
  guard let a, let b else { return false }
  if a.resolvingSymlinksInPath().standardizedFileURL == b.resolvingSymlinksInPath().standardizedFileURL { return true }
  guard let idA = Bundle(url: a)?.bundleIdentifier, let idB = Bundle(url: b)?.bundleIdentifier else { return false }
  return idA == idB
}

func describe(_ app: URL?) -> [String: Any]? {
  guard let app else { return nil }
  var name = FileManager.default.displayName(atPath: app.path)
  if name.hasSuffix(".app") { name.removeLast(4) }
  return ["name": name, "bundleId": Bundle(url: app)?.bundleIdentifier ?? "", "path": app.path]
}

func open(_ urlString: String?) -> [String: Any] {
  guard let urlString, let url = URL(string: urlString),
        let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
    return ["ok": false, "error": "bad-url"]
  }
  guard let browser = defaultBrowser() else { return ["ok": false, "error": "no-default-browser"] }
  // Handing the link to ourselves would just bring it back.
  if sameApp(browser, hostBrowser()) { return ["ok": false, "error": "default-is-host"] }

  if let log = ProcessInfo.processInfo.environment["DBL_DRY_RUN"], !log.isEmpty {
    let line = Data((urlString + "\n").utf8)
    if let handle = FileHandle(forWritingAtPath: log) {
      handle.seekToEndOfFile()
      handle.write(line)
      handle.closeFile()
    } else {
      FileManager.default.createFile(atPath: log, contents: line)
    }
    return ["ok": true, "dryRun": true]
  }

  let done = DispatchSemaphore(value: 0)
  var failure: Error?
  NSWorkspace.shared.open([url], withApplicationAt: browser, configuration: NSWorkspace.OpenConfiguration()) { _, error in
    failure = error
    done.signal()
  }
  if done.wait(timeout: .now() + 10) == .timedOut { return ["ok": false, "error": "timeout"] }
  if let failure { return ["ok": false, "error": failure.localizedDescription] }
  return ["ok": true]
}

while let message = readMessage() {
  switch message["type"] as? String {
  case "ping":
    let browser = defaultBrowser()
    let host = hostBrowser()
    var reply: [String: Any] = ["ok": true, "version": version, "defaultIsHost": sameApp(browser, host)]
    if let d = describe(browser) { reply["defaultBrowser"] = d }
    if let h = describe(host) { reply["host"] = h }
    send(reply)
  case "open":
    send(open(message["url"] as? String))
  default:
    send(["ok": false, "error": "unknown request"])
  }
}
