import { ripgrep } from "ripgrep";

// Preserve ripgrep's 0 (match), 1 (no match), and 2 (error) exit statuses.
const { code } = await ripgrep(process.argv.slice(2), { nodeWasi: false });
process.exitCode = code;
