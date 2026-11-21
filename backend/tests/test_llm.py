"""Any provider's AI key (terrax/agents/llm.py, api/agents.py), against stand-in providers (httpx.MockTransport)."""

import base64
import json

import httpx
import pytest

from terrax import ratelimit
from terrax.agents import gemini, llm
from terrax.agents.gemini import GenerateRequest, GenerateResult


class Fake:
    """A stand-in for the providers: routes by host and path; records every request."""

    def __init__(self):
        self.routes: dict[tuple[str, str], object] = {}
        self.seen: list[httpx.Request] = []

    def on(self, host, path, answer):
        self.routes[(host, path)] = answer

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.seen.append(request)
        answer = self.routes.get((request.url.host, request.url.path))
        if answer is None:
            return httpx.Response(404, json={"error": {"message": "no such route"}})
        return answer(request) if callable(answer) else answer


@pytest.fixture()
def fake(monkeypatch):
    f = Fake()
    monkeypatch.setattr(llm, "transport", httpx.MockTransport(f))
    monkeypatch.setattr(llm, "resolver", lambda host, port: {"ai.example.org": ["93.184.216.34"], "inside.example.org": ["10.1.2.3"]}.get(host, []))
    llm._server_cache.clear()
    llm._cooling.clear()
    yield f
    llm._server_cache.clear()
    llm._cooling.clear()


def models(*ids):
    return httpx.Response(200, json={"object": "list", "data": [{"id": i} for i in ids]})


def creds_header(*items):
    return base64.urlsafe_b64encode(json.dumps(list(items)).encode()).decode().rstrip("=")


def test_candidates_by_longest_prefix():
    ids = lambda k: [p.id for p in llm.candidates(k)]
    assert ids("AIzaSyExample0000") == ["gemini"]
    assert ids("sk-ant-api03-xyz") == ["anthropic"]
    assert ids("sk-or-v1-abc") == ["openrouter"]
    assert ids("sk-proj-abc123") == ["openai", "deepseek"]  # a plain sk- could be either: OpenAI first
    assert ids("gsk_abc123") == ["groq"]
    assert ids("xai-abc123") == ["xai"]
    assert ids("0123456789abcdef") == ["mistral", "together"]  # no known prefix


def test_detect_probes_until_a_provider_accepts(fake):
    fake.on("api.openai.com", "/v1/models", httpx.Response(401, json={"error": {"message": "Incorrect API key provided: sk-test-key-1234"}}))
    fake.on("api.deepseek.com", "/models", models("deepseek-reasoner", "deepseek-chat"))
    d = llm.detect("sk-test-key-1234")
    assert d.credential.provider == "deepseek" and d.credential.model == "deepseek-chat" and d.models == ["deepseek-reasoner", "deepseek-chat"]
    assert [r.url.host for r in fake.seen] == ["api.openai.com", "api.deepseek.com"]  # 2 probes, most likely first
    assert all(r.headers["authorization"] == "Bearer sk-test-key-1234" for r in fake.seen)


def test_detect_gemini_lists_chat_models_over_pages(fake):
    def page(request):
        if "pageToken" not in str(request.url):
            return httpx.Response(200, json={"models": [{"name": "models/text-embedding-004", "supportedGenerationMethods": ["embedContent"]},
                                                        {"name": "models/gemini-2.5-pro", "supportedGenerationMethods": ["generateContent"]}],
                                             "nextPageToken": "p/2+"})
        assert request.url.params["pageToken"] == "p/2+"  # sent encoded, read back intact
        return httpx.Response(200, json={"models": [{"name": "models/gemini-2.5-flash", "supportedGenerationMethods": ["generateContent", "countTokens"]}]})

    fake.on("generativelanguage.googleapis.com", "/v1beta/models", page)
    d = llm.detect("AIzaSyTestKey0000000")
    assert d.models == ["gemini-2.5-pro", "gemini-2.5-flash"] and d.credential.model == "gemini-2.5-flash"
    assert fake.seen[0].headers["x-goog-api-key"] == "AIzaSyTestKey0000000"


def test_default_model_without_a_preferred_one():
    together = llm.PROVIDERS["together"]
    assert llm.default_model(together, ["BAAI/bge-large-embed", "meta-llama/Llama-3.3-70B", "meta-llama/Llama-3.1-8B-Instruct-mini"]) == "meta-llama/Llama-3.1-8B-Instruct-mini"
    assert llm.default_model(together, ["whisper-large", "zeta-7b"]) == "zeta-7b"
    assert llm.default_model(llm.PROVIDERS["deepseek"], []) == "deepseek-chat"  # nothing listed: the preferred name
    assert llm.default_model(llm.PROVIDERS["custom"], []) == ""  # the user types it


def test_no_provider_accepts(fake, client):
    fake.on("api.openai.com", "/v1/models", httpx.Response(401, json={}))
    fake.on("api.deepseek.com", "/models", httpx.Response(401, json={}))
    with pytest.raises(llm.LLMError, match="tried OpenAI, DeepSeek") as e:
        llm.detect("sk-wrong-key-000")
    assert e.value.kind == "auth"
    r = client.post("/api/agents/detect", json={}, headers={"X-AI-Key": "sk-wrong-key-000"})
    assert r.status_code == 422 and "No provider accepted" in r.json()["detail"]
    assert client.post("/api/agents/detect", json={}, headers={"X-AI-Key": "has space in it"}).status_code == 400


def test_openai_compatible_chat_and_temperature_retry(fake):
    bodies = []

    def chat(request):
        body = json.loads(request.content)
        bodies.append(body)
        if "temperature" in body:
            return httpx.Response(400, json={"error": {"message": "Unsupported value: 'temperature' does not support 0.4 with this model."}})
        return httpx.Response(200, json={"model": "gpt-x-2026", "choices": [{"message": {"role": "assistant", "content": [{"type": "text", "text": "NDVI is "}, {"type": "text", "text": "a ratio."}]}}]})

    fake.on("api.groq.com", "/openai/v1/chat/completions", chat)
    cred = llm.make_credential("gsk_abcdefgh", "groq", "llama-3.3-70b-versatile")
    req = GenerateRequest(turns=[{"role": "user", "text": "hi"}, {"role": "model", "text": "Hello"}, {"role": "user", "text": "What is NDVI?"}],
                          system_instruction="Be brief.", temperature=0.4)
    res = llm.generate(cred, req)
    assert res.text == "NDVI is a ratio." and res.model == "gpt-x-2026"
    assert [m["role"] for m in bodies[0]["messages"]] == ["system", "user", "assistant", "user"] and bodies[0]["model"] == "llama-3.3-70b-versatile"
    assert len(bodies) == 2 and "temperature" not in bodies[1]  # refused once, then sent without it


def test_anthropic_messages(fake):
    seen = {}

    def msg(request):
        seen.update(headers=dict(request.headers), body=json.loads(request.content))
        return httpx.Response(200, json={"model": "claude-haiku-5-5", "content": [{"type": "text", "text": "Forest loss is "}, {"type": "text", "text": "a drop."}]})

    fake.on("api.anthropic.com", "/v1/messages", msg)
    res = llm.generate(llm.make_credential("sk-ant-test-0000", "anthropic", "claude-haiku-5-5"),
                       GenerateRequest(turns=[{"role": "user", "text": "Explain"}], system_instruction="You are TerraX.", temperature=0.3))
    assert res.text == "Forest loss is a drop."
    assert seen["headers"]["x-api-key"] == "sk-ant-test-0000" and seen["headers"]["anthropic-version"] == "2023-06-01"
    assert seen["body"]["system"] == "You are TerraX." and seen["body"]["max_tokens"] == 4096 and seen["body"]["messages"] == [{"role": "user", "content": "Explain"}]


def test_errors_are_actionable_and_never_show_the_key(fake):
    key = "gsk_secret_value_123"
    fake.on("api.groq.com", "/openai/v1/chat/completions", httpx.Response(429, headers={"Retry-After": "17"}, json={"error": {"message": f"Rate limit for {key}"}}))
    cred = llm.make_credential(key, "groq", "m")
    with pytest.raises(llm.LLMError) as e:
        llm.generate(cred, GenerateRequest(turns=[{"role": "user", "text": "x"}]))
    assert e.value.kind == "rate" and e.value.retry_after == 17 and "17 s" in str(e.value) and key not in str(e.value)
    fake.on("api.groq.com", "/openai/v1/chat/completions", httpx.Response(404, json={"error": {"message": f"model m not found for key {key}"}}))
    with pytest.raises(llm.LLMError) as e:
        llm.generate(cred, GenerateRequest(turns=[{"role": "user", "text": "x"}]))
    assert e.value.kind == "model" and key not in str(e.value) and "***" in str(e.value)
    fake.on("api.groq.com", "/openai/v1/chat/completions", httpx.Response(302, headers={"Location": "http://10.0.0.1/"}))
    with pytest.raises(llm.LLMError, match="does not follow redirects"):
        llm.generate(cred, GenerateRequest(turns=[{"role": "user", "text": "x"}]))
    fake.on("api.groq.com", "/openai/v1/chat/completions", httpx.Response(200, content=b"x" * (llm.MAX_RESPONSE_BYTES + 1)))
    with pytest.raises(llm.LLMError, match="larger than"):
        llm.generate(cred, GenerateRequest(turns=[{"role": "user", "text": "x"}]))
    # Google answers a bad key with 400 API_KEY_INVALID, which is a rejected key, not a bad request.
    fake.on("generativelanguage.googleapis.com", "/v1beta/models", httpx.Response(400, json={"error": {"message": "API key not valid.", "details": [{"reason": "API_KEY_INVALID"}]}}))
    with pytest.raises(llm.LLMError) as e:
        llm.list_models(llm.make_credential("AIzaBadKey000000", "gemini"))
    assert e.value.kind == "auth"


def test_user_typed_addresses_are_checked_and_pinned(fake, monkeypatch):
    fake.on("93.184.216.34", "/v1/models", lambda r: models("my-model") if r.headers["host"] == "ai.example.org" else httpx.Response(400))
    d = llm.detect("tok-12345678", "custom", "https://ai.example.org/v1/")
    assert d.credential.base_url == "https://ai.example.org/v1" and d.credential.model == "my-model"
    sent = fake.seen[-1]
    assert sent.url.host == "93.184.216.34" and sent.headers["host"] == "ai.example.org" and sent.extensions["sni_hostname"] == "ai.example.org"
    # Private, loopback and link-local addresses (here by name and directly), and cloud metadata, are refused by default.
    for url in ("https://inside.example.org/v1", "http://127.0.0.1:11434/v1", "http://169.254.169.254/latest", "http://[::1]:8080/v1", "http://[::ffff:10.0.0.1]/v1"):
        with pytest.raises(llm.LLMError, match="TERRAX_AI_ALLOW_PRIVATE") as e:
            llm.detect("", "custom", url)
        assert e.value.kind == "config"
    with pytest.raises(llm.LLMError, match="unencrypted"):
        llm.detect("tok-12345678", "custom", "http://ai.example.org/v1")
    with pytest.raises(llm.LLMError, match="could not be found"):
        llm.detect("tok-12345678", "custom", "https://nowhere.example.org/v1")
    for bad in ("ftp://ai.example.org", "https://user:pw@ai.example.org/v1", "https://ai.example.org/v1?x=1", "https://ai.example.org:99999/v1"):
        with pytest.raises(llm.LLMError):
            llm.make_credential("tok-12345678", "custom", None, bad)
    # A local Ollama, keyless, once the administrator allows private addresses; its model list without /models.
    monkeypatch.setenv("TERRAX_AI_ALLOW_PRIVATE", "true")
    fake.on("127.0.0.1", "/v1/models", models("llama3.2:3b", "nomic-embed-text"))
    d = llm.detect("", "ollama", "http://127.0.0.1:11434/v1")
    assert d.credential.provider == "ollama" and d.credential.model == "llama3.2:3b" and "authorization" not in fake.seen[-1].headers
    d = llm.detect("", "custom", "http://127.0.0.1:9000/openai")  # no /models there: the model is typed by hand
    assert d.models == [] and d.credential.model == ""


def test_credentials_header():
    h = creds_header({"key": "gsk_abcdefgh", "provider": "groq", "model": "llama-3.3-70b-versatile"}, {"key": "AIzaSyTest000000", "provider": "gemini"})
    a, b = llm.parse_credentials(h)
    assert (a.provider, a.model, b.provider) == ("groq", "llama-3.3-70b-versatile", "gemini") and a.fingerprint != b.fingerprint
    assert len(a.fingerprint) == 24 and "gsk_" not in a.fingerprint
    for bad in ("%%%", creds_header({"key": "x" * 9, "provider": "nope"}), creds_header(*[{"key": "gsk_abcdefgh", "provider": "groq"}] * 4),
                creds_header({"key": "AIza bad", "provider": "gemini"}), creds_header({"provider": "groq"}), creds_header({"key": "k" * 9, "provider": "gemini", "model": "../x"})):
        with pytest.raises(llm.LLMError):
            llm.parse_credentials(bad)


def test_chat_falls_back_along_the_chain(fake, client, monkeypatch):
    """The user's key is rejected; the server's Gemini key answers; the note says so. Then both fail: built-in answer."""
    fake.on("api.groq.com", "/openai/v1/chat/completions", httpx.Response(401, json={"error": {"message": "Invalid API Key"}}))
    monkeypatch.setenv("GEMINI_API_KEY", "AIzaServerKey00000")
    calls = []

    def fake_gemini(key, req):
        calls.append((key, req.model, req.use_search))
        return GenerateResult(text="Answer from Gemini.", model=req.model)

    monkeypatch.setattr(gemini, "generate", fake_gemini)
    h = {"X-AI-Credentials": creds_header({"key": "gsk_userkey123", "provider": "groq", "model": "llama-3.3-70b-versatile"})}
    j = client.post("/api/agents/chat", json={"question": "what is ndvi"}, headers=h).json()
    assert j["engine"] == "gemini" and j["providerName"] == "Google Gemini" and "Answer from Gemini." in j["text"]
    assert "Groq (your key): Groq rejected the API key" in j["text"] and calls == [("AIzaServerKey00000", "gemini-2.5-flash", True)]
    assert client.get("/api/agents/status").json()["provider"] == "gemini"

    def broken(key, req):
        raise gemini.GeminiError("The Gemini API rejected the API key.", "auth")

    monkeypatch.setattr(gemini, "generate", broken)
    j = client.post("/api/agents/chat", json={"question": "what is ndvi"}, headers=h).json()
    assert j["engine"] == "built-in" and "The AI request failed" in j["text"] and "NDVI" in j["text"]
    r = client.post("/api/agents/interpret", json={"toolName": "Forest loss", "markdown": "x"}, headers=h)
    assert r.status_code == 502 and "rejected" in r.json()["detail"]


def test_each_key_has_its_own_limit(fake, client, monkeypatch):
    monkeypatch.setenv("TERRAX_RATE_LIMITS", "true")
    monkeypatch.setenv("TERRAX_RATE_LIMIT_STORE", "memory")
    monkeypatch.setenv("TERRAX_AI_PER_KEY_PER_MINUTE", "2")
    monkeypatch.setattr(ratelimit, "_now", lambda: 1_000_020.0)  # mid-window
    ratelimit._memory.reset()
    fake.on("api.groq.com", "/openai/v1/chat/completions", httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]}))
    fake.on("api.mistral.ai", "/v1/chat/completions", httpx.Response(200, json={"choices": [{"message": {"content": "from mistral"}}]}))
    one = {"X-AI-Credentials": creds_header({"key": "gsk_keyone123", "provider": "groq", "model": "m"})}
    two = {"X-AI-Credentials": creds_header({"key": "gsk_keytwo123", "provider": "groq", "model": "m"}, {"key": "mistralkey123", "provider": "mistral", "model": "m"})}
    try:
        assert [client.post("/api/agents/chat", json={"question": "q"}, headers=one).json()["engine"] for _ in range(3)] == ["groq", "groq", "built-in"]
        j = client.post("/api/agents/chat", json={"question": "q"}, headers=two).json()  # another key: its own budget
        assert j["engine"] == "groq"
        client.post("/api/agents/chat", json={"question": "q"}, headers=two)
        j = client.post("/api/agents/chat", json={"question": "q"}, headers=two).json()  # key two is used up: the next key answers
        assert j["engine"] == "mistral" and "at most 2 requests a minute with this key" in j["text"]
        # A provider's own 429 rests that key for its Retry-After, without asking the provider again meanwhile.
        fake.on("api.groq.com", "/openai/v1/chat/completions", httpx.Response(429, headers={"Retry-After": "30"}, json={}))
        three = {"X-AI-Credentials": creds_header({"key": "gsk_keythree1", "provider": "groq", "model": "m"})}
        r = client.post("/api/agents/interpret", json={"toolName": "t", "markdown": "x"}, headers=three)
        assert r.status_code == 429 and r.headers["retry-after"] == "30" and "This key's rate limit" in r.json()["detail"]
        before = len(fake.seen)
        r = client.post("/api/agents/interpret", json={"toolName": "t", "markdown": "x"}, headers=three)
        assert r.status_code == 429 and "usable again in" in r.json()["detail"] and len(fake.seen) == before
    finally:
        ratelimit._memory.reset()


def test_status_and_detect_limits(fake, client, monkeypatch):
    st = client.get("/api/agents/status").json()
    assert st["configured"] is False and {p["id"] for p in st["providers"]} >= {"gemini", "anthropic", "openai", "groq", "ollama", "custom"}
    assert client.post("/api/agents/interpret", json={"toolName": "x", "markdown": "y"}).status_code == 503
    monkeypatch.setenv("TERRAX_RATE_LIMITS", "true")
    monkeypatch.setenv("TERRAX_RATE_LIMIT_STORE", "memory")
    monkeypatch.setattr(ratelimit, "_now", lambda: 2_000_020.0)
    ratelimit._memory.reset()
    fake.on("api.groq.com", "/openai/v1/models", models("llama-3.3-70b-versatile"))
    try:
        codes = [client.post("/api/agents/detect", json={}, headers={"X-AI-Key": "gsk_abcdefgh"}).status_code for _ in range(11)]
        assert codes == [200] * 10 + [429]
    finally:
        ratelimit._memory.reset()


def test_server_key_for_any_provider(fake, client, monkeypatch):
    monkeypatch.setenv("TERRAX_AI_KEY", "gsk_serverkey12")
    fake.on("api.groq.com", "/openai/v1/models", models("llama-3.1-8b-instant", "llama-3.3-70b-versatile"))
    fake.on("api.groq.com", "/openai/v1/chat/completions", httpx.Response(200, json={"model": "llama-3.3-70b-versatile", "choices": [{"message": {"content": "Server answer."}}]}))
    st = client.get("/api/agents/status").json()
    assert st["configured"] and st["provider"] == "groq" and st["defaultModel"] == "llama-3.3-70b-versatile"
    j = client.post("/api/agents/chat", json={"question": "q"}).json()
    assert j["engine"] == "groq" and j["text"] == "Server answer."
    probes = sum(r.url.path.endswith("/models") for r in fake.seen)
    client.post("/api/agents/chat", json={"question": "q"})
    assert sum(r.url.path.endswith("/models") for r in fake.seen) == probes  # recognised once, remembered
    assert client.get("/api/health").json()["ai"] is True
    # The older X-Gemini-Key header still works, before the server's key.
    monkeypatch.setattr(gemini, "generate", lambda key, req: GenerateResult(text=f"Gemini {req.model}", model=req.model))
    j = client.post("/api/agents/chat", json={"question": "q", "model": "gemini-2.5-pro"}, headers={"X-Gemini-Key": "AIzaOldClient000"}).json()
    assert j["engine"] == "gemini" and j["text"] == "Gemini gemini-2.5-pro"


def test_an_unreadable_browser_key_never_breaks_the_chat(fake, client, monkeypatch):
    j = client.post("/api/agents/chat", json={"question": "what is ndvi"}, headers={"X-AI-Credentials": "%%%"}).json()
    assert j["engine"] == "built-in" and "Your AI key could not be used" in j["text"] and "NDVI" in j["text"]
    assert client.post("/api/agents/interpret", json={"toolName": "t", "markdown": "x"}, headers={"X-AI-Credentials": "%%%"}).status_code == 400
    monkeypatch.setenv("GEMINI_API_KEY", "AIzaServerKey00000")
    monkeypatch.setattr(gemini, "generate", lambda key, req: GenerateResult(text="Server answer.", model=req.model))
    j = client.post("/api/agents/chat", json={"question": "q"}, headers={"X-Gemini-Key": "bad"}).json()  # too short to be a key
    assert j["engine"] == "gemini" and "Your AI key could not be used" in j["text"] and "Server answer." in j["text"]


def test_the_servers_key_is_shared_so_it_has_its_own_cap(fake, client, monkeypatch):
    monkeypatch.setenv("TERRAX_RATE_LIMITS", "true")
    monkeypatch.setenv("TERRAX_RATE_LIMIT_STORE", "memory")
    monkeypatch.setenv("TERRAX_AI_PER_KEY_PER_MINUTE", "1")
    monkeypatch.setenv("TERRAX_AI_KEY", "gsk_serverkey12")
    monkeypatch.setenv("TERRAX_AI_PROVIDER", "groq")
    monkeypatch.setenv("TERRAX_AI_MODEL", "m")
    monkeypatch.setattr(ratelimit, "_now", lambda: 3_000_020.0)
    ratelimit._memory.reset()
    fake.on("api.groq.com", "/openai/v1/models", models("m"))
    fake.on("api.groq.com", "/openai/v1/chat/completions", httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]}))
    try:
        # A user key's cap (1 a minute) does not apply to the server's key, which every user shares: no cap by default.
        assert [client.post("/api/agents/chat", json={"question": "q"}).json()["engine"] for _ in range(4)] == ["groq"] * 4
        monkeypatch.setenv("TERRAX_AI_SERVER_PER_MINUTE", "5")
        engines = [client.post("/api/agents/chat", json={"question": "q"}).json()["engine"] for _ in range(6)]
        assert engines == ["groq"] * 5 + ["built-in"]
    finally:
        ratelimit._memory.reset()
