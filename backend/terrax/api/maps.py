"""Built-in world maps: XYZ picture tiles, vector layers, the graticule and point identification."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, Response

from ..services import worldmaps as wm

router = APIRouter(prefix="/api/maps", tags=["maps"])
CACHE = {"Cache-Control": "public, max-age=604800, immutable"}


@router.get("/catalog")
def catalog() -> dict[str, Any]:
    present = {k: (wm.maps_dir() / p.file).is_file() for k, p in wm.PICTURES.items()}
    return {
        "pictures": {k: {"maxZoom": p.max_zoom, "classes": p.classes, "tileSize": wm.TILE, "available": present[k], "tiles": f"/api/maps/tiles/{k}/{{z}}/{{x}}/{{y}}"} for k, p in wm.PICTURES.items()},
        "vectors": {k: (wm.maps_dir() / f).is_file() for k, f in wm.VECTOR_FILES.items()},
        "detailZoom": 5,
        **wm.legends(),
    }


@router.get("/tiles/{layer}/{z}/{x}/{y}")
def tile(layer: str, z: int, x: int, y: int) -> Response:
    try:
        data, media = wm.tile(layer, z, x, y)
    except FileNotFoundError as err:
        raise HTTPException(404, f"The built-in map file {err} is missing on the server.") from err
    return Response(data, media_type=media, headers=CACHE)


@router.get("/vector/{name}")
def vector(name: str) -> FileResponse:
    f = wm.VECTOR_FILES.get(name)
    if not f or not (wm.maps_dir() / f).is_file():
        raise HTTPException(404, f"There is no built-in layer called {name}.")
    return FileResponse(wm.maps_dir() / f, media_type="application/json", headers={"Cache-Control": "public, max-age=604800"})


@router.get("/detail")
def detail(
    west: float = Query(..., ge=-540, le=540),
    south: float = Query(..., ge=-90, le=90),
    east: float = Query(..., ge=-540, le=540),
    north: float = Query(..., ge=-90, le=90),
    layers: str = "land,borders,admin1,rivers,lakes",
) -> dict[str, Any]:
    wanted = [layer for layer in layers.split(",") if layer in {"land", "borders", "admin1", "rivers", "lakes"}]
    try:
        return wm.detail(west, south, east, north, wanted)
    except ValueError as err:
        raise HTTPException(400, str(err)) from err


@router.get("/graticule")
def graticule() -> dict[str, Any]:
    return wm.graticule()


@router.get("/identify")
def identify(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-540, le=540)) -> dict[str, Any]:
    return wm.identify(lat, lon)
