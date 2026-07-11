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
CORE_CONTEXT_SOURCE = SCRIPT_DIR / "codex-core-discipline-turn-context.py"
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


def managed_hooks_document(codex_home: Path, include_graphify: bool) -> bytes:
    core_context = codex_home / "hooks/core-discipline/codex-core-discipline-turn-context.py"
    user_hooks = [{
        "type": "command",
        "command": f'/usr/bin/python3 "{core_context}"',
        "timeout": 5,
        "statusMessage": "Loading Codex core work contract",
    }]
    hooks = {"UserPromptSubmit": [{"hooks": user_hooks}]}
    if include_graphify:
        policy = codex_home / "hooks/graphify/codex-pre-tool-use-policy.py"
        graph_context = codex_home / "hooks/graphify/codex-graphify-turn-context.py"
        user_hooks.append({
            "type": "command",
            "command": f'/usr/bin/python3 "{graph_context}"',
            "timeout": 5,
            "statusMessage": "Loading graphify development contract",
        })
        policy_hook = {
            "type": "command",
            "command": f'/usr/bin/python3 "{policy}"',
            "timeout": 10,
        }
        hooks["PreToolUse"] = [
            {
                "matcher": "^Bash$",
                "hooks": [{**policy_hook, "statusMessage": "Checking canonical graphify first"}],
            },
            {
                "matcher": "^(apply_patch|Edit|Write)$",
                "hooks": [{**policy_hook, "statusMessage": "Checking canonical graphify before edit"}],
            },
            {
                "matcher": "^mcp__filesystem__.*$",
                "hooks": [{**policy_hook, "statusMessage": "Checking canonical graphify before filesystem access"}],
            },
        ]
    return (json.dumps({"hooks": hooks}, indent=2, sort_keys=True) + "\n").encode("utf-8")

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
        unsupported = sorted(set(bundles) - {"core-discipline", "graphify"})
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

        hooks_path = codex_home / "hooks.json"
        rendered_hooks = managed_hooks_document(codex_home, "graphify" in bundles)
        if hooks_path.exists() and hooks_path.read_bytes() != rendered_hooks:
            raise ValueError("target CODEX_HOME/hooks.json already contains unmanaged hooks")

        installed = []
        if "core-discipline" in bundles:
            core_target = codex_home / "hooks/core-discipline/codex-core-discipline-turn-context.py"
            atomic_write(core_target, CORE_CONTEXT_SOURCE.read_bytes())
            installed.append("core-discipline")

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
                    "--skip-hooks",
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

        atomic_write(hooks_path, rendered_hooks)

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
