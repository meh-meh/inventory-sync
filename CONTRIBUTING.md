# Contributing

Thanks for contributing! This project follows a few simple rules to keep contributions smooth and maintainable.

## How to run the project locally

1. Clone the repo and install dependencies:

```powershell
npm install
```

1. Start MongoDB locally (or use a Docker/MongoDB Atlas instance).
1. Start the app:

```powershell
npm start
```

## Running tests

- Run integration tests (uses an in-memory MongoDB):

```powershell
npm test
```

- Seed local deterministic test DB (for local manual testing):

```powershell
npm run seed:test-db
npm run start:test
```

## Coding style

- JavaScript files follow existing project conventions (ES6+, camelCase for functions/vars, PascalCase for classes).
- Run `npx prettier --write .` before committing.

## PR workflow

1. Create a feature branch named like `feature/short-description` or `fix/issue-123`.
2. Make small, focused commits.
3. Run tests locally and ensure they pass.
4. Open a PR against `dev` branch and include a short description and testing steps.

## Adding tests

- Add integration tests in `tests/integration/` using Jest + supertest.
- Prefer deterministic seeds (use `data/test-db.json`) to keep tests stable.

## CI

The repository has a smoke-tests workflow that runs integration smoke tests on push/PR. Keep the workflow green.

If you'd like me to add code owners or a CLA, tell me and I can add the necessary files.
