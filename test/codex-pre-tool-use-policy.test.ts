import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const hookScript = fileURLToPath(new URL("../scripts/codex-pre-tool-use-policy.py", import.meta.url));

function runHook(command: string) {
  return spawnSync("/usr/bin/python3", [hookScript], {
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
    }),
    encoding: "utf8",
  });
}

describe("codex PreToolUse policy hook", () => {
  it("allows ordinary read-only shell commands", () => {
    const result = runHook("rg -n pkill src");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it.each([
    "killall -TERM node",
    "/usr/bin/pkill -f tsc",
    "echo ok && kill -9 1234",
    "launchctl bootout gui/501/com.example",
    "sudo rm -rf /tmp/example",
    "osascript -e 'tell application \"Terminal\" to quit'",
    "bash -lc 'killall -TERM node'",
    "/bin/zsh -c 'echo ok && pkill -f tsc'",
    "printf 'node\\n' | xargs pkill -f",
    "find . -name node -exec killall {} ;",
    "echo $(pkill -f tsc)",
    "echo ok\npkill -f tsc",
    "echo ok\r\nkillall node",
    "exec pkill -f tsc",
    "nohup killall node",
    "if pkill -f tsc; then echo stopped; fi",
    "echo `pkill -f tsc`",
    "echo `killall node`",
    "eval pkill -f tsc",
    "eval 'killall node'",
    "trap 'pkill -f tsc' EXIT",
    "{ pkill -f tsc; }",
    "f(){ pkill -f tsc; }; f",
    "f() { pkill -f tsc; }; f",
    "function f { pkill -f tsc; }; f",
    "bash -lc '{ pkill -f tsc; }'",
    "cmd=pkill; $cmd -f tsc",
    "cmd=pkill\n$cmd -f tsc",
    "CMD=killall; $CMD node",
    "$(printf pkill) -f tsc",
    "$(printf /usr/bin/pkill) -f tsc",
    "shopt -s expand_aliases\nalias k=pkill\nk -f tsc",
    "! pkill -f tsc",
    "bash -lc '! pkill -f tsc'",
    "zsh -c 'coproc pkill -f tsc'",
    "> /tmp/codex-hook-review.out pkill -f tsc",
    ">/tmp/codex-hook-review.out pkill -f tsc",
    "2>/tmp/codex-hook-review.err pkill -f tsc",
    "FOO=1 > /tmp/codex-hook-review.out pkill -f tsc",
    "bash -lc '> /tmp/codex-hook-review.out pkill -f tsc'",
    "echo \"$(pkill -f tsc)\"",
    "printf %s \"$(pkill -f tsc)\"",
    "x=\"$(pkill -f tsc)\"",
    "x=\"$(pkill -f tsc)\" echo ok",
    "bash -lc 'echo \"$(pkill -f tsc)\"'",
    "zsh -c 'x=\"$(pkill -f tsc)\"'",
    "command echo \"$(pkill -f tsc)\"",
    "echo ok > \"$(pkill -f tsc)\"",
    "hash -p /usr/bin/pkill k; k -f tsc",
    "bash -lc 'hash -p /usr/bin/pkill k; k -f tsc'",
    "command hash -p /usr/bin/pkill k; k -f tsc",
    "builtin hash -p /usr/bin/pkill k; k -f tsc",
    "printf 'pkill -f tsc\\n' > /tmp/codex-hook-review.sh; bash /tmp/codex-hook-review.sh",
    "printf 'pkill -f tsc\\n' > /tmp/codex-hook-review.sh; sh /tmp/codex-hook-review.sh",
    "printf 'pkill -f tsc\\n' > /tmp/codex-hook-review.sh; zsh /tmp/codex-hook-review.sh",
    "bash -lc \"printf 'pkill -f tsc\\n' > /tmp/codex-hook-review.sh; bash /tmp/codex-hook-review.sh\"",
    "printf 'pkill -f tsc\\n' > /tmp/codex-hook-review.sh; source /tmp/codex-hook-review.sh",
    "printf 'pkill -f tsc\\n' > /tmp/codex-hook-review.sh; . /tmp/codex-hook-review.sh",
    "bash --norc -c 'pkill -f tsc'",
    "bash --rcfile /dev/null -c 'pkill -f tsc'",
    "bash --restricted -c 'pkill -f tsc'",
    "printf 'pkill -f tsc\\n' > /tmp/codex-hook-review.sh; bash --norc /tmp/codex-hook-review.sh",
    "zsh --no-rcs -c 'pkill -f tsc'",
    "env -S \"bash -c 'pkill -f tsc'\"",
    "env -S \"sh -c 'pkill -f tsc'\"",
    "env -S \"/usr/bin/pkill -f tsc\"",
    "env FOO=1 -S \"bash -c 'pkill -f tsc'\"",
    "env --split-string=\"bash -c 'pkill -f tsc'\"",
    "cmd=kill; p$cmd -f tsc",
    "cmd=ill; pk$cmd -f tsc",
    "cmd=kill; p${cmd} -f tsc",
    "p$'kill' -f tsc",
    "p$\"kill\" -f tsc",
    "bash -lc \"p$'kill' -f tsc\"",
    "env -u FOO pkill -f tsc",
    "env -u FOO /usr/bin/pkill -f tsc",
    "env -u FOO launchctl help",
    "env -C /tmp launchctl help",
    "env -P /bin launchctl help",
    "nice -n +5 launchctl help",
    "arch -arch arm64 launchctl help",
    "timeout -s TERM launchctl help",
    "/usr/bin/pki* -f tsc",
    "/bin/launchct* help",
    "cd /usr/bin; pki* -f tsc",
    "cd /bin; launchct* help",
    "bash -lc '/usr/bin/pki* -f tsc'",
    "p{k,}ill -f tsc",
    "/bin/launch{ctl,} help",
    "bash -lc 'p{k,}ill -f tsc'",
  ])("blocks host control command: %s", (command) => {
    const result = runHook(command);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Blocked Codex shell command");
  });

  it("allows safe shell wrapper commands", () => {
    const result = runHook("bash -lc 'rg -n pkill src'");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("allows the audited THEO self-restart helper but still blocks raw launchctl", () => {
    const helper = "/Users/albertyang0888/code/codex-telegram-research/discipline-workspace/bin/theo-self-restart";

    expect(runHook(`${helper} --dry-run`).status).toBe(0);
    expect(runHook(helper).status).toBe(0);

    const rawLaunchctl = runHook("launchctl kickstart -k gui/501/com.albert.albert-v3-codex-dispatcher");
    expect(rawLaunchctl.status).not.toBe(0);
    expect(rawLaunchctl.stderr).toContain("Blocked Codex shell command");
  });

  it("fails closed when the hook input is malformed", () => {
    const result = spawnSync("/usr/bin/python3", [hookScript], {
      input: "not-json",
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid Codex hook input");
  });
});
