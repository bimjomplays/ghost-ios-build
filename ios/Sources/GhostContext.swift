import Foundation
import CoreLocation

/// Snap editor "info" stickers (weather / location), like Snapchat's: one location fix while the editor asks,
/// the place name from Apple's reverse geocoder, the temperature from Open-Meteo (free, no key, no account).
/// Location is only requested when you open the Info stickers - never in the background, never stored.
final class GhostContext: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var waiting: [(CLLocation?, String?) -> Void] = []
    private var last: (location: CLLocation, at: Date)?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    /// op "contextInfo" -> {city, place, tempF, tempC, code (WMO weather code), isDay, speed (m/s, -1 = unknown)}
    /// maxAge: how old a remembered position may be (the speed filter asks for a fresh one)
    func info(maxAge: TimeInterval = 600, reply: @escaping (Any?, String?) -> Void) {
        locate(maxAge: maxAge) { [weak self] location, error in
            guard let self, let location else { return reply(nil, error ?? "location unavailable") }
            let group = DispatchGroup()
            var out: [String: Any] = ["lat": location.coordinate.latitude, "lon": location.coordinate.longitude,
                                      "speed": location.speed >= 0 ? location.speed : -1] // the snap editor's speed filter
            group.enter()
            CLGeocoder().reverseGeocodeLocation(location) { marks, _ in
                if let m = marks?.first {
                    out["city"] = m.locality ?? m.subAdministrativeArea ?? m.administrativeArea ?? ""
                    out["place"] = m.name ?? ""
                    out["region"] = m.administrativeArea ?? ""
                }
                group.leave()
            }
            group.enter()
            self.weather(location) { w in
                for (k, v) in w { out[k] = v }
                group.leave()
            }
            group.notify(queue: .main) { reply(out, nil) }
        }
    }

    private func weather(_ location: CLLocation, done: @escaping ([String: Any]) -> Void) {
        let lat = String(format: "%.3f", location.coordinate.latitude), lon = String(format: "%.3f", location.coordinate.longitude)
        guard let url = URL(string: "https://api.open-meteo.com/v1/forecast?latitude=\(lat)&longitude=\(lon)&current=temperature_2m,weather_code,is_day") else { return done([:]) }
        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        URLSession.shared.dataTask(with: request) { data, _, _ in
            // back on main: info() merges this and the geocoder's answer into one dictionary there
            guard let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let current = json["current"] as? [String: Any], let c = (current["temperature_2m"] as? NSNumber)?.doubleValue else {
                return DispatchQueue.main.async { done([:]) }
            }
            let result: [String: Any] = ["tempC": c, "tempF": c * 9 / 5 + 32, "code": (current["weather_code"] as? NSNumber)?.intValue ?? 0,
                                         "isDay": ((current["is_day"] as? NSNumber)?.intValue ?? 1) == 1]
            DispatchQueue.main.async { done(result) }
        }.resume()
    }

    private func locate(maxAge: TimeInterval = 600, _ done: @escaping (CLLocation?, String?) -> Void) {
        if let last, Date().timeIntervalSince(last.at) < maxAge { return done(last.location, nil) }
        switch manager.authorizationStatus {
        case .denied, .restricted: return done(nil, "Location is off for Ghost")
        default: break
        }
        waiting.append(done)
        guard waiting.count == 1 else { return }
        if manager.authorizationStatus == .notDetermined { manager.requestWhenInUseAuthorization() } else { manager.requestLocation() }
    }

    private func finish(_ location: CLLocation?, _ error: String?) {
        if let location { last = (location, Date()) }
        let list = waiting
        waiting.removeAll()
        for w in list { w(location, error) }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard !waiting.isEmpty else { return }
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways: manager.requestLocation()
        case .denied, .restricted: finish(nil, "Location is off for Ghost")
        default: break
        }
    }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) { finish(locations.last, nil) }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) { finish(nil, error.localizedDescription) }
}
