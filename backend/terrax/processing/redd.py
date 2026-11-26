"""A forest-loss emissions summary laid out the way REDD+ and IPCC reporting separate it: activity data (the loss area
from a validated map, with its confidence interval), the emission factor, the emissions with their uncertainty, what
is and is not counted, and the summary's status. It is assembled from the forest tool's run, its stratified reference
sample (Olofsson et al. 2014) and the emissions recomputed from the estimated area (IPCC 2006 Vol. 4).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from .stats import fmt


def _pct(v: float | None, ci: float | None = None) -> str:
    if v is None:
        return "not estimable (no sample points in this class)"
    return f"{v * 100:.1f} %" + (f" ± {ci * 100:.1f}" if ci is not None else "")


def summary(name: str, accuracy: dict[str, Any], validated: dict[str, Any], mapped: dict[str, Any] | None,
            period_years: float | None = None, forest_rule: str | None = None, today: datetime | None = None) -> str:
    """Markdown summary. `validated` is the emissions estimate from the sample's estimated loss area; `mapped` the
    estimate from the map's own loss area, shown for comparison."""
    loss = next(c for c in accuracy["classes"] if c["label"] == "Forest loss")
    e = validated
    rel_area = (loss["areaCi"] / loss["area"] * 100) if loss["area"] and loss["areaCi"] is not None else None
    when = (today or datetime.now(UTC)).strftime("%Y-%m-%d")
    lines = [
        "# Forest-loss emissions summary", "",
        f"{name} · prepared with TerraX on {when}.", "",
        "## 1. Activity data: forest loss area", "",
        "| Quantity | Value |", "|---|---|",
        f"| Mapped loss area (map pixel count) | {fmt(loss['mappedArea'], 4)} ha |",
        f"| **Estimated loss area** (stratified estimator, 95 % CI) | **{fmt(loss['area'], 4)}"
        + (f" ± {fmt(loss['areaCi'], 4)} ha** (±{rel_area:.0f} %)" if rel_area is not None else " ha**") + " |",
        f"| User's accuracy of the loss class | {_pct(loss['userAccuracy'], loss['userCi'])} |",
        f"| Producer's accuracy of the loss class | {_pct(loss['producerAccuracy'], loss['producerCi'])} |",
        f"| Overall accuracy | {_pct(accuracy['overallAccuracy'], accuracy['overallCi'])} |",
        f"| Reference sample | {accuracy['samples']} labelled points, {loss['samples']} of them mapped as loss |",
        "",
        "The estimated area corrects the map's pixel count for its omission and commission errors (Olofsson et al. 2014); "
        "report it, with its interval, rather than the mapped area.",
    ]
    if forest_rule:
        lines.append(f"Forest definition used by the map: {forest_rule}")
    lines += [
        "", "## 2. Emission factor", "",
        "| Quantity | Value |", "|---|---|",
        f"| Above-ground biomass of the lost forest ({'biomass map' if e['biomassSource'] == 'map' else 'given value'}) | "
        f"{fmt(e['agb'], 4)}" + (f" ± {fmt(e['agbCi'], 4)}" if e["agbCi"] else "") + " t/ha |",
        f"| Root-to-shoot ratio | {e['rootShoot']:.3f} |",
        f"| Total biomass (above + below ground) | {fmt(e['totalBiomass'], 4)} t/ha |",
        f"| Biomass left after clearing | {fmt(e['afterBiomass'], 4)} t/ha |",
        f"| Carbon fraction | {e['carbonFraction']:g}" + (f" ± {e['carbonFractionCi']:g}" if e["carbonFractionCi"] else "") + " |",
        f"| Carbon lost per hectare | {fmt(e['carbonPerHa'], 4)} t C/ha = {fmt(e['co2PerHa'], 4)} t CO₂/ha |",
        "", "## 3. Emissions", "",
        "| Quantity | Value |", "|---|---|",
        f"| **Emissions from the estimated loss area** | **{fmt(e['co2'], 4)} t CO₂** |",
    ]
    if e["co2Low"] != e["co2High"]:
        lines.append(f"| 95 % interval (Monte Carlo, IPCC Approach 2) | {fmt(e['co2Low'], 4)} – {fmt(e['co2High'], 4)} t CO₂ |")
        lines.append(f"| Error propagation (IPCC Approach 1), for comparison | ±{e['uncertaintyPct']['approach1']:.0f} % |")
    if period_years:
        lines.append(f"| Mean per year over {fmt(period_years, 3)} years | {fmt(e['co2'] / period_years, 4)} t CO₂/yr"
                     + (f" (95 %: {fmt(e['co2Low'] / period_years, 4)} – {fmt(e['co2High'] / period_years, 4)})" if e["co2Low"] != e["co2High"] else "") + " |")
    if mapped:
        lines.append(f"| From the mapped area instead (not for reporting) | {fmt(mapped['co2'], 4)} t CO₂ |")
    u = e["uncertaintyPct"]
    lines += [
        "", "## 4. Uncertainty", "",
        f"- Included: the loss area's sampling uncertainty (±{u['area']:.0f} %), the biomass uncertainty given (±{u['biomass']:.0f} %)"
        + (f" and the carbon fraction's (±{u['carbonFraction']:.0f} %)" if u["carbonFraction"] else "") + ", as independent normal inputs.",
        "- Not included: errors in the reference labels themselves, image misregistration, the root-to-shoot ratio's uncertainty, "
        "and any correlation between the area and the biomass of the cleared forest.",
    ]
    if not e["agbCi"]:
        lines.append("- No biomass uncertainty was given, so the interval is too narrow.")
    if loss["samples"] < 30:
        lines.append(f"- Only {loss['samples']} reference points fall in the mapped loss, so the loss class's accuracy and area are imprecise; "
                     "a larger sample in that stratum narrows the interval.")
    lines += [
        "", "## 5. What is counted", "",
        "- Gross committed emissions: all the biomass carbon on the lost area is counted as emitted at the time of loss (IPCC Tier 1). "
        "Regrowth and other removals are not subtracted, so this is not a net figure.",
        "- Pools: above- and below-ground biomass. Dead wood, litter and soil carbon, and non-CO₂ gases from fire, are not included.",
        "- Every kind of loss in the map counts (harvest, fire, storm, clearing); degradation without loss of cover is not detected.",
        "", "## 6. Status", "",
        "Produced automatically from TerraX's analyses. It is not a verified submission: reporting under REDD+ also needs the national forest "
        "definition, consistency with the forest reference level, documented QA/QC and independent verification.",
        "",
        "References: IPCC (2006) Guidelines for National Greenhouse Gas Inventories, Vol. 4. Olofsson P et al. (2014) Remote Sensing of "
        "Environment 148: 42–57.",
    ]
    return "\n".join(lines) + "\n"
