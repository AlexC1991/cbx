# Contributing

Issues and pull requests are welcome.

- Run `npm test` in both `cbx/` and `cli/` before sending a change.
- A change to anything in `.cbx/` or on the wire changes a specification:
  update `cbx/spec/FORMAT.md` or `cbx/spec/PROTOCOL.md` in the same change,
  and add or update a test vector where one applies.
- Anything that writes to somebody's folder must refuse rather than overwrite
  work it was not asked to discard. Tests that show the refusal are part of
  the change.

This repository is published from CodeRook's own source, so a merged pull
request is applied there and appears here with the next release. By
contributing you agree that your contribution is licensed under the Apache
License 2.0, as section 5 of the licence describes.
