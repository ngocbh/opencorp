"""Profiles: each person's profile.md in the company clone, and (later) how they learn."""

from agent_corp.profile.store import EMPTY_BLOB, GitProfileStore, blob_id, commit_message

__all__ = ["EMPTY_BLOB", "GitProfileStore", "blob_id", "commit_message"]
