"""Map validation: a stratified random sample of a classified map (land cover, forest change or burn severity), and
the accuracy and area estimates from its reference labels (Olofsson et al. 2014)."""

from __future__ import annotations

import csv
import io
import json
import math
from pathlib import Path

import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import auth, storage
from ..auth import Principal, principal
from ..config import settings
from ..processing.accuracy import allocate, assess, stratified_sample
from ..processing.rio import Raster, grid_to_lonlat_arrays
from ..processing.stats import fmt
from ..signing import sign_urls

router = APIRouter()


class SampleRequest(BaseModel):
    total: int | None = Field(None, ge=2, le=20_000)
    minPerClass: int = Field(50, ge=1, le=5_000)
    seed: int = 11
    labels: list[str] | None = None


class AccuracyRequest(BaseModel):
    file: str


class _Map(BaseModel):
    """What validation needs from a classified map's job, whichever tool made it."""

    labels: list[str]
    file: str
    filename: str


def _job(job_id: str, p: Principal) -> tuple[_Map, Path]:
    try:
        auth.own_job(p, job_id)
        st = storage.job_status(job_id)
    except KeyError:
        raise HTTPException(404, "That map is no longer on the server. Run the analysis again.") from None
    res = storage.job_result(job_id)
    art = storage.job_dir(job_id) / "artifacts"
    if not res or st["tool"] not in ("landcover", "forest"):
        raise HTTPException(400, "Validation needs a classified map: land cover, forest change or burn severity.")
    if not storage.has_artifact(job_id, "classes.npz"):  # fetched from the bucket when it is not on this disk
        raise HTTPException(400, "This result was made before maps could be validated. Run the analysis again.")
    if st["tool"] == "landcover":
        return _Map(labels=res["labels"], file=res["file"], filename=res["landcover"]["filename"]), art
    return _Map(labels=res["labels"], file=res["file"], filename=res["filename"]), art


def _mapped(classes: np.ndarray, row_area: np.ndarray, k: int) -> np.ndarray:
    """Mapped area of classes 1..k (ground units of row_area), counted in row blocks."""
    out = np.zeros(k)
    for r0 in range(0, classes.shape[0], 512):
        block = classes[r0 : r0 + 512]
        for c in range(1, k + 1):
            out[c - 1] += float((block == c).sum(axis=1) @ row_area[r0 : r0 + 512])
    return out


def cochran_n(weights: np.ndarray, user_accuracy: float = 0.8, se: float = 0.01) -> int:
    """Sample size for a target standard error of overall accuracy (Olofsson et al. 2014, eq. 13; Cochran 1977)."""
    s = math.sqrt(user_accuracy * (1 - user_accuracy))
    return math.ceil((float(np.sum(weights)) * s / se) ** 2)


@router.post("/api/jobs/{job_id}/validation/sample")
@router.post("/api/landcover/{job_id}/sample")
def sample(job_id: str, req: SampleRequest, p: Principal = Depends(principal)) -> dict:
    m, art = _job(job_id, p)
    d = np.load(art / "classes.npz")
    classes, row_area = d["classes"], d["rowArea"]
    k = len(m.labels)
    labels = [(req.labels[i] if req.labels and i < len(req.labels) and req.labels[i] else m.labels[i]) for i in range(k)]
    areas = _mapped(classes, row_area, k)
    present = int((areas > 0).sum())
    total = req.total or max(100 * present, req.minPerClass * present)
    sizes = allocate(areas, total, req.minPerClass)
    pts = stratified_sample(classes, list(range(1, k + 1)), sizes, req.seed)
    pts.sort(key=lambda p: (p[2], p[0], p[1]))
    f = storage.get_file(m.file)
    r = Raster(f.path, f.name, max_pixels=settings().max_pixels)
    h, w = classes.shape
    ll = grid_to_lonlat_arrays(r, w, h) if (r.gw, r.gh) == (w, h) else None
    rows = np.array([p[0] for p in pts], dtype=np.float64)
    cols = np.array([p[1] for p in pts], dtype=np.float64)
    lon, lat = ll(cols + 0.5, rows + 0.5) if ll and pts else (None, None)
    ids = [f"S{i + 1:04d}" for i in range(len(pts))]
    feats = []
    lines = io.StringIO()
    out = csv.writer(lines)
    out.writerow(["id", "lon", "lat", "row", "col", "map_class", "reference"])
    for i, (rr, cc, c) in enumerate(pts):
        x = None if lon is None else round(float(lon[i]), 7)
        y = None if lat is None else round(float(lat[i]), 7)
        out.writerow([ids[i], "" if x is None else x, "" if y is None else y, rr, cc, labels[c - 1], ""])
        if x is not None:
            feats.append({"type": "Feature", "properties": {"id": ids[i], "map_class": labels[c - 1], "reference": ""}, "geometry": {"type": "Point", "coordinates": [x, y]}})
    (art / "sample.json").write_text(json.dumps({"labels": labels, "areas": areas.tolist(), "geo": bool(np.any(row_area != 1)),
                                                 "points": [{"id": ids[i], "row": p[0], "col": p[1], "map": p[2]} for i, p in enumerate(pts)]}))
    base = m.filename.rsplit(".", 1)[0]
    (art / f"{base}_validation_sample.csv").write_text(lines.getvalue(), encoding="utf-8")
    def download(label: str, name: str, media: str) -> dict:
        return {"label": label, "filename": name, "url": sign_urls(f"/api/jobs/{job_id}/artifacts/{name}", job_id), "mediaType": media}

    downloads = [download("Validation sample (CSV)", f"{base}_validation_sample.csv", "text/csv")]
    saved = ["sample.json", f"{base}_validation_sample.csv"]
    if feats:
        (art / f"{base}_validation_sample.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats}), encoding="utf-8")
        saved.append(f"{base}_validation_sample.geojson")
        downloads.insert(0, download("Validation sample (GeoJSON)", f"{base}_validation_sample.geojson", "application/geo+json"))
    storage.save_artifacts(job_id, *saved)
    weights = areas / areas.sum() if areas.sum() else areas
    unit = "ha" if np.any(row_area != 1) else "px"
    scale = 1e-4 if unit == "ha" else 1.0
    return {
        "points": len(pts), "downloads": downloads,
        "allocation": [{"label": labels[i], "mapped": float(areas[i] * scale), "share": float(weights[i]), "n": int(sizes[i])} for i in range(k)], "unit": unit,
        "note": (f"Points are drawn at random within each mapped class: at least {req.minPerClass} per class, the rest in proportion to area (Olofsson et al. 2014). "
                 f"For ±2 % (95 %) on overall accuracy about {cochran_n(weights):,} points are needed if user’s accuracies are near 80 %. "
                 "Label each point’s reference class from field visits or imagery finer than the map, without looking at the map class, then upload the file."),
    }


def _read_labels(path, name: str) -> dict[str, str]:
    """{sample id: reference label} from the returned GeoJSON or CSV."""
    text = path.read_text(encoding="utf-8-sig")
    out: dict[str, str] = {}
    if name.lower().endswith((".geojson", ".json")):
        try:
            fc = json.loads(text)
        except json.JSONDecodeError:
            raise HTTPException(400, f"{name} is not valid JSON.") from None
        for f in fc.get("features", []):
            p = {str(k).lower(): v for k, v in ((f or {}).get("properties") or {}).items()}
            if p.get("id") not in (None, ""):
                out[str(p["id"]).strip()] = "" if p.get("reference") is None else str(p["reference"]).strip()
        return out
    rows = list(csv.DictReader(io.StringIO(text)))
    for row in rows:
        p = {str(k).strip().lower(): v for k, v in row.items() if k is not None}
        if p.get("id"):
            out[p["id"].strip()] = (p.get("reference") or "").strip()
    return out


@router.post("/api/jobs/{job_id}/validation/accuracy")
@router.post("/api/landcover/{job_id}/accuracy")
def accuracy(job_id: str, req: AccuracyRequest, who: Principal = Depends(principal)) -> dict:
    _job(job_id, who)
    try:
        s = json.loads(storage.artifact_path(job_id, "sample.json").read_text())
    except KeyError:
        raise HTTPException(400, "Create the validation sample first, then label it.") from None
    try:
        auth.own_file(who, req.file)
        f = storage.get_file(req.file)
    except KeyError:
        raise HTTPException(404, "The labelled file is no longer on the server. Upload it again.") from None
    refs = _read_labels(f.path, f.name)
    labels: list[str] = s["labels"]
    k = len(labels)
    by_name = {lab.strip().lower(): i for i, lab in enumerate(labels)}
    counts = np.zeros((k, k), dtype=np.int64)
    unknown: set[str] = set()
    missing = 0
    for p in s["points"]:
        ref = refs.get(p["id"], "")
        if not ref:
            missing += 1
            continue
        j = by_name.get(ref.lower())
        if j is None and ref.isdigit() and 1 <= int(ref) <= k:
            j = int(ref) - 1
        if j is None:
            unknown.add(ref)
            continue
        counts[p["map"] - 1, j] += 1
    if unknown:
        raise HTTPException(400, f"Reference labels must be one of the map’s classes ({', '.join(labels)}) or their numbers; found {', '.join(sorted(unknown))}.")
    if not counts.sum():
        raise HTTPException(400, "No sample point has a reference label yet. Fill in the “reference” column and upload the file again.")
    unit = "ha" if s["geo"] else "px"
    areas = np.array(s["areas"]) * (1e-4 if unit == "ha" else 1.0)
    out = assess(counts, areas, labels)
    out.update({"unit": unit, "unlabelled": missing, "markdown": accuracy_markdown(out, unit, missing)})
    return out


def accuracy_markdown(a: dict, unit: str, missing: int) -> str:
    def pct(v: float | None, ci: float | None) -> str:
        return "—" if v is None else f"{v * 100:.1f} %" + ("" if ci is None else f" ± {ci * 100:.1f}")

    labels = a["labels"]
    lines = ["", "## Accuracy and area (stratified sample)", "",
             f"- {a['samples']} reference points{f' ({missing} unlabelled points were left out)' if missing else ''}; overall accuracy {pct(a['overallAccuracy'], a['overallCi'])} (95 % CI).", "",
             f"| Class | Mapped ({unit}) | Estimated area ({unit}, 95 % CI) | User’s accuracy | Producer’s accuracy | Points |", "|---|---|---|---|---|---|"]
    for c in a["classes"]:
        ci = "" if c["areaCi"] is None else f" ± {fmt(c['areaCi'], 4)}"
        lines.append(f"| {c['label']} | {fmt(c['mappedArea'], 4)} | {fmt(c['area'], 4)}{ci} | {pct(c['userAccuracy'], c['userCi'])} | {pct(c['producerAccuracy'], c['producerCi'])} | {c['samples']} |")
    lines += ["", "Error matrix of sample counts (rows: map, columns: reference):", "", "| | " + " | ".join(labels) + " |", "|---" * (len(labels) + 1) + "|"]
    lines += [f"| **{labels[i]}** | " + " | ".join(str(x) for x in row) + " |" for i, row in enumerate(a["counts"])]
    lines += ["", "- Method: Olofsson et al. (2014) stratified estimators: cell proportions p̂ᵢⱼ = Wᵢ nᵢⱼ / nᵢ· weight each stratum by its mapped area, so the estimated areas correct the map’s "
              "own pixel counts for its errors. Report these estimates with their confidence intervals rather than the mapped areas."]
    if a["unsampled"]:
        lines.append(f"- No sample points in: {', '.join(a['unsampled'])}; their accuracy and area cannot be estimated.")
    return "\n".join(lines)
