import AmbientAi

public let isCapacitorApp = true

/// Prevent the linker from stripping plugin classes that Capacitor discovers at runtime
/// via NSClassFromString. Without these references, plugin symbols are dead-stripped
/// and Capacitor.Plugins stays empty.
private let _capacitorPluginClasses: [AnyClass] = [
    AudioCapturePlugin.self,
    VisitMonitorPlugin.self,
    DeviceStatePlugin.self,
    NotificationUsagePlugin.self,
    MediaNotebookPlugin.self,
    CalendarPlugin.self,
    NearbyConnectivityPlugin.self,
]
