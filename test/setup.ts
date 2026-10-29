import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate every test from the developer's own git config and identity.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_AUTHOR_NAME = "Test";
process.env.GIT_AUTHOR_EMAIL = "test@example.com";
process.env.GIT_COMMITTER_NAME = "Test";
process.env.GIT_COMMITTER_EMAIL = "test@example.com";

// A test that forgets useTempHome() must not touch the real ~/.repobrain.
process.env.REPOBRAIN_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repobrain-home-default-")));

// A test that forgets to fake claude must not run the real one: this stub comes first on PATH.
const stubBin = fs.mkdtempSync(path.join(os.tmpdir(), "repobrain-claude-stub-"));
fs.writeFileSync(path.join(stubBin, "claude"), "#!/bin/sh\necho 'repobrain test setup: the real claude must never run in tests' >&2\nexit 97\n", { mode: 0o755 });
process.env.PATH = `${stubBin}${path.delimiter}${process.env.PATH ?? ""}`;
