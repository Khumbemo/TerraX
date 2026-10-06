"""Tree biomass and carbon from a field inventory (DBH, height, wood density).

Above-ground biomass (AGB, kg dry matter per tree):

* with height: Chave et al. 2014 (Glob. Change Biol. 20:3177), eq. 4:
  AGB = 0.0673 × (ρ D² H)^0.976  (D cm, H m, ρ g/cm³)
* without height, with the bioclimatic stress E: eq. 7:
  AGB = exp(−1.803 − 0.976 E + 0.976 ln ρ + 2.673 ln D − 0.0299 (ln D)²)
* without height or E: Chave et al. 2005 (Oecologia 145:87), model II.3:
  AGB = ρ × exp(a + b ln D + 0.207 (ln D)² − 0.0281 (ln D)³)

Below-ground biomass from IPCC (2006) Vol. 4 Table 4.4 root-to-shoot ratios;
carbon fraction 0.47 (IPCC 2006 Table 4.3); CO₂e = C × 44/12.
"""

from __future__ import annotations

import csv
import io
import math
import re

from scipy.stats import t as student_t

from .stats import fmt

CHAVE2005 = {
    "dry": {"a": -0.667, "b": 1.784, "label": "Dry (< 1,500 mm rain, > 5 dry months)"},
    "moist": {"a": -1.499, "b": 2.148, "label": "Moist (1,500–3,500 mm rain)"},
    "wet": {"a": -1.239, "b": 1.98, "label": "Wet (> 3,500 mm rain, no dry season)"},
}
ROOT_SHOOT = [
    {"id": "trop-rain", "label": "Tropical rainforest", "ratio": lambda a: 0.37, "rule": "0.37"},
    {"id": "trop-moist", "label": "Tropical moist deciduous forest", "ratio": lambda a: 0.2 if a < 125 else 0.24, "rule": "0.20 if AGB < 125 t/ha, else 0.24"},
    {"id": "trop-dry", "label": "Tropical dry forest", "ratio": lambda a: 0.56 if a < 20 else 0.28, "rule": "0.56 if AGB < 20 t/ha, else 0.28"},
    {"id": "trop-shrub", "label": "Tropical shrubland", "ratio": lambda a: 0.4, "rule": "0.40"},
    {"id": "trop-mountain", "label": "Tropical mountain systems", "ratio": lambda a: 0.27, "rule": "0.27"},
    {"id": "temp-broadleaf", "label": "Temperate broadleaf forest", "ratio": lambda a: 0.46 if a < 75 else 0.23 if a <= 150 else 0.24, "rule": "0.46 if AGB < 75 t/ha, 0.23 for 75–150, 0.24 above"},
    {"id": "temp-conifer", "label": "Temperate conifer forest", "ratio": lambda a: 0.4 if a < 50 else 0.29 if a <= 150 else 0.2, "rule": "0.40 if AGB < 50 t/ha, 0.29 for 50–150, 0.20 above"},
]
DEFAULT_PARAMS = {"defaultDensity": 0.57, "densities": {}, "forestType": "moist", "stressE": None, "rootShoot": "trop-moist", "carbonFraction": 0.47, "minDbh": 5.0, "plotAreaM2": 0.0}
DIAMETER_CLASSES = [5, 10, 20, 30, 40, 50, 60, 80, 100, math.inf]


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9#%]+", "", s.lower())


def _find(header: list[str], names: list[str]) -> int:
    h = [_norm(x) for x in header]
    for n in names:
        if _norm(n) in h:
            return h.index(_norm(n))
    for n in names:
        for i, x in enumerate(h):
            if x.startswith(_norm(n)):
                return i
    return -1


def _num(v) -> float | None:
    if v is None:
        return None
    s = str(v).strip().replace(",", ".", 1)
    if not s or s in ("—", "-"):
        return None
    try:
        x = float(s)
    except ValueError:
        return None
    return x if math.isfinite(x) else None


def parse_inventory(text: str, filename: str) -> dict:
    rows = list(csv.reader(io.StringIO(text.lstrip("﻿"))))
    hi = next((i for i, r in enumerate(rows) if any(re.match(r"^(dbh|gbh|girth|diameter|circumference|cbh)", c.strip(), re.I) for c in r)), -1)
    if hi < 0:
        raise ValueError(f"{filename} has no DBH or girth (GBH) column. Add a column named DBH (cm) or GBH (cm).")
    header = [c.strip() for c in rows[hi]]
    col = {
        "survey": _find(header, ["Survey"]), "plot": _find(header, ["Q#", "Quadrat", "Plot", "PlotID", "Plot_ID", "Subplot"]),
        "size": _find(header, ["Size", "PlotArea", "Plot_area", "Area_m2", "Area"]), "species": _find(header, ["Species", "ScientificName", "Taxon", "Name"]),
        "status": _find(header, ["Status", "TreeStatus", "Condition"]), "count": _find(header, ["Abundance", "Count", "N", "Trees"]),
        "dbh": _find(header, ["DBH", "DBH_cm", "Diameter", "D"]), "gbh": _find(header, ["GBH", "GBH_cm", "Girth", "CBH", "Circumference"]),
        "height": _find(header, ["Height", "Height_m", "H", "TreeHeight"]), "measHt": _find(header, ["DBH_MeasHt", "MeasHeight", "POM"]),
    }
    is_fc = col["survey"] >= 0 and col["plot"] >= 0 and "DBH_MeasHt" in header
    get = lambda r, k: r[col[k]] if 0 <= col[k] < len(r) else None
    trees, warnings, gbh_used = [], [], 0
    for r in rows[hi + 1 :]:
        if all(not c.strip() for c in r):
            if is_fc:
                break  # Forest-Capture puts transect/point tables after a blank row
            continue
        if r and r[0].strip().startswith("---"):
            break
        dbh_raw, gbh_raw = _num(get(r, "dbh")), _num(get(r, "gbh"))
        dbh = dbh_raw if dbh_raw and dbh_raw > 0 else None
        src = "DBH" if dbh else None
        if not dbh and gbh_raw and gbh_raw > 0:
            dbh, src = gbh_raw / math.pi, "GBH"
            gbh_used += 1
        h = _num(get(r, "height"))
        count = _num(get(r, "count"))
        plot = " · ".join(x for x in [(get(r, "survey") or "").strip(), (get(r, "plot") or "").strip()] if x) or "All trees"
        trees.append({
            "plot": plot, "plotAreaM2": (_num(get(r, "size")) or 0) if col["size"] >= 0 else 0,
            "species": (get(r, "species") or "").strip() or "Unidentified", "dbh": dbh, "dbhFrom": src,
            "height": h if h and h > 0 else None, "status": (get(r, "status") or "").strip().lower() or "live",
            "count": 1 if is_fc and dbh else (round(count) if count and count > 0 else 1), "measHeight": _num(get(r, "measHt")),
        })
    if not trees:
        raise ValueError(f"{filename} has a header but no tree rows.")
    if gbh_used:
        warnings.append(f"{gbh_used} row{'' if gbh_used == 1 else 's'} had girth only; DBH = GBH / π.")
    if col["height"] < 0:
        warnings.append("No height column: biomass uses a diameter-only equation, which is less accurate.")
    return {"filename": filename, "format": "Forest-Capture" if is_fc else "Generic", "trees": trees, "warnings": warnings}


def tree_agb(d: float, h: float | None, rho: float, p: dict) -> tuple[float, str]:
    if h is not None and h > 0:
        return 0.0673 * (rho * d * d * h) ** 0.976, "chave2014-h"
    ln = math.log(d)
    e = p.get("stressE")
    if e is not None and math.isfinite(e):
        return math.exp(-1.803 - 0.976 * e + 0.976 * math.log(rho) + 2.673 * ln - 0.0299 * ln * ln), "chave2014-e"
    c = CHAVE2005[p["forestType"]]
    return rho * math.exp(c["a"] + c["b"] * ln + 0.207 * ln * ln - 0.0281 * ln**3), "chave2005"


def basal_area_m2(d_cm: float) -> float:
    return math.pi / 4 * (d_cm / 100) ** 2


def _estimate(values: list[float]) -> dict:
    n = len(values)
    mean = sum(values) / n
    if n < 2:
        return {"mean": mean, "sd": None, "ci95": None}
    sd = math.sqrt(sum((v - mean) ** 2 for v in values) / (n - 1))
    half = float(student_t.ppf(0.975, n - 1)) * sd / math.sqrt(n)
    return {"mean": mean, "sd": sd, "ci95": [mean - half, mean + half]}


def _scale(e: dict, k: float) -> dict:
    return {"mean": e["mean"] * k, "sd": None if e["sd"] is None else e["sd"] * k, "ci95": [e["ci95"][0] * k, e["ci95"][1] * k] if e["ci95"] else None}


def compute_carbon(inv: dict, p: dict) -> dict:
    p = {**DEFAULT_PARAMS, **{k: v for k, v in p.items() if v is not None or k == "stressE"}}
    zone = next((z for z in ROOT_SHOOT if z["id"] == p["rootShoot"]), ROOT_SHOOT[1])
    equations = {"chave2014-h": 0, "chave2014-e": 0, "chave2005": 0}
    excluded = {"dead": 0, "small": 0, "noDiameter": 0, "large": 0}
    plots: dict[str, dict] = {}
    species: dict[str, dict] = {}
    classes = [{"lo": lo, "hi": DIAMETER_CLASSES[i + 1], "trees": 0, "agb": 0.0} for i, lo in enumerate(DIAMETER_CLASSES[:-1])]
    live = {"trees": 0, "basalArea": 0.0, "agb": 0.0}
    d2 = 0.0
    buttress = 0
    conflicts: list[str] = []
    for t in inv["trees"]:
        area = t["plotAreaM2"] if t["plotAreaM2"] > 0 else p["plotAreaM2"]
        pr = plots.get(t["plot"])
        if not pr:
            pr = plots[t["plot"]] = {"plot": t["plot"], "areaM2": area, "trees": 0, "basalArea": 0.0, "agb": 0.0, "agbHa": None, "baHa": None, "stemsHa": None}
        elif area > 0 and pr["areaM2"] > 0 and abs(area - pr["areaM2"]) > 1e-9 and t["plot"] not in conflicts:
            conflicts.append(t["plot"])
        if not re.match(r"^live|^alive|^$", t["status"]):
            excluded["dead"] += t["count"]
            continue
        if t["dbh"] is None:
            excluded["noDiameter"] += t["count"]
            continue
        if t["dbh"] < p["minDbh"]:
            excluded["small"] += t["count"]
            continue
        if t["dbh"] > 212:
            excluded["large"] += t["count"]  # outside the Chave 2014 calibration; still included
        if t["measHeight"] is not None and abs(t["measHeight"] - 1.3) > 0.05:
            buttress += t["count"]
        rho = p["densities"].get(t["species"], p["defaultDensity"])
        agb, eq = tree_agb(t["dbh"], t["height"], rho, p)
        n = t["count"]
        equations[eq] += n
        ba = basal_area_m2(t["dbh"])
        live["trees"] += n
        live["basalArea"] += ba * n
        live["agb"] += agb * n
        d2 += t["dbh"] ** 2 * n
        pr["trees"] += n
        pr["basalArea"] += ba * n
        pr["agb"] += agb * n
        sp = species.setdefault(t["species"], {"species": t["species"], "density": rho, "densityDefault": t["species"] not in p["densities"], "trees": 0, "basalArea": 0.0, "agb": 0.0, "dSum": 0.0})
        sp["trees"] += n
        sp["basalArea"] += ba * n
        sp["agb"] += agb * n
        sp["dSum"] += t["dbh"] * n
        for c in classes:
            if c["lo"] <= t["dbh"] < c["hi"]:
                c["trees"] += n
                c["agb"] += agb * n
                break
    plot_list = list(plots.values())
    with_area = [x for x in plot_list if x["areaM2"] > 0]
    for x in with_area:
        ha = x["areaM2"] / 10_000
        x["agbHa"] = x["agb"] / 1000 / ha
        x["baHa"] = x["basalArea"] / ha
        x["stemsHa"] = x["trees"] / ha
    warnings = list(inv["warnings"])
    if conflicts:
        warnings.append(f"Plots with rows giving different sizes (the first size was used): {', '.join(conflicts[:5])}.")
    per_ha = None
    if with_area and len(with_area) == len(plot_list):
        agb = _estimate([x["agbHa"] for x in with_area])
        rs = zone["ratio"](agb["mean"])
        carbon = _scale(agb, (1 + rs) * p["carbonFraction"])
        per_ha = {"plots": len(with_area), "areaHa": sum(x["areaM2"] for x in with_area) / 10_000, "agb": agb, "bgb": _scale(agb, rs), "carbon": carbon,
                  "co2e": _scale(carbon, 44 / 12), "basalArea": _estimate([x["baHa"] for x in with_area]), "stems": _estimate([x["stemsHa"] for x in with_area]), "rootShoot": rs}
    elif with_area:
        warnings.append(f"{len(plot_list) - len(with_area)} of {len(plot_list)} plots have no size, so per-hectare values are not given. Enter a plot size to use for all plots.")
    agb_t = live["agb"] / 1000
    rs_m = per_ha["rootShoot"] if per_ha else zone["ratio"](math.inf)
    cf = p["carbonFraction"]
    measured = {"agb": agb_t, "bgb": agb_t * rs_m, "carbon": agb_t * (1 + rs_m) * cf, "co2e": agb_t * (1 + rs_m) * cf * 44 / 12, "rootShoot": rs_m}
    dd = p["defaultDensity"]
    notes = [
        "Above-ground biomass per tree: Chave et al. (2014) pantropical equation AGB = 0.0673 × (ρD²H)^0.976 where height was measured.",
        f"Trees without height: Chave et al. (2014) eq. 7 with the site’s environmental stress E = {p['stressE']:g}." if p["stressE"] is not None
        else f"Trees without height: Chave et al. (2005) {p['forestType']}-forest equation (diameter and wood density only).",
        f"Wood density: {fmt(dd, 3)} g/cm³ unless set per species{' (0.57 is the tropical Asian mean of Brown 1997, FAO Forestry Paper 134)' if dd == 0.57 else ''}. Species values from the Global Wood Density Database (Zanne et al. 2009) improve accuracy.",
        f"Below-ground biomass: IPCC (2006) root-to-shoot ratio for {zone['label'].lower()} ({zone['rule']}); {fmt(rs_m, 2)} applied.",
        f"Carbon = {cf:g} × total biomass (IPCC 2006 default 0.47); CO₂e = C × 44/12.",
        f"Only live stems with DBH ≥ {p['minDbh']:g} cm are included; the Chave 2014 equation was calibrated on trees of 5–212 cm DBH.",
        "The 95 % interval covers sampling variation between plots only (Student t); allometric-model error (residual SE 0.357 in log units for Chave 2014 eq. 4) and measurement error are not propagated.",
    ]
    if excluded["dead"]:
        warnings.append(f"{excluded['dead']} dead stems or stumps were excluded from live biomass (dead wood needs a separate method).")
    if excluded["noDiameter"]:
        warnings.append(f"{excluded['noDiameter']} rows without a diameter (seedlings, herbs, counts) were left out.")
    if excluded["small"]:
        warnings.append(f"{excluded['small']} stems below {p['minDbh']:g} cm DBH were left out.")
    if excluded["large"]:
        warnings.append(f"{excluded['large']} trees exceed 212 cm DBH, beyond the Chave 2014 calibration range.")
    if buttress:
        warnings.append(f"{buttress} trees were measured at a height other than 1.3 m (buttresses); their DBH was used as recorded.")
    no_h = equations["chave2005"] + equations["chave2014-e"]
    if no_h > 0 and equations["chave2014-h"] > 0:
        warnings.append(f"{no_h} of {live['trees']} trees had no height and used a diameter-only equation.")
    if not per_ha and live["trees"]:
        warnings.append("Without plot sizes the stand biomass class is unknown, so the root-to-shoot ratio for the highest biomass class was used.")
    if not live["trees"]:
        warnings.append("No live trees with a diameter at or above the minimum were found.")
    sp_list = sorted(({**{k: v for k, v in s.items() if k != "dSum"}, "meanDbh": s["dSum"] / s["trees"]} for s in species.values()), key=lambda s: -s["agb"])
    return {
        "filename": inv["filename"], "format": inv["format"], "live": live, "plots": plot_list, "species": sp_list, "perHa": per_ha, "measured": measured,
        "equations": equations,
        "diameterClasses": [{"label": f"≥ {c['lo']}" if c["hi"] == math.inf else f"{c['lo']}–{c['hi']}", "trees": c["trees"], "agb": c["agb"] / 1000} for c in classes],
        "excluded": excluded, "qmd": math.sqrt(d2 / live["trees"]) if live["trees"] else None, "notes": notes, "warnings": warnings,
    }


def _est(e: dict, unit: str, sig: int = 4) -> str:
    ci = f" (95 % CI {fmt(max(0, e['ci95'][0]), sig)}–{fmt(e['ci95'][1], sig)})" if e["ci95"] else ""
    return f"{fmt(e['mean'], sig)} {unit}{ci}"


def carbon_markdown(r: dict) -> str:
    n = len(r["plots"])
    lines = ["## Dataset", "", f"- File: {r['filename']} ({r['format']} inventory); {n} plot{'' if n == 1 else 's'}; {r['live']['trees']} live trees measured", "", "## Results", ""]
    ph = r["perHa"]
    if ph:
        lines += [f"Per hectare, from {ph['plots']} plot{'' if ph['plots'] == 1 else 's'} covering {fmt(ph['areaHa'], 3)} ha:", "", "| Measure | Value |", "|---|---|",
                  f"| Above-ground biomass | {_est(ph['agb'], 't/ha')} |", f"| Below-ground biomass | {_est(ph['bgb'], 't/ha')} |",
                  f"| Carbon stock (AGB + BGB) | {_est(ph['carbon'], 't C/ha')} |", f"| CO₂ equivalent | {_est(ph['co2e'], 't CO₂e/ha')} |",
                  f"| Basal area | {_est(ph['basalArea'], 'm²/ha')} |", f"| Stem density | {_est(ph['stems'], 'stems/ha', 3)} |",
                  f"| Quadratic mean diameter | {fmt(r['qmd'], 3)} cm |", ""]
    m = r["measured"]
    total = r["live"]["agb"] or 1
    lines += ["Measured trees only:", "", f"- Above-ground biomass {fmt(m['agb'], 4)} t; below-ground {fmt(m['bgb'], 4)} t; carbon {fmt(m['carbon'], 4)} t C; {fmt(m['co2e'], 4)} t CO₂e",
              f"- Basal area {fmt(r['live']['basalArea'], 4)} m²", "", "### By species", "", "| Species | Trees | Mean DBH (cm) | Wood density | AGB (t) | Share of AGB |", "|---|---|---|---|---|---|",
              *[f"| {s['species']} | {s['trees']} | {fmt(s['meanDbh'], 3)} | {fmt(s['density'], 3)}{' (default)' if s['densityDefault'] else ''} | {fmt(s['agb'] / 1000, 4)} | {s['agb'] / total * 100:.1f} % |" for s in r["species"]], ""]
    if n > 1 and ph:
        lines += ["### By plot", "", "| Plot | Area (m²) | Trees | AGB (t/ha) | Basal area (m²/ha) |", "|---|---|---|---|---|",
                  *[f"| {x['plot']} | {fmt(x['areaM2'])} | {x['trees']} | {'—' if x['agbHa'] is None else fmt(x['agbHa'], 4)} | {'—' if x['baHa'] is None else fmt(x['baHa'], 4)} |" for x in r["plots"]], ""]
    lines += ["### Diameter classes (cm)", "", *[f"- {c['label']}: {c['trees']} trees, {fmt(c['agb'], 3)} t AGB" for c in r["diameterClasses"] if c["trees"]], ""]
    if r["warnings"]:
        lines += ["## Data quality", "", *[f"- {w}" for w in r["warnings"]], ""]
    lines += ["## Method and limits", "", *[f"- {x}" for x in r["notes"]]]
    return "\n".join(lines)
