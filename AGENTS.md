# Repository source-of-truth rules

This repository uses `src/` as the only application source tree.

## Application entrypoint

- Production entrypoint: `src/index.js`
- Start command: `node src/index.js`
- `package.json` and `Procfile` must continue to point to `src/index.js`.

## Source layout

All application JavaScript modules must live under `src/`.
Do not create duplicate application modules in the repository root.

Examples of files that belong only under `src/`:

- `index.js`
- `db.js`
- `historicalSignals.js`
- `knownStockNames.js`
- `migrate.js`
- `pendingSignals.js`
- `portfolio.js`
- `signalParser.js`
- `stockPrice.js`
- `scheduler.js`
- `tracker.js`

## Change policy

When modifying the bot, edit the existing module under `src/` instead of creating a root-level copy.
Before adding a new module, check whether an equivalent module already exists under `src/`.

The repository root should contain project/configuration files only, such as `package.json`, `Procfile`, documentation, and repository metadata.
