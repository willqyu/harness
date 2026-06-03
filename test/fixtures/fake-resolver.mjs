// Stand-in for `claude` acting as a conflict resolver. Reads the prompt on
// stdin, then writes a clean, marker-free config.txt into the cwd (the
// integration worktree), simulating an agent resolving the conflict in place.
import { writeFileSync } from "node:fs";

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (prompt += c));
process.stdin.on("end", () => {
  writeFileSync("config.txt", "value = resolved-by-agent\n");
  console.log("fake-resolver: rewrote config.txt without markers");
  process.exit(0);
});
