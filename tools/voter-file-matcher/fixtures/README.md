# Voter matcher fixtures

## `sample-signers.csv`

- **No PII:** all names, addresses, voter IDs, and locations are synthetic labels for automated tests (e.g. `TestFirst`, `FAKE-VRN-*`, `Demo St`, `Fixture Ave`).
- **Purpose:** exercise CSV parsing, header alias mapping (`configs/sos-voter-map.json`), `--dry-run`, and (after migration) a real import against a database that has **matching fake rows in the canonical voter table** if you want `MATCHED` outcomes.
- **Real matching:** the tool matches to whatever `VFM_CANONICAL_TABLE` points at (legacy tiers), or to **`VFM_MATCH_SOURCE_TABLE`** when set for **petition mail** profiles. Unless that relation contains rows that align with these fake keys/names, expect mostly `NOT_FOUND` / `WEAK_MATCH` / `ERROR` — that is normal for a fixture-only database.
- **Do not commit** real petition sheets, voter exports, or production maps.
- For **Petition Mail List Share**–style Excel lists, use the source profile at `../configs/petition-mail-list-share-v1.json` and run **`--preflight-file`** before import (see main `README.md`); never commit real `.xlsx` uploads.
- For **production** petition-mail imports, use **`--prepare-import-plan` → `--review-import-plan` → `--execute-import-plan`** (see main `README.md` “Guarded production import plans”); direct imports with that profile require **`--confirm-direct-import`** unless you use the dry-run path.

### Dry-run (no database writes)

Run from `petition_match/`:

```bash
npm run voter-match -- --file ./tools/voter-file-matcher/fixtures/sample-signers.csv --project sos --map ./tools/voter-file-matcher/configs/sos-voter-map.json --petition-code FIXTURE_TEST --petition-name "Fixture Test Petition" --source-label fixture --dry-run
```

### Real import (requires migration + `DATABASE_URL`)

```bash
npm run voter-match -- --file ./tools/voter-file-matcher/fixtures/sample-signers.csv --project sos --map ./tools/voter-file-matcher/configs/sos-voter-map.json --petition-code FIXTURE_TEST --petition-name "Fixture Test Petition" --source-label fixture
```

### SQL checks

See `acceptance-queries.sql` in this folder.

### Re-import / duplicates

Run the real import command twice. The duplicate row in the CSV targets the same synthetic `Voter ID` as row 1; if both rows **match the same** canonical `voter_id`, `voter_petition_signatures` should still have **one** row per `(voter_id, petition_id)` due to `ON CONFLICT DO UPDATE`. The duplicate-detection query in `acceptance-queries.sql` should return **zero** rows.
