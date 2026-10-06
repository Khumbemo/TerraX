// Solar geometry for the telemetry panel.
// Equation of time and declination follow the NOAA Solar Calculator
// (Meeus, "Astronomical Algorithms"); accuracy is well under a minute of
// time and 0.01° of declination for current dates.
import SunCalc from 'suncalc';

const RAD = Math.PI / 180;

function julianCentury(date: Date): number {
  const jd = date.getTime() / 86_400_000 + 2440587.5;
  return (jd - 2451545) / 36525;
}

export interface SolarAngles {
  /** Equation of time in minutes (apparent − mean solar time). */
  equationOfTime: number;
  /** Solar declination in degrees. */
  declination: number;
}

export function solarAngles(date: Date): SolarAngles {
  const T = julianCentury(date);
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T) + Math.sin(3 * M * RAD) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const declination = Math.asin(Math.sin(eps * RAD) * Math.sin(appLong * RAD)) / RAD;
  const y = Math.tan((eps / 2) * RAD) ** 2;
  const eot =
    y * Math.sin(2 * L0 * RAD) -
    2 * e * Math.sin(M * RAD) +
    4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD) -
    0.5 * y * y * Math.sin(4 * L0 * RAD) -
    1.25 * e * e * Math.sin(2 * M * RAD);
  return { equationOfTime: (4 * eot) / RAD, declination };
}

function utcHours(date: Date): number {
  return date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
}

/** Formats hours-of-day (any real number) as HH:MM:SS, wrapping at 24 h. */
export function formatClock(hours: number): string {
  const total = Math.round((((hours % 24) + 24) % 24) * 3600) % 86400;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export interface SolarReport {
  /** Local mean solar time in hours: UTC + longitude / 15. */
  meanSolarTime: number;
  /** Local apparent (sundial) solar time in hours: mean solar time + equation of time. */
  apparentSolarTime: number;
  equationOfTime: number;
  declination: number;
  altitude: number;
  zenith: number;
  /** Azimuth in degrees clockwise from true north. */
  azimuth: number;
  sunrise: Date | null;
  sunset: Date | null;
  /** Subsolar point (where the sun is overhead). */
  subsolar: { lat: number; lon: number };
}

export function solarReport(date: Date, lat: number, lon: number): SolarReport {
  const { equationOfTime, declination } = solarAngles(date);
  const meanSolarTime = utcHours(date) + lon / 15;
  const apparentSolarTime = meanSolarTime + equationOfTime / 60;
  const pos = SunCalc.getPosition(date, lat, lon);
  const altitude = pos.altitude / RAD;
  // SunCalc measures azimuth from south, positive westward.
  const azimuth = ((pos.azimuth / RAD + 180) % 360 + 360) % 360;
  const times = SunCalc.getTimes(date, lat, lon);
  const valid = (d: Date) => (Number.isNaN(d.getTime()) ? null : d);
  const subsolarLon = ((-15 * (utcHours(date) - 12 + equationOfTime / 60) + 540) % 360) - 180;
  return {
    meanSolarTime,
    apparentSolarTime,
    equationOfTime,
    declination,
    altitude,
    zenith: 90 - altitude,
    azimuth,
    sunrise: valid(times.sunrise),
    sunset: valid(times.sunset),
    subsolar: { lat: declination, lon: subsolarLon },
  };
}
