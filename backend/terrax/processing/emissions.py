"""CO₂ emissions from forest loss: the area lost times the carbon it held, with a propagated uncertainty.

IPCC 2006 Guidelines Vol. 4 (stock-difference terms for land converted from forest):

    total biomass        B = AGB × (1 + R)                        R: root-to-shoot ratio (Table 4.4)
    carbon lost per ha   ΔC = (B_before − B_after) × CF           CF: carbon fraction of dry matter (Table 4.3)
    emissions            E = A × ΔC × 44/12                       t CO₂, with A the loss area in ha

B_after, the biomass left on the land just after clearing, is zero by default (IPCC 2006 Vol. 4 eq. 2.16 uses zero for
immediate conversion); set it when trees or crops remain. Only biomass is counted: dead wood, litter and soil carbon
are not, and nor are emissions from fire, which need combustion and emission factors.

Uncertainty, as 95 % half-widths of each input:

* Monte Carlo (IPCC 2006 Vol. 1 ch. 3, Approach 2): area, biomass and carbon fraction are drawn as independent normal
  variables (negative draws set to zero) and the 2.5th and 97.5th percentiles of E are the interval to report.
* Error propagation (Approach 1, eq. 3.1 for a product): U_E = √(U_A² + U_B² + U_CF²) in per cent, shown for
  comparison; it is accurate only when the relative uncertainties are small.

The loss area is the map's own until a validation sample gives the estimated area and its confidence interval
(Olofsson et al. 2014), which is what reporting should use.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from .accuracy import Z95
from .carbon import ROOT_SHOOT
from .stats import fmt

CO2_PER_C = 44 / 12
DEFAULT_CARBON_FRACTION = 0.47  # IPCC 2006 Vol. 4 Table 4.3
DRAWS = 20_000


def root_shoot(zone: str | None, agb: float, ratio: float | None = None) -> tuple[float, str]:
    """The root-to-shoot ratio for this AGB (t/ha) and where it came from: a given ratio, or the zone's IPCC rule."""
    if ratio is not None:
        return ratio, f"{ratio:g} (given)"
    z = next((z for z in ROOT_SHOOT if z["id"] == zone), None)
    if z is None:
        raise ValueError(f"Unknown ecological zone “{zone}”. Zones: {', '.join(z['id'] for z in ROOT_SHOOT)}.")
    return z["ratio"](agb), f"{z['label']}: {z['rule']} (IPCC 2006 Vol. 4 Table 4.4)"


def biomass_from_map(agb_cells: np.ndarray, cell_area: np.ndarray, zone: str | None, ratio: float | None) -> dict[str, Any]:
    """Area-weighted mean above-ground and total biomass (t/ha) over the loss cells a biomass map covers.

    `agb_cells` holds each loss cell's AGB (NaN where the map has no value) and `cell_area` its area. The
    root-to-shoot ratio is applied cell by cell, since IPCC's ratios change with AGB.
    """
    ok = np.isfinite(agb_cells) & (agb_cells >= 0)
    if not ok.any():
        raise ValueError("The biomass map has no values over the forest loss: check that it covers the same area.")
    agb, w = agb_cells[ok], cell_area[ok]
    r = np.array([root_shoot(zone, float(v), ratio)[0] for v in agb]) if ratio is None else np.full(agb.shape, ratio)
    mean_agb = float(np.average(agb, weights=w))
    mean_total = float(np.average(agb * (1 + r), weights=w))
    return {"agb": mean_agb, "total": mean_total, "coveredShare": float(w.sum()) / float(cell_area.sum()), "cells": int(ok.sum())}


def estimate(area_ha: float, area_ci: float | None, agb: float, agb_ci: float | None, *, zone: str | None = "trop-moist",
             ratio: float | None = None, total_biomass: float | None = None, carbon_fraction: float = DEFAULT_CARBON_FRACTION,
             carbon_fraction_ci: float | None = None, after_biomass: float = 0.0, area_source: str = "map",
             biomass_source: str = "value", seed: int = 0) -> dict[str, Any]:
    """Emissions with a Monte Carlo interval. `total_biomass` (AGB + BGB, t/ha), when known (from a biomass map),
    replaces AGB × (1 + R); its uncertainty is AGB's, scaled. CIs are 95 % half-widths in the input's own units."""
    if area_ha < 0 or agb < 0 or after_biomass < 0:
        raise ValueError("Area and biomass must not be negative.")
    if not 0 < carbon_fraction <= 1:
        raise ValueError("The carbon fraction must be between 0 and 1 (IPCC default 0.47).")
    r, rule = root_shoot(zone, agb, ratio)
    total = total_biomass if total_biomass is not None else agb * (1 + r)
    effective_r = total / agb - 1 if total_biomass is not None and agb > 0 else r  # a map's ratio varies cell by cell
    if after_biomass > total:
        raise ValueError(f"The biomass left after clearing ({fmt(after_biomass, 3)} t/ha) is more than the forest held ({fmt(total, 3)} t/ha).")
    c_per_ha = (total - after_biomass) * carbon_fraction
    co2_per_ha = c_per_ha * CO2_PER_C
    co2 = area_ha * co2_per_ha

    rel = {"area": (area_ci or 0) / area_ha if area_ha else 0.0, "biomass": (agb_ci or 0) / agb if agb else 0.0,
           "carbonFraction": (carbon_fraction_ci or 0) / carbon_fraction}
    rng = np.random.default_rng(seed)

    def draw(mean: float, half: float | None) -> np.ndarray | float:
        return np.maximum(rng.normal(mean, half / Z95, DRAWS), 0) if half else mean

    a = draw(area_ha, area_ci)
    # The biomass draw scales the whole stock (AGB and roots) by the same factor, as the ratio is fixed.
    scale = draw(1.0, rel["biomass"] or None)
    cf = draw(carbon_fraction, carbon_fraction_ci)
    sims = np.broadcast_to(a * np.maximum(total * scale - after_biomass, 0) * cf * CO2_PER_C, (DRAWS,))
    uncertain = any(rel.values())
    lo, med, hi = (float(v) for v in np.percentile(sims, [2.5, 50, 97.5])) if uncertain else (co2, co2, co2)
    approach1 = math.sqrt(sum(v * v for v in rel.values())) * 100

    notes = [
        f"E = A × (B − B_after) × CF × 44/12, with B = AGB × (1 + R) (IPCC 2006 Vol. 4). R: {rule}; CF {carbon_fraction:g}"
        + (" (IPCC 2006 Vol. 4 Table 4.3)." if carbon_fraction == DEFAULT_CARBON_FRACTION else " (given)."),
        "Committed emissions: all the biomass carbon on the lost area is counted as emitted when the forest is lost, as in IPCC Tier 1. "
        "Dead wood, litter and soil carbon are not included, nor emissions from fire.",
    ]
    if after_biomass:
        notes.append(f"{fmt(after_biomass, 3)} t/ha of biomass is taken to remain on the land after clearing.")
    if area_source == "map":
        notes.append("The area is the map's own count of loss pixels, which includes the map's errors and has no confidence interval. "
                     "Validate the map with a reference sample to report emissions from the estimated area (Olofsson et al. 2014).")
    if not agb_ci:
        notes.append("No uncertainty was given for the biomass, so the interval leaves it out and is too narrow.")
    if uncertain:
        notes.append(f"95 % interval from {DRAWS:,} Monte Carlo draws (IPCC Approach 2) of independent normal inputs. "
                     f"Error propagation (Approach 1) gives ±{approach1:.0f} %, accurate only for small relative uncertainties.")
    return {
        "areaHa": area_ha, "areaCi": area_ci, "areaSource": area_source,
        "agb": agb, "agbCi": agb_ci, "biomassSource": biomass_source, "rootShoot": effective_r, "totalBiomass": total,
        "afterBiomass": after_biomass, "carbonFraction": carbon_fraction, "carbonFractionCi": carbon_fraction_ci,
        "carbonPerHa": c_per_ha, "co2PerHa": co2_per_ha,
        "carbon": co2 / CO2_PER_C, "co2": co2, "co2Low": lo, "co2Median": med, "co2High": hi,
        "uncertaintyPct": {"area": rel["area"] * 100, "biomass": rel["biomass"] * 100, "carbonFraction": rel["carbonFraction"] * 100, "approach1": approach1},
        "notes": notes,
    }


def emissions_markdown(e: dict[str, Any], title: str = "CO₂ emissions from forest loss") -> str:
    def ci(v: float | None, digits: int = 3) -> str:
        return f" ± {fmt(v, digits)}" if v else ""

    area_kind = "estimated from the validation sample" if e["areaSource"] == "sample" else "mapped"
    rows = [
        f"## {title}", "", "| Quantity | Value |", "|---|---|",
        f"| Loss area ({area_kind}) | {fmt(e['areaHa'], 4)}{ci(e['areaCi'], 4)} ha |",
        f"| Above-ground biomass ({'biomass map' if e['biomassSource'] == 'map' else 'given'}) | {fmt(e['agb'], 4)}{ci(e['agbCi'])} t/ha |",
        f"| Root-to-shoot ratio | {e['rootShoot']:.3f} |",
        f"| Total biomass (above + below ground) | {fmt(e['totalBiomass'], 4)} t/ha |",
        f"| Carbon lost per hectare | {fmt(e['carbonPerHa'], 4)} t C/ha ({fmt(e['co2PerHa'], 4)} t CO₂/ha) |",
        f"| **Emissions** | **{fmt(e['co2'], 4)} t CO₂** ({fmt(e['carbon'], 4)} t C) |",
    ]
    if e["co2Low"] != e["co2High"]:
        rows.append(f"| 95 % interval (Monte Carlo) | {fmt(e['co2Low'], 4)} – {fmt(e['co2High'], 4)} t CO₂ |")
    return "\n".join([*rows, "", *[f"- {n}" for n in e["notes"]], ""])
