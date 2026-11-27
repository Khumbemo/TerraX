"""Physical and orbital facts of the planets, the Moon and Pluto, exactly as printed in NASA's Planetary Fact Sheet
(metric): NSSDCA, NASA Goddard Space Flight Center, https://nssdc.gsfc.nasa.gov/planetary/factsheet/ (read on
27 November 2026). Values are NASA's rounded figures; they are shown, not used in calculations.

Negative rotation periods are retrograde (the body spins the opposite way to its orbit). For the Moon, the distance,
perihelion, aphelion, orbital period and orbital velocity are about the Earth (perigee, apogee). "Unknown" surface
pressure: the giant planets have no solid surface.
"""

from __future__ import annotations

SOURCE = {
    "name": "NASA Planetary Fact Sheet (NSSDCA, NASA Goddard)",
    "url": "https://nssdc.gsfc.nasa.gov/planetary/factsheet/",
    "read": "2026-11-27",
}

#: Row label, unit, then one value per body in COLUMNS order (None: the sheet says "Unknown").
COLUMNS = ["Mercury", "Venus", "Earth", "Moon", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune", "Pluto"]
ROWS: list[tuple[str, str, str, list]] = [
    ("mass", "Mass", "10^24 kg", [0.330, 4.87, 5.97, 0.073, 0.642, 1898, 568, 86.8, 102, 0.0130]),
    ("diameter", "Diameter", "km", [4879, 12104, 12756, 3475, 6792, 142984, 120536, 51118, 49528, 2376]),
    ("density", "Density", "kg/m³", [5429, 5243, 5514, 3340, 3934, 1326, 687, 1270, 1638, 1850]),
    ("gravity", "Gravity", "m/s²", [3.7, 8.9, 9.8, 1.6, 3.7, 23.1, 9.0, 8.7, 11.0, 0.6]),
    ("escapeVelocity", "Escape velocity", "km/s", [4.3, 10.4, 11.2, 2.4, 5.0, 59.5, 35.5, 21.3, 23.5, 1.2]),
    ("rotationPeriod", "Rotation period", "hours", [1407.6, -5832.5, 23.9, 655.7, 24.6, 9.9, 10.7, -17.2, 16.1, -153.3]),
    ("lengthOfDay", "Length of day", "hours", [4222.6, 2802.0, 24.0, 708.7, 24.7, 9.9, 10.7, 17.2, 16.1, 153.3]),
    ("distanceFromSun", "Distance from Sun", "10^6 km", [57.9, 108.2, 149.6, 0.384, 228.0, 778.5, 1432.0, 2867.0, 4515.0, 5906.4]),
    ("perihelion", "Perihelion", "10^6 km", [46.0, 107.5, 147.1, 0.363, 206.7, 740.6, 1357.6, 2732.7, 4471.1, 4436.8]),
    ("aphelion", "Aphelion", "10^6 km", [69.8, 108.9, 152.1, 0.406, 249.3, 816.4, 1506.5, 3001.4, 4558.9, 7375.9]),
    ("orbitalPeriod", "Orbital period", "days", [88.0, 224.7, 365.2, 27.3, 687.0, 4331, 10747, 30589, 59800, 90560]),
    ("orbitalVelocity", "Orbital velocity", "km/s", [47.4, 35.0, 29.8, 1.0, 24.1, 13.1, 9.7, 6.8, 5.4, 4.7]),
    ("orbitalInclination", "Orbital inclination", "degrees", [7.0, 3.4, 0.0, 5.1, 1.8, 1.3, 2.5, 0.8, 1.8, 17.2]),
    ("orbitalEccentricity", "Orbital eccentricity", "", [0.206, 0.007, 0.017, 0.055, 0.094, 0.049, 0.052, 0.047, 0.010, 0.244]),
    ("obliquity", "Obliquity to orbit (axial tilt)", "degrees", [0.034, 177.4, 23.4, 6.7, 25.2, 3.1, 26.7, 97.8, 28.3, 119.5]),
    ("meanTemperature", "Mean temperature", "°C", [167, 464, 15, -20, -65, -110, -140, -195, -200, -225]),
    ("surfacePressure", "Surface pressure", "bars", [0, 92, 1, 0, 0.01, None, None, None, None, 0.00001]),
    ("moons", "Number of moons", "", [0, 0, 1, 0, 2, 95, 274, 28, 16, 5]),
    ("rings", "Ring system", "", [False, False, False, False, False, True, True, True, True, False]),
    ("magneticField", "Global magnetic field", "", [True, False, True, False, False, True, True, True, True, None]),
]

FACTS: dict[str, dict] = {
    body: {key: values[i] for key, _, _, values in ROWS} for i, body in enumerate(COLUMNS)
}
LABELS = [{"key": key, "label": label, "unit": unit} for key, label, unit, _ in ROWS]
