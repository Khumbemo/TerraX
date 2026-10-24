"""S3-compatible object storage behind the storage folder (AWS S3, Cloudflare R2, Backblaze B2, MinIO, Wasabi, …).

With TERRAX_S3_BUCKET set, every upload and every finished job's results are copied to the bucket, and the storage
folder becomes a cache: a file or result that is not on this machine's disk (after a restart on a host whose disk does
not survive one, or on another API or worker machine) is fetched from the bucket when it is first needed. Cached copies
nobody has used for TERRAX_S3_CACHE_HOURS are dropped from the disk by the hourly clean-up; the bucket keeps them until
they expire like any other upload or result.

Keys mirror the folder layout (``<prefix>files/<id>/…``, ``<prefix>jobs/<id>/…``). Credentials come from the usual
AWS variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, or an instance role); TERRAX_S3_ENDPOINT points at a service
other than AWS.
"""

from __future__ import annotations

import os
import uuid
from functools import lru_cache
from pathlib import Path
from typing import Any

from .config import settings


def enabled() -> bool:
    return bool(settings().s3_bucket)


@lru_cache(maxsize=4)
def _client(endpoint: str, region: str, path_style: bool) -> Any:
    import boto3
    from botocore.config import Config

    cfg = Config(retries={"max_attempts": 5, "mode": "standard"}, s3={"addressing_style": "path" if path_style else "auto"})
    return boto3.client("s3", endpoint_url=endpoint or None, region_name=region or None, config=cfg)


def client() -> Any:
    s = settings()
    return _client(s.s3_endpoint, s.s3_region, s.s3_path_style)


def key(rel: str) -> str:
    """The object key for a path relative to the storage folder."""
    return settings().s3_prefix + rel.replace(os.sep, "/").lstrip("/")


def _rel(path: Path) -> str:
    from .storage import root

    return path.resolve().relative_to(root().resolve()).as_posix()


def _missing(err: Exception) -> bool:
    from botocore.exceptions import ClientError

    return isinstance(err, ClientError) and str(err.response.get("Error", {}).get("Code")) in ("404", "NoSuchKey", "NotFound")


def upload(path: Path) -> None:
    """Copies one file under the storage folder to the bucket (multipart for large files)."""
    client().upload_file(str(path), settings().s3_bucket, key(_rel(path)))


def upload_tree(folder: Path, skip: tuple[str, ...] = ()) -> int:
    """Copies every file in a folder (recursively) to the bucket; returns how many."""
    n = 0
    for p in sorted(folder.rglob("*")):
        if p.is_file() and p.name not in skip and not p.name.endswith(".tmp"):
            upload(p)
            n += 1
    return n


def download(rel: str) -> bool:
    """Fetches one object into the storage folder at its path; False when the bucket does not have it."""
    from .storage import root

    dest = root() / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f"{dest.name}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        client().download_file(settings().s3_bucket, key(rel), str(tmp))
    except Exception as err:
        tmp.unlink(missing_ok=True)
        if _missing(err):
            return False
        raise
    os.replace(tmp, dest)  # readers never see a half-downloaded file
    return True


def read_bytes(rel: str) -> bytes | None:
    """One object's content without storing it (None when the bucket does not have it)."""
    try:
        return bytes(client().get_object(Bucket=settings().s3_bucket, Key=key(rel))["Body"].read())
    except Exception as err:
        if _missing(err):
            return None
        raise


def put_bytes(rel: str, data: bytes) -> None:
    client().put_object(Bucket=settings().s3_bucket, Key=key(rel), Body=data)


def list_keys(rel_prefix: str) -> list[str]:
    """Keys (relative to the storage folder) under a prefix."""
    s = settings()
    out: list[str] = []
    for page in client().get_paginator("list_objects_v2").paginate(Bucket=s.s3_bucket, Prefix=key(rel_prefix)):
        out += [o["Key"][len(s.s3_prefix):] for o in page.get("Contents", [])]
    return out


def delete_tree(rel_folder: str) -> int:
    """Deletes every object under a folder; returns how many."""
    keys = list_keys(rel_folder.rstrip("/") + "/")
    for i in range(0, len(keys), 1000):  # DeleteObjects takes at most 1000 keys
        client().delete_objects(Bucket=settings().s3_bucket, Delete={"Objects": [{"Key": key(k)} for k in keys[i : i + 1000]], "Quiet": True})
    return len(keys)


def delete(rel: str) -> None:
    client().delete_object(Bucket=settings().s3_bucket, Key=key(rel))


def ping() -> bool:
    try:
        client().head_bucket(Bucket=settings().s3_bucket)
        return True
    except Exception:
        return False
