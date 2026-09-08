#!/usr/bin/env node
// The one thing a global install prints: what to run next.
//
// Everything `devflow` can do is invisible at the moment someone finishes
// `npm install -g @iziatask/devflow` — npm prints "added 84 packages" and
// stops. This script spends five lines telling them about `setup-agents` and
// `init`, and is otherwise the most cautious thing in the package: it writes
// nothing, reads no network, touches no filesystem, and runs no devflow
// command. Postinstall side effects are an antipattern; a postinstall that
// only speaks is the narrow case that is defensible, and only if it stays
// quiet whenever a human is not the one watching.
//
// One thing worth knowing before touching this: npm >= 7 buffers lifecycle
// script output and discards it when the script succeeds, so this message
// only actually reaches a terminal under pnpm, yarn, or
// `npm install --foreground-scripts`. That is not a reason to make it louder
// — nothing here should ever grow a "make sure they see it" mechanism. The
// discoverable copy of this text lives in `devflow --help`, which the user
// can always run. This is a bonus when the package manager allows it.
//
// Deliberately dependency-free: it runs from `scripts/` before anything in
// `dist/` is guaranteed to exist, so it cannot import the CLI's own colour
// helper, and picocolors may not be resolvable during a partial install.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** ANSI, applied only when we have already decided colour is welcome. */
const paint = (code, text) => `\x1b[${code}m${text}\x1b[0m`;

/**
 * Whether to print at all.
 *
 * Silence is the default for everything except a person deliberately
 * installing the tool for themselves. In particular, being a dependency of
 * another project must never print: that would put DevFlow's onboarding in
 * front of every user of every package that depends on it.
 *
 * Kept as a pure function of the environment so it can be exercised directly
 * against captured real-world env snapshots, which is the only practical way
 * to test install shapes without performing installs.
 */
function shouldSpeak(env) {
  // Any CI system: nobody is reading, and the line only pollutes build logs.
  // CONTINUOUS_INTEGRATION and the provider-specific flags catch the runners
  // that predate the CI convention.
  if (
    env.CI ||
    env.CONTINUOUS_INTEGRATION ||
    env.BUILD_NUMBER ||
    env.GITHUB_ACTIONS ||
    env.GITLAB_CI ||
    env.JENKINS_URL
  ) {
    return false;
  }

  // Deliberately NOT gated on `process.stdout.isTTY`. Every package manager
  // runs lifecycle scripts with piped stdio — npm, pnpm and yarn all report
  // isTTY false even when the user is sitting at a real terminal — so that
  // check is not "is a human watching?", it is an unconditional `false`, and
  // it would silence this message in every case including the one it exists
  // for. The install-shape checks below are what actually discriminate.

  // A coding agent driving the install is not an audience for onboarding.
  if (env.CLAUDECODE || env.CLAUDE_CODE || env.AGENT || env.DEVFLOW_QUIET) {
    return false;
  }

  // `npm ci`, and reproducible/automated installs generally: a machine.
  if (env.npm_command === "ci") return false;

  // npm/pnpm/yarn all set this for `-g`, and only for `-g`. It is the direct
  // answer to "did this person install the tool, or did a project pull it in
  // as a dependency", so it is the check that matters most.
  if (env.npm_config_global !== "true") return false;

  // A belt-and-braces reading of the same question, for the case where a
  // package manager sets npm_config_global while installing into a project.
  // INIT_CWD is where the install was launched from; npm_config_local_prefix
  // is the project root it resolved. When they agree and a manifest sits
  // there, this is a project install wearing a global flag, so stay quiet.
  const from = env.INIT_CWD;
  const local = env.npm_config_local_prefix;
  if (from && local && from === local && env.npm_config_prefix !== local) {
    return false;
  }

  return true;
}

function render(useColor) {
  const dim = t => (useColor ? paint("2", t) : t);
  const bold = t => (useColor ? paint("1", t) : t);
  const cyan = t => (useColor ? paint("36", t) : t);

  // The version is read here rather than hardcoded so it cannot drift; the
  // caller has already guarded the whole thing, so a failure just means we
  // print without it.
  let version = "";
  try {
    const manifest = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
      "utf8",
    );
    version = JSON.parse(manifest).version || "";
  } catch {
    version = "";
  }

  // Matches the shape `devflow init` prints when it finishes: a bold heading,
  // then dim intent on the left and the literal command on the right.
  return [
    "",
    `  ${bold("devflow")} ${dim(version)}`,
    "",
    `  ${bold("Next")}  ${cyan("devflow setup-agents")}  ${dim("teach your coding agent to use it")}`,
    `        ${cyan("devflow init")}          ${dim("register this project")}`,
    "",
    `  ${dim("Docs")}  ${dim("https://github.com/leoleducq/devflow")}`,
    "",
  ].join("\n");
}

// Nothing below may fail the install. A postinstall that throws breaks
// `npm install` outright, which is a far worse outcome than no message, so
// the entire body is wrapped and the process always ends at 0.
try {
  if (shouldSpeak(process.env)) {
    // NO_COLOR is honoured for the text but does not silence the message.
    const useColor = !process.env.NO_COLOR;
    process.stdout.write(render(useColor) + "\n");
  }
} catch {
  // Intentionally empty: the message is optional, the install is not.
}

process.exitCode = 0;
