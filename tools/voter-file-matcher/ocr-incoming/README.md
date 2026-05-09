# OCR incoming (private server storage)

- Temporary **JPEG/PNG** uploads for the VoteMatch OCR pipeline are written here (`tools/voter-file-matcher/ocr-incoming/<batch_id>/`).
- **Do not commit** real petition images or scans.
- This directory is **not** served as static files from `public/` and must not be exposed by the web server.
- Operators should treat contents as **sensitive**; rotate or purge disks according to your retention policy.
