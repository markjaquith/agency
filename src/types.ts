export interface Command {
  name: string;
  description: string;
  run: (args: string[], options: Record<string, any>) => Promise<void>;
  help: string;
}
