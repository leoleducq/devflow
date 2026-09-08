import { Command } from "commander";
import { DevflowError } from "../lib/errors.js";
import { failCommand } from "../lib/json-output.js";

/**
 * `devflow completion <shell>`: a completion script on stdout.
 *
 * commander has no completion support of its own, and the generators that
 * exist for it pull in a dependency to emit a file that never changes at
 * runtime. Reading the command names off the program at generation time is
 * enough, and keeps the script honest: a command added to `index.ts` appears
 * in the completions without anyone remembering to update a list.
 *
 * Deliberately shallow — it completes command and subcommand names, not flag
 * values. Completing an environment name would mean querying the database
 * from inside the user's shell on every Tab, which is a cost they did not
 * ask for.
 */

const SHELLS = ["bash", "zsh", "fish"] as const;
type Shell = (typeof SHELLS)[number];

const isShell = (value: string): value is Shell =>
  (SHELLS as readonly string[]).includes(value);

/** Top-level command names, with their subcommands where they have any. */
type CommandTree = Array<{ name: string; subcommands: string[] }>;

const describeCommands = (program: Command): CommandTree =>
  program.commands.map(command => ({
    name: command.name(),
    subcommands: command.commands.map(sub => sub.name()),
  }));

const bash = (tree: CommandTree): string => {
  const names = tree.map(c => c.name).join(" ");
  const cases = tree
    .filter(c => c.subcommands.length > 0)
    .map(
      c =>
        `      ${c.name}) COMPREPLY=($(compgen -W "${c.subcommands.join(" ")}" -- "$cur")); return;;`,
    )
    .join("\n");

  return `# devflow bash completion
# Install: devflow completion bash > /usr/local/etc/bash_completion.d/devflow
_devflow() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W "${names}" -- "$cur"))
    return
  fi

  if [ "$COMP_CWORD" -eq 2 ]; then
    case "$prev" in
${cases}
    esac
  fi

  COMPREPLY=($(compgen -W "--help --json --yes" -- "$cur"))
}
complete -F _devflow devflow
`;
};

const zsh = (tree: CommandTree): string => {
  const commands = tree.map(c => `    '${c.name}'`).join("\n");
  const cases = tree
    .filter(c => c.subcommands.length > 0)
    .map(
      c =>
        `        ${c.name}) _values 'subcommand' ${c.subcommands
          .map(s => `'${s}'`)
          .join(" ")} ;;`,
    )
    .join("\n");

  return `#compdef devflow
# devflow zsh completion
# Install: devflow completion zsh > "\${fpath[1]}/_devflow"
_devflow() {
  local -a commands
  commands=(
${commands}
  )

  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi

  if (( CURRENT == 3 )); then
    case "\${words[2]}" in
${cases}
    esac
  fi

  _arguments '--help[Show help]' '--json[Machine-readable output]'
}
_devflow "$@"
`;
};

const fish = (tree: CommandTree): string => {
  const lines = [
    "# devflow fish completion",
    "# Install: devflow completion fish > ~/.config/fish/completions/devflow.fish",
    "complete -c devflow -f",
  ];
  for (const command of tree) {
    lines.push(
      `complete -c devflow -n '__fish_use_subcommand' -a '${command.name}'`,
    );
    for (const sub of command.subcommands) {
      lines.push(
        `complete -c devflow -n '__fish_seen_subcommand_from ${command.name}' -a '${sub}'`,
      );
    }
  }
  lines.push("complete -c devflow -l help -d 'Show help'");
  lines.push("complete -c devflow -l json -d 'Machine-readable output'");
  return `${lines.join("\n")}\n`;
};

const GENERATORS: Record<Shell, (tree: CommandTree) => string> = {
  bash,
  zsh,
  fish,
};

export const completionCommand = new Command()
  .name("completion")
  .description("Print a shell completion script (bash, zsh, fish)")
  .argument("<shell>", `One of: ${SHELLS.join(", ")}`)
  .addHelpText(
    "after",
    `
Examples:
  $ devflow completion zsh > "\${fpath[1]}/_devflow"
  $ devflow completion bash > /usr/local/etc/bash_completion.d/devflow
  $ devflow completion fish > ~/.config/fish/completions/devflow.fish`,
  )
  .action((shell: string) => {
    try {
      if (!isShell(shell)) {
        throw new DevflowError(
          "INVALID_ARGUMENT",
          `Unsupported shell '${shell}'. Known: ${SHELLS.join(", ")}`,
        );
      }
      // The parent is the program itself, so the script always lists the
      // commands this build actually has.
      const program = completionCommand.parent;
      if (!program) throw new Error("completion must be attached to a program");
      process.stdout.write(GENERATORS[shell](describeCommands(program)));
    } catch (error) {
      failCommand(error);
    }
  });
