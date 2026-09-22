import Foundation

enum CalendarFailure: String, Error {
    case invalid, permission, unavailable, conflict
    case notFound = "not-found"
    case readOnly = "read-only"
    case tooMany = "too-many"
    case writeUnknown = "write-unknown"
}

struct EventInput: Codable {
    let calendarId: String
    let title: String
    let start: String
    let end: String
    let allDay: Bool
    let timeZone: String
    let location: String
    let notes: String

    func validatedDates() throws -> (Date, Date, TimeZone) {
        guard !calendarId.isEmpty, calendarId.count <= 4096,
              !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, title.count <= 1000,
              location.count <= 4000, notes.count <= 100_000,
              let zone = TimeZone(identifier: timeZone) else { throw CalendarFailure.invalid }
        let startDate = try parseCalendarDate(start, allDay: allDay, zone: zone)
        let endDate = try parseCalendarDate(end, allDay: allDay, zone: zone)
        guard endDate > startDate else { throw CalendarFailure.invalid }
        return (startDate, endDate, zone)
    }
}

struct EventTarget: Codable {
    let id: String
    let revision: String
}

struct CalendarCommand: Decodable {
    let action: String
    let start: String?
    let end: String?
    let calendarId: String?
    let event: EventInput?
    let target: EventTarget?
}

func dayFormatter(_ zone: TimeZone) -> DateFormatter {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.timeZone = zone
    formatter.dateFormat = "yyyy-MM-dd"
    formatter.isLenient = false
    return formatter
}

func parseCalendarDate(_ value: String, allDay: Bool, zone: TimeZone = TimeZone(secondsFromGMT: 0)!) throws -> Date {
    if allDay {
        let formatter = dayFormatter(zone)
        guard value.count == 10, let date = formatter.date(from: value), formatter.string(from: date) == value else {
            throw CalendarFailure.invalid
        }
        return date
    }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if value.hasSuffix("Z"), let date = formatter.date(from: value) { return date }
    formatter.formatOptions = [.withInternetDateTime]
    guard value.hasSuffix("Z"), let date = formatter.date(from: value) else { throw CalendarFailure.invalid }
    return date
}

func formattedCalendarDate(_ date: Date, allDay: Bool, zone: TimeZone) -> String {
    if allDay { return dayFormatter(zone).string(from: date) }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
}

func calendarEventDates(start: Date, end: Date, allDay: Bool, zone: TimeZone) throws -> (start: String, end: String) {
    guard end >= start else { throw CalendarFailure.invalid }
    if !allDay {
        return (formattedCalendarDate(start, allDay: false, zone: zone),
                formattedCalendarDate(end, allDay: false, zone: zone))
    }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone
    let startDay = calendar.startOfDay(for: start)
    let endDay = calendar.startOfDay(for: end)
    // Providers can return a same-day or inclusive end for an all-day event.
    // The UI uses an exclusive date, so retain every day touched by the event.
    let exclusiveEnd: Date
    if endDay == startDay || end > endDay {
        guard let next = calendar.date(byAdding: .day, value: 1, to: endDay) else { throw CalendarFailure.invalid }
        exclusiveEnd = next
    } else {
        exclusiveEnd = endDay
    }
    return (formattedCalendarDate(startDay, allDay: true, zone: zone),
            formattedCalendarDate(exclusiveEnd, allDay: true, zone: zone))
}

func calendarEventDatesForUpdate(start: Date, end: Date, allDay: Bool, zone: TimeZone,
                                 input: EventInput) throws -> (Date, Date) {
    let proposed = try input.validatedDates()
    guard input.allDay == allDay, proposed.2 == zone else { return (proposed.0, proposed.1) }
    let displayed = try calendarEventDates(start: start, end: end, allDay: allDay, zone: zone)
    // A title/notes edit must not rewrite the provider's native end time merely
    // because its displayed all-day end was converted to an exclusive date.
    return (input.start == displayed.start ? start : proposed.0,
            input.end == displayed.end ? end : proposed.1)
}

func validateEventMutation(writable: Bool, recurring: Bool, detached: Bool, attendees: Bool,
                           expectedRevision: String, currentRevision: String) throws {
    guard writable, !recurring, !detached, !attendees else { throw CalendarFailure.readOnly }
    guard !expectedRevision.isEmpty, expectedRevision == currentRevision else { throw CalendarFailure.conflict }
}
