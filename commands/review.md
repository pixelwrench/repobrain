---
description: Quiz yourself on due CodeBrain cards for this repository
allowed-tools: Bash(codebrain due *), Bash(codebrain answer *), Bash(codebrain grade *)
---
If `codebrain` isn't found, say the plugin's CLI isn't built or installed (run `npm run build` in the plugin's folder) and stop. Every `codebrain` command prints JSON; on a non-zero exit it carries an `error` field.

Run `codebrain due --limit 10`. If it fails, show the error and stop; if it says the repository isn't connected, suggest `/codebrain:connect`. If `due` is empty, say nothing is due in one line and stop.

`due` gives questions only. Ask one card at a time:
- Multiple choice (`body.kind: "mcq"`): show the question and the four choices labelled A-D.
- Flashcard: show the front.

If a card has `codeChanged: true`, mention that the code at its `path` has changed since the card was written, so the answer may be out of date.

Wait for the user's reply. Only then run `codebrain answer <id>`; never run it before they reply. Judge the reply: for multiple choice compare it with `correct` and give the `explanation`; for a flashcard show the `back` and ask "Did you get it?" unless their reply makes it clear. Then record it:
- right: `codebrain grade <id> right`
- wrong: `codebrain grade <id> wrong`
- the user says they didn't know: `codebrain grade <id> didnt-know`

If `answer` or `grade` fails, show its `error` and go on to the next card.
Stop after the last due card or when the user wants to stop. End with how many were right out of how many answered.
