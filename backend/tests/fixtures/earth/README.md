Real responses, recorded on 28 November 2026, for tests/test_earth.py.

| File | Request |
| --- | --- |
| `usgs_2.5_day.json` | `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson`, metadata and bbox as served, 4 of its 43 features kept |
| `firms_viirs_noaa20.csv` | Header and 20 rows of FIRMS's public 24-hour NOAA-20 VIIRS file (`/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv`); the columns are those the Area API's OpenAPI file lists for a FireHotspot |
| `firms_modis.csv` | Header and 10 rows of the public 24-hour MODIS C6.1 file (`/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_24h.csv`) |
| `firms_viirs_snpp_empty.csv` | The public 24-hour Suomi NPP file: a header only (Suomi NPP stopped delivering on 2 November 2026) |
| `firms_invalid_key.txt` | `/api/area/csv/INVALIDKEY000/VIIRS_NOAA20_NRT/world/1`: HTTP 400 |
| `firms_status_invalid.txt` | `/mapserver/mapkey_status/?MAP_KEY=INVALIDKEY000`: HTTP 403 |
| `openmeteo_forecast_1.json`, `openmeteo_forecast_3.json` | `forecast_url()` for one point and for three (52.52, 13.41; −33.87, 151.21; 0, −30) |
| `openmeteo_elevation_3.json` | `elevation_url()` for Everest's summit, Berlin and the open Atlantic |
| `openmeteo_error_400.json` | `/v1/elevation?latitude=95&longitude=0`: HTTP 400 |
| `openmeteo_daily_limit_429.json` | A forecast request after the free daily limit for the caller's address was used up: HTTP 429 |

No request with a valid FIRMS MAP_KEY was recorded (the key belongs to the server's owner).
