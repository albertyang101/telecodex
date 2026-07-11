#!/usr/bin/env python3
import json
import os
import re
import shlex
import shutil
import stat
import subprocess
import sys
import time
import hashlib
from typing import Optional

BLOCKED_COMMANDS = {
    "kill",
    "killall",
    "launchctl",
    "osascript",
    "pkill",
    "reboot",
    "shutdown",
    "sudo",
}

TRANSPARENT_WRAPPERS = {
    "arch",
    "builtin",
    "command",
    "env",
    "exec",
    "ionice",
    "nice",
    "noglob",
    "nohup",
    "setsid",
    "time",
    "timeout",
}

FAIL_CLOSED_COMMANDS = {
    "alias",
    "eval",
    "hash",
    "parallel",
    "shopt",
    "source",
    "trap",
    "xargs",
}

CONTROL_FLOW_KEYWORDS = {
    "!",
    "case",
    "coproc",
    "for",
    "function",
    "if",
    "select",
    "until",
    "while",
}

SHELL_WRAPPERS = {
    "bash",
    "sh",
    "zsh",
}

SEPARATORS = {";", "&&", "||", "|", "("}
SHELL_PUNCTUATION = set(";&|(){}")
ASSIGNMENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=.*$")
REDIRECTION_RE = re.compile(r"^(\d*)?(>>?|<<?|<>|>&|<&|&>).*$")
TIMEOUT_DURATION_RE = re.compile(r"^\d+(\.\d+)?[smhd]?$")


GRAPHIFY_SUBCOMMANDS = {"explain", "query", "affected"}
CODE_EDIT_TOOLS = {"apply_patch", "Edit", "Write"}
FILESYSTEM_TOOL_PREFIX = "mcp__filesystem__"
CONTROL_DOC_NAMES = {"AGENTS.md", "CURRENT_HANDOFF.md", "SKILL.md"}
DOC_DIR_NAMES = {"docs", "logs"}
DOC_SUFFIXES = {".md", ".txt", ".log", ".jsonl", ".rst"}
CODE_DIR_NAMES = {"app", "bin", "config", "launchd", "scripts", "src", "test", "tests", "tools"}
CODE_SUFFIXES = {
    ".c", ".cc", ".cpp", ".css", ".go", ".h", ".hpp", ".html", ".java",
    ".js", ".jsx", ".kt", ".mjs", ".php", ".py", ".rb", ".rs", ".sh",
    ".sql", ".svelte", ".swift", ".toml", ".ts", ".tsx", ".vue", ".yaml", ".yml",
}
MARKER_TTL_SECONDS = 24 * 60 * 60


def canonical_graph_root() -> str:
    return os.path.realpath(
        os.path.expanduser(
            os.environ.get(
                "CODEX_GRAPHIFY_GRAPH_ROOT",
                "~/personas/_shared/graphify/graphs",
            )
        )
    )


def graphify_bin() -> str:
    return os.path.realpath(
        os.path.expanduser(
            os.environ.get("CODEX_GRAPHIFY_BIN", "~/.local/bin/graphify")
        )
    )


def repo_map_file() -> str:
    override = os.environ.get("CODEX_GRAPHIFY_REPO_MAP_FILE")
    if override:
        return os.path.realpath(os.path.expanduser(override))

    codex_home = os.environ.get("CODEX_HOME")
    if codex_home:
        installed = os.path.join(
            os.path.realpath(os.path.expanduser(codex_home)),
            "skills",
            "graphify",
            "references",
            "repo-map.json",
        )
        if os.path.isfile(installed):
            return installed

    return os.path.join(
        os.path.dirname(os.path.realpath(__file__)),
        "codex-graphify-skill",
        "references",
        "repo-map.json",
    )


def graph_catalog() -> dict[str, str]:
    root = canonical_graph_root()
    try:
        names = os.listdir(root)
    except OSError:
        return {}
    return {
        name: os.path.realpath(os.path.join(root, name, "graph.json"))
        for name in names
        if os.path.isfile(os.path.join(root, name, "graph.json"))
    }


def load_repo_map() -> tuple[Optional[list[dict]], Optional[str]]:
    path = repo_map_file()
    try:
        with open(path, encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, ValueError) as exc:
        return None, f"graphify repository map unavailable: {exc}"

    if raw.get("version") != 1 or not isinstance(raw.get("repositories"), list):
        return None, "graphify repository map must have version 1 and repositories"

    repositories = []
    for entry in raw["repositories"]:
        if not isinstance(entry, dict) or not isinstance(entry.get("graph"), str):
            return None, "graphify repository map contains an invalid repository"
        paths = entry.get("path_prefixes", [])
        common_dirs = entry.get("git_common_dirs", [])
        if not isinstance(paths, list) or not isinstance(common_dirs, list):
            return None, "graphify repository map paths must be lists"
        if not all(isinstance(value, str) for value in [*paths, *common_dirs]):
            return None, "graphify repository map paths must be strings"
        repositories.append(
            {
                "graph": entry["graph"],
                "path_prefixes": [
                    os.path.realpath(os.path.expanduser(value))
                    for value in paths
                ],
                "git_common_dirs": [
                    os.path.realpath(os.path.expanduser(value))
                    for value in common_dirs
                ],
            }
        )
    return repositories, None


def payload_locations(payload: dict) -> tuple[list[str], list[str]]:
    tool_input = payload.get("tool_input")
    cwd = payload.get("cwd")
    base = (
        os.path.realpath(os.path.expanduser(cwd))
        if isinstance(cwd, str) and cwd
        else os.getcwd()
    )
    explicit: list[str] = []
    contextual: list[str] = [base]

    if isinstance(tool_input, dict):
        for key in ("path", "file_path"):
            value = tool_input.get(key)
            if isinstance(value, str) and value:
                expanded = os.path.expanduser(value)
                if not os.path.isabs(expanded):
                    expanded = os.path.join(base, expanded)
                explicit.append(os.path.realpath(expanded))
        for key in ("cwd", "workdir"):
            value = tool_input.get(key)
            if isinstance(value, str) and value:
                contextual.append(os.path.realpath(os.path.expanduser(value)))

        command = tool_input.get("command")
        if isinstance(command, str):
            try:
                tokens = shlex.split(command, posix=True)
            except ValueError:
                tokens = []
            for token in tokens[1:]:
                expanded = os.path.expanduser(token)
                if os.path.isabs(expanded):
                    explicit.append(os.path.realpath(expanded))

    return explicit, contextual

def path_is_within(path: str, prefix: str) -> bool:
    return path == prefix or path.startswith(prefix + os.sep)


def git_common_dir(location: str) -> Optional[str]:
    start = os.path.realpath(os.path.expanduser(location))
    if not os.path.isdir(start):
        start = os.path.dirname(start)
    if not os.path.isdir(start):
        return None
    try:
        result = subprocess.run(
            ["/usr/bin/git", "-C", start, "rev-parse", "--git-common-dir"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=2,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0 or not result.stdout.strip():
        return None
    common = result.stdout.strip()
    if not os.path.isabs(common):
        common = os.path.join(start, common)
    return os.path.realpath(common)


def repository_for_locations(
    locations: list[str],
    repositories: list[dict],
) -> tuple[Optional[dict], Optional[str]]:
    matches: dict[str, tuple[int, dict]] = {}
    for location in locations:
        normalized = os.path.realpath(os.path.expanduser(location))
        path_matches: list[tuple[int, dict]] = []
        for repository in repositories:
            for prefix in repository["path_prefixes"]:
                if path_is_within(normalized, prefix):
                    path_matches.append((len(prefix), repository))
        if path_matches:
            longest = max(length for length, _ in path_matches)
            winners = {
                repository["graph"]: repository
                for length, repository in path_matches
                if length == longest
            }
            if len(winners) > 1:
                return None, "graphify repository map matched more than one graph"
            repository = next(iter(winners.values()))
            matches[repository["graph"]] = (longest, repository)
            continue

        common_dir = git_common_dir(normalized)
        if common_dir is None:
            continue
        common_matches = {
            repository["graph"]: repository
            for repository in repositories
            if common_dir in repository["git_common_dirs"]
        }
        if len(common_matches) > 1:
            return None, "graphify repository map matched more than one graph"
        if common_matches:
            repository = next(iter(common_matches.values()))
            matches[repository["graph"]] = (0, repository)

    if len(matches) > 1:
        return None, "graphify repository map matched more than one graph"
    return (
        next(iter(matches.values()))[1] if matches else None,
        None,
    )


def repository_for_payload(
    payload: dict,
) -> tuple[Optional[dict], Optional[str]]:
    repositories, error = load_repo_map()
    if error:
        return None, error

    explicit, contextual = payload_locations(payload)
    repository, explicit_error = repository_for_locations(
        explicit, repositories or []
    )
    if explicit_error or repository:
        return repository, explicit_error
    return repository_for_locations(contextual, repositories or [])

def graphify_marker_path(payload: dict, graph_name: str) -> Optional[str]:
    session_id = payload.get("session_id")
    turn_id = payload.get("turn_id")
    if (
        not isinstance(session_id, str)
        or not session_id
        or not isinstance(turn_id, str)
        or not turn_id
        or not graph_name
    ):
        return None

    state_dir = os.environ.get("CODEX_GRAPHIFY_GATE_STATE_DIR")
    if not state_dir:
        state_dir = os.path.join("/tmp", "codex-graphify-gate")

    digest = hashlib.sha256(
        f"{session_id}:{turn_id}:{graph_name}".encode("utf-8")
    ).hexdigest()
    return os.path.join(state_dir, f"{digest}.json")


def validate_state_dir(state_dir: str, create: bool = False) -> bool:
    try:
        if create:
            os.makedirs(state_dir, mode=0o700, exist_ok=True)
        info = os.lstat(state_dir)
    except OSError:
        return not create and not os.path.exists(state_dir)

    return (
        stat.S_ISDIR(info.st_mode)
        and not stat.S_ISLNK(info.st_mode)
        and info.st_uid == os.getuid()
        and stat.S_IMODE(info.st_mode) == 0o700
    )


def cleanup_stale_markers(state_dir: str) -> None:
    try:
        entries = os.scandir(state_dir)
    except OSError:
        return
    now = time.time()
    marker_name = re.compile(r"^[0-9a-f]{64}[.]json$")
    with entries:
        for entry in entries:
            try:
                if (
                    marker_name.fullmatch(entry.name)
                    and entry.is_file(follow_symlinks=False)
                    and now - entry.stat(follow_symlinks=False).st_mtime
                    > MARKER_TTL_SECONDS
                ):
                    os.unlink(entry.path)
            except OSError:
                continue


def mark_graphify_query(
    payload: dict,
    graph_name: str,
    query_kind: str,
) -> bool:
    marker = graphify_marker_path(payload, graph_name)
    if not marker:
        return False
    state_dir = os.path.dirname(marker)
    if not validate_state_dir(state_dir, create=True):
        return False
    cleanup_stale_markers(state_dir)

    previous_kind = None
    try:
        with open(marker, encoding="utf-8") as handle:
            previous_kind = json.load(handle).get("query_kind")
    except (OSError, ValueError):
        pass
    query_ranks = {"query": 0, "explain": 1, "affected": 2}
    effective_kind = max(
        (kind for kind in (previous_kind, query_kind) if kind in query_ranks),
        key=query_ranks.get,
    )

    temporary = marker + f".{os.getpid()}.tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "graph_name": graph_name,
                "session_id": payload["session_id"],
                "turn_id": payload["turn_id"],
                "query_kind": effective_kind,
                "created_at": time.time(),
            },
            handle,
        )
    os.chmod(temporary, 0o600)
    os.replace(temporary, marker)
    return True


def graphify_query_recorded(
    payload: dict,
    graph_name: str,
    require_affected: bool = False,
) -> bool:
    marker = graphify_marker_path(payload, graph_name)
    if not marker:
        return False
    state_dir = os.path.dirname(marker)
    if not validate_state_dir(state_dir):
        return False
    try:
        if time.time() - os.path.getmtime(marker) > MARKER_TTL_SECONDS:
            os.unlink(marker)
            return False
        with open(marker, encoding="utf-8") as handle:
            saved = json.load(handle)
    except (OSError, ValueError):
        return False
    return (
        saved.get("graph_name") == graph_name
        and saved.get("session_id") == payload.get("session_id")
        and saved.get("turn_id") == payload.get("turn_id")
        and (
            saved.get("query_kind") == "affected"
            if require_affected
            else saved.get("query_kind") in {"explain", "affected"}
        )
    )

def shell_tokens(command: str) -> Optional[list[str]]:
    try:
        tokens = shlex.split(command, posix=True)
    except ValueError:
        return None
    if not tokens or any(token in SEPARATORS for token in tokens):
        return None
    return tokens


def resolved_executable(token: str) -> Optional[str]:
    expanded = os.path.expanduser(token)
    candidate = expanded if os.path.sep in expanded else shutil.which(expanded)
    return os.path.realpath(candidate) if candidate else None


def executable_is(token: str, names: set[str]) -> bool:
    executable = resolved_executable(token)
    if not executable:
        return False
    allowed = {
        os.path.realpath(candidate)
        for name in names
        for candidate in (
            shutil.which(name),
            f"/bin/{name}",
            f"/usr/bin/{name}",
        )
        if candidate and os.path.exists(candidate)
    }
    return executable in allowed


def is_graph_catalog_listing(command: str) -> bool:
    tokens = shell_tokens(command)
    if not tokens or not executable_is(tokens[0], {"ls"}):
        return False
    operands = [token for token in tokens[1:] if not token.startswith("-")]
    if len(operands) != 1:
        return False
    return (
        os.path.realpath(os.path.expanduser(operands[0]))
        == canonical_graph_root()
    )


def is_control_doc_read(command: str) -> bool:
    tokens = shell_tokens(command)
    if not tokens:
        return False
    command_name = os.path.basename(tokens[0])
    if (
        command_name not in {"cat", "sed", "head", "tail"}
        or not executable_is(tokens[0], {command_name})
    ):
        return False

    operands = []
    for token in tokens[1:]:
        if token.startswith("-"):
            continue
        if command_name == "sed" and re.fullmatch(r"\d+(?:,\d+)?p", token):
            continue
        if command_name in {"head", "tail"} and token.isdigit():
            continue
        operands.append(token)

    return bool(operands) and all(
        os.path.basename(operand) in CONTROL_DOC_NAMES
        for operand in operands
    )


def path_kind(value: str) -> Optional[str]:
    normalized = value.replace("\\", "/").strip("/")
    if not normalized:
        return None
    parts = [part for part in normalized.split("/") if part not in {".", ".."}]
    if not parts:
        return None
    suffix = os.path.splitext(parts[-1])[1].lower()
    if any(part in CODE_DIR_NAMES for part in parts) or suffix in CODE_SUFFIXES:
        return "code"
    if any(part in DOC_DIR_NAMES for part in parts) or suffix in DOC_SUFFIXES:
        return "docs"
    return None


def is_docs_or_logs_read(command: str) -> bool:
    tokens = shell_tokens(command)
    if not tokens:
        return False
    command_name = os.path.basename(tokens[0])

    if command_name == "git":
        if not executable_is(tokens[0], {"git"}):
            return False
        if len(tokens) < 2 or tokens[1] != "log":
            return False
        if "--" not in tokens:
            return True
        paths = tokens[tokens.index("--") + 1 :]
        kinds = [path_kind(value) for value in paths]
        return bool(kinds) and all(kind == "docs" for kind in kinds)

    readers = {
        "cat", "grep", "head", "less", "nl", "rg", "sed", "tail", "wc",
    }
    if (
        command_name not in readers
        or not executable_is(tokens[0], {command_name})
    ):
        return False

    values = [value for value in tokens[1:] if not value.startswith("-")]
    kinds = [path_kind(value) for value in values]
    explicit = [kind for kind in kinds if kind is not None]
    if command_name in {"cat", "head", "less", "nl", "tail", "wc"}:
        return bool(kinds) and all(kind == "docs" for kind in kinds)
    return bool(explicit) and all(kind == "docs" for kind in explicit)

def payload_is_docs_only(payload: dict) -> bool:
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return False
    paths = [
        value
        for key, value in tool_input.items()
        if key in {"path", "file_path", "cwd", "workdir"}
        and isinstance(value, str)
    ]
    kinds = [path_kind(value) for value in paths]
    explicit = [kind for kind in kinds if kind is not None]
    return bool(explicit) and all(kind == "docs" for kind in explicit)


def mentions_graphify_executable(command: str) -> bool:
    return re.search(
        r"(?:^|[\s;&|()])(?:~|/)?[^\s;&|()]*/?graphify(?=\s|$)",
        command,
    ) is not None


def parse_graphify_command(
    command: str,
) -> tuple[Optional[list[str]], Optional[str], Optional[str]]:
    tokens = shell_tokens(command)
    if not tokens:
        if mentions_graphify_executable(command):
            return None, None, "graphify must be a standalone shell command"
        return None, None, None

    executable_token = os.path.expanduser(tokens[0])
    executable = os.path.realpath(executable_token)
    if executable != graphify_bin():
        if os.path.basename(executable_token) == "graphify":
            return None, None, "graphify must use the canonical binary"
        return None, None, None
    if len(tokens) < 4 or tokens[1] not in GRAPHIFY_SUBCOMMANDS:
        return None, None, "unsupported graphify query command"
    if tokens.count("--graph") != 1:
        return None, None, "graphify must name one canonical --graph"

    graph_index = tokens.index("--graph")
    if graph_index + 1 >= len(tokens):
        return None, None, "graphify --graph is missing its path"

    requested_graph = os.path.realpath(
        os.path.expanduser(tokens[graph_index + 1])
    )
    catalog = graph_catalog()
    matching = [
        graph_name
        for graph_name, graph_path in catalog.items()
        if requested_graph == graph_path
    ]
    if len(matching) != 1:
        return None, None, "graphify must use the canonical shared graph"
    tokens[graph_index + 1] = requested_graph
    return [graphify_bin(), *tokens[1:]], matching[0], None

def graphify_rewrite(
    payload: dict,
    command: str,
    repository: Optional[dict],
) -> tuple[Optional[str], Optional[str]]:
    argv, graph_name, error = parse_graphify_command(command)
    if error:
        return None, error
    if not argv or not graph_name:
        return None, None

    if repository and graph_name != repository["graph"]:
        return None, (
            f"wrong graph for this repository: expected {repository['graph']}, "
            f"got {graph_name}"
        )

    marker = graphify_marker_path(payload, graph_name)
    if marker:
        state_dir = os.path.dirname(marker)
        if os.path.exists(state_dir) and not validate_state_dir(state_dir):
            return None, "graphify receipt state directory is insecure"

    session_id = payload.get("session_id")
    turn_id = payload.get("turn_id")
    if not isinstance(session_id, str) or not session_id:
        return None, "graphify validation cannot bind this session"
    if not isinstance(turn_id, str) or not turn_id:
        return None, "graphify validation cannot bind this turn"

    wrapper = [
        sys.executable,
        os.path.realpath(__file__),
        "--run-graphify",
        session_id,
        turn_id,
        graph_name,
        *argv,
    ]
    return shlex.join(wrapper), None


def run_graphify_wrapper(args: list[str]) -> int:
    if len(args) < 5:
        print("Invalid graphify wrapper arguments", file=sys.stderr)
        return 2

    session_id, turn_id, expected_graph, *argv = args
    parsed_argv, graph_name, error = parse_graphify_command(shlex.join(argv))
    if error or not parsed_argv or graph_name != expected_graph:
        print(error or "graphify wrapper graph mismatch", file=sys.stderr)
        return 2

    try:
        result = subprocess.run(parsed_argv, check=False)
    except OSError as exc:
        print(f"graphify execution failed: {exc}", file=sys.stderr)
        return 2
    if result.returncode != 0:
        return result.returncode

    payload = {"session_id": session_id, "turn_id": turn_id}
    if not mark_graphify_query(payload, graph_name, parsed_argv[1]):
        print("graphify receipt could not be recorded", file=sys.stderr)
        return 2
    return 0


def main() -> int:
    if len(sys.argv) > 1:
        if sys.argv[1] == "--run-graphify":
            return run_graphify_wrapper(sys.argv[2:])
        print("Invalid policy helper mode", file=sys.stderr)
        return 2

    try:
        payload = json.load(sys.stdin)
    except Exception as exc:
        return reject(f"Invalid Codex hook input: {exc}")

    tool_name = payload.get("tool_name")
    relevant = (
        tool_name == "Bash"
        or tool_name in CODE_EDIT_TOOLS
        or (
            isinstance(tool_name, str)
            and tool_name.startswith(FILESYSTEM_TOOL_PREFIX)
        )
    )
    if not relevant:
        return 0

    repository, map_error = repository_for_payload(payload)
    if map_error:
        return reject(map_error)
    if repository and repository["graph"] not in graph_catalog():
        return reject(
            "Blocked Codex code command: query the canonical shared graph first "
            "(a broad query must be followed by explain); the configured "
            "canonical graph is unavailable."
        )

    if tool_name in CODE_EDIT_TOOLS:
        if repository and not graphify_query_recorded(
            payload, repository["graph"], require_affected=True
        ):
            return reject(
                "Blocked Codex code edit: query the canonical shared graph first "
                f"({repository['graph']}) with affected, then retry this "
                "edit in the same turn."
            )
        return 0

    if isinstance(tool_name, str) and tool_name.startswith(
        FILESYSTEM_TOOL_PREFIX
    ):
        if (
            repository
            and not graphify_query_recorded(
                payload,
                repository["graph"],
                require_affected=not payload_is_docs_only(payload),
            )
        ):
            return reject(
                "Blocked Codex filesystem code access: query the canonical "
                "shared graph first and complete explain after any broad query, "
                "then retry in the same turn."
            )
        return 0

    command = payload.get("tool_input", {}).get("command")
    if not isinstance(command, str) or not command.strip():
        return reject("Invalid Codex hook input: missing tool_input.command")

    blocked = find_blocked_command(command)
    if blocked:
        return reject(
            "Blocked Codex shell command: "
            f"{blocked}. Use the audited dispatcher self-restart helper instead of raw host process control."
        )

    rewritten, graphify_error = graphify_rewrite(
        payload, command, repository
    )
    if graphify_error:
        return reject(
            "Blocked Codex graphify command: "
            f"{graphify_error}. Query the canonical shared graph first."
        )
    if rewritten:
        print(
            json.dumps(
                {
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": "allow",
                        "updatedInput": {"command": rewritten},
                    }
                }
            )
        )
        return 0

    if not repository:
        return 0

    require_affected = shell_command_requires_affected(command)
    if graphify_query_recorded(
        payload,
        repository["graph"],
        require_affected=require_affected,
    ):
        return 0

    if (
        is_control_doc_read(command)
        or is_graph_catalog_listing(command)
        or is_docs_or_logs_read(command)
    ):
        return 0

    return reject(
        "Blocked Codex code command: query the canonical shared graph first "
        "and complete explain after any broad query, then retry this command "
        "in the same turn."
    )


def shell_command_requires_affected(command: str) -> bool:
    write_patterns = (
        r"(^|[;&|]\s*)(cp|install|mkdir|mv|patch|rm|tee|touch|truncate)(\s|$)",
        r"(^|\s)(>|>>)(\s|$)",
        r"\b(writeFile|writeFileSync|appendFile|appendFileSync|renameSync|"
        r"unlinkSync|rmSync|mkdirSync)\s*\(",
        r"\bopen\s*\([^)]*,\s*['\"][wax+]",
        r"\b(sed|perl)\b[^\n;&|]*\s-i(?:\s|$)",
        r"\bgit\s+apply(?:\s|$)",
    )
    return any(re.search(pattern, command) for pattern in write_patterns)


def find_blocked_command(command: str, depth: int = 0) -> Optional[str]:
    if depth > 3:
        return "nested shell wrapper"

    if "`" in command:
        return "shell command substitution (`...`)"

    if "$(" in command:
        return "shell command substitution ($(…))"

    normalized_command = normalize_command(command)
    try:
        lexer = shlex.shlex(normalized_command, posix=True, punctuation_chars=";&|(){}")
        lexer.whitespace_split = True
        lexer.commenters = ""
        tokens = list(lexer)
    except ValueError as exc:
        return f"unparseable shell command ({exc})"

    expect_command = True
    for index, token in enumerate(tokens):
        if token in SEPARATORS or set(token) <= SHELL_PUNCTUATION:
            if "{" in token or "}" in token:
                return "shell brace expansion/group"
            expect_command = token != ")"
            continue

        if not expect_command:
            continue

        if is_prefix_noise(token):
            continue

        if is_redirection_prefix(token):
            return "shell redirection prefix"

        if has_shell_expansion_metachar(token):
            return "shell pathname expansion"

        if "$" in token:
            return "shell command indirection ($...)"

        if token == ".":
            return token

        command_name = os.path.basename(token)
        if command_name in BLOCKED_COMMANDS:
            return token

        if command_name in FAIL_CLOSED_COMMANDS:
            return token

        if command_name in CONTROL_FLOW_KEYWORDS:
            return f"shell control flow ({token})"

        if command_name == "find" and has_find_exec(tokens[index + 1 :]):
            return "find -exec"

        if command_name == "env" and has_env_split_string(tokens[index + 1 :]):
            return "env -S"

        if command_name in SHELL_WRAPPERS:
            script = shell_c_script(tokens, index + 1)
            if not script:
                return f"{token} script execution"
            if script:
                nested = find_blocked_command(script, depth + 1)
                if nested:
                    return f"{token} -c -> {nested}"
            expect_command = False
            continue

        if command_name in TRANSPARENT_WRAPPERS:
            if has_transparent_wrapper_option(tokens[index + 1 :]):
                return f"{token} option"
            expect_command = True
            continue

        expect_command = False

    return None


def normalize_command(command: str) -> str:
    return command.replace("\r\n", "\n").replace("\r", "\n").replace("\n", " ; ")


def is_prefix_noise(token: str) -> bool:
    return bool(
        ASSIGNMENT_RE.match(token)
        or token.startswith("-")
        or TIMEOUT_DURATION_RE.match(token)
    )


def is_redirection_prefix(token: str) -> bool:
    return bool(REDIRECTION_RE.match(token))


def shell_c_script(tokens: list[str], start_index: int) -> Optional[str]:
    saw_c = False
    for token in tokens[start_index:]:
        if token in SEPARATORS or set(token) <= SHELL_PUNCTUATION:
            break
        if not saw_c:
            if is_shell_c_option(token):
                saw_c = True
                continue
            if not token.startswith("-"):
                return None
            continue
        return token
    return None


def has_find_exec(tokens: list[str]) -> bool:
    return "-exec" in tokens or "-execdir" in tokens


def has_env_split_string(tokens: list[str]) -> bool:
    for token in tokens:
        if token in SEPARATORS or set(token) <= SHELL_PUNCTUATION:
            return False
        if token == "-S" or token.startswith("--split-string"):
            return True
    return False


def has_transparent_wrapper_option(tokens: list[str]) -> bool:
    for token in tokens:
        if token in SEPARATORS or set(token) <= SHELL_PUNCTUATION:
            return False
        if ASSIGNMENT_RE.match(token) or TIMEOUT_DURATION_RE.match(token):
            continue
        return token.startswith("-") or bool(re.match(r"^\+\d+$", token))
    return False


def has_shell_expansion_metachar(token: str) -> bool:
    return any(char in token for char in "*?[]{}")


def is_shell_c_option(token: str) -> bool:
    return token.startswith("-") and not token.startswith("--") and "c" in token[1:]


def reject(message: str) -> int:
    print(message, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
