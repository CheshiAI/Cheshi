import Foundation
import EventKit
import CryptoKit

func accessStatus() -> String {
    let status = EKEventStore.authorizationStatus(for: .event)
    if #available(macOS 14.0, *) {
        if status == .fullAccess { return "full" }
        if status == .writeOnly { return "write-only" }
    } else if status == .authorized { return "full" }
    switch status {
    case .notDetermined: return "not-determined"
    case .restricted: return "restricted"
    default: return "denied"
    }
}

func eventValue(_ event: EKEvent) throws -> [String: Any] {
    guard let id = event.eventIdentifier, let start = event.startDate, let end = event.endDate,
          let calendar = event.calendar else { throw CalendarFailure.unavailable }
    let zone = event.timeZone ?? .current
    let dates = try calendarEventDates(start: start, end: end, allDay: event.isAllDay, zone: zone)
    let recurring = event.hasRecurrenceRules || event.isDetached
    var value: [String: Any] = [
        "id": id, "calendarId": calendar.calendarIdentifier, "title": event.title ?? "",
        "start": dates.start, "end": dates.end,
        "allDay": event.isAllDay, "timeZone": zone.identifier,
        "location": event.location ?? "", "notes": event.notes ?? "",
        "recurring": recurring, "readOnly": !calendar.allowsContentModifications || recurring || event.hasAttendees,
    ]
    var revisionValue = value
    revisionValue["modified"] = event.lastModifiedDate?.timeIntervalSince1970 ?? 0
    revisionValue["nativeStart"] = start.timeIntervalSince1970
    revisionValue["nativeEnd"] = end.timeIntervalSince1970
    revisionValue["url"] = event.url?.absoluteString ?? ""
    revisionValue["alarms"] = event.alarms?.map { "\($0.relativeOffset):\($0.absoluteDate?.timeIntervalSince1970 ?? 0)" } ?? []
    let bytes = try JSONSerialization.data(withJSONObject: revisionValue, options: [.sortedKeys])
    value["revision"] = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    return value
}

func selectedCalendar(_ store: EKEventStore, _ id: String, writable: Bool) throws -> EKCalendar {
    guard let calendar = store.calendars(for: .event).first(where: { $0.calendarIdentifier == id }) else {
        throw CalendarFailure.notFound
    }
    guard !writable || calendar.allowsContentModifications else { throw CalendarFailure.readOnly }
    return calendar
}

func selectedEvent(_ store: EKEventStore, _ target: EventTarget?) throws -> EKEvent {
    guard let target = target, !target.id.isEmpty, !target.revision.isEmpty else { throw CalendarFailure.invalid }
    guard let event = store.event(withIdentifier: target.id) else { throw CalendarFailure.notFound }
    let snapshot = try eventValue(event)
    try validateEventMutation(writable: event.calendar.allowsContentModifications,
                              recurring: event.hasRecurrenceRules, detached: event.isDetached, attendees: event.hasAttendees,
                              expectedRevision: target.revision, currentRevision: snapshot["revision"] as? String ?? "")
    return event
}

func perform(_ command: CalendarCommand, store: EKEventStore) throws -> Any {
    switch command.action {
    case "calendars":
        let defaultId = store.defaultCalendarForNewEvents?.calendarIdentifier
        return store.calendars(for: .event).map { calendar -> [String: Any] in
            ["id": calendar.calendarIdentifier, "title": calendar.title, "source": calendar.source.title,
             "writable": calendar.allowsContentModifications, "isDefault": calendar.calendarIdentifier == defaultId]
        }
    case "events":
        guard let start = command.start, let end = command.end, let calendarId = command.calendarId else { throw CalendarFailure.invalid }
        let from = try parseCalendarDate(start, allDay: false)
        let to = try parseCalendarDate(end, allDay: false)
        guard to > from, to.timeIntervalSince(from) <= 63 * 86400 else { throw CalendarFailure.invalid }
        let calendars = calendarId.isEmpty ? store.calendars(for: .event) : [try selectedCalendar(store, calendarId, writable: false)]
        if calendars.isEmpty { return [] as [String] }
        let predicate = store.predicateForEvents(withStart: from, end: to, calendars: calendars)
        let events = store.events(matching: predicate).sorted { $0.startDate < $1.startDate }
        guard events.count <= 10_000 else { throw CalendarFailure.tooMany }
        return try events.map(eventValue)
    case "create", "update":
        guard let input = command.event else { throw CalendarFailure.invalid }
        let (start, end, zone) = try input.validatedDates()
        let calendar = try selectedCalendar(store, input.calendarId, writable: true)
        let event = command.action == "create" ? EKEvent(eventStore: store) : try selectedEvent(store, command.target)
        if command.action == "update", event.calendar.calendarIdentifier != input.calendarId { throw CalendarFailure.invalid }
        let dates = command.action == "update"
            ? try calendarEventDatesForUpdate(start: event.startDate, end: event.endDate,
                allDay: event.isAllDay, zone: event.timeZone ?? .current, input: input)
            : (start, end)
        event.calendar = calendar
        event.title = input.title.trimmingCharacters(in: .whitespacesAndNewlines)
        if command.action == "create" || (event.timeZone ?? .current).identifier != zone.identifier {
            event.timeZone = zone
        }
        if event.isAllDay != input.allDay { event.isAllDay = input.allDay }
        if event.startDate != dates.0 { event.startDate = dates.0 }
        if event.endDate != dates.1 { event.endDate = dates.1 }
        event.location = input.location
        event.notes = input.notes
        do { try store.save(event, span: .thisEvent, commit: true) }
        catch { throw CalendarFailure.writeUnknown }
        // A lost acknowledgement must never be reported as a definite failed write.
        do { return try eventValue(event) }
        catch { throw CalendarFailure.writeUnknown }
    case "delete":
        let event = try selectedEvent(store, command.target)
        do { try store.remove(event, span: .thisEvent, commit: true) }
        catch { throw CalendarFailure.writeUnknown }
        return ["id": command.target!.id, "revision": command.target!.revision]
    default: throw CalendarFailure.invalid
    }
}

@main
struct CalendarBridge {
    static func respond(_ reply: [String: Any]) {
        if let data = try? JSONSerialization.data(withJSONObject: reply, options: [.sortedKeys]) {
            FileHandle.standardOutput.write(data)
        }
    }

    static func main() async {
        do {
            let data = FileHandle.standardInput.readDataToEndOfFile()
            guard data.count <= 500_000 else { throw CalendarFailure.invalid }
            let command: CalendarCommand
            do { command = try JSONDecoder().decode(CalendarCommand.self, from: data) }
            catch { throw CalendarFailure.invalid }
            guard ["status", "connect", "calendars", "events", "create", "update", "delete"].contains(command.action) else {
                throw CalendarFailure.invalid
            }
            if command.action == "status" {
                respond(["ok": true, "value": accessStatus()]); return
            }
            if command.action == "connect" {
                let store = EKEventStore()
                if accessStatus() == "not-determined" || accessStatus() == "write-only" {
                    if #available(macOS 14.0, *) {
                        _ = try await store.requestFullAccessToEvents()
                    } else {
                        _ = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Bool, Error>) in
                            store.requestAccess(to: .event) { granted, error in
                                if let error = error { continuation.resume(throwing: error) }
                                else { continuation.resume(returning: granted) }
                            }
                        }
                    }
                }
                respond(["ok": true, "value": accessStatus()]); return
            }
            guard accessStatus() == "full" else { throw CalendarFailure.permission }
            let value = try perform(command, store: EKEventStore())
            respond(["ok": true, "value": value])
        } catch let error as CalendarFailure {
            respond(["ok": false, "error": ["code": error.rawValue]])
        } catch {
            respond(["ok": false, "error": ["code": "unavailable"]])
        }
    }
}
