# Incoming spreadsheets (local only)

Put real petition mail / signature list spreadsheets here **only while running imports** on your machine.

- **Do not commit** real spreadsheets; they contain sensitive petition and signer information.
- This directory is gitignored except this README.
- Always run **`--preflight-file`** before a real import to validate mapping, QA flags, and row counts without touching the database.

Example preflight:

```bash
npm run voter-match -- --preflight-file --file "./tools/voter-file-matcher/incoming/YourFile.xlsx" --profile ./tools/voter-file-matcher/configs/petition-mail-list-share-v1.json
```
