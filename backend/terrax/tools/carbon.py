"""Carbon & biomass from a tree inventory."""

from __future__ import annotations

from ..processing.carbon import CHAVE2005, DEFAULT_PARAMS, ROOT_SHOOT, carbon_markdown, compute_carbon, parse_inventory
from . import tool
from .common import clean, number
from .context import ToolContext, ToolError


@tool("carbon")
def run(ctx: ToolContext, inputs: dict, params: dict) -> dict:
    f = ctx.file(inputs.get("file"))
    if f is None:
        raise ToolError("Choose a tree inventory CSV.")
    inv = parse_inventory(f.path.read_text(encoding="utf-8-sig", errors="replace"), f.name)
    p = {
        "defaultDensity": number(params, "defaultDensity", DEFAULT_PARAMS["defaultDensity"], 0.1, 1.5, "Wood density must be between 0.1 and 1.5 g/cm³."),
        "densities": {str(k): float(v) for k, v in (params.get("densities") or {}).items() if v not in (None, "")},
        "forestType": params.get("forestType") if params.get("forestType") in CHAVE2005 else "moist",
        "stressE": None if params.get("stressE") in (None, "") else number(params, "stressE", 0, -1, 2, "The environmental stress E must be between −1 and 2 (Chave et al. 2014)."),
        "rootShoot": params.get("rootShoot") if params.get("rootShoot") in [z["id"] for z in ROOT_SHOOT] else "trop-moist",
        "carbonFraction": number(params, "carbonFraction", 0.47, 0.3, 0.6, "The carbon fraction must be between 0.3 and 0.6."),
        "minDbh": number(params, "minDbh", 5, 0, 100, "The minimum DBH must be between 0 and 100 cm."),
        "plotAreaM2": number(params, "plotAreaM2", 0, 0, 1e7, "The plot size must be a positive number of square metres."),
    }
    for sp, rho in p["densities"].items():
        if not 0.1 <= rho <= 1.5:
            raise ToolError(f"Wood density for {sp} must be between 0.1 and 1.5 g/cm³.")
    r = compute_carbon(inv, p)
    return clean({"tool": "carbon", "name": f.name, "markdown": carbon_markdown(r), "carbon": r, "params": p,
                  "speciesList": sorted({t["species"] for t in inv["trees"] if t.get("dbh") is not None}),
                  "needsArea": any(not t["plotAreaM2"] > 0 for t in inv["trees"]),
                  "forestTypes": [{"id": k, "label": v["label"]} for k, v in CHAVE2005.items()], "zones": [{"id": z["id"], "label": z["label"], "rule": z["rule"]} for z in ROOT_SHOOT]})
