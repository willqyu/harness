// Stand-in for the `claude` CLI used by ClaudeAgentRunner tests.
// Reads the prompt from stdin and, unless FAKE_AGENT_NOOP is set, writes it to
// agent-output.txt in the cwd (the task worktree) and prints a short summary.
import { writeFileSync } from "node:fs";

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (prompt += chunk));
process.stdin.on("end", () => {
  if (process.env.FAKE_AGENT_NOOP) {
    console.log("fake-claude: noop");
    process.exit(0);
  }
  writeFileSync("agent-output.txt", prompt);
  console.log("fake-claude: wrote agent-output.txt; decided to keep it simple.");
  process.exit(0);
});
