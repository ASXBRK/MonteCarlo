# Specs

Specs are the durable record of what was asked.

They are written before implementation and are not edited afterwards
to match what was built. Where implementation diverged from a spec —
a correction, a simplification, a scope cut, a defect found later —
that belongs in the commit message or in `docs/reference/build-log.md`,
not as an edit to the spec itself.

A spec describes intent at the time it was written. If it stopped
matching the code the day after it landed, that's expected, not a bug
in the spec: the spec's job is to answer "what did we ask for and why",
not "what does the code currently do." Keeping it frozen is what makes
it trustworthy as a record — an editable spec is just a second,
less-current copy of the code comments.

See `CLAUDE.md`'s Workflow rules for how specs are meant to be used
day to day (read from disk, never from a paraphrase; stop rather than
reconstruct a missing one).
