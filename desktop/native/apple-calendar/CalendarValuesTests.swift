import Foundation

@main
struct CalendarValuesTests {
    static func allDayEventDates() throws {
        let cases = [
            ("2026-09-23T15:00:00.000Z", "2026-09-23T15:00:00.000Z", "Asia/Seoul", "2026-09-24", "2026-09-25"),
            ("2026-09-23T15:00:00.000Z", "2026-09-24T14:59:59.999Z", "Asia/Seoul", "2026-09-24", "2026-09-25"),
            ("2026-09-23T15:00:00.000Z", "2026-09-24T15:00:00.000Z", "Asia/Seoul", "2026-09-24", "2026-09-25"),
            ("2026-09-23T15:00:00.000Z", "2026-09-25T14:59:59.999Z", "Asia/Seoul", "2026-09-24", "2026-09-26"),
            ("2026-03-08T08:00:00.000Z", "2026-03-09T06:59:59.999Z", "America/Los_Angeles", "2026-03-08", "2026-03-09"),
            ("2026-11-01T07:00:00.000Z", "2026-11-02T07:59:59.999Z", "America/Los_Angeles", "2026-11-01", "2026-11-02"),
        ]
        var fixtures: [[String: String]] = []
        for (rawStart, rawEnd, identifier, expectedStart, expectedEnd) in cases {
            let zone = TimeZone(identifier: identifier)!
            let start = try parseCalendarDate(rawStart, allDay: false)
            let end = try parseCalendarDate(rawEnd, allDay: false)
            let displayed = try calendarEventDates(start: start, end: end, allDay: true, zone: zone)
            precondition(displayed.start == expectedStart && displayed.end == expectedEnd)
            let input = EventInput(calendarId: "id", title: "Changed title", start: displayed.start,
                end: displayed.end, allDay: true, timeZone: identifier, location: "", notes: "Changed notes")
            let saved = try calendarEventDatesForUpdate(start: start, end: end, allDay: true, zone: zone, input: input)
            precondition(saved.0 == start && saved.1 == end, "Unedited native dates must remain exact")
            fixtures.append(["start": displayed.start, "end": displayed.end, "timeZone": identifier])
        }
        let zone = TimeZone(identifier: "Asia/Seoul")!
        let start = try parseCalendarDate(cases[1].0, allDay: false)
        let end = try parseCalendarDate(cases[1].1, allDay: false)
        let changed = EventInput(calendarId: "id", title: "Title", start: "2026-09-25", end: "2026-09-27",
            allDay: true, timeZone: zone.identifier, location: "", notes: "")
        let moved = try calendarEventDatesForUpdate(start: start, end: end, allDay: true, zone: zone, input: changed)
        precondition(formattedCalendarDate(moved.0, allDay: true, zone: zone) == changed.start)
        precondition(formattedCalendarDate(moved.1, allDay: true, zone: zone) == changed.end)
        let timed = try calendarEventDates(start: start, end: end, allDay: false, zone: zone)
        precondition(timed.start == cases[1].0 && timed.end == cases[1].1)
        rejects(.invalid) { _ = try calendarEventDates(start: end, end: start, allDay: true, zone: zone) }
        let data = try JSONSerialization.data(withJSONObject: fixtures, options: [.sortedKeys])
        print("Calendar date fixtures: " + String(decoding: data, as: UTF8.self))
    }

    static func rejects(_ code: CalendarFailure, _ run: () throws -> Void) {
        do { try run(); fatalError("Expected rejection") }
        catch let error as CalendarFailure { precondition(error == code) }
        catch { fatalError("Unexpected error type") }
    }

    static func main() throws {
        try allDayEventDates()
        let zone = TimeZone(identifier: "America/Los_Angeles")!
        // A spring DST day is 23 hours, not a fixed 24-hour duration.
        let start = try parseCalendarDate("2026-03-08", allDay: true, zone: zone)
        let end = try parseCalendarDate("2026-03-09", allDay: true, zone: zone)
        precondition(end.timeIntervalSince(start) == 23 * 3600)
        precondition(formattedCalendarDate(start, allDay: true, zone: zone) == "2026-03-08")
        let autumn = try parseCalendarDate("2026-11-01", allDay: true, zone: zone)
        let next = try parseCalendarDate("2026-11-02", allDay: true, zone: zone)
        precondition(next.timeIntervalSince(autumn) == 25 * 3600)
        rejects(.invalid) { _ = try parseCalendarDate("2026-02-30", allDay: true) }
        rejects(.invalid) { _ = try parseCalendarDate("invalid", allDay: false) }
        let input = EventInput(calendarId: "id", title: "Title", start: "2026-09-22", end: "2026-09-23",
                               allDay: true, timeZone: "Asia/Seoul", location: "", notes: "")
        let dates = try input.validatedDates()
        precondition(dates.1 > dates.0)
        // Foundation emits these identifiers for fixed-offset calendar events.
        // They must remain usable on save, including exclusive all-day endings.
        for identifier in ["GMT+0900", "GMT-0330", "GMT+0530", "GMT+05:45", "GMT+0000", "GMT-1800", "GMT+1800"] {
            let fixedZone = TimeZone(identifier: identifier)!
            for allDay in [false, true] {
                let fixed = EventInput(calendarId: "id", title: "Title",
                    start: allDay ? "2026-09-22" : "2026-09-22T00:00:35.123Z",
                    end: allDay ? "2026-09-23" : "2026-09-22T01:00:35.123Z",
                    allDay: allDay, timeZone: identifier, location: "", notes: "")
                let validated = try fixed.validatedDates()
                precondition(validated.2.secondsFromGMT() == fixedZone.secondsFromGMT())
                precondition(formattedCalendarDate(validated.0, allDay: allDay, zone: validated.2) == fixed.start)
                precondition(formattedCalendarDate(validated.1, allDay: allDay, zone: validated.2) == fixed.end)
            }
        }
        for flags in [(false, false, false, false), (true, true, false, false), (true, false, true, false), (true, false, false, true)] {
            rejects(.readOnly) {
                try validateEventMutation(writable: flags.0, recurring: flags.1, detached: flags.2, attendees: flags.3,
                                          expectedRevision: "same", currentRevision: "same")
            }
        }
        rejects(.conflict) {
            try validateEventMutation(writable: true, recurring: false, detached: false, attendees: false,
                                      expectedRevision: "old", currentRevision: "new")
        }
        try validateEventMutation(writable: true, recurring: false, detached: false, attendees: false,
                                  expectedRevision: "same", currentRevision: "same")
        print("Calendar native boundary checks passed")
    }
}
