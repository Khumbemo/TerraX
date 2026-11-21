import os
import shutil
import tempfile
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parent.parent
SAMPLES = BACKEND / "data" / "samples"


@pytest.fixture(autouse=True, scope="session")
def _env():
    tmp = tempfile.mkdtemp(prefix="terrax-test-")
    os.environ["TERRAX_STORAGE"] = tmp
    os.environ["TERRAX_EAGER"] = "true"
    os.environ["TERRAX_RATE_LIMITS"] = "false"  # tests run many jobs a minute; test_accounts checks the limits on their own
    for name in ("GEMINI_API_KEY", "GEMINI_MODEL", "TERRAX_AI_KEY", "TERRAX_AI_PROVIDER", "TERRAX_AI_MODEL", "TERRAX_AI_BASE_URL", "TERRAX_AI_ALLOW_PRIVATE", "TERRAX_AI_PER_KEY_PER_MINUTE", "TERRAX_AI_SERVER_PER_MINUTE"):
        os.environ.pop(name, None)  # a developer's own AI settings must not change the tests
    yield
    shutil.rmtree(tmp, ignore_errors=True)


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient

    from terrax.api.main import app

    return TestClient(app)


@pytest.fixture()
def sample():
    return lambda name: SAMPLES / name
