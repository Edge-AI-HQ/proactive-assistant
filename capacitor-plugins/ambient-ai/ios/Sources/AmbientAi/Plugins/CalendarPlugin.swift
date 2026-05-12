import Foundation
import EventKit
import Capacitor

@objc(CalendarPlugin)
public class CalendarPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CalendarPlugin"
    public let jsName = "Calendar"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startMonitoring", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopMonitoring", returnType: CAPPluginReturnPromise),
    ]

    private let eventStore = EKEventStore()
    private var isMonitoring = false
    private var timer: DispatchSourceTimer?
    private var calendarGate = CollectionCadenceGate(minimumInterval: 15 * 60)

    // MARK: - Permissions

    @objc public override func requestPermissions(_ call: CAPPluginCall) {
        EKEventStore().requestFullAccessToEvents { granted, _ in
            DispatchQueue.main.async {
                call.resolve(["calendar": granted ? "granted" : "denied"])
            }
        }
    }

    @objc public override func checkPermissions(_ call: CAPPluginCall) {
        let status = EKEventStore.authorizationStatus(for: .event)
        let resolved = (status == .fullAccess || status == .writeOnly) ? "granted" : "prompt"
        call.resolve(["calendar": resolved])
    }

    // MARK: - Start / Stop

    @objc func startMonitoring(_ call: CAPPluginCall) {
        guard !isMonitoring else {
            call.resolve()
            return
        }
        isMonitoring = true
        readCalendar()

        let queue = DispatchQueue(label: "com.pin.calendar.timer", qos: .utility)
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 15 * 60, repeating: 15 * 60)
        t.setEventHandler { [weak self] in
            DispatchQueue.main.async {
                self?.readCalendar()
            }
        }
        t.resume()
        self.timer = t

        print("[Calendar] Started monitoring")
        call.resolve()
    }

    @objc func stopMonitoring(_ call: CAPPluginCall) {
        timer?.cancel()
        timer = nil
        isMonitoring = false
        calendarGate.reset()

        print("[Calendar] Stopped monitoring")
        call.resolve()
    }

    // MARK: - Private

    private func readCalendar() {
        let auth = EKEventStore.authorizationStatus(for: .event)
        guard auth == .fullAccess || auth == .writeOnly else { return }
        guard calendarGate.shouldRun() else { return }

        let now = Date()
        let end = now.addingTimeInterval(24 * 3600)
        let calendars = eventStore.calendars(for: .event)
        let predicate = eventStore.predicateForEvents(withStart: now, end: end, calendars: calendars)
        let upcoming = eventStore.events(matching: predicate)
        guard !upcoming.isEmpty else { return }

        let summaryPayload: [String: Any] = [
            "count24h": upcoming.count,
            "timestamp": Int(now.timeIntervalSince1970 * 1000),
        ]
        notifyListeners("calendarSummary", data: summaryPayload)

        for event in upcoming.prefix(5) {
            let attendeeEmails: [String] = (event.attendees ?? []).compactMap { attendee in
                guard let url = attendee.url as URL?,
                      let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
                      comps.scheme == "mailto" else { return nil }
                return comps.path
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .lowercased()
            }
            let eventPayload: [String: Any] = [
                "title": event.title ?? "(untitled)",
                "startsAt": ISO8601DateFormatter().string(from: event.startDate),
                "endsAt": ISO8601DateFormatter().string(from: event.endDate),
                "attendeeCount": attendeeEmails.count,
                "calendar": event.calendar?.title ?? "",
                "timestamp": Int(now.timeIntervalSince1970 * 1000),
            ]
            notifyListeners("calendarEvent", data: eventPayload)
        }
    }
}
