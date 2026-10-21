"""Time-based one-time passwords (RFC 6238, with HOTP from RFC 4226): HMAC-SHA1, 30-second steps, 6 digits, the
settings every authenticator app (Google Authenticator, Microsoft Authenticator, Aegis, 1Password, …) uses.

A code is accepted for the current step and one step either side (clock drift), and never twice: the last step used is
stored, and only a later one is accepted. Recovery codes (ten, single use, stored hashed) get in when the phone is lost.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import struct
import time
from urllib.parse import quote, urlencode

STEP = 30
DIGITS = 6


def new_secret() -> str:
    """A 160-bit secret, base32 without padding (RFC 4226 recommends 160 bits)."""
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")


def _key(secret_b32: str) -> bytes:
    s = secret_b32.strip().replace(" ", "").upper()
    return base64.b32decode(s + "=" * (-len(s) % 8))


def hotp(secret_b32: str, counter: int) -> str:
    """RFC 4226 section 5.3: dynamic truncation of HMAC-SHA1 over the 8-byte big-endian counter."""
    mac = hmac.new(_key(secret_b32), struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = mac[-1] & 0x0F
    code = struct.unpack(">I", mac[offset : offset + 4])[0] & 0x7FFFFFFF
    return str(code % 10**DIGITS).zfill(DIGITS)


def step(at: float | None = None) -> int:
    return int((time.time() if at is None else at) // STEP)


def match(secret_b32: str, code: str, last_step: int | None, at: float | None = None) -> int | None:
    """The step a code belongs to (now ±1), if it is right and newer than `last_step`; else None."""
    code = "".join(ch for ch in code if ch.isdigit())
    if len(code) != DIGITS:
        return None
    now = step(at)
    for s in (now - 1, now, now + 1):
        if (last_step is None or s > last_step) and hmac.compare_digest(hotp(secret_b32, s), code):
            return s
    return None


def uri(secret_b32: str, account: str, issuer: str = "TerraX") -> str:
    """The otpauth:// link (Key Uri Format) that authenticator apps read from a QR code."""
    label = quote(f"{issuer}:{account}")
    return f"otpauth://totp/{label}?{urlencode({'secret': secret_b32, 'issuer': issuer, 'algorithm': 'SHA1', 'digits': DIGITS, 'period': STEP})}"


def recovery_codes(n: int = 10) -> list[str]:
    """Codes like "k7wq-2mzp-x9ad": 12 characters from 31 without look-alikes, about 59 bits each."""
    alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
    return ["-".join("".join(secrets.choice(alphabet) for _ in range(4)) for _ in range(3)) for _ in range(n)]


def hash_code(code: str) -> str:
    return hashlib.sha256(code.strip().lower().replace(" ", "").encode()).hexdigest()
