import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const harness = String.raw`
import Foundation
import ApplicationServices

enum Failure: Error { case expected, assertion(String) }
func require(_ condition: Bool, _ message: String) throws {
    if !condition { throw Failure.assertion(message) }
}
func mustFail(_ operation: () throws -> Void) throws {
    do { try operation() } catch Failure.expected { return }
    throw Failure.assertion("Operation must report its failure")
}
@main struct BackgroundInputTests {
    static func main() throws {
        let identifier: UInt32 = 0x12345678
        var events: [[UInt8]] = []
        let session = MailBackgroundInput(windowID: identifier, post: { events.append($0) }, isFrontmost: { false })
        let result = try session.perform {
            try require(events.map { $0[8] } == [13, 1, 2], "Prepare input before pasting")
            try require(events[0][138] == 1, "Activate only the target's internal responder")
            return "verified"
        }
        try require(result == "verified" && events.count == 4 && events[3][138] == 2, "Restore after success")
        for event in events {
            let target = (0..<4).reduce(UInt32(0)) { $0 | UInt32(event[60 + $1]) << ($1 * 8) }
            try require(event.count == 248 && event[4] == 248 && target == identifier, "Every record must address the same window")
        }
        events = []
        try mustFail { try session.perform { throw Failure.expected } }
        try require(events.count == 4 && events.last?[138] == 2, "Restore after body failure")

        events = []
        var operated = false
        let broken = MailBackgroundInput(windowID: identifier, post: { event in
            events.append(event)
            if events.count == 2 { throw Failure.expected }
        }, isFrontmost: { false })
        try mustFail { try broken.perform { operated = true } }
        try require(!operated && events.count == 3 && events.last?[138] == 2, "Restore partially delivered setup; never paste")

        events = []
        let uncertain = MailBackgroundInput(windowID: identifier, post: { event in
            events.append(event)
            if event[8] == 13 && event[138] == 2 { throw Failure.expected }
        }, isFrontmost: { false })
        try mustFail { try uncertain.perform {} }
        try require(events.count == 4, "Failed cleanup must not claim success or dispatch twice")

        events = []
        var frontmost = true
        let foreground = MailBackgroundInput(windowID: identifier, post: { events.append($0) }, isFrontmost: { frontmost })
        try foreground.perform { operated = true }
        try require(events.isEmpty, "Do not alter an already active Mail window")
        frontmost = false
        try foreground.perform { frontmost = true }
        try require(events.count == 3, "Do not deactivate Mail after the user activates it")

        let frame = CGRect(x: 10, y: 20, width: 640, height: 480)
        let window: [String: Any] = [kCGWindowOwnerPID as String: Int32(123), kCGWindowLayer as String: 0,
            kCGWindowBounds as String: frame.dictionaryRepresentation, kCGWindowNumber as String: identifier]
        func match(_ entries: [[String: Any]]) -> UInt32? {
            matchingWindowID(entries, frame: frame, title: "Cheshi-test", pid: 123)
        }
        try require(match([window]) == identifier, "Resolve a unique window without screen-recording permission")
        try require(match([window, window]) == nil, "Ambiguous windows must wait instead of receiving input")
        var unrelated = window
        unrelated[kCGWindowOwnerPID as String] = Int32(456)
        try require(match([unrelated]) == nil, "Do not target a different application")
        unrelated = window
        unrelated[kCGWindowName as String] = "An unrelated draft"
        try require(match([unrelated]) == nil, "Reject a known different title")
        unrelated = window
        unrelated[kCGWindowLayer as String] = 101
        try require(match([unrelated]) == nil, "Do not route input to a menu")
        print("background-input: success, body failure, partial setup, cleanup failure, foreground, user activation")
    }
}
`;

test.skipIf(process.platform !== 'darwin')('native background input restores partial and completed sessions without changing user activation', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cheshi-mail-background-input-'));
  try {
    const source = path.join(directory, 'BackgroundInputTests.swift');
    const executable = path.join(directory, 'background-input-tests');
    writeFileSync(source, harness);
    const compiled = spawnSync('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library',
      '-DMAIL_BACKGROUND_INPUT_TESTS', '-module-cache-path', path.join(tmpdir(), 'cheshi-mail-swift-cache'),
      path.join(root, 'desktop/native/apple-mail/MailPaste.swift'), source, '-o', executable], { encoding: 'utf8', timeout: 60_000 });
    expect(compiled.error).toBeUndefined();
    expect(compiled.stderr).toBe('');
    expect(compiled.status).toBe(0);
    const result = spawnSync(executable, [], { encoding: 'utf8', timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('background-input: success');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 75_000);
