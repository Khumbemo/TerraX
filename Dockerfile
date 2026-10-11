# TerraX in one container, for hosts that run a single service (Hugging Face
# Spaces, Render): the FastAPI server serves the built web app itself and runs
# jobs on background threads, so no nginx, Redis or Celery is needed.
# For a full deployment with separate workers use docker-compose.yml instead.
#   docker build -t terrax . && docker run -p 7860:7860 terrax
FROM node:22-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    TERRAX_DATA=/app/data TERRAX_STATIC=/app/web TERRAX_STORAGE=/home/terrax/storage \
    TERRAX_JOB_THREADS=2 NUMBA_CACHE_DIR=/tmp/numba PORT=7860

# rasterio, pyproj, shapely and pyogrio wheels bundle GDAL/PROJ/GEOS; the GDAL in them only needs libexpat from the system.
RUN apt-get update && apt-get install -y --no-install-recommends libexpat1 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/pyproject.toml ./
COPY backend/terrax ./terrax
RUN pip install .
COPY backend/data ./data
COPY --from=web /web/dist ./web

# Hugging Face Spaces run the container as user 1000.
RUN useradd --create-home --uid 1000 terrax && mkdir -p /home/terrax/storage /tmp/numba && chown -R terrax /home/terrax /tmp/numba
USER terrax
EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD python -c "import os, urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\", \"7860\")}/api/health', timeout=4)"
# The host sets PORT (Render: 10000); Hugging Face uses app_port 7860.
CMD ["sh", "-c", "exec uvicorn terrax.api.main:app --host 0.0.0.0 --port ${PORT:-7860} --proxy-headers --forwarded-allow-ips='*'"]
