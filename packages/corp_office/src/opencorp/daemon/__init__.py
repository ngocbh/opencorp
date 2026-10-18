"""The office daemon: a Starlette app on a unix socket over the store and the company repo."""

from opencorp.daemon.app import Office, OfficePaths, create_app

__all__ = ["Office", "OfficePaths", "create_app"]
