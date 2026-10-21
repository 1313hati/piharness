/**
 * What this machine actually has, stated once so the model stops guessing.
 *
 * The failure this prevents is boring and expensive: a turn that writes a
 * script importing numpy, then spends five tool calls discovering that `pip`
 * does not exist here, then rewrites the script in stdlib Python. The model
 * cannot see the machine, so it assumes the usual setup. One short block of
 * facts — checked, not guessed — removes that class of fumbling.
 *
 * Detection runs once per process and is cached: the environment does not
 * change mid-session, and a turn must not pay for fifteen `which` calls.
 */

import { execFileSync } from "node:child_process";

export interface ExecResult {
  /** Exit status was zero and stdout was captured. */
  ok: boolean;
  /** Trimmed stdout (or "" on failure). */
  out: string;
}

/** Injectable so the renderer can be tested without this machine's setup. */
export type Runner = (cmd: string, args: string[], timeoutMs?: number) => ExecResult;

export const defaultRunner: Runner = (cmd, args, timeoutMs = 400) => {
  try {
    const out = execFileSync(cmd, args, {
      timeout: timeoutMs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out: out.trim() };
  } catch {
    return { ok: false, out: "" };
  }
};

/** Probed for presence. Ordered: the ones a coding turn reaches for first. */
export const PROBED = [
  "python3", "node", "npm", "npx", "uv", "bun", "deno",
  "git", "jq", "ffmpeg", "sqlite3", "docker", "cargo", "go", "tmux", "magick",
] as const;

/** Python packages worth knowing about before writing a script. */
export const PYTHON_PROBES = ["numpy", "PIL", "matplotlib", "requests", "yaml"] as const;

export interface EnvReport {
  os: string;
  shell: string;
  /** How this machine can install Python packages, if at all. */
  pythonPackaging: string;
  /** "name 1.2.3" for things that report a version, bare name otherwise. */
  present: string[];
  /** Names that are not installed — the half the model usually gets wrong. */
  absent: string[];
  /** Python modules that import from the system python3. */
  pythonModules: string[];
}

/** Only these get a version probe: each one is a subprocess. */
const VERSION_PROBES = new Set(["python3", "node", "npm", "git", "uv"]);

/** Version by flag, when the tool is generous enough to report one. */
function version(name: string, run: Runner): string | null {
  const flags: Record<string, string[]> = {
    python3: ["--version"],
    node: ["--version"],
    npm: ["--version"],
    git: ["--version"],
    jq: ["--version"],
    ffmpeg: ["-version"],
    sqlite3: ["--version"],
    docker: ["--version"],
    cargo: ["--version"],
    go: ["version"],
    tmux: ["-V"],
    magick: ["-version"],
    uv: ["--version"],
    bun: ["--version"],
    deno: ["--version"],
  };
  const args = flags[name];
  if (!args || !VERSION_PROBES.has(name)) return null;
  const res = run(name, args);
  if (!res.ok || !res.out) return null;
  const first = res.out.split("\n")[0];
  const m = /(\d+\.\d+(?:\.\d+)?)/.exec(first);
  return m ? m[1] : null;
}

export function detectEnvironment(run: Runner = defaultRunner): EnvReport {
  const osName = (() => {
    for (const path of ["/etc/os-release", "/usr/lib/os-release"]) {
      const res = run("sh", ["-c", `cat ${path} 2>/dev/null`]);
      if (!res.ok || !res.out) continue;
      const pretty = /^PRETTY_NAME="?(.+?)"?$/m.exec(res.out);
      if (pretty) return pretty[1];
    }
    return `${process.platform} ${process.arch}`;
  })();

  // One subprocess for all presence checks: this runs while a turn is waiting
  // for its first token, so it has to be cheap.
  const found = new Set(
    run("sh", ["-c", `for n in ${PROBED.join(" ")}; do command -v "$n" >/dev/null 2>&1 && echo "$n"; done`])
      .out.split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
  const present: string[] = [];
  const absent: string[] = [];
  for (const name of PROBED) {
    if (!found.has(name)) {
      absent.push(name);
      continue;
    }
    const v = version(name, run);
    present.push(v ? `${name} ${v}` : name);
  }

  // Presence is not the same as working: `pip3` can sit on PATH while
  // `python3 -m pip` fails, which is exactly how a turn ends up installing
  // nothing for five calls. Probe the form the model would actually type.
  const pythonPackaging = (() => {
    if (!present.some((p) => p.startsWith("python3"))) return "no python3";
    const viaModule = /pip ([\d.]+)/.exec(run("python3", ["-m", "pip", "--version"]).out)?.[1];
    const viaPip3 = /pip ([\d.]+)/.exec(run("pip3", ["--version"]).out)?.[1];
    const viaUv = /(\d+\.\d+\.\d+)/.exec(run("uv", ["--version"]).out)?.[1];
    const ways: string[] = [];
    if (viaModule) ways.push(`python3 -m pip ${viaModule}`);
    if (viaPip3) ways.push(`pip3 ${viaPip3}`);
    if (viaUv) ways.push(`uv ${viaUv}`);
    if (ways.length === 0) {
      return "none works — do not try to install packages; write stdlib-only Python or ask";
    }
    return ways.join(", ");
  })();

  const modules = (() => {
    if (!present.some((p) => p.startsWith("python3"))) return [];
    const code =
      "import importlib.util as u;" +
      `print(' '.join(m for m in ${JSON.stringify([...PYTHON_PROBES])} if u.find_spec(m)))`;
    const res = run("python3", ["-c", code], 1500);
    return res.ok && res.out ? res.out.split(/\s+/).filter(Boolean) : [];
  })();

  return {
    os: osName,
    shell: process.env.SHELL ?? "unknown",
    pythonPackaging,
    present,
    absent,
    pythonModules: modules,
  };
}

/**
 * Render for the system prompt. Deliberately terse: this is paid for on every
 * turn, so it states only what changes a decision — the absences most of all,
 * plus whether a python script may import anything beyond the stdlib.
 */
export function renderEnvironment(report: EnvReport, maxChars = 900): string {
  const lines = [`## This machine (probed, not assumed)`, `- os: ${report.os}; shell: ${report.shell}`];
  if (report.present.length > 0) lines.push(`- installed: ${report.present.join(", ")}`);
  if (report.absent.length > 0) {
    lines.push(`- not installed: ${report.absent.join(", ")} — do not call them`);
  }
  lines.push(`- python packaging: ${report.pythonPackaging}`);
  if (report.present.some((p) => p.startsWith("python3"))) {
    lines.push(
      report.pythonModules.length > 0
        ? `- system python3 can import: ${report.pythonModules.join(", ")} (anything else needs an install that may not be possible)`
        : `- system python3 imports no third-party modules: write stdlib-only Python or say what you need`,
    );
  }
  const text = lines.join("\n");
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n… [environment block truncated]`;
}

let cached: string | null = null;

/** Cached per process: the machine does not change mid-session. */
export function environmentBlock(): string {
  if (cached === null) {
    try {
      cached = renderEnvironment(detectEnvironment());
    } catch {
      cached = "";
    }
  }
  return cached;
}
