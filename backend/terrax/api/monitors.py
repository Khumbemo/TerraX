"""Forest-loss monitors (terrax/monitors.py): watched areas, checked as new Sentinel-2 scenes arrive, with e-mailed alerts.

Monitors belong to signed-in accounts (alerts go to the account's address), and each account may keep TERRAX_MONITORS
of them (default 10)."""

from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .. import auth, mailer, monitors, ratelimit, storage, tasks
from ..auth import Principal, require_user

router = APIRouter(prefix="/api/monitors")


def _limit() -> int:
    return int(os.environ.get("TERRAX_MONITORS", "10") or 10)


class MonitorIn(BaseModel):
    name: str = Field("", max_length=200)
    geojson: dict[str, Any]
    settings: dict[str, Any] | None = None
    email: bool = True


class MonitorChange(BaseModel):
    name: str | None = Field(None, max_length=200)
    active: bool | None = None
    email: bool | None = None
    settings: dict[str, Any] | None = None
    rebuildReference: bool = False


def _user(p: Principal) -> str:
    assert p.user_id is not None  # require_user refuses guests
    return p.user_id


def _mine(mid: str, p: Principal) -> dict[str, Any]:
    try:
        return monitors.owned(mid, _user(p))
    except KeyError:
        raise HTTPException(404, "That monitor does not exist.") from None


@router.get("")
def list_monitors(p: Principal = Depends(require_user)) -> dict[str, Any]:
    return {"monitors": monitors.list_for(_user(p)), "canEmail": mailer.can_send(), "limit": _limit()}


@router.post("", status_code=201)
def create_monitor(req: MonitorIn, request: Request, p: Principal = Depends(require_user)) -> dict[str, Any]:
    ratelimit.check("live", p.owner, auth.client_ip(request))
    if len(monitors.list_for(_user(p))) >= _limit():
        raise HTTPException(400, f"An account can keep {_limit()} monitors; delete one first.")
    try:
        m = monitors.create(_user(p), req.name, req.geojson, req.settings, req.email)
    except monitors.MonitorError as err:
        raise HTTPException(400, str(err)) from None
    tasks.submit_monitor_check(m["id"])  # builds the reference image
    return monitors.public(monitors.get(m["id"]), monitors.alerts_of(m["id"]))


@router.get("/{mid}")
def get_monitor(mid: str, p: Principal = Depends(require_user)) -> dict[str, Any]:
    m = _mine(mid, p)
    return monitors.public(m, monitors.alerts_of(mid))


@router.patch("/{mid}")
def change_monitor(mid: str, req: MonitorChange, p: Principal = Depends(require_user)) -> dict[str, Any]:
    m = _mine(mid, p)
    values: dict[str, Any] = {}
    if req.name is not None:
        values["name"] = req.name.strip()[:200] or m["name"]
    if req.active is not None:
        values["active"] = req.active
    if req.email is not None:
        values["email"] = req.email
    if req.settings is not None:
        try:
            values["settings"] = monitors.settings_from({**m["settings"], **req.settings})
        except monitors.MonitorError as err:
            raise HTTPException(400, str(err)) from None
    if req.rebuildReference:
        values.update(reference=None, status="Rebuilding the reference image…")
    if values:
        monitors.change(mid, **values)
    if req.rebuildReference:
        tasks.submit_monitor_check(mid)
    return monitors.public(monitors.get(mid), monitors.alerts_of(mid))


@router.delete("/{mid}", status_code=204)
def delete_monitor(mid: str, p: Principal = Depends(require_user)) -> None:
    _mine(mid, p)
    monitors.remove(mid)


@router.post("/{mid}/check", status_code=202)
def check_now(mid: str, request: Request, p: Principal = Depends(require_user)) -> dict[str, Any]:
    ratelimit.check("live", p.owner, auth.client_ip(request))
    _mine(mid, p)
    tasks.submit_monitor_check(mid)
    return monitors.public(monitors.get(mid), monitors.alerts_of(mid))


@router.get("/{mid}/alerts/{aid}.geojson")
def alert_geojson(mid: str, aid: str, p: Principal = Depends(require_user)) -> JSONResponse:
    m = _mine(mid, p)
    a = next((x for x in monitors.alerts_of(mid, with_geojson=True) if x["id"] == aid), None)
    if a is None:
        raise HTTPException(404, "That alert does not exist.")
    name = storage.safe_name(f"{m['name']}_loss_{a['confirmed']}.geojson")  # the user's monitor name, made safe for a header
    return JSONResponse(a["geojson"], media_type="application/geo+json", headers={"Content-Disposition": f'attachment; filename="{name}"'})
