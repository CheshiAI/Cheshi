import Foundation
import EventKit

private func sendCalendarChange(_ event: String) {
    FileHandle.standardOutput.write(Data((event + "\n").utf8))
}

/// Keeps an EventKit store alive without polling or requesting access.
/// Closing the parent's stdin pipe also terminates this observer.
@MainActor
func watchCalendarChanges() async {
    let store = EKEventStore()
    let center = NotificationCenter.default
    let calendar = center.addObserver(forName: .EKEventStoreChanged, object: store, queue: .main) { _ in
        sendCalendarChange("changed")
    }
    let clock = center.addObserver(forName: .NSSystemClockDidChange, object: nil, queue: .main) { _ in
        sendCalendarChange("clock-changed")
    }
    let zone = center.addObserver(forName: .NSSystemTimeZoneDidChange, object: nil, queue: .main) { _ in
        sendCalendarChange("clock-changed")
    }
    if accessStatus() == "full" { _ = store.calendars(for: .event) }
    sendCalendarChange("ready")
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        DispatchQueue.global(qos: .utility).async {
            _ = FileHandle.standardInput.readDataToEndOfFile()
            continuation.resume()
        }
    }
    center.removeObserver(calendar)
    center.removeObserver(clock)
    center.removeObserver(zone)
    withExtendedLifetime(store) {}
}
