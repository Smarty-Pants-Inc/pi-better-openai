#!/usr/bin/env python3
"""Local owned-runner check; no network, credentials, or mutable state.

Policy constants and pure helpers below are copied unchanged from
smarty-dev setup/factory/actions_minutes.py at
41e21cf136231f8d0dcb723cf0a61e10d7b9d10a (guard policy version 8).
The shell entrypoint retains the canonical #1246 hosted-runner checks.
"""
import re
import sys
from pathlib import Path

OWNED_LABELS = frozenset({'smarty-linux-x64', 'playful-linux-x64', 'smarty-ci-dev2', 'smarty-ci-linux-arm64',
                          'smarty-ci-linux-x64', 'smarty-ci-windows-x64'})
OWNED_GROUPS = frozenset({'smarty linux ci', 'smarty windows ci', 'smarty dev2 ci'})
RUNNER_CONSTRAINTS = frozenset({'self-hosted', 'linux', 'macos', 'windows', 'arm64', 'x64'})
GUARD_VERSION = 8  # bump when selector policy changes: an unchanged blob still needs reparsing
EXPRESSION = re.compile(r'\$\{\{(.*?)\}\}', re.S)
FALLBACK_LABEL = re.compile(r"(?:&&|\|\|)\s*'((?:[^']|'')*)'")
APPROVAL_ISSUE = re.compile(r'https://github\.com/Smarty-Pants-Inc/[\w.-]+/issues/[1-9][0-9]*(?:#[^\s]*)?')
UNPARSEABLE = '<workflow YAML does not parse>'
UNOWNED = '<runner ownership not established>'


def strings(value):
    """Every string inside a YAML value (a string, a list or a mapping, nested)."""
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [t for v in value.values() for t in strings(v)]
    if isinstance(value, list):
        return [t for v in value for t in strings(v)]
    return []


def runner_values(value, matrix):
    """Literal selectors and expression fallbacks (legacy API; matrix is deliberately unused)."""
    if isinstance(value, list):
        return [alternative for item in value for alternative in
                (runner_values(item, None) if isinstance(item, str) else [[UNPARSEABLE]])] or [[UNPARSEABLE]]
    if not isinstance(value, str) or not value.strip():
        return [[UNPARSEABLE]]  # malformed labels must not disappear beside an owned selector
    return [[value.strip()] + [label.replace("''", "'") for expression in EXPRESSION.findall(value)
                              for label in FALLBACK_LABEL.findall(expression)]]


def hosted_labels(text):
    """Sorted paid or unowned selectors. Only literal labels/groups can prove runner ownership.
    Expressions remain full findings, even beside owned literals; matrix metadata is never interpreted."""
    import yaml  # the factory host's /usr/bin/python3 has PyYAML (review_gate.py)

    class WorkflowLoader(yaml.SafeLoader):
        def construct_mapping(self, node, deep=False):
            # Keep structural keys verbatim (on/yes are distinct job IDs), not YAML 1.1 scalars.
            self.flatten_mapping(node)
            return {self.construct_scalar(key): self.construct_object(value, deep=deep)
                    for key, value in node.value}

    try:
        doc = yaml.load(text, Loader=WorkflowLoader)
    except yaml.YAMLError:
        return [UNPARSEABLE]
    jobs = doc.get('jobs') if isinstance(doc, dict) else None
    found = set()
    for body in (jobs.values() if isinstance(jobs, dict) else []):
        if not isinstance(body, dict) or 'runs-on' not in body:
            continue  # a reusable-workflow call (`uses:`) has no runner of its own
        selector = body['runs-on']
        if isinstance(selector, dict):
            labels = strings(runner_values(selector['labels'], None)) if 'labels' in selector else []
            if not selector or selector.keys() - {'labels', 'group'}:
                labels.append(UNPARSEABLE)
            group = selector.get('group')
            groups = (strings(runner_values(group, None)) if isinstance(group, str) else [UNPARSEABLE]) \
                if 'group' in selector else []
        else:
            labels, groups = strings(runner_values(selector, None)), []
        refused = {label for label in labels if label.lower() not in OWNED_LABELS | RUNNER_CONSTRAINTS}
        refused.update(group for group in groups if group.lower() not in OWNED_GROUPS)
        owned = any(label.lower() in OWNED_LABELS for label in labels) or (bool(groups) and
                all(group.lower() in OWNED_GROUPS for group in groups))
        found.update(refused or ([] if owned else [UNOWNED]))
    return sorted(found)



def main():
    import yaml

    class WorkflowLoader(yaml.SafeLoader):
        def construct_mapping(self, node, deep=False):
            self.flatten_mapping(node)
            return {self.construct_scalar(key): self.construct_object(value, deep=deep)
                    for key, value in node.value}

    allowed = set()
    for line in Path(sys.argv[1]).read_text().splitlines():
        if line.strip() and not line.lstrip().startswith('#'):
            workflow, job, label, _approval = line.split()
            allowed.add((workflow, job, label))
    failed = False
    for path in map(Path, sys.argv[2:]):
        text = path.read_text()
        if UNPARSEABLE in hosted_labels(text):
            print(f'{path}: {UNPARSEABLE}', file=sys.stderr)
            failed = True
            continue
        doc = yaml.load(text, Loader=WorkflowLoader)
        jobs = doc.get('jobs', {}) if isinstance(doc, dict) else {}
        if not isinstance(jobs, dict):
            print(f'{path}: malformed jobs mapping', file=sys.stderr)
            failed = True
            continue
        for job, body in jobs.items():
            # Evaluate each job independently so an exception never crosses jobs.
            selectors = hosted_labels(yaml.safe_dump({'jobs': {job: body}}))
            for label in selectors:
                if (path.name, job, label) not in allowed:
                    print(f'{path}: job {job}: unapproved runner: {label}', file=sys.stderr)
                    failed = True
    return int(failed)


if __name__ == '__main__':
    sys.exit(main())
