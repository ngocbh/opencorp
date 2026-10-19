"""The ids that keep the web app and the office in step: the ``api`` compatibility key and the app's build."""

from pathlib import Path

CHECKOUT = Path(__file__).resolve().parents[5]
"""The checkout this code runs from (``packages/corp_office/src/opencorp/hq`` up five)."""
