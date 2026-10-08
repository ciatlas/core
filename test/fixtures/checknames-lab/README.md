# Check-run names captured from GitHub

The workflows here are a copy of the private lab repository `rumankazi/flowpact-checknames-lab`. `expected.json` lists
the check runs GitHub reported for them (commit and command inside). `packages/core/test/checks.test.ts` computes the
names with flowpact's engine and requires an exact match, so any change in GitHub's naming shows up as a failing test
after the lab is re-run and `expected.json` is refreshed.

Two lab jobs depend on runtime facts and are marked in the test: `after-boom` is skipped because the job it needs
fails, and `Ref ${{ github.event_name }}` reads the triggering event.
