# TerraX

TerraX is an Earth-observation workbench for forest, land, climate and imagery analysis. You upload GeoTIFF rasters, vector boundaries, time-series tables or photos. A Python server runs the analysis with stated scientific methods and returns a report, charts and map layers. An optional Gemini interpretation can be added.

## Architecture

| Part | Technology | Folder |
|---|---|---|
| Web app | React 19 + TypeScript, Vite, **MapLibre GL** maps, Recharts | `frontend/` |
| API | **FastAPI** (uploads, jobs, results, built-in map tiles, assistants, live data) | `backend/terrax/api/` |
| Jobs | **Celery** workers with **Redis** as broker; Celery beat deletes old files | `backend/terrax/tasks.py` |
| Processing | Python: **rasterio**, **GeoPandas**, **scikit-learn**, SciPy, pyproj, Shapely, NumPy, numba, Pillow | `backend/terrax/processing/` |
| Agents | Built-in assistant (no AI model) and Gemini agents (google-genai) | `backend/terrax/agents/` |
| Accounts and data | **SQLAlchemy**: SQLite by default, **PostgreSQL** with `DATABASE_URL` (users, sessions, upload and job index, history, projects, recorded errors) | `backend/terrax/db.py`, `auth.py` |
| Monitoring | Request IDs, JSON logs, Prometheus metrics, error records and optional Sentry | `backend/terrax/monitoring.py` |

The browser uploads a file once and gets an id. To analyse it, the browser starts a job (`POST /api/jobs`), polls the job's progress and then shows the result. Pictures, GeoJSON and CSV files from a job are served from `/api/jobs/{id}/artifacts/`. Uploads and results live in a shared storage folder (`TERRAX_STORAGE`), so any worker can run any job. Interactive documentation for the API is at `/api/docs`.

## Tools

| Tool | Upload | What it computes |
|---|---|---|
| **Forest loss** | Two NDVI (or red/NIR) GeoTIFFs on the same grid; Hansen GFC `lossyear` (+ `treecover2000`); pre/post NBR | Forest area, loss and gain in hectares; Hansen loss by year; dNBR burn severity (USGS classes); minimum mapping unit; loss polygons; a stratified validation sample and loss (or burned) area with a 95 % CI from its reference labels (Olofsson et al. 2014), as IPCC and REDD+ reporting expect |
| **Carbon & biomass** | Forest-Capture CSV or any CSV with species, DBH/GBH, height, plot size | AGB by Chave et al. 2014/2005, IPCC root:shoot, carbon and CO₂e per hectare with a Student-t 95 % CI |
| **Land survey** | GeoJSON, KML, GPX, CSV (lat/lon), zipped Shapefile, or drawn on the map | Geodesic area and perimeter (Karney 2013), legs and bearings, UTM/DMS, elevation profile; becomes the analysis boundary |
| **Residential plot** | Dated GeoTIFFs plus a boundary, or same-view photos | Radiometric normalisation, robust change detection, changes crossing the boundary (area and depth) |
| **Weather & climate** | CSV, TSV or XLSX series; Open-Meteo ERA5 or NASA POWER fetched by the server | Mann–Kendall and Theil–Sen, seasonal cycle, Seasonal Kendall, anomalies, SPI-1/3/6/12, IMD rainfall classes |
| **Satellite imagery** | Multiband GeoTIFF; Sentinel-2 L2A windows from Earth Search, one scene or a cloud-free median composite of 2–12 (each masked by its own SCL, reprojected onto one grid); several dated images | Composites, NDVI, EVI, SAVI, NDWI, NDMI, NBR, NDBI, SCL/QA_PIXEL cloud masks, pixel inspector, multi-date trend; per-pixel disturbance dating (one abrupt drop on a trend, BIC-selected, as in BFAST's single-break model; Verbesselt et al. 2010) with the disturbed area by date |
| **Land cover** | Multiband GeoTIFF (+ training shapes) | k-means (scikit-learn, k-means++) clusters ordered by NDVI, or a random forest (50, 100 or 200 trees) trained on labelled polygons or points and cross-validated by shape, optionally with Sentinel-1 VV, VH and VH/VV (dB) as extra features, reprojected onto the image's grid in linear power; a stratified validation sample and accuracy and area estimates with 95 % CIs (Olofsson et al. 2014) |
| **Radar (Sentinel-1)** | VV/VH backscatter GeoTIFFs (dB or linear), one date or two from the same relative orbit; or search Sentinel-1 RTC (γ⁰, 10 m) on the Microsoft Planetary Computer and read the window over the area | Lee (1980) speckle filter in linear power, VV, VH, VH/VV and dual-pol RVI; VH log-ratio change map (±3 dB) with areas and a GeoTIFF export |
| **Canopy height** | LAS/LAZ point cloud (ground classified), DSM + DTM, or a CHM GeoTIFF | Canopy height model (first returns minus TIN-filled ground), cover at 2 m and the FAO 5 m height, height classes, tree tops by local maxima with Popescu & Wynne (2004) crown windows (a lower bound under overlapping crowns); with field plots counted on the ground, a calibrated tree count with a 95 % CI (ratio estimator, Cochran 1977); with field plots of measured biomass, AGB = a·TCHᵇ fitted on plot-scale mean canopy height (Asner & Mascaro 2014) and applied to plot-sized cells, with biomass, carbon and CO₂e totals and a Monte Carlo 95 % CI; CHM GeoTIFF and tree-top GeoJSON |
| **Terrain** | DEM GeoTIFF | Slope and aspect (Horn 1981), hillshade, hypsometric integral, Priority-Flood + D8 flow, Strahler streams, watersheds, contours; optional D∞ flow (Tarboton 1997) with the topographic wetness index and D∞ watersheds (upslope dependence on the clicked outlet) |
| **Space & aerial photos** | JPG, PNG, WebP | Vegetation cover (ExG + Otsu), VARI, EXIF position on the map, comparison of two photos |

Every tool has sample data in `backend/data/samples/`. The rasters, plots, photo, inventory and 1990–2024 climate series are **synthetic**, generated by `backend/scripts/make_samples.py`; do not use them as research data. The six Kohima CSV series are bundled for demonstration, and their original source is not documented.

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
cp .env.example .env        # optional: GEMINI_API_KEY, retention, upload limit
docker compose up --build
# open http://localhost:8080
```

This starts five containers:

- `web`: nginx serving the app and proxying `/api`
- `api`: FastAPI
- `worker`: Celery
- `beat`: the hourly clean-up
- `redis`

Uploads and results are kept in the `storage` volume. To handle more jobs at once, scale the workers with `docker compose up --scale worker=3`.

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
- `GEMINI_API_KEY` and `GEMINI_MODEL`
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
  - Admins get an **Admin** tab: accounts, usage, the audit log, recorded errors. They can also turn off someone's two-factor sign-in (a lost phone) and mark an address as confirmed.
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

The assistants and "Add AI interpretation" use Gemini through the server (`/api/agents`). The key can come from two places:

- **The server's `GEMINI_API_KEY`.** The key never reaches the browser.
- **A user's own key, entered in Settings.** It is kept in that browser and sent with each AI request. The server passes it to Google and does not store it.

Without a key, the built-in assistant answers. It has no AI model. It handles questions about the tools, terms and units, sun times, and the current results.

## Tests

| Command | What it checks |
|---|---|
| `cd backend && pytest` | 242 tests (3 of them live, run with `TERRAX_LIVE=1`), on SQLite or (with `DATABASE_URL`) PostgreSQL: accounts, sessions, two-factor sign-in (RFC 6238 test vectors), password reset and confirmation over a real SMTP exchange, single sign-on against a stand-in provider, signed links, the audit log, migrations, body limits, guest isolation, projects and sharing, admin rights, rate limits, quotas, retention, metrics and error records; statistics, dates, metrics, climate (Seasonal Kendall, SPI), hydrology, patches, carbon allometry, encroachment, forest/terrain/index results with known answers, boundary clipping, survey geodesy, EXIF, solar and Kp, live-data parsers, Sentinel-2 window reading, maps, assistant, every API tool, one-container hosting and strip processing equal to whole-grid results |
| `cd frontend && npm run lint && npm test` | Type-check and unit tests for maps, projects, units, theme and vector export |
| `cd frontend && npm run test:e2e` | Playwright on desktop and mobile against the real API (it starts uvicorn and `vite preview`); set `TERRAX_URL=http://localhost:8080` to test the Docker stack instead |

CI (`.github/workflows/ci.yml`) runs all three, then builds and starts the Docker Compose stack and the one-container image.

`TERRAX_LIVE=1 pytest tests/test_live.py` searches, reads and analyses real Sentinel-1 scenes (Planetary Computer) and Sentinel-2 scenes and a median composite (Earth Search). It checks that the radar backscatter values are physically plausible. The **Live data** workflow (`.github/workflows/live.yml`) runs it weekly, by hand, and on pull requests that change that code. It is kept out of CI because it depends on outside services.

## Hosting

TerraX needs its Python server, so a static host such as GitHub Pages or Netlify cannot run it. The older browser-only build, which runs every analysis in the browser and is kept as a claude.ai artifact, is described in `deploy/browser-preview/`.

### Free, one container: Hugging Face Spaces or Render

The root `Dockerfile` builds a single container for hosts that run one service. In it, the FastAPI server serves the web app itself (`TERRAX_STATIC`) and runs analyses on background threads (`TERRAX_JOB_THREADS`), so nginx, Redis and Celery are not needed.

**Hugging Face Spaces.** The free CPU tier has 2 vCPU and 16 GB of memory, which is enough for real rasters.

1. Create a write token at huggingface.co → Settings → Access Tokens.
2. Upload the app: `HF_TOKEN=hf_... python deploy/huggingface/upload.py <your-name>/terrax`. This creates the Space if needed and uploads the repository with the Space README (`deploy/huggingface/README.md`).
3. Optional: upload automatically on every push to `main`. In GitHub → Settings → Secrets and variables → Actions, add the secret `HF_TOKEN` and the variable `HF_SPACE` (for example `khumbemo/terrax`). The **Deploy to Hugging Face Spaces** workflow then runs on each push.

**Render.** [Deploy with the blueprint](https://render.com/deploy?repo=https://github.com/Khumbemo/TerraX) (`render.yaml`). The free plan has 512 MB of memory. It runs the sample data one analysis at a time, sleeps after 15 idle minutes and takes about a minute to wake. Large rasters need a paid plan.

On both hosts, add `GEMINI_API_KEY` as a secret if the AI assistants should use a server key. Uploads and results are lost when the container restarts. So is the built-in SQLite database, with its accounts, history and projects. For accounts that last, set `DATABASE_URL` to a PostgreSQL database. `render.yaml` asks for it, along with `TERRAX_AUTH=required` and the first admin's e-mail and password. It also generates `TERRAX_SECRET_KEY`. For password-reset e-mail or single sign-on, add the `TERRAX_SMTP_*` or `TERRAX_OIDC_*` settings and `TERRAX_PUBLIC_URL`.

To run the same container yourself:

```bash
docker build -t terrax . && docker run -p 7860:7860 terrax   # http://localhost:7860
```

### Full stack: Docker Compose

On any machine or VM, `docker compose up --build` runs the web app (nginx), the API, Celery workers, the scheduler, Redis and PostgreSQL. Uploads are kept in one volume and the database in another. Set `POSTGRES_PASSWORD`, `TERRAX_AUTH` and the first admin in `.env` (see `backend/.env.example`). Put HTTPS in front of nginx for a public server. Cookies are marked Secure when the API sees HTTPS. If TLS ends at a proxy in front of nginx, set `TERRAX_COOKIE_SECURE=true`. You can also run the `backend` image as three services (API, worker, beat) next to a managed Redis, and serve `frontend/dist` behind a proxy that forwards `/api`. `frontend/nginx.conf` is a working example. If the API is on another origin, build the app with `VITE_API_BASE=https://api.example.org` and add that origin to `TERRAX_CORS`.

## Scientific notes

- **Areas.** Geographic rasters use exact WGS84 cell areas (authalic latitude). Survey measurements are geodesic on the WGS84 ellipsoid (Karney 2013, pyproj).
- **Forest loss.** Loss from NDVI thresholds is a proxy and does not apply the FAO forest definition. Compare images from the same season.
- **Trends.** The Mann–Kendall test assumes independent observations, so seasonal or autocorrelated series can look significant when they are not. Use the Seasonal Kendall test for monthly data.
- **Classes.** Class thresholds are indicative and vary with sensor, season and region.
- **Sun.** Solar geometry uses the NOAA Solar Calculator equations (equation of time, declination). Sun position and rise/set times use the formulas of aa.quae.nl (the same as SunCalc).
- **Residential plot.** The screening is not proof of ownership or encroachment. Use a licensed surveyor for disputes.
