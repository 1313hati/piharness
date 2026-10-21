/**
 * What "check this project" means, discovered from the files that already say
 * it: package.json scripts, Cargo.toml, go.mod, pyproject, a Makefile test
 * target. A model that has to guess how to verify a change guesses wrong or
 * skips it; both look like incompetence from the outside.
 *
 * Bounded on purpose: at most three commands, ordered by how much they prove.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ProjectChecks {
  /** Commands to run, most useful first. */
  commands: string[];
  /** Where each came from, for the provenance line. */
  source: string[];
}

/** Only the package.json scripts worth spending a turn on. */
const SCRIPT_ORDER = ["typecheck", "test", "build", "lint"] as const;

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function detectProjectChecks(cwd: string, max = 3): ProjectChecks {
  const commands: string[] = [];
  const source: string[] = [];

  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readText(pkgPath) || "{}") as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      const found: string[] = [];
      for (const key of SCRIPT_ORDER) {
        if (typeof scripts[key] === "string") found.push(key === "test" ? "npm test" : `npm run ${key}`);
      }
      if (found.length > 0) {
        commands.push(...found);
        source.push("package.json scripts");
      }
    } catch {
      // a broken package.json is the model's business, not the probe's
    }
  }

  const hasTsConfig = existsSync(join(cwd, "tsconfig.json"));
  const hasTypecheck = commands.some((c) => /typecheck|tsc/.test(c));
  if (hasTsConfig && !hasTypecheck) {
    commands.push("npx tsc --noEmit");
    source.push("tsconfig.json");
  }

  if (existsSync(join(cwd, "Cargo.toml"))) {
    commands.push("cargo check", "cargo test");
    source.push("Cargo.toml");
  }
  if (existsSync(join(cwd, "go.mod"))) {
    commands.push("go build ./...", "go test ./...");
    source.push("go.mod");
  }
  if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "pytest.ini"))) {
    commands.push("python3 -m pytest -q");
    source.push("pyproject.toml");
  }
  const makefile = join(cwd, "Makefile");
  if (existsSync(makefile) && /^test:/m.test(readText(makefile))) {
    commands.push("make test");
    source.push("Makefile");
  }

  const seen = new Set<string>();
  const unique = commands.filter((c) => (seen.has(c) ? false : (seen.add(c), true)));
  return { commands: unique.slice(0, max), source };
}

/** One line for the machine block; "" when the project declares no checks. */
export function renderProjectChecks(checks: ProjectChecks, maxChars = 220): string {
  if (checks.commands.length === 0) return "";
  const line = `- project checks (run before you say it works): ${checks.commands.join(", ")}`;
  return line.length <= maxChars ? line : `${line.slice(0, maxChars)}…`;
}
