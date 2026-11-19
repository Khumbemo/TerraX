"""Disturbances with a seasonal model (processing/seasonal.py): any month, several breaks per pixel, recovery."""

import numpy as np
import pytest

from tests.test_tools import run, run_err

# Monthly NDVI with an annual cycle (amplitude 0.15, peak in August), noise σ 0.02 and 30 % of dates clouded.
T = 2017 + np.arange(72) / 12 + 1 / 24
SEASON = 0.6 + 0.15 * np.cos(2 * np.pi * (T - 0.6))


def _pixels(y: np.ndarray, n: int = 300, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    out = y[:, None] + rng.normal(0, 0.02, (y.size, n))
    out[rng.random(out.shape) < 0.3] = np.nan
    return out


def test_a_seasonal_cycle_is_not_a_disturbance():
    from terrax.processing.seasonal import fit_seasonal

    r = fit_seasonal(T, _pixels(SEASON), 0.15)
    assert r["valid"].all() and (r["count"] == 0).all()


def test_two_disturbances_are_found_and_dated():
    from terrax.processing.seasonal import fit_seasonal

    y = np.where(T >= 2018.5, SEASON - 0.3 + 0.05 * np.clip(T - 2018.5, 0, None), SEASON)
    y = np.where(T >= 2021.5, y - 0.25, y)
    r = fit_seasonal(T, _pixels(y), 0.15)
    assert (r["count"] == 2).mean() > 0.97
    first, second = T[r["index"][r["count"] == 2, 0]], T[r["index"][r["count"] == 2, 1]]
    # Dated by the first clear observation in the drop: the month it happened, or the next clear one.
    assert np.median(first) == pytest.approx(2018.54, abs=0.05) and np.percentile(first, 95) < 2018.8
    assert np.median(second) == pytest.approx(2021.54, abs=0.05)
    assert np.nanmedian(r["magnitude"][:, 0]) == pytest.approx(-0.3, abs=0.03) and np.nanmedian(r["magnitude"][:, 1]) == pytest.approx(-0.25, abs=0.03)


def test_recovery_is_the_share_of_the_drop_regained():
    from terrax.processing.seasonal import fit_seasonal

    y = np.where(T >= 2019.0, SEASON - 0.3 + 0.06 * np.clip(T - 2019.0, 0, None), SEASON)  # regrows 0.06 a year
    r = fit_seasonal(T, _pixels(y), 0.15)
    assert (r["count"] == 1).all()
    expected = 0.06 * (T[-1] - 2019.0) / 0.3
    assert np.nanmedian(r["recovery"]) == pytest.approx(expected, abs=0.05)


def test_a_drop_in_the_first_year_is_not_detectable_and_causes_no_false_breaks():
    from terrax.processing.seasonal import fit_seasonal

    r = fit_seasonal(T, _pixels(np.where(T >= 2017.5, SEASON - 0.3, SEASON)), 0.15)
    assert (r["count"] == 0).all()


def test_the_series_tool_maps_repeated_disturbances_and_recovery(client, tmp_path):
    """48 monthly NDVI images (2018–2021) at 10 m, 40 × 40 px. Rows 0–19 of the left half are cleared in July 2019 and
    regrow 0.1 a year; rows 20–39 are cleared then too and again in January 2021. The right half is stable forest."""
    import rasterio
    from rasterio.transform import from_origin

    rng = np.random.default_rng(7)
    ids, months = [], [(2018 + m // 12, m % 12 + 1) for m in range(48)]
    for year, month in months:
        t = year + (month - 0.5) / 12
        a = np.full((40, 40), 0.6 + 0.15 * np.cos(2 * np.pi * (t - 0.6)))
        if t >= 2019.5:
            a[:, :20] -= 0.3 - 0.1 * (t - 2019.5)
        if t >= 2021.0:
            a[20:, :20] -= 0.3
        a = (a + rng.normal(0, 0.02, a.shape)).astype(np.float32)
        a[rng.random(a.shape) < 0.2] = np.nan
        p = tmp_path / f"ndvi_{year}-{month:02d}-15.tif"
        with rasterio.open(p, "w", driver="GTiff", width=40, height=40, count=1, dtype="float32", crs="EPSG:32646", transform=from_origin(600000, 2850000, 10, 10), nodata=np.nan) as f:
            f.write(a, 1)
        with p.open("rb") as fh:
            ids.append(client.post("/api/files", files={"file": (p.name, fh, "image/tiff")}).json()["id"])
    res = run(client, "stack", {"files": ids}, {"mapBreaks": True, "minDrop": 0.15, "breakModel": "seasonal"})
    b = res["breaks"]
    assert b["model"] == "seasonal" and b["analysedPixels"] == 1600
    assert b["disturbedHa"] == pytest.approx(8, abs=0.1)  # the left half: 800 px of 100 m²; the stable right half has no false breaks
    assert b["repeatedHa"] == pytest.approx(4, abs=0.1)
    first = {x["date"]: x["ha"] for x in b["byDate"]}
    assert sum(ha for d, ha in first.items() if "2019-07-15" <= d <= "2019-10-15") == pytest.approx(8, abs=0.1)
    again = sum(x["ha"] for x in b["allByDate"] if "2021-01-15" <= x["date"] <= "2021-04-15")
    assert again == pytest.approx(4, abs=0.1)
    md = res["markdown"]
    assert "CCDC" in md and "Disturbed more than once: 4 ha" in md and "All disturbances, by date" in md

    def tif(name):
        p = tmp_path / name
        p.write_bytes(client.get(next(d["url"] for d in res["downloads"] if d["filename"] == name)).content)
        with rasterio.open(p) as f:
            return f.read(1)

    count, recovery = tif("disturbance_count.tif"), tif("disturbance_recovery.tif")
    assert (count[:20, :20] == 1).mean() > 0.97 and (count[20:, :20] == 2).mean() > 0.97 and (count[:, 20:] == 0).all()
    # Regrowth of 0.1 a year from July 2019 to December 2021 regains about 0.24 of the 0.3 drop.
    assert np.nanmedian(recovery[:20, :20]) == pytest.approx(0.1 * (2021 + 11.5 / 12 - 2019.5) / 0.3, abs=0.1)
    latest = tif("disturbance_latest_date.tif")
    dates = b["dates"]
    assert all("2021-01-15" <= dates[k] <= "2021-04-15" for k in latest[20:, :20].ravel())
    # The seasonal model needs a year of data and enough dates.
    assert "over more than a year" in run_err(client, "stack", {"files": ids[:10]}, {"mapBreaks": True, "breakModel": "seasonal"})
    assert "single (one drop" in run_err(client, "stack", {"files": ids}, {"mapBreaks": True, "breakModel": "ccdc"})
