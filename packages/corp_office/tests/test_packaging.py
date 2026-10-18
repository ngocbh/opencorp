"""The sdist and wheel published to PyPI carry the office and its package data, and nothing else."""

import os
import shutil
import subprocess
import tarfile
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / "packages/corp_office/src"
UV = os.environ.get("UV") or shutil.which("uv")


@pytest.fixture(scope="module")
def dist(tmp_path_factory: pytest.TempPathFactory) -> Path:
    if UV is None:
        pytest.skip("uv is not installed")
    out = tmp_path_factory.mktemp("dist")
    # Wheel built from the sdist, as `uv build` does by default, so a file the sdist drops is caught too.
    subprocess.run([UV, "build", "--no-sources", "-q", "--out-dir", str(out), str(ROOT)], check=True, timeout=120)
    return out


def package_data() -> set[str]:
    """Every non-Python file under ``opencorp/``, as a path from ``src``."""
    return {
        p.relative_to(SRC).as_posix()
        for p in (SRC / "opencorp").rglob("*")
        if p.is_file() and p.suffix not in {".py", ".pyc"} and "__pycache__" not in p.parts
    }


def test_package_data_is_found():
    data = package_data()
    assert "opencorp/store/migrations/0001_initial.sql" in data
    assert "opencorp/install/flows/init.yaml" in data
    assert "opencorp/company_template/company.yaml" in data


def test_the_wheel_carries_the_package_data(dist: Path):
    (wheel,) = dist.glob("opencorp-*.whl")
    names = set(zipfile.ZipFile(wheel).namelist())
    assert package_data() <= names
    assert "opencorp/daemon/main.py" in names


def test_the_sdist_holds_only_the_office(dist: Path):
    (sdist,) = dist.glob("opencorp-*.tar.gz")
    with tarfile.open(sdist) as tar:
        # Drop the leading "opencorp-<version>/".
        names = {n.split("/", 1)[1] for n in tar.getnames() if "/" in n}
    tops = {n.split("/", 2)[1] for n in names if n.startswith("packages/")}
    assert tops == {"corp_office"}
    assert {n for n in names if n.startswith("packages/corp_office/") and not n.startswith("packages/corp_office/src/")} == set()
