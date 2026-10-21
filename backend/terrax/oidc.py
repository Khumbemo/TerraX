"""Single sign-on with OpenID Connect (Core 1.0): the authorization-code flow with PKCE (RFC 7636, S256), state and
nonce, for any provider with discovery (Google, Microsoft Entra ID, Okta, Auth0, Keycloak, …).

The ID token comes straight from the provider's token endpoint over TLS, in exchange for the code and this server's
client secret. For that case OpenID Connect Core 3.1.3.7 (step 6) lets the client rely on TLS instead of checking the
token's signature; TerraX still checks the issuer, audience (and azp), expiry, issue time and nonce. Accounts are found
by the provider's subject, or linked by e-mail when the provider says the address is verified.
"""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
import time
from typing import Any
from urllib.parse import urlencode

from .config import settings

STATE_SECONDS = 600
_discovery: dict[str, tuple[float, dict[str, Any]]] = {}


def enabled() -> bool:
    s = settings()
    return bool(s.oidc_issuer and s.oidc_client_id and s.oidc_client_secret)


def _get_json(url: str, headers: dict[str, str] | None = None) -> dict[str, Any]:
    import httpx

    r = httpx.get(url, headers=headers or {}, timeout=15, follow_redirects=True)
    r.raise_for_status()
    return r.json()


def _post_form(url: str, data: dict[str, str], auth: tuple[str, str]) -> dict[str, Any]:
    import httpx

    r = httpx.post(url, data=data, auth=auth, timeout=15, headers={"Accept": "application/json"})
    if r.status_code >= 400:
        try:
            detail = r.json().get("error_description") or r.json().get("error")
        except ValueError:
            detail = f"HTTP {r.status_code}"
        raise ValueError(f"The sign-in provider refused the code ({detail}).")
    return r.json()


def discovery() -> dict[str, Any]:
    """The provider's metadata (cached for an hour); its issuer must be the configured one."""
    iss = settings().oidc_issuer
    hit = _discovery.get(iss)
    if hit and time.time() - hit[0] < 3600:
        return hit[1]
    meta = _get_json(f"{iss}/.well-known/openid-configuration")
    if meta.get("issuer", "").rstrip("/") != iss:
        raise ValueError("The sign-in provider's metadata names another issuer.")
    _discovery[iss] = (time.time(), meta)
    return meta


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def authorization_url(redirect_uri: str, state: str, nonce: str, verifier: str) -> str:
    meta = discovery()
    challenge = _b64url(hashlib.sha256(verifier.encode()).digest())
    q = {"response_type": "code", "client_id": settings().oidc_client_id, "redirect_uri": redirect_uri, "scope": "openid email profile",
         "state": state, "nonce": nonce, "code_challenge": challenge, "code_challenge_method": "S256"}
    return f"{meta['authorization_endpoint']}?{urlencode(q)}"


def new_flow() -> tuple[str, str, str]:
    """(state, nonce, PKCE verifier): random, single use."""
    return secrets.token_urlsafe(32), secrets.token_urlsafe(24), secrets.token_urlsafe(48)


def _claims(id_token: str) -> dict[str, Any]:
    try:
        payload = id_token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except (IndexError, ValueError) as err:
        raise ValueError("The sign-in provider sent an ID token that is not a JWT.") from err


def finish(code: str, redirect_uri: str, nonce: str, verifier: str, now: float | None = None) -> dict[str, Any]:
    """Exchanges the code and checks the ID token; returns {sub, email, email_verified, name}."""
    s = settings()
    meta = discovery()
    tok = _post_form(meta["token_endpoint"], {"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri, "code_verifier": verifier},
                     (s.oidc_client_id, s.oidc_client_secret))
    if "id_token" not in tok:
        raise ValueError("The sign-in provider sent no ID token.")
    c = _claims(tok["id_token"])
    now = time.time() if now is None else now
    aud = c.get("aud")
    auds = aud if isinstance(aud, list) else [aud]
    problems = []
    if str(c.get("iss", "")).rstrip("/") != s.oidc_issuer:
        problems.append("issuer")
    if s.oidc_client_id not in auds or (len(auds) > 1 and c.get("azp") != s.oidc_client_id):
        problems.append("audience")
    if not isinstance(c.get("exp"), (int, float)) or c["exp"] < now - 60:
        problems.append("expiry")
    if isinstance(c.get("iat"), (int, float)) and c["iat"] > now + 300:
        problems.append("issue time")
    if c.get("nonce") != nonce:
        problems.append("nonce")
    if not c.get("sub"):
        problems.append("subject")
    if problems:
        raise ValueError(f"The sign-in provider's ID token failed the {', '.join(problems)} check.")
    info = dict(c)
    if not info.get("email") and meta.get("userinfo_endpoint") and tok.get("access_token"):
        u = _get_json(meta["userinfo_endpoint"], {"Authorization": f"Bearer {tok['access_token']}"})
        if u.get("sub") == c["sub"]:  # Core 5.3.2: the userinfo subject must match the ID token's
            info |= u
    verified = info.get("email_verified")
    return {"sub": f"{s.oidc_issuer}|{c['sub']}", "email": str(info.get("email") or "").strip().lower(),
            "email_verified": verified is True or verified == "true", "name": str(info.get("name") or "")[:120]}
