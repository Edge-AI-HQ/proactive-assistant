import Foundation
import Capacitor

@objc(GeocoderPlugin)
public class GeocoderPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GeocoderPlugin"
    public let jsName = "Geocoder"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "reverseGeocode", returnType: CAPPluginReturnPromise),
    ]

    @objc func reverseGeocode(_ call: CAPPluginCall) {
        guard let lat = call.getDouble("latitude"),
              let lng = call.getDouble("longitude") else {
            call.reject("latitude and longitude are required", "BAD_ARGS")
            return
        }
        Task {
            let info = await GeocodeService.shared.lookup(lat: lat, lng: lng)
            call.resolve(info.toDict())
        }
    }
}
