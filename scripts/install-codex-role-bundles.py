#!/usr/bin/env python3
"""Install reviewed default bundles for one Codex Bot builder role."""

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
MANIFEST_PATH = SCRIPT_DIR / "codex-bot-role-bundles.json"
GRAPHIFY_INSTALLER = SCRIPT_DIR / "install-codex-graphify-bundle.py"
DEFAULT_GRAPH_ROOT = Path(
    os.environ.get(
        "CODEX_GRAPHIFY_GRAPH_ROOT",
        "~/personas/_shared/graphify/graphs",
    )
).expanduser().resolve()


def is_within(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary_name = tempfile.mkstemp(
        prefix=path.name + ".",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--codex-home", required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--role", required=True)
    args = parser.parse_args()

    try:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        roles = manifest.get("roles", {})
        role = roles.get(args.role)
        if manifest.get("version") != 1 or not isinstance(role, dict):
            raise ValueError(f"unknown Codex Bot role: {args.role}")
        bundles = role.get("default_bundles")
        if not isinstance(bundles, list) or not all(
            isinstance(bundle, str) for bundle in bundles
        ):
            raise ValueError(f"invalid bundle contract for role: {args.role}")
        unsupported = sorted(set(bundles) - {"graphify"})
        if unsupported:
            raise ValueError(
                "unsupported default bundle(s): " + ", ".join(unsupported)
            )

        codex_home = Path(args.codex_home).expanduser().resolve()
        workspace = Path(args.workspace).expanduser().resolve()
        if is_within(codex_home, DEFAULT_GRAPH_ROOT) or is_within(
            workspace, DEFAULT_GRAPH_ROOT
        ):
            raise ValueError("role bundle installer must not target shared graph root")

        installed = []
        if "graphify" in bundles:
            result = subprocess.run(
                [
                    sys.executable,
                    str(GRAPHIFY_INSTALLER),
                    "--codex-home",
                    str(codex_home),
                    "--workspace",
                    str(workspace),
                    "--role",
                    "developer",
                ],
                check=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            if result.returncode != 0:
                if result.stdout:
                    sys.stdout.write(result.stdout)
                if result.stderr:
                    sys.stderr.write(result.stderr)
                return result.returncode
            installed.append("graphify")

        receipt = {
            "version": 1,
            "role": args.role,
            "installed_bundles": installed,
        }
        atomic_write(
            workspace / ".codex/role-bundles.json",
            (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode("utf-8"),
        )
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(str(exc), file=sys.stderr)
        return 2

    print(f"installed default bundles for Codex Bot role {args.role}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
