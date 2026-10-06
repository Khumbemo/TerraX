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
    os.environ.setdefault("GEMINI_API_KEY", "")
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
