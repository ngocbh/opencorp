"""The office as a systemd user service in ``~/.config/systemd/user``."""

from pathlib import Path

from agent_corp.install.files import write_if_changed
from agent_corp.install.launch import Host, Launch, ServiceError


def unit_name(launch: Launch) -> str:
    return f"agent-corp-{launch.name}.service"


def unit_path(launch: Launch, host: Host) -> Path:
    return host.user_home / ".config" / "systemd" / "user" / unit_name(launch)


def _plain(value: str) -> str:
    """``value`` for a unit setting: ``%`` is systemd's specifier prefix, so it is doubled."""
    if "\n" in value:
        raise ValueError(f"a newline can't go in a systemd unit: {value!r}")
    return value.replace("%", "%%")


def _quoted(value: str) -> str:
    return '"' + _plain(value).replace("\\", "\\\\").replace('"', '\\"') + '"'


def _arg(value: str) -> str:
    """One ``ExecStart`` word: ``$`` doubled so systemd doesn't expand it, quoted only if needed."""
    if value == "" or any(c in value for c in ' \t"\'\\;'):
        return _quoted(value).replace("$", "$$")
    return _plain(value).replace("$", "$$")


def unit(launch: Launch) -> str:
    """The unit: the daemon, restarted only when it fails, output appended to the log.

    A daemon that fails five times in two minutes is left stopped rather than restarted forever.
    """
    env = "".join(f"Environment={_quoted(f'{k}={v}')}\n" for k, v in sorted(launch.env.items()))
    log = _plain(str(launch.log))
    return (
        "[Unit]\n"
        f"Description=agent-corp office at {_plain(str(launch.home))}\n"
        "StartLimitIntervalSec=120\n"
        "StartLimitBurst=5\n"
        "\n"
        "[Service]\n"
        "Type=simple\n"
        f"WorkingDirectory={_plain(str(launch.cwd))}\n"
        f"{env}"
        f"ExecStart={' '.join(_arg(a) for a in launch.argv)}\n"
        f"StandardOutput=append:{log}\n"
        f"StandardError=append:{log}\n"
        "Restart=on-failure\n"
        "RestartSec=5\n"
        "\n"
        "[Install]\n"
        "WantedBy=default.target\n"
    )


def not_enabled(launch: Launch, host: Host) -> str | None:
    """Why this office's unit isn't enabled (systemctl's own words), or None if it is."""
    done = host.run(["systemctl", "--user", "is-enabled", unit_name(launch)])
    if done.returncode == 0:
        return None
    return done.stderr.strip() or done.stdout.strip() or f"systemctl --user is-enabled exited {done.returncode}"


def install(launch: Launch, host: Host) -> None:
    """Write the unit, enable it, and (re)start it.

    Raises ``ServiceError`` if a path can't go in a unit (a newline), or if ``systemctl
    --user`` is missing, has no user bus, or refuses; the unit and its
    ``default.target.wants`` link are then removed.
    """
    path = unit_path(launch, host)
    name = unit_name(launch)
    try:
        text = unit(launch)
    except ValueError as exc:
        raise ServiceError(str(exc)) from None
    changed = write_if_changed(path, text.encode())
    for verb in ("daemon-reload", "enable", "restart" if changed else "start"):
        argv = ["systemctl", "--user", verb] + ([] if verb == "daemon-reload" else [name])
        done = host.run(argv)
        if done.returncode != 0:
            path.unlink(missing_ok=True)
            (path.parent / "default.target.wants" / name).unlink(missing_ok=True)
            raise ServiceError(f"systemctl --user {verb} failed: {done.stderr.strip()}")


def start(launch: Launch, host: Host) -> None:
    """Start the installed unit if it isn't running."""
    done = host.run(["systemctl", "--user", "start", unit_name(launch)])
    if done.returncode != 0:
        raise ServiceError(f"systemctl --user start failed: {done.stderr.strip()}")
