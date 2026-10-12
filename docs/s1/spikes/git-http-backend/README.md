# S1-T1 spike — git-http-backend (THROWAWAY)

Evidence-gathering spike for `docs/s1/selection.md`. Not product code.
Rerun commands: see docs/s1/selection.md Appendix A.

Rules source & version (sprint scenario S3, G1/G2 fix 2026-10-12): `docs/contracts/rules-version.json`, rulesVersion **1.0.0-draft.1** (S1-T2 validation contract — the same machine source [api.md](../../../contracts/api.md) cites). The pre-receive hook's title check is a minimal subset of those rules; it asserts its builtin version constant against the manifest (drift alarm) and surfaces `rulesVersion` in its pre-receive report line. Manifest-driven validation itself is S3-T3 work; this spike stays THROWAWAY.
