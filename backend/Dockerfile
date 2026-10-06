# TerraX Python image: the FastAPI API, Celery workers and the Celery beat
# scheduler all run from it (docker-compose.yml picks the command).
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    TERRAX_STORAGE=/data/storage TERRAX_DATA=/app/data \
    NUMBA_CACHE_DIR=/tmp/numba

# rasterio, pyproj, shapely and pyogrio wheels bundle GDAL/PROJ/GEOS; the GDAL in them only needs libexpat from the system.
RUN apt-get update && apt-get install -y --no-install-recommends libexpat1 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml ./
COPY terrax ./terrax
RUN pip install .
COPY data ./data

RUN useradd --create-home --uid 1000 terrax && mkdir -p /data/storage /tmp/numba && chown -R terrax /data /tmp/numba
USER terrax
VOLUME ["/data/storage"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4)"
CMD ["uvicorn", "terrax.api.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]
