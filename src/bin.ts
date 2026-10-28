#!/usr/bin/env node
import { main } from "./cli.js";

main(process.argv.slice(2)).then(
  ({ code, out }) => {
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stdout.write(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) + "\n");
    process.exitCode = 1;
  },
);
