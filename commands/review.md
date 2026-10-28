---
description: Quiz yourself on due CodeBrain cards for this repository
allowed-tools: Bash(codebrain *)
---
Run `codebrain due --limit 10` and read its JSON. On a non-zero exit, show its `error` and stop. If `due` is empty, say nothing is due in one line and stop.

Ask one card at a time and never reveal the answer before the user replies.
- Multiple choice (`body.kind: "mcq"`): show the question and the four choices labelled A-D, and wait for the answer. The correct letter is `body.correct`.
- Flashcard (`body.kind: "flashcard"`): show the front and wait. Then show the back and ask "Did you get it?"

If a card has `codeChanged: true`, mention when you show it that the code at its `path` has changed since the card was written, so the answer may be out of date.

After each reply, say whether it was right, give the explanation (or the back), and record it:
- right: `codebrain grade <id> right`
- wrong: `codebrain grade <id> wrong`
- the user says they didn't know: `codebrain grade <id> didnt-know`

If grading fails, show its `error` and carry on with the next card.
Stop after the last due card or when the user wants to stop. End with how many were right out of how many answered.
