"""Any AI provider's key: recognise the provider, list its models, and ask it a question.

Three adapters cover the providers TerraX knows and any other server that speaks one of their protocols:

* **OpenAI-compatible** (`/chat/completions`, `/models`): OpenAI, DeepSeek, Groq, OpenRouter, xAI, Mistral, Together,
  a local Ollama, and any custom base URL.
* **Gemini** (google-genai SDK, with Google Search grounding; models listed over REST).
* **Anthropic** (`/v1/messages`, `/v1/models`).

Recognising a key: keys of several providers start with a fixed prefix (`AIza`, `sk-ant-`, `gsk_`, …). The longest
matching prefix narrows the key to one or a few providers (a plain `sk-` could be OpenAI or DeepSeek; a key with no
known prefix could be Mistral or Together), and each candidate is then asked to list its models, in order of
likelihood, until one accepts the key. Listing models costs nothing, so a key is checked without spending tokens.
The result (provider, models, default model) is kept with the key in the browser, so later requests probe nothing.

Endpoints checked from this code's development container (an invalid key got the provider's own "invalid key"
answer): Google Gemini and Anthropic. The others follow the providers' published OpenAI-compatible endpoints; any
endpoint can also be given by hand as a custom base URL.

Safety: keys are never stored or logged by the server and are scrubbed from error messages. Base URLs typed by a
user (custom, Ollama) must resolve to public addresses unless TERRAX_AI_ALLOW_PRIVATE is set, and the request is sent
to the address that was checked (pinned, with the hostname kept for TLS), so a DNS answer that changes between the
check and the request cannot point it into the server's own network. Plain http is accepted only for allowed private
addresses. Redirects are not followed and answers are capped in size.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import re
import socket
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, replace
from typing import Any, Literal
from urllib.parse import quote, urlsplit

import httpx

from ..config import settings
from . import gemini
from .gemini import GenerateRequest, GenerateResult

Kind = Literal["gemini", "openai", "anthropic"]

MAX_RESPONSE_BYTES = 4_000_000
MAX_MODELS = 500
MAX_CREDENTIALS = 3
TIMEOUT = httpx.Timeout(90.0, connect=10.0)
PROBE_TIMEOUT = httpx.Timeout(15.0, connect=8.0)
KEY_PATTERN = re.compile(r"^[\x21-\x7e]{8,512}$")  # printable ASCII, no spaces: nothing can break out of a header
MODEL_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,127}$")  # vendor/model (OpenRouter), name:tag (Ollama)
# Models a key lists that cannot answer a chat (embeddings, speech, images, moderation, …).
NOT_CHAT = re.compile(r"embed|whisper|tts|speech|audio|transcri|dall-e|image|imagen|veo|moderation|rerank|guard|realtime|-search-|vision-only|aqa", re.I)
# When no preferred model is listed: fast, inexpensive models first.
CHEAP_HINTS = ("flash", "haiku", "mini", "small", "instant", "lite", "chat", "8b")


@dataclass(frozen=True)
class Provider:
    id: str
    name: str
    kind: Kind
    base_url: str = ""  # fixed for known providers; typed by the user for ollama and custom
    prefixes: tuple[str, ...] = ()
    preferred: tuple[str, ...] = ()  # default model candidates, best first; used only when the key lists them
    search: bool = False  # answers grounded in a web search, with sources
    needs_key: bool = True
    user_url: bool = False

    def public(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "needsKey": self.needs_key, "userUrl": self.user_url, "search": self.search,
                "baseUrl": self.base_url if self.user_url else ""}


# Order matters: candidates sharing a prefix (or having none) are probed in this order, most likely first.
PROVIDERS: dict[str, Provider] = {p.id: p for p in [
    Provider("gemini", "Google Gemini", "gemini", "https://generativelanguage.googleapis.com/v1beta", ("AIza",),
             ("gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"), search=True),
    Provider("anthropic", "Anthropic Claude", "anthropic", "https://api.anthropic.com/v1", ("sk-ant-",),
             ("claude-haiku-5-5", "claude-sonnet-5-5", "claude-haiku-4-5", "claude-sonnet-4-5")),
    Provider("openrouter", "OpenRouter", "openai", "https://openrouter.ai/api/v1", ("sk-or-",), ("openrouter/auto",)),
    Provider("openai", "OpenAI", "openai", "https://api.openai.com/v1", ("sk-",), ("gpt-4.1-mini", "gpt-4o-mini")),
    Provider("deepseek", "DeepSeek", "openai", "https://api.deepseek.com", ("sk-",), ("deepseek-chat",)),
    Provider("groq", "Groq", "openai", "https://api.groq.com/openai/v1", ("gsk_",), ("llama-3.3-70b-versatile", "llama-3.1-8b-instant")),
    Provider("xai", "xAI Grok", "openai", "https://api.x.ai/v1", ("xai-",)),
    Provider("mistral", "Mistral", "openai", "https://api.mistral.ai/v1", (), ("mistral-small-latest", "mistral-large-latest")),
    Provider("together", "Together AI", "openai", "https://api.together.xyz/v1"),
    Provider("ollama", "Ollama (local)", "openai", "http://localhost:11434/v1", needs_key=False, user_url=True),
    Provider("custom", "Custom (OpenAI-compatible)", "openai", "", needs_key=False, user_url=True),
]}


class LLMError(RuntimeError):
    """A failure the user can act on. kind: auth, rate, model, bad, network, server, config."""

    def __init__(self, message: str, kind: str = "server", retry_after: float | None = None):
        super().__init__(message)
        self.kind = kind
        self.retry_after = retry_after


@dataclass(frozen=True)
class Credential:
    key: str
    provider: str
    model: str = ""
    base_url: str = ""
    source: Literal["user", "server"] = "user"

    @property
    def spec(self) -> Provider:
        return PROVIDERS[self.provider]

    @property
    def url(self) -> str:
        return (self.base_url or self.spec.base_url).rstrip("/")

    @property
    def fingerprint(self) -> str:
        """Identifies the key for its limits without keeping it: an HMAC with the server's secret, so nothing stored
        (rate-limit counters) can be linked to the key; a keyless local server by its address."""
        from ..signing import secret

        material = self.key or f"{self.provider}:{self.url}"
        return hmac.new(secret(), f"ai-key:{material}".encode(), hashlib.sha256).hexdigest()[:24]


# --- input checks -------------------------------------------------------------------------------------------------

def clean_key(key: str | None) -> str:
    k = (key or "").strip()
    if k and not KEY_PATTERN.match(k):
        raise LLMError("That doesn't look like an API key: keys are 8 to 512 characters of letters, digits and symbols, without spaces.", "bad")
    return k


def clean_model(model: str | None, provider: Provider) -> str:
    m = (model or "").strip()
    if not m:
        return ""
    if provider.kind == "gemini":
        picked = gemini.pick_model(m, "")
        if not picked:
            raise LLMError(f"“{m[:80]}” is not a valid Gemini model name.", "bad")
        return picked
    if not MODEL_PATTERN.match(m):
        raise LLMError(f"“{m[:80]}” is not a valid model name.", "bad")
    return m


def clean_base_url(url: str | None) -> str:
    """Scheme and host checked, no credentials, query or fragment; trailing slash removed."""
    u = (url or "").strip()
    if not u:
        return ""
    if len(u) > 300:
        raise LLMError("The base URL is too long.", "bad")
    parts = urlsplit(u)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise LLMError("The base URL must start with https:// (or http:// for a local server) and name a host.", "bad")
    if parts.username or parts.password or parts.query or parts.fragment:
        raise LLMError("The base URL must not contain a user name, password, query or fragment.", "bad")
    try:
        parts.port  # noqa: B018 - raises on a malformed port
    except ValueError:
        raise LLMError("The base URL has an invalid port.", "bad") from None
    return u.rstrip("/")


def make_credential(key: str | None, provider: str, model: str | None = None, base_url: str | None = None,
                    source: Literal["user", "server"] = "user") -> Credential:
    spec = PROVIDERS.get((provider or "").strip().lower())
    if spec is None:
        raise LLMError(f"Unknown AI provider “{str(provider)[:40]}”.", "bad")
    k = clean_key(key)
    if spec.needs_key and not k:
        raise LLMError(f"{spec.name} needs an API key.", "bad")
    url = clean_base_url(base_url) if spec.user_url else ""
    if spec.id == "custom" and not url:
        raise LLMError("Give the base URL of the OpenAI-compatible server (for example https://example.com/v1).", "bad")
    return Credential(k, spec.id, clean_model(model, spec), url, source)


def parse_credentials(header: str | None) -> list[Credential]:
    """The X-AI-Credentials header: base64 (URL-safe or standard) of a JSON list of {key, provider, model?, baseUrl?}."""
    if not header or not header.strip():
        return []
    raw = header.strip()
    try:
        padded = raw + "=" * (-len(raw) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded.replace("+", "-").replace("/", "_")).decode())
    except (ValueError, UnicodeDecodeError):
        raise LLMError("The AI credentials sent by the browser could not be read. Remove and add the key again in Settings.", "bad") from None
    if not isinstance(data, list) or not all(isinstance(d, dict) for d in data):
        raise LLMError("The AI credentials must be a list.", "bad")
    if len(data) > MAX_CREDENTIALS:
        raise LLMError(f"At most {MAX_CREDENTIALS} AI keys can be used.", "bad")
    return [make_credential(d.get("key"), str(d.get("provider", "")), d.get("model"), d.get("baseUrl")) for d in data]


def scrub(text: str, key: str) -> str:
    """A provider's message, shortened, with the key itself removed (some providers quote part of a rejected key)."""
    out = text.replace(key, "***") if key else text
    return out[:400]


# --- addresses typed by users (custom, ollama) ---------------------------------------------------------------------

Resolver = Callable[[str, int], list[str]]


def _resolve(host: str, port: int) -> list[str]:
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return list(dict.fromkeys(str(i[4][0]) for i in infos))


resolver: Resolver = _resolve  # replaced in tests


def _public(ip: str) -> bool:
    a = ipaddress.ip_address(ip.split("%")[0])
    if isinstance(a, ipaddress.IPv6Address) and a.ipv4_mapped:
        a = a.ipv4_mapped
    return a.is_global and not a.is_multicast


def pin(url: str) -> tuple[str, dict[str, str], dict[str, Any]]:
    """For a user-typed URL: (URL with the checked IP in place of the host, extra headers, httpx extensions).

    Every address the name resolves to must be public, unless the administrator allows private ones; http only to
    allowed private addresses."""
    parts = urlsplit(url)
    host = parts.hostname or ""
    port = parts.port or (443 if parts.scheme == "https" else 80)
    try:
        ips = [host] if _is_ip(host) else resolver(host, port)
    except OSError:
        raise LLMError(f"The address {host} could not be found.", "network") from None
    if not ips:
        raise LLMError(f"The address {host} could not be found.", "network")
    private = [ip for ip in ips if not _public(ip)]
    allow = settings().ai_allow_private
    if private and not allow:
        raise LLMError(f"{host} points to a private or local address, which TerraX does not call unless the server's administrator "
                       "sets TERRAX_AI_ALLOW_PRIVATE=true (needed for a local Ollama).", "config")
    if parts.scheme == "http" and not private:
        raise LLMError("Use https:// for a server on the internet: over http:// the API key would travel unencrypted.", "config")
    ip = ips[0]
    netloc_ip = f"[{ip}]" if ":" in ip else ip
    pinned = parts._replace(netloc=f"{netloc_ip}:{port}").geturl()
    headers = {"Host": parts.netloc.rsplit("@", 1)[-1]}
    ext: dict[str, Any] = {"sni_hostname": host} if parts.scheme == "https" else {}
    return pinned, headers, ext


def _is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


# --- HTTP ----------------------------------------------------------------------------------------------------------

transport: httpx.BaseTransport | None = None  # replaced in tests by an httpx.MockTransport


def _client(timeout: httpx.Timeout) -> httpx.Client:
    return httpx.Client(timeout=timeout, follow_redirects=False, transport=transport)


def _send(cred: Credential, method: str, path: str, headers: dict[str, str], body: Any = None, timeout: httpx.Timeout = TIMEOUT) -> Any:
    """One request to the credential's provider; the JSON answer, or LLMError with a message the user can act on."""
    url = f"{cred.url}{path}"
    ext: dict[str, Any] = {}
    if cred.spec.user_url:
        url, extra, ext = pin(url)
        headers = {**headers, **extra}
    name = cred.spec.name if cred.provider != "custom" else (urlsplit(cred.url).hostname or "the server")
    try:
        with _client(timeout) as c:
            req = c.build_request(method, url, headers=headers, json=body, extensions=ext)
            r = c.send(req, stream=True)
            try:
                chunks, size = [], 0
                for chunk in r.iter_bytes():
                    size += len(chunk)
                    if size > MAX_RESPONSE_BYTES:
                        raise LLMError(f"{name} sent an answer larger than {MAX_RESPONSE_BYTES // 1_000_000} MB.", "server")
                    chunks.append(chunk)
            finally:
                r.close()
    except httpx.TimeoutException:
        raise LLMError(f"{name} did not answer in time.", "network") from None
    except httpx.HTTPError as e:
        raise LLMError(f"{name} could not be reached ({type(e).__name__}).", "network") from None
    content = b"".join(chunks)
    try:
        data = json.loads(content) if content else None
    except ValueError:
        data = None
    if r.status_code >= 300:  # errors, and redirects (not followed)
        raise _http_error(r.status_code, data, content, r.headers.get("retry-after"), cred, name)
    if data is None:
        raise LLMError(f"{name} sent an answer that is not JSON.", "server")
    return data


def _message(data: Any, content: bytes) -> str:
    if isinstance(data, dict):
        err = data.get("error", data)
        if isinstance(err, dict):
            m = err.get("message") or err.get("msg") or err.get("detail") or ""
            if isinstance(m, str) and m:
                return m
        if isinstance(err, str):
            return err
        if isinstance(data.get("detail"), str):
            return str(data["detail"])
    return content[:200].decode("utf-8", "replace")


def _http_error(status: int, data: Any, content: bytes, retry_after: str | None, cred: Credential, name: str) -> LLMError:
    msg = scrub(_message(data, content), cred.key)
    wait = None
    if retry_after:
        try:
            wait = min(3600.0, max(1.0, float(retry_after)))
        except ValueError:
            wait = None
    google_bad_key = status == 400 and re.search(r"API_KEY_INVALID|API key not valid", content.decode("utf-8", "replace"))
    if status in (401, 403) or google_bad_key:
        return LLMError(f"{name} rejected the API key ({status}). Check the key, and that it may use this API.", "auth")
    if status == 429:
        return LLMError(f"This key's rate limit or quota at {name} was reached{f'; try again in {int(wait)} s' if wait else ''}. "
                        "Each key has its own limit set by the provider.", "rate", wait or 60.0)
    if status == 404:
        return LLMError(f"{name} does not offer the requested model or address for this key ({msg}). Choose another model in Settings.", "model")
    if 300 <= status < 400:
        return LLMError(f"{name} redirected the request ({status}); TerraX does not follow redirects. Check the base URL.", "config")
    if status in (400, 422):
        return LLMError(f"{name} refused the request: {msg}", "bad")
    return LLMError(f"{name} had a problem ({status}): {msg}", "server")


def _headers(cred: Credential) -> dict[str, str]:
    kind = cred.spec.kind
    if kind == "anthropic":
        return {"x-api-key": cred.key, "anthropic-version": "2023-06-01"}
    if kind == "gemini":
        return {"x-goog-api-key": cred.key}
    return {"Authorization": f"Bearer {cred.key}"} if cred.key else {}


# --- models --------------------------------------------------------------------------------------------------------

def list_models(cred: Credential, timeout: httpx.Timeout = PROBE_TIMEOUT) -> list[str]:
    kind = cred.spec.kind
    if kind == "gemini":
        names: list[str] = []
        token = ""
        for _ in range(5):  # pages of 1000
            page = "&pageToken=" + quote(token, safe="") if token else ""
            data = _send(cred, "GET", f"/models?pageSize=1000{page}", _headers(cred), timeout=timeout)
            for m in data.get("models", []) if isinstance(data, dict) else []:
                if "generateContent" in (m.get("supportedGenerationMethods") or []):
                    names.append(str(m.get("name", "")).removeprefix("models/"))
            token = data.get("nextPageToken", "") if isinstance(data, dict) else ""
            if not token:
                break
        return [n for n in names if n][:MAX_MODELS]
    if kind == "anthropic":
        data = _send(cred, "GET", "/models?limit=1000", _headers(cred), timeout=timeout)
    else:
        data = _send(cred, "GET", "/models", _headers(cred), timeout=timeout)
    found = (data.get("data") or data.get("models")) if isinstance(data, dict) else data
    items: list[Any] = found if isinstance(found, list) else []
    ids = [str(m.get("id") or m.get("name") or "") if isinstance(m, dict) else str(m) for m in items]
    return [i for i in dict.fromkeys(ids) if i and MODEL_PATTERN.match(i)][:MAX_MODELS]


def default_model(provider: Provider, models: list[str]) -> str:
    """The provider's preferred model if the key lists it, else a fast chat model from the list, else ''."""
    listed = set(models)
    for m in provider.preferred:
        if m in listed:
            return m
    chat = [m for m in models if not NOT_CHAT.search(m)]
    for hint in CHEAP_HINTS:
        hits = sorted(m for m in chat if hint in m.lower())
        if hits:
            return hits[0]
    if chat:
        return sorted(chat)[0]
    return provider.preferred[0] if provider.preferred and not models else ""


# --- recognising a key ---------------------------------------------------------------------------------------------

def candidates(key: str) -> list[Provider]:
    """Providers a key may belong to, most likely first: those with the longest matching prefix, else those without one."""
    matches = [(len(px), p) for p in PROVIDERS.values() for px in p.prefixes if key.startswith(px)]
    if matches:
        best = max(n for n, _ in matches)
        return list(dict.fromkeys(p for n, p in matches if n == best))
    return [p for p in PROVIDERS.values() if not p.prefixes and not p.user_url]


@dataclass
class Detected:
    credential: Credential
    models: list[str]

    def public(self) -> dict[str, Any]:
        spec = self.credential.spec
        return {"provider": spec.id, "name": spec.name, "kind": spec.kind, "search": spec.search, "models": self.models,
                "model": self.credential.model, "baseUrl": self.credential.base_url}


def detect(key: str | None, provider: str = "auto", base_url: str | None = None, model: str | None = None,
           source: Literal["user", "server"] = "user") -> Detected:
    """Finds the key's provider (or checks the one given) by listing its models; picks the default model."""
    k = clean_key(key)
    chosen = (provider or "auto").strip().lower()
    if chosen != "auto":
        cred = make_credential(k, chosen, model, base_url, source)
        try:
            models = list_models(cred)
        except LLMError as e:
            if cred.spec.user_url and e.kind == "model":  # a server without /models: the model must be typed by hand
                models = []
            else:
                raise
        return Detected(replace(cred, model=cred.model or default_model(cred.spec, models)), models)
    if not k:
        raise LLMError("Paste an API key, or choose Ollama or a custom server for a model without a key.", "bad")
    tried, reasons = [], []
    for spec in candidates(k):
        cred = Credential(k, spec.id, clean_model(model, spec), "", source)
        try:
            models = list_models(cred)
        except LLMError as e:
            tried.append(spec.name)
            if e.kind != "auth":
                reasons.append(str(e))
            continue
        return Detected(replace(cred, model=cred.model or default_model(spec, models)), models)
    names = ", ".join(tried) or "no provider"
    detail = f" ({reasons[0]})" if reasons else ""
    raise LLMError(f"No provider accepted this key: tried {names}{detail}. Choose the provider by hand, or a custom server.", "auth" if not reasons else "network")


# --- asking --------------------------------------------------------------------------------------------------------

def _openai_messages(req: GenerateRequest) -> list[dict[str, str]]:
    msgs = [{"role": "system", "content": req.system_instruction}] if req.system_instruction else []
    return msgs + [{"role": "assistant" if t["role"] == "model" else "user", "content": t["text"]} for t in req.turns]


def _text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):  # content parts
        return "".join(str(p.get("text", "")) for p in content if isinstance(p, dict))
    return ""


def _with_temperature(cred: Credential, send: Callable[[dict[str, Any]], Any], body: dict[str, Any]) -> Any:
    """Sends with the temperature; if the model refuses a temperature (some reasoning models), once more without it."""
    try:
        return send(body)
    except LLMError as e:
        if e.kind == "bad" and "temperature" in str(e).lower() and "temperature" in body:
            return send({k: v for k, v in body.items() if k != "temperature"})
        raise


def generate(cred: Credential, req: GenerateRequest) -> GenerateResult:
    spec = cred.spec
    model = cred.model or req.model
    if not model:
        raise LLMError(f"Choose a model for {spec.name} in Settings.", "model")
    if spec.kind == "gemini":
        try:
            return gemini.generate(cred.key, replace(req, model=model, use_search=req.use_search and spec.search))
        except gemini.GeminiError as e:
            raise LLMError(scrub(str(e), cred.key), {"auth": "auth", "rate": "rate", "model": "model"}.get(e.kind, "server"),
                           60.0 if e.kind == "rate" else None) from None
    if spec.kind == "anthropic":
        body: dict[str, Any] = {"model": model, "max_tokens": 4096, "temperature": req.temperature,
                                "messages": [{"role": "assistant" if t["role"] == "model" else "user", "content": t["text"]} for t in req.turns]}
        if req.system_instruction:
            body["system"] = req.system_instruction
        data = _with_temperature(cred, lambda b: _send(cred, "POST", "/messages", {**_headers(cred), "content-type": "application/json"}, b), body)
        text = "".join(str(b.get("text", "")) for b in data.get("content", []) if isinstance(b, dict) and b.get("type") == "text") if isinstance(data, dict) else ""
        return GenerateResult(text=text, model=str(data.get("model", model)) if isinstance(data, dict) else model)
    body = {"model": model, "messages": _openai_messages(req), "temperature": req.temperature}
    data = _with_temperature(cred, lambda b: _send(cred, "POST", "/chat/completions", _headers(cred), b), body)
    choices = data.get("choices") if isinstance(data, dict) else None
    if not choices or not isinstance(choices, list) or not isinstance(choices[0], dict):
        raise LLMError(f"{spec.name} sent an answer without a reply.", "server")
    return GenerateResult(text=_text_of((choices[0].get("message") or {}).get("content")), model=str(data.get("model", model)))


# --- the server's own key ------------------------------------------------------------------------------------------

_server_lock = threading.Lock()
_server_cache: dict[str, Any] = {}


def server_configured() -> bool:
    s = settings()
    return bool(s.ai_key or s.gemini_api_key or s.ai_provider in ("ollama", "custom"))


def server_credential() -> Credential | None:
    """The server's key (TERRAX_AI_*, or GEMINI_API_KEY), with its provider recognised once and remembered."""
    s = settings()
    if not server_configured():
        return None
    key = s.ai_key or s.gemini_api_key
    provider = s.ai_provider or ("gemini" if not s.ai_key and s.gemini_api_key else "auto")
    model = s.ai_model or (s.gemini_model if provider == "gemini" else "")
    signature = hashlib.sha256(f"{key}|{provider}|{model}|{s.ai_base_url}".encode()).hexdigest()
    with _server_lock:
        hit = _server_cache.get(signature)
        if hit is not None and (isinstance(hit, Credential) or time.monotonic() < hit):
            return hit if isinstance(hit, Credential) else None
        try:
            if provider == "gemini" and model:  # as before: no detection round trip for a configured Gemini key
                cred = make_credential(key, "gemini", model, None, "server")
            else:
                cred = detect(key, provider, s.ai_base_url, model, "server").credential
        except LLMError:
            _server_cache[signature] = time.monotonic() + 300  # try again in 5 minutes, not on every request
            return None
        _server_cache.clear()
        _server_cache[signature] = cred
        return cred


def server_status() -> dict[str, Any]:
    s = settings()
    cred = server_credential() if server_configured() else None
    return {"configured": cred is not None, "provider": cred.provider if cred else None, "providerName": cred.spec.name if cred else None,
            "defaultModel": cred.model if cred else s.gemini_model, "allowPrivate": s.ai_allow_private,
            "providers": [p.public() for p in PROVIDERS.values()]}


# --- limits and fallback -------------------------------------------------------------------------------------------

_cool_lock = threading.Lock()
_cooling: dict[str, float] = {}  # key fingerprint → monotonic time the provider's own limit allows it again


def cooling_for(cred: Credential) -> float:
    with _cool_lock:
        until = _cooling.get(cred.fingerprint, 0.0)
    return max(0.0, until - time.monotonic())


def cool_down(cred: Credential, seconds: float) -> None:
    with _cool_lock:
        _cooling[cred.fingerprint] = time.monotonic() + seconds
        if len(_cooling) > 10_000:
            now = time.monotonic()
            for k in [k for k, v in _cooling.items() if v < now]:
                del _cooling[k]


def ask(chain: list[Credential], req: GenerateRequest, allow: Callable[[Credential], tuple[bool, int]]) -> tuple[GenerateResult, Credential, list[str]]:
    """Asks the first key in the chain that is within its limits and answers; the notes say why earlier ones were skipped.

    `allow` counts the request against the key's own limit. A provider's 429 rests that key for its Retry-After."""
    notes: list[str] = []
    last: LLMError | None = None
    for cred in chain:
        label = f"{cred.spec.name} ({'server key' if cred.source == 'server' else 'your key'})"
        wait = cooling_for(cred)
        if wait > 0:
            notes.append(f"{label}: its rate limit was reached; usable again in {int(wait) + 1} s.")
            last = LLMError(notes[-1], "rate", wait)
            continue
        ok, retry = allow(cred)
        if not ok:
            cap = settings().ai_server_per_minute if cred.source == "server" else settings().ai_per_key_per_minute
            notes.append(f"{label}: at most {cap} requests a minute with this key; try again in {retry} s.")
            last = LLMError(notes[-1], "rate", float(retry))
            continue
        try:
            return generate(cred, req), cred, notes
        except LLMError as e:
            if e.kind == "rate":
                cool_down(cred, e.retry_after or 60.0)
            notes.append(f"{label}: {e}")
            last = e
    raise last or LLMError("No AI key is set up.", "config")
