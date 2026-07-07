import { Effect } from "effect"

const shells = ["bash", "zsh"] as const
type Shell = (typeof shells)[number]

const commands = [
	"init",
	"task",
	"tasks",
	"edit",
	"work",
	"template",
	"emit",
	"emitted",
	"pr",
	"push",
	"pull",
	"rebase",
	"base",
	"switch",
	"source",
	"merge",
	"status",
	"clean",
	"loop",
	"completions",
] as const

const templateSubcommands = ["use", "save", "list", "view", "delete"] as const
const baseSubcommands = ["get", "set"] as const
const completionSubcommands = shells

const globalOptions = [
	"--help",
	"-h",
	"--version",
	"-v",
	"--no-color",
	"--silent",
	"-s",
	"--verbose",
] as const

const commandOptions: Record<string, readonly string[]> = {
	init: [
		"--help",
		"-h",
		"--template",
		"-t",
		"--silent",
		"-s",
		"--verbose",
		"-v",
	],
	emit: [
		"--help",
		"-h",
		"--emit",
		"--branch",
		"--silent",
		"-s",
		"--verbose",
		"-v",
	],
	push: [
		"--help",
		"-h",
		"--emit",
		"--branch",
		"--force",
		"-f",
		"--no-verify",
		"--pr",
		"--silent",
		"-s",
		"--verbose",
		"-v",
	],
	pull: ["--help", "-h", "--remote", "-r", "--silent", "-s", "--verbose", "-v"],
	rebase: [
		"--help",
		"-h",
		"--emit",
		"--branch",
		"--silent",
		"-s",
		"--verbose",
		"-v",
	],
	task: [
		"--help",
		"-h",
		"--emit",
		"--branch",
		"--task",
		"--from",
		"--from-current",
		"--continue",
		"--squash",
		"--silent",
		"-s",
		"--verbose",
		"-v",
	],
	tasks: ["--help", "-h", "--json", "--silent", "-s", "--verbose", "-v"],
	base: ["--help", "-h", "--repo", "--silent", "-s", "--verbose", "-v"],
	template: [
		"--help",
		"-h",
		"--template",
		"-t",
		"--silent",
		"-s",
		"--verbose",
		"-v",
	],
	work: [
		"--help",
		"-h",
		"--opencode",
		"--claude",
		"--silent",
		"-s",
		"--verbose",
		"-v",
	],
	loop: [
		"--help",
		"-h",
		"--min-loops",
		"--max-loops",
		"--opencode",
		"--claude",
		"--silent",
		"-s",
		"--verbose",
		"-v",
	],
	status: ["--help", "-h", "--json", "--silent", "-s", "--verbose", "-v"],
	clean: [
		"--help",
		"-h",
		"--dry-run",
		"--merged-into",
		"--silent",
		"-s",
		"--verbose",
		"-v",
	],
	completions: ["--help", "-h"],
}

const words = (values: readonly string[]) => values.join(" ")

const bashCase = (command: string, subcommands?: readonly string[]) => {
	const options = commandOptions[command] ?? [
		"--help",
		"-h",
		"--silent",
		"-s",
		"--verbose",
		"-v",
	]
	const completions = subcommands ? [...subcommands, ...options] : options
	return `\t\t${command})\n\t\t\tCOMPREPLY=( $(compgen -W "${words(completions)}" -- "$cur") )\n\t\t\treturn 0\n\t\t\t;;`
}

const zshCommandSpec = (command: string, description: string) =>
	`    '${command}:${description}'`

const generateBashCompletions = () => `# bash completion for agency
_agency_completions() {
	local cur prev command
	COMPREPLY=()
	cur="\${COMP_WORDS[COMP_CWORD]}"
	prev="\${COMP_WORDS[COMP_CWORD-1]}"

	if [[ $COMP_CWORD -eq 1 ]]; then
		COMPREPLY=( $(compgen -W "${words([...commands, ...globalOptions])}" -- "$cur") )
		return 0
	fi

	command="\${COMP_WORDS[1]}"
	case "$command" in
${bashCase("template", templateSubcommands)}
${bashCase("base", baseSubcommands)}
${bashCase("completions", completionSubcommands)}
${commands
	.filter((command) => !["template", "base", "completions"].includes(command))
	.map((command) => bashCase(command))
	.join("\n")}
	esac

	case "$prev" in
		--template|-t|--emit|--branch|--task|--from|--remote|-r|--merged-into)
			return 0
			;;
	esac
}

complete -F _agency_completions agency
`

const generateZshCompletions = () => `#compdef agency
# zsh completion for agency

_agency() {
  local context state line
  local -a agency_commands
  typeset -A opt_args

  agency_commands=(
${zshCommandSpec("init", "Initialize agency with template selection")}
${zshCommandSpec("task", "Initialize template files on a feature branch")}
${zshCommandSpec("tasks", "List all task branches")}
${zshCommandSpec("edit", "Open TASK.md in system editor")}
${zshCommandSpec("work", "Start working on TASK.md with OpenCode")}
${zshCommandSpec("template", "Template management commands")}
${zshCommandSpec("emit", "Emit a branch with backpack files reverted")}
${zshCommandSpec("emitted", "Get the name of the emitted branch")}
${zshCommandSpec("pr", "Run gh pr with the emitted branch name")}
${zshCommandSpec("push", "Emit, push to remote, return to source")}
${zshCommandSpec("pull", "Pull commits from remote emit branch to source")}
${zshCommandSpec("rebase", "Rebase source branch onto base branch")}
${zshCommandSpec("base", "Get or set the base branch")}
${zshCommandSpec("switch", "Toggle between source and emitted branch")}
${zshCommandSpec("source", "Switch to source branch from emitted branch")}
${zshCommandSpec("merge", "Merge emitted branch into base branch")}
${zshCommandSpec("status", "Show agency status for this repository")}
${zshCommandSpec("clean", "Delete branches merged into a specified branch")}
${zshCommandSpec("loop", "Run a Ralph Wiggum loop to complete all tasks")}
${zshCommandSpec("completions", "Generate shell completion scripts")}
  )

  _arguments -C \\
    '(-h --help)'{-h,--help}'[show help]' \\
    '(-v --version)'{-v,--version}'[show version]' \\
    '--no-color[disable color output]' \\
    '(-s --silent)'{-s,--silent}'[suppress output messages]' \\
    '--verbose[show verbose output]' \\
    '1:command:->command' \\
    '*::arg:->args'

  case $state in
    command)
      _describe 'agency command' agency_commands
      ;;
    args)
      case $line[1] in
        template)
          _arguments \\
            '(-h --help)'{-h,--help}'[show help]' \\
            '(-t --template)'{-t,--template}'[template name]:template:' \\
            '(-s --silent)'{-s,--silent}'[suppress output messages]' \\
            '--verbose[show verbose output]' \\
            '1:subcommand:((use\\:Set\\ template save\\:Save\\ files list\\:List\\ files view\\:View\\ file delete\\:Delete\\ files))' \\
            '*:file:_files'
          ;;
        base)
          _arguments \\
            '(-h --help)'{-h,--help}'[show help]' \\
            '--repo[use repository-local configuration]' \\
            '(-s --silent)'{-s,--silent}'[suppress output messages]' \\
            '--verbose[show verbose output]' \\
            '1:subcommand:((get\\:Get\\ base\\ branch set\\:Set\\ base\\ branch))' \\
            '*:branch:'
          ;;
        completions)
          _arguments \\
            '(-h --help)'{-h,--help}'[show help]' \\
            '1:shell:((bash\\:Generate\\ bash\\ completions zsh\\:Generate\\ zsh\\ completions))'
          ;;
        *)
          _arguments \\
            '(-h --help)'{-h,--help}'[show help]' \\
            '(-s --silent)'{-s,--silent}'[suppress output messages]' \\
            '--verbose[show verbose output]'
          ;;
      esac
      ;;
  esac
}

_agency "$@"
`

export const completions = (shell: string | undefined) =>
	Effect.gen(function* () {
		if (!shell || !shells.includes(shell as Shell)) {
			return yield* Effect.fail(
				new Error("Usage: agency completions <bash|zsh>"),
			)
		}

		console.log(
			shell === "bash" ? generateBashCompletions() : generateZshCompletions(),
		)
	})

export const help = `
Usage: agency completions <bash|zsh>

Generate shell completion scripts.

Examples:
  agency completions zsh > ~/.zsh/completions/_agency
  agency completions bash > ~/.local/share/bash-completion/completions/agency
`
