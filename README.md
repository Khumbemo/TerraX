# TerraX

TerraX is an Earth-observation workbench for forest, land, climate and imagery analysis. You upload GeoTIFF rasters, vector boundaries, time-series tables or photos. A Python server runs the analysis with stated scientific methods and returns a report, charts and map layers. An optional AI interpretation can be added, with an API key from any AI provider.

## Architecture

| Part | Technology | Folder |
|---|---|---|
| Web app | React 19 + TypeScript, Vite, **MapLibre GL** maps, Recharts | `frontend/` |
| API | **FastAPI** (uploads, jobs, results, built-in map tiles, assistants, live data) | `backend/terrax/api/` |
| Jobs | **Celery** workers with **Redis** as broker; Celery beat deletes old files | `backend/terrax/tasks.py` |
| Processing | Python: **rasterio**, **GeoPandas**, **scikit-learn**, SciPy, pyproj, Shapely, NumPy, numba, Pillow | `backend/terrax/processing/` |
| Agents | Built-in assistant (no AI model) and AI agents for any provider's key (Gemini via google-genai; Claude; OpenAI-compatible APIs) | `backend/terrax/agents/` |
| Accounts and data | **SQLAlchemy**: SQLite by default, **PostgreSQL** with `DATABASE_URL` (users, sessions, upload and job index, history, projects, recorded errors) | `backend/terrax/db.py`, `auth.py` |
| Monitoring | Request IDs, JSON logs, Prometheus metrics, error records and optional Sentry | `backend/terrax/monitoring.py` |

The browser uploads a file once and gets an id. To analyse it, the browser starts a job (`POST /api/jobs`), polls the job's progress and then shows the result. Pictures, GeoJSON and CSV files from a job are served from `/api/jobs/{id}/artifacts/`. Uploads and results live in a shared storage folder (`TERRAX_STORAGE`), so any worker can run any job. Interactive documentation for the API is at `/api/docs`.

## Tools

| Tool | Upload | What it computes |
|---|---|---|
| **Forest loss** | Two NDVI (or red/NIR) GeoTIFFs on the same grid, optionally with a forest map (tree cover %, canopy height or a class map); Hansen GFC `lossyear` (+ `treecover2000`); pre/post NBR | Forest area, loss and gain in hectares; Hansen loss by year; dNBR burn severity (USGS classes); minimum mapping unit; loss polygons; a stratified validation sample, labelled in the app over high-resolution imagery (blind to the map's class) or in a downloaded file, and loss (or burned) area with a 95 % CI from its reference labels (Olofsson et al. 2014), as IPCC and REDD+ reporting expect; an emissions summary laid out as activity data, emission factor, emissions and uncertainty, with a yearly mean; CO₂ emissions from the loss (IPCC 2006 stock-difference terms) from a biomass value or a biomass map, with a 95 % Monte Carlo interval, recomputed from the estimated area once the map is validated; monitoring of an area for new loss in new Sentinel-2 scenes, with e-mailed alerts (see [Forest-loss alerts](#forest-loss-alerts)) |
| **Carbon & biomass** | Forest-Capture CSV or any CSV with species, DBH/GBH, height, plot size | AGB by Chave et al. 2014/2005, IPCC root:shoot, carbon and CO₂e per hectare with a Student-t 95 % CI |
| **Land survey** | GeoJSON, KML, GPX, CSV (lat/lon), zipped Shapefile, or drawn on the map | Geodesic area and perimeter (Karney 2013), legs and bearings, UTM/DMS, elevation profile; becomes the analysis boundary |
| **Residential plot** | Dated GeoTIFFs plus a boundary, or same-view photos | Radiometric normalisation, robust change detection, changes crossing the boundary (area and depth) |
| **Weather & climate** | CSV, TSV or XLSX series; Open-Meteo ERA5 or NASA POWER fetched by the server | Mann–Kendall and Theil–Sen, seasonal cycle, Seasonal Kendall, anomalies, SPI-1/3/6/12, IMD rainfall classes |
| **Satellite imagery** | Multiband GeoTIFF; Sentinel-2 L2A windows from Earth Search, one scene or a cloud-free median composite of 2–12 (each masked by its own SCL, reprojected onto one grid); Landsat 4–9 Collection 2 Level-2 (Tier 1, 1982 onwards, 30 m, blue to SWIR2 and QA_PIXEL) from the Microsoft Planetary Computer, one scene or a median composite masked by QA_PIXEL; several dated images | Composites, NDVI, EVI, SAVI, NDWI, NDMI, NBR, NDBI, SCL/QA_PIXEL cloud masks, pixel inspector, multi-date trend; per-pixel disturbance dating (one abrupt drop on a trend, BIC-selected, as in BFAST's single-break model; Verbesselt et al. 2010) with the disturbed area by date; or a seasonal model in the manner of CCDC (Zhu & Woodcock 2014) for images from any month: trend and annual cycle per pixel, several disturbances per pixel, the latest one, and recovery after it |
| **Land cover** | Multiband GeoTIFF (+ training shapes) | k-means (scikit-learn, k-means++) clusters ordered by NDVI, or a random forest (50, 100 or 200 trees) trained on labelled polygons or points and cross-validated by shape, optionally with Sentinel-1 VV, VH and VH/VV (dB) as extra features, reprojected onto the image's grid in linear power; a stratified validation sample and accuracy and area estimates with 95 % CIs (Olofsson et al. 2014) |
| **Radar (Sentinel-1)** | VV/VH backscatter GeoTIFFs (dB or linear), one date or two from the same relative orbit; or search Sentinel-1 RTC (γ⁰, 10 m) on the Microsoft Planetary Computer and read the window over the area | Lee (1980) speckle filter in linear power, VV, VH, VH/VV and dual-pol RVI; VH log-ratio change map (±3 dB) with areas and a GeoTIFF export |
| **Water & floods** | A multispectral GeoTIFF (Sentinel-2, Landsat), or Sentinel-1 VV; one date, before/after on the same grid, or three or more dated images on one grid | Open water from MNDWI (Xu 2006; with SWIR1) or NDWI (McFeeters 1996), cloud-masked by SCL or QA_PIXEL; or from Lee-filtered VV backscatter in dB. Automatic Otsu (1979) threshold, used only when a two-component Gaussian mixture shows a bimodal histogram (Ashman's D ≥ 2) and the threshold is plausible; otherwise index 0 or VV −18 dB, or a threshold set by hand. With two dates: water on both, new water (flood; radar also needs a 3 dB drop) and water gone, in hectares; polygons and a class GeoTIFF. **Water bodies**: every run lists each lake and pond (area, perimeter, shoreline development, centre, size class, truncated by edge or cloud) as a table, CSV and GeoJSON. **Water over time**: water occurrence per pixel (water ÷ clear observations, as in Pekel et al. 2016) with one threshold for every date, and the water seen on each date. **Water quality** (optical): turbidity index NDTI (Lacaux et al. 2007) and, with a red-edge band, chlorophyll index NDCI (Mishra & Mishra 2012) on interior water, per water body; relative indicators, not concentrations. With an optional DEM, water standing more than a set height above its nearest channel (HAND, Rennó et al. 2008) is removed: terrain shadow and steep slopes |
| **Canopy height** | LAS/LAZ point cloud (ground classified), DSM + DTM, or a CHM GeoTIFF | Canopy height model (first returns minus TIN-filled ground), cover at 2 m and the FAO 5 m height, height classes, tree tops by local maxima with Popescu & Wynne (2004) crown windows (a lower bound under overlapping crowns); with field plots counted on the ground, a calibrated tree count with a 95 % CI (ratio estimator, Cochran 1977); with field plots of measured biomass, AGB = a·TCHᵇ fitted on plot-scale mean canopy height (Asner & Mascaro 2014) and applied to plot-sized cells, with biomass, carbon and CO₂e totals and a Monte Carlo 95 % CI; CHM GeoTIFF and tree-top GeoJSON |
| **Terrain** | DEM GeoTIFF | Slope and aspect (Horn 1981), hillshade, hypsometric integral, Priority-Flood + D8 flow, Strahler streams, watersheds, contours; optional D∞ flow (Tarboton 1997) with the topographic wetness index and D∞ watersheds (upslope dependence on the clicked outlet) |
| **Space & aerial photos** | JPG, PNG, WebP | Vegetation cover (ExG + Otsu), VARI, EXIF position on the map, comparison of two photos |

Every tool has sample data in `backend/data/samples/`. The rasters, plots, photo, inventory and 1990–2024 climate series are **synthetic**, generated by `backend/scripts/make_samples.py`; do not use them as research data. The six Kohima CSV series are bundled for demonstration, and their original source is not documented.

## Planetary telemetry

The left-hand panel shows the Sun and time at the target (altitude, azimuth, declination, equation of time, sunrise and sunset, the Kp index), or one of three sky models, chosen in the panel or in Settings:

- **Earth and Moon:** the Moon's phase, how much is lit, its age, distance, place in the sky, next rise and set, the coming quarters; the Earth's rotation (the stellar day) and its spin speed at the target; the Moon's orbit and rotation.
- **Earth around the Sun:** the distance and speed, the axial tilt, the astronomical season in each hemisphere, the next equinoxes and solstices, perihelion and aphelion.
- **Solar system:** each planet's distance from the Sun and from the Earth, light time, place in the sky at the target and orbital speed, with NASA's figures for its year, rotation, day length, axial tilt and moons.

Each picture shows the positions now, and "Play" steps through positions computed for a month, a year or 12 years. Positions come from ERFA, the open-source edition of the IAU's SOFA routines (Earth: eraEpv00; Moon: eraMoon98; planets: eraPlan94), with aberration, light time, IAU 2006/2000A precession-nutation and the observer's place on the WGS84 ellipsoid. Physical facts are NASA's [Planetary Fact Sheet](https://nssdc.gsfc.nasa.gov/planetary/factsheet/). Checked against astropy's own pipeline (tests/test_sky.py, tests/test_services.py): the Sun, Venus and Jupiter within 4 arcsec in the sky, the Moon within 20 arcsec (its model's documented error) and 41 km, equinoxes and solstices to the second, sunrise and sunset to the minute (0.4 min where the Sun only grazes the horizon).

## Maps

The map is MapLibre GL. Under **Settings → Map**, or with **Layers** on the map, you pick one base map and any number of overlays, each with its own opacity.

- **Online maps:** OpenStreetMap, CARTO, OpenFreeMap vector styles, Esri, NASA GIBS, EOX Sentinel-2 cloudless, Stadia, MapTiler, a custom XYZ or WMS service, and Protomaps (a local `.pmtiles` file or a URL).
- **Built-in maps:** these are served by the TerraX API from `backend/data/maps/`, so they work without internet. Pictures are 512-pixel XYZ tiles cut from the full-detail sources. Vectors are Natural Earth at 1:50m, with 1:10m cells from zoom 5. Clicking the map with the Köppen or biome layer on reads the class at that point (`/api/maps/identify`).

| Built-in map | Source (licence) |
|---|---|
| Natural Earth: borders, states/provinces, rivers, lakes, 7,300 places | Natural Earth 1:50m and 1:10m (public domain) |
| Shaded relief | Tom Patterson, shadedrelief.com (public domain) |
| Land and sea-floor relief | NOAA ETOPO1 (public domain) |
| Blue Marble / Black Marble 2016 | NASA (public domain) |
| Köppen–Geiger zones 1980–2016 | Beck et al. 2018, *Sci. Data* 5:180214 (CC BY 4.0) |
| Biomes | RESOLVE Ecoregions 2017, Dinerstein et al. 2017 (CC BY 4.0) |
| Tectonic plate boundaries | Bird 2003, *G3* 4(3):1027 (ODC-BY 1.0) |
| Grid, tropics and polar circles | Computed from the obliquity of the ecliptic (IAU 2006) |

To rebuild the map files, run `python backend/scripts/make_world_maps.py <source-dir>`. The script's header lists where each source comes from.

## Run with Docker (recommended)

```bash
cp .env.example .env        # optional: TERRAX_AI_KEY, retention, upload limit
docker compose up --build
# open http://localhost:8080
```

This starts six containers:

- `web`: nginx serving the app and proxying `/api`
- `api`: FastAPI
- `worker`: Celery
- `beat`: the hourly clean-up
- `redis`
- `db`: PostgreSQL (accounts, sessions, job history and projects)

Uploads and results are kept in the `storage` volume and the database in the `db` volume. To handle more jobs at once, scale the workers with `docker compose up --scale worker=3`.

## Run for development

You need Python 3.11 or later and Node.js 20 or later.

```bash
# API (jobs run inside the API process, so Redis is not needed)
cd backend
pip install -e '.[dev]'
TERRAX_EAGER=true uvicorn terrax.api.main:app --reload --port 8000

# Web app (proxies /api to port 8000)
cd frontend
npm install
npm run dev            # http://localhost:5173
```

To use real workers, start Redis and run these, with `TERRAX_EAGER` unset:

```bash
celery -A terrax.tasks worker --loglevel=INFO
celery -A terrax.tasks beat
```

Settings are environment variables (see `backend/.env.example`):

- `REDIS_URL`
- `TERRAX_STORAGE`
- `TERRAX_EAGER`: run each job inside its request (tests, development)
- `TERRAX_JOB_THREADS`: run jobs on this many background threads, with no Redis (one-container hosting)
- `TERRAX_STATIC`: folder with the built web app, so the API serves it itself
- `TERRAX_MAX_PIXELS`, `TERRAX_DEM_PIXELS`, `TERRAX_TILE_THREADS`, `TERRAX_GRID_PIXELS` and `TERRAX_TILES_MIN_SIDE`: resolution, parallelism and map tiles for large rasters (see **Large rasters**)
- `TERRAX_WORKER_CONCURRENCY`, `TERRAX_JOB_MINUTES` and `TERRAX_WORKER_MAX_MEMORY_MB`: Celery workers
- `TERRAX_AI_KEY`, `TERRAX_AI_PROVIDER`, `TERRAX_AI_MODEL`, `TERRAX_AI_BASE_URL`, `TERRAX_AI_ALLOW_PRIVATE`, `TERRAX_AI_PER_KEY_PER_MINUTE` and `TERRAX_AI_SERVER_PER_MINUTE` (see **AI**); `GEMINI_API_KEY` and `GEMINI_MODEL` are still read
- `TERRAX_CORS`
- `TERRAX_MAX_UPLOAD_MB`
- `TERRAX_RETENTION_HOURS`

## Large rasters

Forest loss, satellite indices, multi-date series and land cover run at **full resolution** up to `TERRAX_MAX_PIXELS` (default 100 million pixels, for example a 10,000 × 10,000 scene). Larger files are resampled to that budget, and the report says so.

These tools read the raster in strips of whole rows and process the strips on `TERRAX_TILE_THREADS` cores (default up to 4). For the whole raster they keep only a one-byte class map and running totals. Tests check that strips give the same numbers as one whole-grid pass, including boundaries, minimum mapping units and latitude-dependent cell areas.

Measured on 4 cores, against the previous whole-grid code at full resolution:

| Analysis | Raster | Before | Now |
|---|---|---|---|
| Forest loss (NDVI change) | 100 MP × 2 dates | 41.8 s, 5.7 GB | 7.3 s, 0.8 GB |
| Satellite statistics (exact quartiles) | 100 MP | 26.8 s, 3.2 GB | 5.3 s, 0.9 GB |
| Land cover (k-means, k = 5) | 36 MP × 4 bands | 46.4 s, 5.5 GB | 14.2 s, 1.8 GB |
| Land cover (random forest, 100 trees, 3 classes) | 36 MP × 4 bands | — | 166 s, 1.9 GB (about half with 50 trees) |
| Terrain (slope, aspect, hillshade, layers) | 25 MP DEM | 243 s, 3.7 GB | 22 s, 2.4 GB |
| Hydrology (fill, D8, Strahler, streams) | 25 MP DEM | 174 s, 3.7 GB | 42 s, 2.4 GB |

Results were identical in each case. A 100 MP DEM takes about 200 s and 6.3 GB for hydrology.

Random-forest time is almost all prediction, which is proportional to the number of trees. scikit-learn's compiled traversal already scales across cores (×3.7 on 4). Three exact re-implementations in Numba gave bit-identical results but were all slower (the best by about 25 % on 4 cores), so the speed choice is the forest size. On synthetic 3–6 class tests, 50 trees took half the time of 100 for 0.03–0.2 percentage points of accuracy, in line with Probst & Boulesteix (2018). 100 stays the default.

Radar runs in strips like the optical tools, with halo rows for the speckle filter and streaming statistics (exact quartiles: 0.01 dB bins locate them, and a second pass keeps only those bins' values). Canopy height reads point clouds in chunks of 5 million points onto a grid of at most 100 million cells, and keeps the CHM in memory for tree tops (rasters use `TERRAX_DEM_PIXELS`).

Terrain and hydrology have their own budget, `TERRAX_DEM_PIXELS` (default 25 MP, for example 5,000 × 5,000), because depression filling and flow routing need the whole DEM at once, about 100 bytes per pixel at peak. Slope, aspect and hillshade run in strips with a one-row halo. On the map, hydrology draws the highest stream orders that fit 250,000 vertices; the flow layer shows every channel cell, and the streams export holds every line.

The residential plot tool reads only the window around the property from each GeoTIFF, at the file's own resolution, so a large drone orthophoto is not coarsened first (for two 100 MP orthophotos: 2.6 s and 0.4 GB, instead of 6.5 s and 0.7 GB at a quarter of the resolution). Its analysis grid is at most 1,600 cells across, with 0.1 m cells at the finest.

Contours run on the DEM budget (Numba marching squares, simplified to a quarter cell by Douglas–Peucker); previews keep `TERRAX_GRID_PIXELS` (default 4 MP). Map overlays are a picture of at most 4,096 cells a side; a result grid larger than that (`TERRAX_TILES_MIN_SIDE`) is also kept as a GeoTIFF with overviews, and the map switches to 256 px Web Mercator tiles from `/api/jobs/{id}/tiles/{layer}/{z}/{x}/{y}.png` once zoomed in far enough to see more than the picture holds, down to the native cells. Class maps, the satellite layer, slope, canopy height and the radar false colour have tiles.

For heavy workloads:

- **Memory per job:** about 10 bytes per pixel plus the strips in flight, so roughly 1 GB at 100 MP. Land cover needs more, about 1.8 GB for 36 MP with 4 bands, and hydrology about 100 bytes per DEM pixel.
- **CPU:** each worker process runs one job at a time on `TERRAX_TILE_THREADS` cores, so total CPU use is `TERRAX_WORKER_CONCURRENCY` × threads per container. Scale out with `docker compose up --scale worker=N`.
- **Limits:**
  - `TERRAX_JOB_MINUTES` stops runaway jobs (default 60 minutes).
  - `TERRAX_WORKER_MAX_MEMORY_MB` replaces a worker process that a big job left large.
  - A job that hits either limit reports what to change instead of failing silently.

## Accounts, access and data

`TERRAX_AUTH` sets who can use a server:

| Value | Who can use it |
|---|---|
| `off` | Anyone, with no accounts. Each browser gets a random guest cookie and can only see its own uploads, results, tiles and history. A job's ID alone is not enough to read it. |
| `optional` (default) | As `off`, and people can also create accounts. Signing in moves the browser's guest work into the account, keeps results for `TERRAX_USER_RETENTION_DAYS` (30) instead of `TERRAX_RETENTION_HOURS` (72), and adds job history and projects on any device. |
| `required` | Everyone signs in, except for health checks and the built-in world maps. Use this on a public server (`render.yaml` does). |

- **Accounts and admins.**
  - `TERRAX_SIGNUP=closed` stops self sign-up.
  - `TERRAX_ADMIN_EMAIL` and `TERRAX_ADMIN_PASSWORD` create the first administrator at start-up. The same variables reset that account's password.
  - `python -m terrax.manage create-user EMAIL --admin`, `set-password`, `set-role`, `disable`, `list-users`, `purge` and `check` do the same from a shell.
  - Admins get an **Admin** tab, in sections:
    - **Overview:** usage, health checks, and buttons to back up the database or run the clean-up now.
    - **Accounts:** find, add, disable or delete accounts, change roles, set a password, turn off someone's two-factor sign-in (a lost phone) and mark an address as confirmed.
    - **Analyses:** everyone's recent analyses, by state and tool, with who ran them.
    - **Site settings,** kept in the database and changed without a restart: sign-up open or closed (overrides `TERRAX_SIGNUP`), an announcement shown to everyone, maintenance (new analyses paused for everyone but admins, with a message), and the owner's contact details (name, e-mail for enquiries and for technical support, a help page), which everyone sees in Settings → About.
    - **System & backups:** the health checks, the running configuration with the environment variable behind each value (never secrets), and the stored backups.
    - **Audit log** and **Errors.**
  - Every user can change their password or delete their account, which deletes their data.
- **Passwords and sessions.**
  - Passwords are hashed with scrypt (N = 2¹⁵, r = 8, p = 3, one of OWASP's recommended settings).
  - Session tokens are 32 random bytes in an HttpOnly, SameSite cookie; only their SHA-256 is stored.
  - Changing a password signs the account out everywhere. Scripts can send the token as `Authorization: Bearer`.
  - The Account tab lists the devices signed in (browser, address, last use). Each can be signed out, or all but this one.
- **E-mail: password reset and address confirmation.** Set `TERRAX_SMTP_HOST`, `_PORT`, `_USER`, `_PASSWORD`, `_SECURITY` (`starttls`, `ssl` or `none`), `_FROM` and `TERRAX_PUBLIC_URL`. Any SMTP service works.
  - **Reset.** "Forgot your password?" e-mails a link that works once, for one hour. Using it signs the account out everywhere. The answer is the same whether or not the address has an account. Five e-mails per hour per address.
  - **Confirmation.** New accounts get a confirmation link that works for 48 hours. With `TERRAX_VERIFY_EMAIL=true`, an account cannot work until the address is confirmed; it can still resend the link.
  - **Links point only at `TERRAX_PUBLIC_URL`.** Without it the server sends no mail. Links are never built from the request's Host header, which the sender controls (password-reset poisoning).
  - Without mail, the server says so. An administrator sets a new password instead.
- **Two-factor sign-in (TOTP, RFC 6238).** Any authenticator app works. Turn it on from the Account tab: scan the QR code, then confirm one code.
  - Ten single-use recovery codes are shown once and stored hashed.
  - A code is accepted for 30 seconds either side of now, and never twice.
  - Turning it off needs the password and a code.
- **Single sign-on (OpenID Connect).** Set `TERRAX_OIDC_ISSUER`, `TERRAX_OIDC_CLIENT_ID`, `TERRAX_OIDC_CLIENT_SECRET` and `TERRAX_OIDC_NAME` (the button label). Register `TERRAX_PUBLIC_URL/api/auth/oidc/callback` as the redirect URI. Any provider with discovery works, for example Google, Microsoft Entra ID, Okta, Auth0 or Keycloak.
  - **Flow.** The authorization-code flow with PKCE (S256), a single-use state and a nonce.
  - **Token checks.** The ID token comes straight from the provider's token endpoint over TLS, so its signature is not checked (OpenID Connect Core 3.1.3.7, step 6). Its issuer, audience, expiry and nonce are checked.
  - **Accounts.** An identity is found by the provider's subject, or linked to an existing account when the provider says the e-mail is verified. Otherwise a new account is created; `TERRAX_OIDC_CREATE_ACCOUNTS=false` stops that.
  - `TERRAX_OIDC_DOMAINS=example.org` limits which e-mail domains may sign in. Accounts made this way have no password; one can be added with a reset link.
- **Audit log.** The Admin tab can filter the log by event and e-mail. It records:
  - Sign-ins and failed sign-ins, with the address they came from.
  - Changes to passwords, two-factor sign-in and sessions, and account deletions.
  - Every administrator action.

  Passwords, tokens and codes are never written. Entries are kept for `TERRAX_AUDIT_RETENTION_DAYS` (365).
- **Cross-site requests.** Writes whose `Origin` is neither this site nor `TERRAX_CORS` are refused.
- **Request size.** Bodies larger than `TERRAX_MAX_BODY_MB` (32) are refused with 413 before they are read. Uploads may be up to `TERRAX_MAX_UPLOAD_MB`.
- **Signed links to pictures and tiles.** Result pictures, tiles and composites carry a signed token (HMAC-SHA-256) that expires after `TERRAX_MEDIA_URL_HOURS` (12).
  - This lets them load where cookies are not sent, such as an API on another site (`VITE_API_BASE`) or a browser that blocks third-party cookies.
  - Only the owner receives the links, and a link stops working once its result is deleted.
  - The key is `TERRAX_SECRET_KEY`, or a random one kept in the storage folder. Set it when machines do not share that folder.
- **Framed hosts.** On Hugging Face Spaces, which show the app in a frame on huggingface.co, cookies are `SameSite=None; Secure; Partitioned`. Set this with `TERRAX_COOKIE_SAMESITE=none` elsewhere.
- **Rate limits.**
  - Answered with HTTP 429 and `Retry-After`. Limits apply per user or guest and per client address.
  - Counters are shared by every process and machine: in Redis with Celery, otherwise in the database. `TERRAX_RATE_LIMIT_STORE` (`redis`, `database` or `memory`) overrides this.
  - Analyses (`TERRAX_JOBS_PER_MINUTE`, 30) and uploads (`TERRAX_UPLOADS_PER_HOUR`, 300).
  - 10 sign-in attempts per address and per e-mail in 15 minutes.
  - Live-data and assistant requests have limits too.
- **Storage quotas.** `TERRAX_USER_QUOTA_MB` (10,000) and `TERRAX_GUEST_QUOTA_MB` (2,000) limit what one account or guest can store.
- **Client addresses behind proxies.** Per-address limits need the real address.
  - With `TERRAX_TRUSTED_PROXIES=N`, the API takes the Nth address from the right of `X-Forwarded-For`, the one your own proxies added. Entries a client wrote further left are ignored. Without it, the connection's own address is used.
  - In `docker-compose.yml`, nginx replaces the header with the client's address, so 1 is right. The one-container image also sets 1, for the single proxy of Hugging Face and Render.
- **Database.**
  - SQLite in the storage folder needs nothing and suits one machine.
  - For several machines, set `DATABASE_URL=postgresql+psycopg://…` and install `pip install 'terrax[postgres]'`. `docker-compose.yml` runs PostgreSQL itself.
  - The schema is managed with Alembic (`terrax/migrations`). Every start upgrades the database to the newest revision. Databases from before Alembic are recognised and carried forward.
  - `python -m terrax.manage migrate status` shows the revision; `migrate upgrade` applies pending ones without starting the server.
  - The hourly clean-up deletes expired files. History rows stay, marked expired.

## Python, command line and QGIS

The same tools run without the web server, on local files. They use the same code, so they give the same numbers.

- **Command line.** `pip install -e backend` installs the `terrax` command.

  ```bash
  terrax tools                                     # each tool's inputs and main parameters
  terrax run forest -i a=ndvi_2016.tif -i b=ndvi_2024.tif -p mode=ndvi -o forest_result
  terrax run stack -i files=s2_2019.tif,s2_2020.tif,s2_2021.tif,s2_2022.tif,s2_2023.tif -p mapBreaks=true -o series
  terrax run canopy -i chm=chm.tif -i plots=plots.geojson --boundary site.geojson -o canopy
  ```

  Each run writes `result.json`, `report.md` and the output files to the folder: GeoTIFF class maps with their colour tables, slope, hillshade, flow accumulation and wetness, plus GeoJSON polygons, streams, contours and tree tops, CSV tables and PNG pictures. `--json` prints the result, and `--progress` reports progress on stderr. Parameters are `key=value` (JSON values, dotted keys for nested ones) or `--params file.json`.
- **Python.** `from terrax.local import run`, then `run("hydrology", {"dem": "dem.tif"}, {"method": "dinf"}, out="hydro")`. It returns the result dictionary, the report and the output files, for scripts and Jupyter notebooks.
- **QGIS.** `qgis-plugin/` is a Processing plugin with ten algorithms:
  - forest loss, burn severity, Hansen loss by year and disturbance dating;
  - canopy height, trees and biomass;
  - land cover;
  - terrain, hydrology and contours;
  - Sentinel-1 change.

  It takes your layers (vector layers in any CRS, reprojected for TerraX) and loads the results, with class maps drawn in their colours and labelled. It calls the `terrax` command, so TerraX keeps its own Python and GDAL. Install and build steps are in `qgis-plugin/README.md`.
- **Jupyter.** `pip install -e 'backend[notebook]'`, then `show(result)` from `terrax.notebook` puts a run's outputs on an interactive map (ipyleaflet, in the style of geemap and leafmap).
  - GeoTIFFs are reprojected to the map's Web Mercator, so class maps line up with their polygons, and class maps get a legend.
  - A result displays as its report.
  - `notebooks/terrax_quickstart.ipynb` walks through forest loss, hydrology, canopy and disturbance dating; the tests execute it from top to bottom.
- **R and Julia.** `clients/R/terrax` (an R package; results as lists, outputs ready for `terra` and `sf`) and `clients/julia/TerraX` (results as Dicts). Both run the `terrax` command; see `clients/README.md`, which also shows the web API for any other language.
- Only the live-catalogue tools (Sentinel-1, Sentinel-2 and Landsat search) and the residential plot tool stay web-only.

## Forest-loss alerts

A signed-in user can watch an area (the analysis boundary, up to 14 km across) from the forest tool.

- **Reference.** TerraX builds a cloud-free median composite from up to six of the clearest Sentinel-2 scenes of the last 120 days. Forest is NDVI ≥ 0.5 on it.
- **Checks.** Every day by default (6 hours to 30 days), and at once with "Check now", TerraX reads the scenes published since the last check onto the reference grid with their own cloud mask (SCL).
- **Confirmation.** A forest pixel whose NDVI is at least 0.2 below the reference is a candidate. It is confirmed when its next clear observation is low too, the two-observation rule of the GLAD (Hansen et al. 2016) and RADD (Reiche et al. 2021) alerts, which removes most false alarms from undetected cloud, haze and shadow.
- **Radar (on by default).** Cloud can hide the ground from Sentinel-2 for weeks in the monsoon, so Sentinel-1 RTC scenes (Planetary Computer) are checked too.
  - The radar reference is the median VH backscatter (dB) of the last 120 days' scenes, each read onto the reference grid and Lee-filtered.
  - A forest pixel whose VH falls at least `vhDrop` (3 dB) below it is a radar candidate. Clearing removes the canopy's volume scattering, so VH usually falls.
  - Each sensor keeps its own pending state: a radar drop is confirmed only by the next radar scene, so speckle cannot confirm or cancel an optical detection, nor the reverse. Alerts say which satellite found them.
  - This is a threshold on a reference, not RADD's probabilistic method. `vhDrop` is a setting, not a calibrated value. Wet or dry canopies, flooding and mixing orbits also move VH.
- **Alerts.** Patches of confirmed loss of at least 0.5 ha become an alert, with the date the drop was first seen, the date it was confirmed, the area and the polygons (GeoJSON). The owner is e-mailed when the server can send mail (`TERRAX_SMTP_*`).
- **Limits.** Harvest, fire, storm and clearing all count as loss. A strong seasonal drop beyond the threshold (leaf-off, drought) is not excluded, so rebuild the reference when the season has changed. An account may keep `TERRAX_MONITORS` monitors (10).
- **Running.** Celery beat (`docker compose`) or, in one-container hosting, the hourly background thread checks the monitors that are due.

## Storage and backups

- **Object storage.** Set `TERRAX_S3_BUCKET` (and, for a service other than AWS S3, `TERRAX_S3_ENDPOINT`, `TERRAX_S3_REGION`, `TERRAX_S3_PATH_STYLE`) with the usual `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. Cloudflare R2, Backblaze B2, MinIO and Wasabi all work. The Docker images include the client (`pip install 'terrax[s3]'` otherwise).
  - Every upload is copied to the bucket before it is indexed. A finished job's result and pictures are copied before its status says "done", so a reader that sees "done" always finds the result.
  - The storage folder becomes a cache. Whatever is not on this machine's disk is fetched from the bucket when it is first needed. This covers restarts on a host whose disk does not survive one, and API and worker machines that share no disk. Copies unused for `TERRAX_S3_CACHE_HOURS` (24) are dropped from the disk; the bucket keeps them until they expire.
  - While a job runs elsewhere, its progress reaches the bucket at most every 3 seconds. The API shows the newer of its own and the bucket's status, and never writes the bucket's over a status on its own disk.
  - Expiry and deletion remove the bucket's copies too. `/api/health/ready` reports whether the bucket answers.
- **Database backups.** Every `TERRAX_BACKUP_HOURS` (24) the hourly clean-up backs the database up, and keeps the newest `TERRAX_BACKUP_KEEP` (14).
  - Backups go to `backups/` in the bucket, or else to `TERRAX_BACKUP_DIR` (default `storage/backups`, which only protects against losing the database file, not the disk).
  - A backup is a consistent snapshot: SQLite's online backup API, or one `REPEATABLE READ` transaction on PostgreSQL. It is written as gzipped JSON lines, one row per line, so a SQLite backup restores into PostgreSQL and back. Rate-limit counters and sign-in round trips are left out.
  - `python -m terrax.manage backup` makes one now, `backups` lists them, and `restore NAME --yes` replaces every row with a backup's in one transaction. Backups from older schema revisions restore; a newer one is refused. On PostgreSQL the id sequences are moved past the restored rows.
  - With `TERRAX_BACKUP_RESTORE_EMPTY=true`, a server that starts with an empty database restores the newest backup itself. This suits SQLite on a host whose disk is wiped on restart, with backups in a bucket.
  - With that setting, while the backups cannot be read (the bucket is unreachable or the credentials are wrong), the database does not open: every request fails, and no backup is made. This is deliberate: serving an empty database would lose the accounts, and backups of it would rotate the good ones away. Each request tries again, so once the bucket answers, the next one restores as usual.
- **Interrupted jobs.** Every minute, the process running or queueing a job touches its database row. A job whose row has not changed for 5 minutes is marked failed, with a message to run it again, instead of showing "running" for ever. This happens when its server restarted or crashed mid-run. With Celery, only running jobs are checked: queued ones wait in Redis, which outlives a restart.

## Monitoring

- **Request IDs and logs.**
  - Every response has an `X-Request-ID` (the caller's, or a new one), which every log line repeats. A 500 answer quotes it.
  - `TERRAX_LOG_FORMAT=json` writes one JSON object per line for log collectors.
- **Health checks.** `GET /api/health` checks the process is alive. `GET /api/health/ready` also checks the database, the storage folder and, with Celery, Redis (503 when one fails).
- **Metrics.** `GET /api/metrics` serves Prometheus metrics: requests and latency by route, uploads, sign-ins, rate-limited requests, jobs by tool and state across all workers, recent job run times, stored bytes and memory. Scrape it with `TERRAX_METRICS_TOKEN` as a bearer token; admins can open it directly.
- **Errors.**
  - Unexpected errors in the API, in analyses on the workers, and in browsers are recorded in the database. Browsers report uncaught exceptions and crashed views to `/api/client-errors`.
  - They are kept for `TERRAX_ERROR_RETENTION_DAYS` and shown in the Admin tab.
  - With `SENTRY_DSN` (and `pip install 'terrax[sentry]'`) they also go to Sentry or a Sentry-compatible service such as GlitchTip.

## AI

The assistants and "Add AI interpretation" work with an API key from almost any AI provider, through the server (`/api/agents`, `backend/terrax/agents/llm.py`).

**Providers.** Three adapters cover them:

| Adapter | Providers |
|---|---|
| Gemini (google-genai SDK, answers grounded in Google Search with sources) | Google Gemini |
| Anthropic Messages API | Anthropic Claude |
| OpenAI-compatible (`/chat/completions`, `/models`) | OpenAI, DeepSeek, Groq, OpenRouter, xAI, Mistral, Together; a local Ollama; any other OpenAI-compatible server by its base URL ("custom") |

**Recognising a key.** Many keys start with a fixed prefix (`AIza` Gemini, `sk-ant-` Anthropic, `sk-or-` OpenRouter, `gsk_` Groq, `xai-` xAI). The longest matching prefix narrows a key to one provider, or a few: a plain `sk-` may be OpenAI or DeepSeek, and a key with no known prefix may be Mistral or Together. Each candidate is then asked to list its models, most likely first, until one accepts the key. Listing models is free, so checking a key spends no tokens.

- With priors p₁ ≥ p₂ ≥ …, the expected number of checks is Σ i·pᵢ: one for a prefixed key, about 1.2 for a plain `sk-` key.
- The provider can also be chosen by hand.
- The model defaults to the provider's preferred model when the key lists it, otherwise to a fast chat model from the list. It can be changed in Settings.
- The Google and Anthropic endpoints were checked against the live services during development. The others follow the providers' published OpenAI-compatible endpoints.

**Where keys come from, in order:**

1. **Up to three keys entered in Settings**, kept in that browser. They are sent with each AI request in a header and passed to the provider. The server never stores or logs them, and removes them from providers' error messages.
2. **The server's key:** `TERRAX_AI_KEY`, with optional `TERRAX_AI_PROVIDER`, `TERRAX_AI_MODEL` and `TERRAX_AI_BASE_URL`. An unset provider is recognised from the key once and remembered. `GEMINI_API_KEY` (and `GEMINI_MODEL`) are still read when `TERRAX_AI_KEY` is unset.
3. **The built-in assistant.** It has no AI model, and it answers questions about the tools, terms and units, sun times and the current results.

A key that fails or is over its limit is skipped, and the answer says which key answered and why an earlier one was skipped. The chat therefore always answers.

**Limits.** Each key a user adds has its own budget: `TERRAX_AI_PER_KEY_PER_MINUTE` (20) per key, counted by a hash of the key in the shared rate-limit store, on top of 20 a minute per client. The server's key is shared by every user, so it has no cap of its own unless `TERRAX_AI_SERVER_PER_MINUTE` sets one. When a provider answers 429, that key rests for the provider's `Retry-After` before it is asked again.

**Custom servers and Ollama.** A base URL typed by a user must resolve only to public addresses. Otherwise TerraX could be made to call into its own network (server-side request forgery), including cloud metadata at 169.254.169.254.

- Set `TERRAX_AI_ALLOW_PRIVATE=true` to allow private and local addresses, for example a local Ollama at `http://localhost:11434/v1`.
- The request goes to the address that was checked, with the hostname kept for TLS, so a DNS answer that changes in between cannot redirect it.
- Plain `http://` is accepted only for allowed private addresses, so a key never crosses the internet unencrypted.
- Redirects are not followed, and answers are capped at 4 MB.

## Tests

| Command | What it checks |
|---|---|
| `cd backend && pytest` | 329 tests (6 of them live, run with `TERRAX_LIVE=1`), on SQLite or (with `DATABASE_URL`) PostgreSQL: the command line and Python API on local files (GeoTIFF georeferencing, colour tables and values checked), notebook maps (overlays aligned with their polygons) and the quickstart notebook run end to end, object storage against an in-process S3 (moto; with `TERRAX_TEST_S3_ENDPOINT`, a real server, which CI runs with SeaweedFS), database backup and restore, interrupted jobs, accounts, sessions, two-factor sign-in (RFC 6238 test vectors), password reset and confirmation over a real SMTP exchange, single sign-on against a stand-in provider, signed links, the audit log, migrations, body limits, guest isolation, projects and sharing, admin rights, rate limits, quotas, retention, metrics and error records; statistics, dates, metrics, climate (Seasonal Kendall, SPI), hydrology, patches, carbon allometry, emissions (hand-computed totals, Monte Carlo against the normal interval, a biomass map resampled from another resolution and projection, the validated estimate), encroachment, forest/terrain/index results with known answers, boundary clipping, survey geodesy, EXIF, solar and Kp, live-data parsers, Sentinel-2 and Landsat window reading and composites (mocked catalogue, local files with known reflectance), forest-loss monitors (reference, cloud-masked candidates, two-observation confirmation, minimum patch, e-mailed alerts, ownership), water and floods (bimodality test, exact optical areas with a cloud mask, a speckled radar flood that leaves permanently dark ground out, water-body areas, perimeters, centroids and truncation on hand-made shapes, NDTI and NDCI per lake against hand-computed values with the mixed shore left out, water occurrence and per-date water on a cloudy five-date series), maps, assistant, AI keys from any provider (recognition by prefix and model listing, the Gemini, Anthropic and OpenAI-compatible protocols against stand-in providers, errors that never show the key, each key's own limit and the provider's Retry-After, falling back along the keys, private-address and redirect protection), every API tool, one-container hosting and strip processing equal to whole-grid results |
| `cd frontend && npm run lint && npm test` | Type-check and unit tests for maps, projects, units, theme and vector export |
| `cd frontend && npm run test:e2e` | Playwright on desktop and mobile against the real API (it starts uvicorn and `vite preview`); set `TERRAX_URL=http://localhost:8080` to test the Docker stack instead |
| `Rscript clients/R/terrax/tests/run_tests.R` and `julia --project=clients/julia/TerraX -e 'using Pkg; Pkg.test()'` | The R and Julia clients on the samples. They check the web app's answers and that TerraX's error messages arrive as R and Julia errors. In R, `terra` also reads the class map. |
| `QT_QPA_PLATFORM=offscreen /usr/bin/python3 -m unittest discover -s qgis-plugin/tests` | The QGIS plugin in a real, headless QGIS: every algorithm registers. The main ones run on the samples and give the web app's answers (184.05 ha of loss, 25 tree tops, 54 ha of disturbance). They also load labelled class maps, and TerraX's error messages reach QGIS. |

CI (`.github/workflows/ci.yml`) runs all five (the QGIS plugin on QGIS 3.34 LTR, R 4.3 and Julia 1.10), then builds and starts the Docker Compose stack and the one-container image.

`TERRAX_LIVE=1 pytest tests/test_live.py` searches, reads and analyses real Sentinel-1 scenes and Landsat scenes (a recent OLI scene, one from 1989–93 and a median composite; Planetary Computer) and Sentinel-2 scenes and a median composite (Earth Search). It checks that radar backscatter and optical reflectance over vegetation are physically plausible. The **Live data** workflow (`.github/workflows/live.yml`) runs it weekly, by hand, and on pull requests that change that code. It is kept out of CI because it depends on outside services.

## Hosting

TerraX needs its Python server, so a static host such as GitHub Pages or Netlify cannot run it. The older browser-only build, which runs every analysis in the browser and is kept as a claude.ai artifact, is described in `deploy/browser-preview/`.

### One container: Hugging Face Spaces or Render

The root `Dockerfile` builds a single container for hosts that run one service. In it, the FastAPI server serves the web app itself (`TERRAX_STATIC`) and runs analyses on background threads (`TERRAX_JOB_THREADS`), so nginx, Redis and Celery are not needed.

**Hugging Face Spaces.** Hugging Face now needs a PRO subscription to host a Docker Space on its CPU tier: in November 2026, creating one on a free account was refused with "Static Spaces are free for everyone, but hosting Gradio and Docker Spaces on free cpu-basic requires a PRO subscription." (HTTP 402). Check huggingface.co/pro for the current terms.

1. Create a write token at huggingface.co → Settings → Access Tokens.
2. Upload the app: `HF_TOKEN=hf_... python deploy/huggingface/upload.py <your-name>/terrax`. This creates the Space if needed and uploads the repository with the Space README (`deploy/huggingface/README.md`).
3. Optional: upload automatically on every push to `main`. In GitHub → Settings → Secrets and variables → Actions, add the secret `HF_TOKEN` (a Hugging Face token with write permission). The Space is the token owner's `terrax`; set the variable `HF_SPACE` (for example `khumbemo/terrax`) for another name. The **Deploy to Hugging Face Spaces** workflow then runs on each push.

**Render.** [Deploy with the blueprint](https://render.com/deploy?repo=https://github.com/Khumbemo/TerraX) (`render.yaml`). The free plan has 512 MB of memory. It runs the sample data one analysis at a time, sleeps after 15 idle minutes and takes about a minute to wake. Large rasters need a paid plan.

On both hosts, add `GEMINI_API_KEY` as a secret if the AI assistants should use a server key. Uploads and results are lost when the container restarts. So is the built-in SQLite database, with its accounts, history and projects. To keep them, set `TERRAX_S3_BUCKET` (Cloudflare R2 and Backblaze B2 have free tiers) for uploads and results. Then either set `DATABASE_URL` to a PostgreSQL database, or keep SQLite with `TERRAX_BACKUP_HOURS=1` and `TERRAX_BACKUP_RESTORE_EMPTY=true`, so a restart loses at most the last hour of account changes (see [Storage and backups](#storage-and-backups)). `render.yaml` asks for it, along with `TERRAX_AUTH=required` and the first admin's e-mail and password. It also generates `TERRAX_SECRET_KEY`. For password-reset e-mail or single sign-on, add the `TERRAX_SMTP_*` or `TERRAX_OIDC_*` settings and `TERRAX_PUBLIC_URL`.

To run the same container yourself:

```bash
docker build -t terrax . && docker run -p 7860:7860 terrax   # http://localhost:7860
```

### Full stack: Docker Compose

On any machine or VM, `docker compose up --build` runs the web app (nginx), the API, Celery workers, the scheduler, Redis and PostgreSQL. Uploads are kept in one volume and the database in another. Set `POSTGRES_PASSWORD`, `TERRAX_AUTH` and the first admin in `.env` (see `backend/.env.example`). Put HTTPS in front of nginx for a public server. Cookies are marked Secure when the API sees HTTPS. If TLS ends at a proxy in front of nginx, set `TERRAX_COOKIE_SECURE=true`. You can also run the `backend` image as three services (API, worker, beat) next to a managed Redis, and serve `frontend/dist` behind a proxy that forwards `/api`. `frontend/nginx.conf` is a working example. If the API is on another origin, build the app with `VITE_API_BASE=https://api.example.org` and add that origin to `TERRAX_CORS`.

## Scientific notes

- **Areas.** Geographic rasters use exact WGS84 cell areas (authalic latitude). Survey measurements are geodesic on the WGS84 ellipsoid (Karney 2013, pyproj).
- **Forest loss.** Loss from NDVI thresholds is a proxy and does not apply the FAO forest definition. Compare images from the same season.
- **Forest at the start.** FAO defines forest as more than 0.5 ha with trees taller than 5 m and canopy cover above 10 %. An NDVI threshold only measures greenness: in a Guwahati test, NDVI ≥ 0.5 agreed with ESA WorldCover trees on 81 % of pixels, confusing dense crops with forest. A forest map follows the definition more closely:
  - a tree-cover map: cover ≥ 10 %, averaged onto the image grid;
  - a canopy height model: the share of its cells at least 5 m tall within each pixel, ≥ 10 %;
  - a class map: the classes named, by the most common class within each pixel.
  
  Then patches under 0.5 ha are dropped, and pixels the map does not cover are left out. Loss is still a drop in NDVI on that forest. Land use is not in these maps (an orchard counts as forest), and a map's own date may differ from the earlier image's.
- **Emissions.** E = A × (B − B_after) × CF × 44/12, with B = AGB × (1 + R), the root-to-shoot ratio R from IPCC 2006 Vol. 4 Table 4.4 for the chosen zone (cell by cell for a biomass map) and CF = 0.47 (Table 4.3).
  - These are committed emissions: all biomass carbon on the lost area counts as emitted at the time of loss, as in IPCC Tier 1. Dead wood, litter, soil carbon and fire emissions are not included.
  - The 95 % interval comes from 20,000 Monte Carlo draws of independent normal inputs (IPCC Approach 2). Approach 1 error propagation is shown for comparison.
  - Until the map is validated, the area is the mapped loss, which has no interval. Report the emissions from the estimated area.
  - TerraX has no built-in IPCC default biomass values: give a biomass value from field plots or a published estimate for the area, or a biomass map.
- **Reference labelling.** The app shows each sample point over Esri World Imagery or Sentinel-2 cloudless (2016, 2020), with its pixel outlined and without its map class. The points are shuffled, because their ids run class by class.
  - Labels are kept in the browser until the accuracy is computed. "Can't tell" leaves a point out of the estimates.
  - Leaving many points out, especially in one class, can bias the estimates, because the estimators assume the missing points are like the labelled ones.
  - Imagery dates vary by place. For change, compare imagery from before and after the map's two dates.
- **Emissions summary.** After validation, the forest-loss emissions are summarised under REDD+ and IPCC headings:
  - activity data: the estimated loss area with its 95 % CI, and the loss class's accuracies;
  - emission factor;
  - emissions, with the Approach 2 interval and an optional yearly mean;
  - the uncertainty sources included and left out;
  - what is counted: gross committed emissions in above- and below-ground biomass.
  
  It states that it is an automatic summary, not a verified submission.
- **Seasonal disturbances.** Each pixel's model, y = a + b·t + c·cos 2πt + d·sin 2πt, is fitted on its first stable year of clear observations (at least 8). The window is stable when the trend across it and its first and last residuals are all below the threshold; otherwise it moves one observation later.
  - **Detection:** 3 (adjustable 2–6) clear observations in a row below the prediction by at least max(3σ, the smallest drop) confirm a disturbance. A single low value is treated as noise. A new model then starts.
  - **Limits:** a disturbance in the first year of clear data cannot be detected. Only drops are mapped. TerraX uses one harmonic and one index, where CCDC uses more harmonics and several bands together.
  - **Recovery:** the share of the last drop regained by the end of the series, from the trend of the model fitted after it.
- **Water.** Water indices and radar backscatter are thresholded by Otsu's method only when the values are bimodal. That is judged by Ashman's D of a fitted two-component Gaussian mixture: the two halves of a single bell curve cut at Otsu's threshold are about 2.6 apart, so D on the split itself would pass by mistake. A tie between thresholds (an empty gap between the peaks) takes the middle of the gap.
  - Radar misses flooded vegetation and towns, which look brighter through double bounce. Radar shadow, smooth tarmac and dry sand can look like water. Use dates from the same orbit.
  - Optical maps can mistake terrain and building shadows, dark asphalt, and turbid or vegetated water.
  - **HAND** (height above the nearest drainage; Rennó et al. 2008, Nobre et al. 2011). With a DEM, each cell's height above the first channel cell on its D8 flow path is computed on the DEM's grid, then warped onto the image bilinearly. Channels start where `streamKm2` (0.5 km²) drains to a cell.
    - Water more than `handMax` (15 m) above its channel is removed, which takes out much of the terrain shadow and steep-slope false water.
    - Both values are settings, not calibrated: set the HAND limit from the flood heights expected locally. A channel threshold that is too small makes long, even hillslopes into channels (HAND 0).
    - The mask also removes real water perched above the drainage, such as ponds, reservoirs and terraces. Where no channel is reached inside the DEM, or the DEM is missing, nothing is removed.
  - **Water bodies** are the 8-connected patches of water. Perimeters follow the pixel edges, so they are longer than the real shoreline (by 4/π ≈ 1.27 on average for shores in every direction, up to √2 on diagonal shores) and grow with finer pixels; shoreline development P / (2√(πA)) (Hutchinson 1957) carries the same bias. Bodies touching the image edge, the boundary, cloud or missing data are marked truncated: only their visible part is measured.
  - **Water over time**: occurrence is water observations ÷ clear observations per pixel (Pekel et al. 2016); pixels with fewer than `minObs` (3) clear observations are left out. "Water almost always" (`almostPct`, 90 %) is a setting. Whether "water at times" is seasonal, a drawn-down reservoir or occasional flooding depends on when the images were taken. Areas seen on cloudy dates are only what was visible.
  - **Water quality**: NDTI = (Red − Green) / (Red + Green) rises with suspended sediment (Lacaux et al. 2007); NDCI = (Red-edge 705 nm − Red) / (Red-edge + Red) rises with chlorophyll-a (Mishra & Mishra 2012) and needs Sentinel-2 band 5 or similar. Both are computed only on interior water pixels (all 8 neighbours water), since shore pixels mix in land. They are relative indicators: converting them to turbidity (NTU) or chlorophyll-a (µg/L) needs water samples near the image date. Shallow clear water, sun glint, floating plants and haze change them; use surface reflectance (Sentinel-2 L2A digital numbers processed since January 2022 carry a −1000 offset to remove first).
- **Trends.** The Mann–Kendall test assumes independent observations, so seasonal or autocorrelated series can look significant when they are not. Use the Seasonal Kendall test for monthly data.
- **Classes.** Class thresholds are indicative and vary with sensor, season and region.
- **Sun.** Solar geometry uses the NOAA Solar Calculator equations (equation of time, declination). Sun position and rise/set times use the formulas of aa.quae.nl (the same as SunCalc).
- **Residential plot.** The screening is not proof of ownership or encroachment. Use a licensed surveyor for disputes.

## Licence

TerraX is released under the [MIT License](LICENSE). The built-in maps keep their own licences (see [Maps](#maps)), and the bundled Kohima CSV series have no documented source.
