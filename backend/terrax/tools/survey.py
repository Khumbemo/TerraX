"""Land survey: measures boundaries, traverses and points; can become the analysis boundary."""

from __future__ import annotations

from ..processing.survey import boundary_from_survey, elevation_profile, measure_survey, parse_survey_file, survey_markdown
from . import tool
from .common import clean
from .context import ToolContext, ToolError


@tool("survey")
def run(ctx: ToolContext, inputs: dict, params: dict) -> dict:
    decl = params.get("declination")
    decl = float(decl) if decl not in (None, "") else None
    if decl is not None and not -90 <= decl <= 90:
        raise ToolError("Declination must be between −90° and 90° (east positive).")
    if params.get("geojson"):
        fc = params["geojson"]
        name, fmt_name, warnings = params.get("name") or "Drawn boundary", "Drawn on map", []
    else:
        f = ctx.file(inputs.get("file"))
        if f is None:
            raise ToolError("Choose a GeoJSON, KML, GPX, CSV or zipped shapefile, or draw a boundary on the map.")
        fc, fmt_name, warnings = parse_survey_file(f.path, f.name, bool(params.get("closeRing", True)))
        name = f.name
    r = measure_survey(name, fmt_name, fc, warnings)
    for feat in r["features"]:
        feat["profile"] = elevation_profile(feat)
    url = ctx.json(f"{name.rsplit('.', 1)[0]}_measured.geojson", fc)
    return clean({
        "tool": "survey", "name": name, "markdown": survey_markdown(r, decl), "survey": r, "boundary": boundary_from_survey(r),
        "map": {"bounds": r["bounds"], "geojson": fc},
        "downloads": [ctx.download("Download as GeoJSON", f"{name.rsplit('.', 1)[0]}.geojson", url, "application/geo+json")],
    })
