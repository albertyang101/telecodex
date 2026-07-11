#!/usr/bin/env python3
"""Install the reviewed read-only graphify bundle for a Codex Developer Bot."""

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
MANIFEST_PATH = SCRIPT_DIR / "codex-graphify-bundle.json"
DEFAULT_GRAPH_ROOT = Path(
    os.environ.get(
        "CODEX_GRAPHIFY_GRAPH_ROOT",
        "~/personas/_shared/graphify/graphs",
    )
).expanduser().resolve()


def is_within(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def atomic_write(path: Path, data: bytes, mode: int) -> None:
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
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def load_manifest() -> dict:
    raw = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    if raw.get("version") != 1 or not isinstance(raw.get("files"), list):
        raise ValueError("invalid graphify bundle manifest")
    return raw


def source_bytes(entry: dict) -> bytes:
    source = SCRIPT_DIR.parent / entry["source"]
    data = source.read_bytes()
    if digest(data) != entry["sha256"]:
        raise ValueError(f"bundle source hash mismatch: {entry['source']}")
    return data


def hooks_document(policy: Path, turn_context: Path) -> bytes:
    policy_command = f'/usr/bin/python3 "{policy}"'
    context_command = f'/usr/bin/python3 "{turn_context}"'
    document = {
        "hooks": {
            "PreToolUse": [
                {
                    "matcher": "^Bash$",
                    "hooks": [{
                        "type": "command",
                        "command": policy_command,
                        "timeout": 10,
                        "statusMessage": "Checking canonical graphify first",
                    }],
                },
                {
                    "matcher": "^(apply_patch|Edit|Write)$",
                    "hooks": [{
                        "type": "command",
                        "command": policy_command,
                        "timeout": 10,
                        "statusMessage": "Checking canonical graphify before edit",
                    }],
                },
                {
                    "matcher": "^mcp__filesystem__.*$",
                    "hooks": [{
                        "type": "command",
                        "command": policy_command,
                        "timeout": 10,
                        "statusMessage": "Checking canonical graphify before filesystem access",
                    }],
                },
            ],
            "UserPromptSubmit": [
                {
                    "hooks": [{
                        "type": "command",
                        "command": context_command,
                        "timeout": 5,
                        "statusMessage": "Loading graphify development contract",
                    }],
                }
            ],
        }
    }
    return (json.dumps(document, indent=2, sort_keys=True) + "\n").encode("utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--codex-home", required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--role", required=True)
    args = parser.parse_args()

    if args.role != "developer":
        print("graphify bundle is for the developer role only", file=sys.stderr)
        return 2

    codex_home = Path(args.codex_home).expanduser().resolve()
    workspace = Path(args.workspace).expanduser().resolve()
    graph_root = DEFAULT_GRAPH_ROOT
    if is_within(codex_home, graph_root) or is_within(workspace, graph_root):
        print("installer must not target the shared graph root", file=sys.stderr)
        return 2

    try:
        manifest = load_manifest()
        destinations = {
            "codex_home": codex_home,
            "workspace": workspace,
        }
        policy = workspace / ".codex/hooks/codex-pre-tool-use-policy.py"
        turn_context = workspace / ".codex/hooks/codex-graphify-turn-context.py"
        hooks_path = workspace / ".codex/hooks.json"
        rendered_hooks = hooks_document(policy, turn_context)
        if hooks_path.exists() and hooks_path.read_bytes() != rendered_hooks:
            raise ValueError("target .codex/hooks.json already contains unmanaged hooks")

        installed = {}
        for entry in manifest["files"]:
            base = destinations[entry["root"]]
            target = base / entry["target"]
            data = source_bytes(entry)
            atomic_write(target, data, int(entry["mode"], 8))
            installed[str(target)] = digest(data)

        atomic_write(hooks_path, rendered_hooks, 0o600)
        installed[str(hooks_path)] = digest(rendered_hooks)

        receipt = {
            "version": 1,
            "role": "developer",
            "files": dict(sorted(installed.items())),
        }
        receipt_data = (
            json.dumps(receipt, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8")
        atomic_write(workspace / ".codex/graphify-install.json", receipt_data, 0o600)
    except (KeyError, OSError, ValueError, json.JSONDecodeError) as exc:
        print(str(exc), file=sys.stderr)
        return 2

    print("installed Codex Developer graphify bundle")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
