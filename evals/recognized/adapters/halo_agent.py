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
        num_ctx: int = 0,
        command_timeout: int = 120,
        max_command_timeout: int = 1800,
        wall_clock: int = 0,
        base_url: str | None = None,
        repo_root: str | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        self._max_steps = int(max_steps)
        # 0 = auto: the CLI sizes the window to the model and the Ollama
        # host's memory (forwarded via HALO_HOST_* below).
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
        await self._install_node(environment)
        await self._install_recon_tools(environment)
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

    async def _install_recon_tools(self, environment: BaseEnvironment) -> None:
        """Pre-install common recon/analysis tools the task sandboxes lack.

        The agent runs as a non-root user (``exec_as_agent``) and cannot
        ``apt-get install`` mid-task, so binaries the trace needs — ``file``,
        ``strings``/``objdump``/``readelf`` (binutils), ``hexdump``/``xxd``,
        ``7z``, ``unzip``, ``gdb``, ``strace``/``ltrace`` — are staged here as
        root instead. They install at the system level (``/usr``), so they live
        **outside** ``/app`` (the graded user project) and are discarded with
        the ephemeral task container; nothing the agent recovers is polluted.

        Best-effort and fail-open, like the Node install: many task images are
        offline or run old apt pools. Each package is installed on its own so
        one missing name does not block the rest. Set
        ``HALO_AGENT_SKIP_SETUP_PACKAGES=1`` to run against the pristine image,
        or ``HALO_AGENT_SETUP_PACKAGES`` to override the list.
        """
        if os.environ.get("HALO_AGENT_SKIP_SETUP_PACKAGES"):
            return
        override = os.environ.get("HALO_AGENT_SETUP_PACKAGES")
        apt_pkgs = override or "file binutils xxd bsdmainutils p7zip-full unzip xz-utils gdb strace ltrace"
        apk_pkgs = override or "file binutils xxd p7zip unzip xz gdb strace ltrace"
        command = (
            "set -u; "
            f"APT={shlex.quote(apt_pkgs)}; APK={shlex.quote(apk_pkgs)}; "
            "if command -v apt-get >/dev/null 2>&1; then "
            "  DEBIAN_FRONTEND=noninteractive apt-get update >/dev/null 2>&1 || true; "
            "  for p in $APT; do DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \"$p\" >/dev/null 2>&1 || true; done; "
            "elif command -v apk >/dev/null 2>&1; then "
            "  apk update >/dev/null 2>&1 || true; "
            "  for p in $APK; do apk add --no-cache \"$p\" >/dev/null 2>&1 || true; done; "
            "fi; "
            "true"
        )
        try:
            await self.exec_as_root(environment, command=command)
        except Exception as error:  # noqa: BLE001 — recon tools are a convenience, never fatal
            self.logger.warning(
                "recon tool pre-install failed (%s); continuing without them", error
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
        preset = None
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
        # The agent runs in the task container but Ollama runs on the host;
        # hand the host's memory to the CLI so fit decisions are about the
        # machine the models actually load on.
        for src, dst in (
            ("HALO_HOST_TOTAL_MEM_BYTES", "HALO_TOTAL_MEM_BYTES"),
            ("HALO_HOST_VRAM_BYTES", "HALO_VRAM_BYTES"),
        ):
            value = os.environ.get(src)
            if value:
                env[dst] = value
        num_ctx_flag = str(self._num_ctx) if self._num_ctx > 0 else "auto"
        wall_clock = self._resolve_wall_clock_seconds()
        wall_clock_flag = f"--wall-clock {wall_clock} " if wall_clock > 0 else ""
        tier_flag = f"--tier-preset {shlex.quote(preset)} " if preset else ""
        # Think mode follows CLI defaults / models.yaml; cloud-max policy sets
        # --think max when an explicit --tier-preset cloud-max is passed.
        cmd = (
            "set -uo pipefail; "
            f"node {shlex.quote(CLI_PATH)} "
            f"--mode agent --quiet --no-index "
            f"--session harbor --cwd \"$PWD\" "
            f"--model {shlex.quote(model)} "
            f"{tier_flag}"
            f"--base-url {shlex.quote(self._base_url)} "
            f"--max-steps {self._max_steps} "
            f"--num-ctx {num_ctx_flag} "
            f"{wall_clock_flag}"
            f"-- \"$(cat {shlex.quote(remote_instruction)})\"; "
            "agent_code=$?; "
            # Sessions live under .bf/bf-agent/ (legacy .halo-agent / bitfield paths still copied).
            "cp -f .bf/bf-agent/sessions/harbor.json /logs/agent/session.json 2>/dev/null || "
            "cp -f bitfield/bf-agent/sessions/harbor.json /logs/agent/session.json 2>/dev/null || "
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
        """Put Node >= 20 in the container.

        The tarball is fetched on the host (cached under the user's cache dir)
        and uploaded, the same way the agent bundle is. Task images are not
        reliable network clients: several are old Debian releases whose apt
        pools have moved on, and some ship without curl — which is why the
        earlier ``apt-get install curl`` step killed trials before the agent
        ever ran. In-container download is only the fallback when the host
        cannot fetch.
        """
        check = await environment.exec(
            command=(
                "if command -v node >/dev/null 2>&1; then "
                "node -p \"parseInt(process.versions.node,10)>=20?'ok':'old'\"; "
                "else echo missing; fi; "
                "uname -m; [ -f /etc/alpine-release ] && echo alpine || echo glibc"
            ),
            user="root",
        )
        lines = [line.strip() for line in (check.stdout or "").splitlines() if line.strip()]
        status = lines[0] if lines else "missing"
        arch = lines[1] if len(lines) > 1 else "x86_64"
        libc = lines[2] if len(lines) > 2 else "glibc"
        if status == "ok":
            return
        if libc == "alpine":
            await self.exec_as_root(
                environment,
                command="command -v apk >/dev/null && apk add --no-cache nodejs npm",
            )
            return
        node_arch = {"x86_64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(arch)
        if node_arch is None:
            raise RuntimeError(f"unsupported container architecture for Node: {arch}")

        tarball = self._host_node_tarball(node_arch)
        if tarball is not None:
            await environment.upload_file(tarball, "/tmp/halo-node.tar.gz")
            await self.exec_as_root(
                environment,
                command=(
                    "tar -xzf /tmp/halo-node.tar.gz -C /usr/local --strip-components=1 && "
                    "rm -f /tmp/halo-node.tar.gz && node --version"
                ),
            )
            return

        await self.exec_as_root(
            environment,
            command=(
                "set -euo pipefail; "
                f"ver={shlex.quote(NODE_VERSION)}; na={node_arch}; "
                "url=\"https://nodejs.org/dist/${ver}/node-${ver}-linux-${na}.tar.gz\"; "
                "if command -v curl >/dev/null 2>&1; then curl -fsSL \"$url\"; "
                "elif command -v wget >/dev/null 2>&1; then wget -qO- \"$url\"; "
                "else python3 -c 'import sys,urllib.request; sys.stdout.buffer.write(urllib.request.urlopen(sys.argv[1]).read())' \"$url\"; fi "
                "| tar -xz -C /usr/local --strip-components=1; "
                "node --version"
            ),
        )

    def _host_node_tarball(self, node_arch: str) -> Path | None:
        """Download (once) and return the Node tarball for ``node_arch``, or
        None when the host cannot fetch it."""
        cache_dir = Path(
            os.environ.get("HALO_NODE_CACHE")
            or Path(os.environ.get("LOCALAPPDATA") or Path.home() / ".cache") / "halo-agent" / "node"
        )
        name = f"node-{NODE_VERSION}-linux-{node_arch}.tar.gz"
        target = cache_dir / name
        if target.is_file() and target.stat().st_size > 1_000_000:
            return target
        url = f"https://nodejs.org/dist/{NODE_VERSION}/{name}"
        try:
            import urllib.request

            cache_dir.mkdir(parents=True, exist_ok=True)
            tmp = target.with_suffix(".part")
            with urllib.request.urlopen(url, timeout=120) as response, tmp.open("wb") as out:
                while True:
                    chunk = response.read(1 << 20)
                    if not chunk:
                        break
                    out.write(chunk)
            tmp.replace(target)
            return target
        except Exception as error:  # noqa: BLE001 — fall back to in-container download
            self.logger.warning("host-side Node download failed (%s); trying inside the container", error)
            return None
