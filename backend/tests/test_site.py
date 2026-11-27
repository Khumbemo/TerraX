"""Site settings and the owner's controls in the Admin tab: sign-up, announcement, maintenance, contact details, system
status, everyone's jobs, backups and clean-up."""

import pytest

from tests.test_accounts import _admin, new_client, sample, signup, uniq


@pytest.fixture(autouse=True)
def _clear_settings():
    from terrax import site

    yield
    site.update({k: None for k in site.KEYS}, "")


@pytest.fixture()
def app():
    from terrax.api.main import app as a

    return a


def test_only_admins_change_settings_and_every_value_is_checked(app):
    user = new_client(app)
    signup(user, uniq("u"))
    assert user.put("/api/admin/settings", json={"announcement": "hi"}).status_code == 403
    assert new_client(app).get("/api/admin/system").status_code == 401
    adm = _admin(app)
    for body, text in [
        ({"signup": "maybe"}, "open or closed"),
        ({"contactEmail": "not an address"}, "not an e-mail address"),
        ({"supportUrl": "javascript:alert(1)"}, "https://"),
        ({"contactPhone": "call me"}, "phone numbers"),
        ({"contactPhone": "12345"}, "phone numbers"),  # too short to be a number
        ({"announcement": "x" * 501}, "under 500"),
        ({"maintenance": "yes"}, "on or off"),
        ({"colour": "red"}, "Unknown setting"),
    ]:
        r = adm.put("/api/admin/settings", json=body)
        assert r.status_code == 400 and text in r.json()["detail"], (body, r.text)
    # Nothing was stored by the refused requests (all values are checked before any is written).
    assert adm.get("/api/admin/settings").json()["settings"] == {}
    r = adm.put("/api/admin/settings", json={"contactName": "  TerraX lab ", "contactEmail": "help@example.org", "supportUrl": "https://example.org/help"})
    assert r.json()["settings"] == {"contactName": "TerraX lab", "contactEmail": "help@example.org", "supportUrl": "https://example.org/help"}
    # Public: anyone sees the contact details, the licence and the version.
    pub = new_client(app).get("/api/site").json()
    assert pub["contact"] == {"contactName": "TerraX lab", "contactEmail": "help@example.org", "contactPhone": None, "supportEmail": None,
                              "supportUrl": "https://example.org/help"}
    # Several phone numbers, written as people write them.
    adm.put("/api/admin/settings", json={"contactPhone": "+91 98765 43210, 0123-456789"})
    assert new_client(app).get("/api/site").json()["contact"]["contactPhone"] == "+91 98765 43210, 0123-456789"
    adm.put("/api/admin/settings", json={"contactPhone": None})
    assert pub["licence"] == "MIT" and pub["version"] and pub["announcement"] is None and pub["maintenance"] is None
    # Clearing a value (empty or null) removes it; the change is audited without the values.
    adm.put("/api/admin/settings", json={"supportUrl": "", "contactName": None})
    assert adm.get("/api/admin/settings").json()["settings"] == {"contactEmail": "help@example.org"}
    entries = adm.get("/api/admin/audit", params={"action": "admin.settings_changed"}).json()["entries"]
    import json

    assert entries and json.loads(entries[0]["detail"]) == {"supportUrl": "cleared", "contactName": "cleared"}


def test_signup_can_be_closed_and_reopened_from_the_admin_tab(app):
    adm = _admin(app)
    adm.put("/api/admin/settings", json={"signup": "closed"})
    assert new_client(app).get("/api/auth/me").json()["signup"] == "closed"
    assert new_client(app).post("/api/auth/signup", json={"email": uniq("c"), "password": "long enough pass"}).status_code == 403
    adm.put("/api/admin/settings", json={"signup": None})  # back to TERRAX_SIGNUP (open)
    signup(new_client(app), uniq("o"))


def test_maintenance_pauses_new_analyses_except_for_admins(app):
    adm = _admin(app)
    adm.put("/api/admin/settings", json={"maintenance": True, "announcement": "Upgrade tonight at 22:00."})
    pub = new_client(app).get("/api/site").json()
    assert pub["announcement"] == "Upgrade tonight at 22:00." and "maintenance" in pub["maintenance"]
    guest = new_client(app)
    r = guest.post("/api/jobs", json={"tool": "terrain", "inputs": {"dem": sample(guest)}, "params": {}})
    assert r.status_code == 503 and "paused" in r.json()["detail"]
    assert adm.post("/api/jobs", json={"tool": "terrain", "inputs": {"dem": sample(adm)}, "params": {}}).json()["state"] == "done"
    adm.put("/api/admin/settings", json={"maintenanceMessage": "Back at 23:00."})
    assert guest.post("/api/jobs", json={"tool": "terrain", "inputs": {"dem": sample(guest)}, "params": {}}).json()["detail"] == "Back at 23:00."
    adm.put("/api/admin/settings", json={"maintenance": False})
    assert guest.post("/api/jobs", json={"tool": "terrain", "inputs": {"dem": sample(guest)}, "params": {}}).json()["state"] == "done"


def test_system_jobs_backups_and_cleanup(app, tmp_path, monkeypatch):
    monkeypatch.setenv("TERRAX_BACKUP_DIR", str(tmp_path / "backups"))
    adm = _admin(app)
    guest = new_client(app)
    guest.post("/api/jobs", json={"tool": "terrain", "inputs": {"dem": sample(guest)}, "params": {}})
    sysinfo = adm.get("/api/admin/system").json()
    assert sysinfo["ok"] and sysinfo["checks"]["database"] and sysinfo["version"]
    names = {c["name"] for c in sysinfo["config"]}
    assert {"Accounts", "Sign-up", "Database type", "Database backups", "Server AI key"} <= names
    assert not any("passphrase" in str(c["value"]) for c in sysinfo["config"])  # no secrets
    jobs = adm.get("/api/admin/jobs", params={"tool": "terrain"}).json()["jobs"]
    assert jobs and jobs[0]["who"] == "guest" and jobs[0]["state"] == "done"
    failed = adm.get("/api/admin/jobs", params={"state": "error"}).json()["jobs"]
    assert all(j["state"] == "error" for j in failed) and jobs[0]["id"] not in {j["id"] for j in failed}
    made = adm.post("/api/admin/backups")
    assert made.status_code == 201 and made.json()["rows"] > 0
    listed = adm.get("/api/admin/backups").json()
    assert made.json()["name"] in [b["name"] for b in listed["backups"]]
    out = adm.post("/api/admin/cleanup").json()
    assert set(out) == {"errors", "counters", "audit", "files"}
    actions = {e["action"] for e in adm.get("/api/admin/audit", params={"action": "admin."}).json()["entries"]}
    assert {"admin.backup_made", "admin.cleanup"} <= actions
