import os
from pathlib import Path


def _load_dotenv(path=".env"):
    p = Path(path)
    if not p.exists():
        return
    for line in p.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv()


def get(key: str, default: str = "") -> str:
    return os.environ.get(key, default)


def get_list(key: str) -> list[str]:
    return [x.strip() for x in get(key).split(",") if x.strip()]
