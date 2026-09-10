# Shopping-list development exercises

This app intentionally starts with the three functional defects listed in
`README.md`. Fix only the bug or feature in the assigned Root Issue; do not
"helpfully" fix the rest of the practice backlog.

- Use Node's standard library and plain browser HTML/CSS/JavaScript. No database,
  dependencies, installation step, or build step is needed.
- Keep the app local-only. Preserve validation, bounded requests, text-only
  rendering of user input, atomic JSON writes, and explicit error messages.
- `npm test` covers working behavior. `npm run test:bugs` contains three
  correct-behavior assertions that intentionally fail in the starting version.
  When fixing one, move its regression into the normal test suite. Do not change
  assertions to expect the bug or require unrelated exercises to pass.
- Update app documentation when changing behavior.
- Do not modify `demo/shopping-list/baseline.json`, the backlog, reset tooling,
  `.github/`, or other repositories as part of an app exercise. The baseline is
  the immutable starting point, not another copy of the implementation to fix.
- Do not run reset/seed commands or mutate GitHub Issues from an implementation
  task. Use the WorkGraph reporting protocol when dispatched by WorkGraph.
