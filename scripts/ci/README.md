# Runner policy guard

Run `bash scripts/ci/test-no-hosted-runners.sh` to check every workflow and the
positive/negative regression cases. Requires `/usr/bin/python3` and PyYAML
(`python3-yaml` on the Forge Ubuntu image, explicitly installed by CI).
The probes use private temporary directories and do not delete files.

## Canonical sources

- `no-hosted-runners.sh`: smarty-dev `scripts/ci/no-hosted-runners.sh` at
  `8dbf8566ae9611a0d6aabb7db4aa4acc1e1a1002` (smarty-dev#1246), unchanged except
  for appending the owned-runner check.
- `owned-runner-policy.py`: constants and the pure `strings`, `runner_values`,
  and `hosted_labels` functions copied unchanged from smarty-dev
  `setup/factory/actions_minutes.py` at
  `41e21cf136231f8d0dcb723cf0a61e10d7b9d10a` (policy version 8; #1246/#3193).
  Only the local, read-only, per-job command adapter is new. It imports no fleet
  network, credential, state-writing, or notification machinery.

Only exact owned pool labels or groups establish ownership. Standard
`self-hosted`/OS/architecture labels are constraints, not ownership evidence;
unknown labels remain refused even next to an owned label. Expression-built
selectors are refused. The canonical shell additionally refuses runner anchors,
aliases and block scalars. Reusable-workflow calls have no runner of their own.

The existing npm trusted-publishing exception is now an exact checked-in
`release.yml publish ubuntu-latest` entry in `hosted-runner-allowlist.txt`, bound
to the original owner-approval comment. Workflow comments alone cannot approve
hosted use. Exceptions cannot cross jobs/files, and unused entries fail.
No runner-wide, provider-wide, or `smarty-*` prefix exception is introduced.
