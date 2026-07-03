#!/usr/bin/env python3
import json
import os
import re
import shlex
import sys
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


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception as exc:
        return reject(f"Invalid Codex hook input: {exc}")

    if payload.get("tool_name") != "Bash":
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

    return 0


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
