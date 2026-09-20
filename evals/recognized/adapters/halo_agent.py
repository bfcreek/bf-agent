"""Harbor installed agent: run halo-agent inside the task container.

Ollama stays on the host. The container reaches it via host.docker.internal
(or HALO_AGENT_BASE_URL). Source is uploaded from HALO_AGENT_REPO on the
machine that launched Harbor.
"""

from __future__ import annotations

import json
import os
import shlex
import tarfile
import tempfile
import tomllib
from pathlib import Path
from typing import Any, override

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

NODE_VERSION = "v20.18.3"
INSTALL_ROOT = "/installed-agent"
CLI_PATH = f"{INSTALL_ROOT}/src/cli.mjs"


class HaloAgent(BaseInstalledAgent):
    def __init__(
        self,
        *args: Any,
        max_steps: int = 80,
        num_ctx: int = 16384,
        command_timeout: int = 120,
        max_command_timeout: int = 1800,
        wall_clock: int = 0,
        base_url: str | None = None,
        repo_root: str | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        self._max_steps = int(max_steps)
        self._num_ctx = int(num_ctx)
        self._command_timeout = int(command_timeout)
        self._max_command_timeout = int(max_command_timeout)
        # 0 = derive from the task's [agent] timeout_sec (Harbor kills the agent
        # at that point, so the loop should know it and wrap up first).
        self._wall_clock = int(wall_clock)
        self._base_url = (
            base_url
            or os.environ.get("HALO_AGENT_BASE_URL")
            or "http://host.docker.internal:11434"
        )
        self._repo_root = Path(
            repo_root or os.environ.get("HALO_AGENT_REPO") or Path.cwd()
        )

    @staticmethod
    @override
    def name() -> str:
        return "halo-agent"

    @override
    def version(self) -> str | None:
        return os.environ.get("HALO_AGENT_VERSION") or super().version()

    @override
    def get_version_command(self) -> str | None:
        return f"node {shlex.quote(CLI_PATH)} --version"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(
            environment, ("curl", "bash", "tar", "ca_certificates")
        )
        await self._install_node(environment)
        bundle = self._make_bundle()
        try:
            await environment.upload_file(bundle, "/tmp/halo-agent.tar.gz")
        finally:
            bundle.unlink(missing_ok=True)
        await self.exec_as_root(
            environment,
            command=(
                f"mkdir -p {shlex.quote(INSTALL_ROOT)} && "
                f"tar -xzf /tmp/halo-agent.tar.gz -C {shlex.quote(INSTALL_ROOT)} && "
                f"chmod -R a+rX {shlex.quote(INSTALL_ROOT)}"
            ),
        )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        instruction_path = Path(tempfile.mkdtemp(prefix="halo-instruction-")) / "instruction.txt"
        instruction_path.write_text(instruction, encoding="utf8")
        remote_instruction = "/logs/agent/instruction.txt"
        try:
            await self._upload_agent_owned_file(
                environment, instruction_path, remote_instruction
            )
        finally:
            instruction_path.unlink(missing_ok=True)

        model = self.model_name or os.environ.get("HALO_AGENT_MODEL") or "auto"
        if "/" in model:
            model = model.split("/", 1)[1]
        preset = "cloud-max"
        lowered = model.strip().lower()
        if lowered.startswith("tier-preset "):
            token = lowered.split(None, 1)[1].strip()
            if token:
                preset = token
            model = "auto"
        elif lowered in ("cloud", "cloud-max", "hybrid", "local"):
            preset = lowered
            model = "auto"
        env = {
            "HALO_COMMAND_TIMEOUT": str(self._command_timeout),
            "HALO_MAX_COMMAND_TIMEOUT": str(self._max_command_timeout),
        }
        wall_clock = self._resolve_wall_clock_seconds()
        wall_clock_flag = f"--wall-clock {wall_clock} " if wall_clock > 0 else ""
        cmd = (
            "set -uo pipefail; "
            f"node {shlex.quote(CLI_PATH)} "
            f"--mode agent --quiet --no-index "
            f"--session harbor --cwd \"$PWD\" "
            f"--model {shlex.quote(model)} "
            f"--tier-preset {shlex.quote(preset)} "
            f"--think max "
            f"--base-url {shlex.quote(self._base_url)} "
            f"--max-steps {self._max_steps} "
            f"--num-ctx {self._num_ctx} "
            f"{wall_clock_flag}"
            f"-- \"$(cat {shlex.quote(remote_instruction)})\"; "
            "agent_code=$?; "
            "cp -f .halo-agent/sessions/harbor.json /logs/agent/session.json 2>/dev/null || true; "
            # CLI exit 2 is max-steps: still a scored attempt, not a Harbor crash.
            "if [ \"$agent_code\" -eq 2 ]; then exit 0; fi; "
            "exit \"$agent_code\""
        )
        await self.exec_as_agent(environment, command=cmd, env=env)

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        session_path = self.logs_dir / "session.json"
        if not session_path.exists():
            return
        try:
            data = json.loads(session_path.read_text(encoding="utf8"))
        except (OSError, json.JSONDecodeError):
            return
        steps = data.get("steps") or []
        if hasattr(context, "n_output_tokens") and context.n_output_tokens is None:
            context.n_output_tokens = 0
        extra = getattr(context, "extra", None)
        if isinstance(extra, dict):
            extra["halo_steps"] = len(steps)

    def _resolve_wall_clock_seconds(self) -> int:
        """Seconds until Harbor kills the agent, or 0 when unknown.

        Harbor only hands ``agent_timeout_sec`` to its oracle agent, so read it
        the way Harbor does: the trial's ``config.json`` names the task and its
        content hash, which locate ``task.toml`` in Harbor's task cache.
        """
        if self._wall_clock > 0:
            return self._wall_clock
        try:
            trial_dir = Path(self.logs_dir).parent
            config = json.loads((trial_dir / "config.json").read_text(encoding="utf8"))
            task = config.get("task") or {}
            name = str(task.get("name") or "")
            ref = str(task.get("ref") or "")
            digest = ref.split(":", 1)[1] if ":" in ref else ref
            if not name or not digest:
                return 0
            cache_root = Path(
                os.environ.get("HARBOR_CACHE_DIR") or Path.home() / ".cache" / "harbor"
            ) / "tasks"
            candidates = [cache_root / "packages" / name / digest / "task.toml"]
            candidates.extend(cache_root.glob(f"**/{Path(name).name}/{digest}/task.toml"))
            for toml_path in candidates:
                if not toml_path.is_file():
                    continue
                with toml_path.open("rb") as handle:
                    data = tomllib.load(handle)
                timeout = (data.get("agent") or {}).get("timeout_sec")
                if timeout is None:
                    return 0
                multiplier = float(os.environ.get("HALO_AGENT_TIMEOUT_MULTIPLIER") or 1.0)
                return max(0, int(float(timeout) * multiplier))
        except (OSError, ValueError, TypeError, tomllib.TOMLDecodeError):
            return 0
        return 0

    def _make_bundle(self) -> Path:
        src = self._repo_root / "src"
        package_json = self._repo_root / "package.json"
        if not src.is_dir() or not package_json.is_file():
            raise RuntimeError(
                f"HALO_AGENT_REPO does not look like halo-agent ({self._repo_root}). "
                "Set HALO_AGENT_REPO to the repo root."
            )
        tmp = Path(tempfile.mkdtemp(prefix="halo-bundle-")) / "halo-agent.tar.gz"
        with tarfile.open(tmp, "w:gz") as tar:
            tar.add(src, arcname="src")
            tar.add(package_json, arcname="package.json")
        return tmp

    async def _install_node(self, environment: BaseEnvironment) -> None:
        check = await environment.exec(
            command=(
                "if command -v node >/dev/null 2>&1; then "
                "node -p \"parseInt(process.versions.node,10)>=20?'ok':'old'\"; "
                "else echo missing; fi"
            ),
            user="root",
        )
        status = (check.stdout or "").strip()
        if status == "ok":
            return
        alpine = await environment.exec(
            command="[ -f /etc/alpine-release ] && echo alpine || echo glibc",
            user="root",
        )
        if (alpine.stdout or "").strip() == "alpine":
            await self.exec_as_root(
                environment,
                command="command -v apk >/dev/null && apk add --no-cache nodejs npm",
            )
            return
        await self.exec_as_root(
            environment,
            command=(
                "set -euo pipefail; "
                "arch=$(uname -m); "
                "case \"$arch\" in "
                "x86_64) na=x64 ;; aarch64|arm64) na=arm64 ;; "
                "*) echo \"unsupported arch $arch\" >&2; exit 1 ;; esac; "
                f"ver={shlex.quote(NODE_VERSION)}; "
                "url=\"https://nodejs.org/dist/${ver}/node-${ver}-linux-${na}.tar.gz\"; "
                "curl -fsSL \"$url\" | tar -xz -C /usr/local --strip-components=1; "
                "node --version"
            ),
        )
