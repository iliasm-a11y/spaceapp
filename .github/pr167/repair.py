#!/usr/bin/env python3
"""Reproduce one reviewed PR167 merge tree; never publish or rewrite refs."""
import base64
import gzip
import hashlib
import pathlib
import re
import subprocess
import sys

HEAD = '91395b1f4de1712c8790957234305697ad607ef3'
UPSTREAM = '50272acbe54c4d82bd3174d712456f6bf3af2e53'
TREE = '4a6248b99690d9d291330f3dacad0c291cf433bf'
PATCH_SHA256 = '79a69e5ae1dd797c27f6d3fcde2fdd09530e3b459b63e5083198f55fa2749901'

def git(*args, **kwargs):
    return subprocess.run(['git', *args], check=True, **kwargs)

def output(*args):
    return subprocess.check_output(['git', *args], text=True).strip()

def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: repair.py PATCH_BASE64_PATH')
    patch = gzip.decompress(base64.b64decode(pathlib.Path(sys.argv[1]).read_bytes()))
    if hashlib.sha256(patch).hexdigest() != PATCH_SHA256:
        raise SystemExit('Patch digest mismatch')
    if output('rev-parse', 'HEAD') != HEAD:
        raise SystemExit('Refusing unexpected candidate starting head')
    if output('rev-parse', 'origin/audit-upstream') != UPSTREAM:
        raise SystemExit('Refusing unexpected upstream revision')
    if output('status', '--porcelain'):
        raise SystemExit('Refusing a nonempty worktree')
    result = subprocess.run(['git', '-c', 'user.name=PR167 validation', '-c', 'user.email=validation@localhost', 'merge', '--no-commit', '--no-ff', 'origin/audit-upstream'])
    conflicts = set(output('diff', '--name-only', '--diff-filter=U').splitlines())
    expected = {'CHANGELOG.md', 'apps/api/src/auth.ts', 'scripts/tests/public-credential-install.test.mjs'}
    if result.returncode != 1 or conflicts != expected:
        raise SystemExit(f'Unexpected merge result: {result.returncode}, {conflicts}')
    pattern = re.compile(r'^<<<<<<< HEAD\n(.*?)^=======\n(.*?)^>>>>>>> [^\n]+\n', re.S | re.M)
    for filename in sorted(expected):
        path = pathlib.Path(filename)
        def resolve(match):
            ours, theirs = match.groups()
            if filename == 'CHANGELOG.md':
                return ours + '\n' + theirs
            if filename == 'apps/api/src/auth.ts':
                if 'secureCookies: boolean;' in ours:
                    return theirs + ours.replace('  secureCookies: boolean;\n', '')
                if 'secureCookies: env.NODE_ENV === "production",' in ours:
                    return theirs + '    googleAuthDisabled,\n'
                raise ValueError('Unrecognized auth conflict')
            if filename == 'scripts/tests/public-credential-install.test.mjs':
                if '$(wc -c)' not in theirs:
                    raise ValueError('Unrecognized credential fixture conflict')
                return theirs.replace('$(wc -c)', '$(wc -c | tr -d "[:space:]")')
            raise ValueError(filename)
        resolved, count = pattern.subn(resolve, path.read_text())
        if count != (2 if filename == 'apps/api/src/auth.ts' else 1):
            raise SystemExit(f'Unexpected conflict count in {filename}: {count}')
        path.write_text(resolved)
        git('add', filename)
    git('apply', '--index', '--check', '-', input=patch)
    git('apply', '--index', '-', input=patch)
    # Normalize the macOS cwd alias while still checking the complete client argument list.
    path = pathlib.Path('scripts/tests/dev-stack.test.mjs')
    text = path.read_text()
    text = text.replace('readFileSync, readdirSync, renameSync', 'readFileSync, realpathSync, readdirSync, renameSync')
    text = text.replace('assert.deepEqual(output.args, ["--server", "http://127.0.0.1:54096", directory]);', 'assert.deepEqual(output.args, ["--server", "http://127.0.0.1:54096", realpathSync(directory)]);')
    path.write_text(text)
    # Reproduced on unmodified upstream: the fixture still expected 6.28.1, Dockerfile ships 6.29.1.
    path = pathlib.Path('scripts/tests/public-docker-distribution.test.mjs')
    text = path.read_text()
    if text.count(r'6\.28\.1') != 2:
        raise SystemExit('Unexpected upstream Undici fixture')
    path.write_text(text.replace(r'6\.28\.1', r'6\.29\.1'))
    path = pathlib.Path('scripts/dev-stack-state.mjs')
    path.write_text(path.read_text().replace('@returns {{api: number, web: number, postgres: number, temporal: number}} Validated loopback bindings.', '@returns {{api: number, web: number, postgres: number, temporal: number, opencode?: number}} Validated loopback bindings; legacy recovery omits OpenCode.'))
    path = pathlib.Path('.github/workflows/ci.yml')
    text = path.read_text()
    text = text.replace('  dev-stack:\n    name: Contributor stack from a fresh checkout\n    runs-on: ubuntu-latest\n', '  dev-stack:\n    name: Contributor stack (${{ matrix.os }})\n    strategy:\n      fail-fast: false\n      matrix:\n        os: [ubuntu-latest, macos-latest]\n    runs-on: ${{ matrix.os }}\n')
    text = text.replace('      - name: Non-TTY owner, OpenCode, reload, supervision and cleanup proof\n        run: npm run smoke:dev-stack', "      - name: Non-TTY owner, concurrent OpenCode panes, reload and cleanup proof\n        if: runner.os == 'Linux'\n        run: npm run smoke:dev-stack")
    text = text.replace('      - name: Retry owned fixture cleanup after an interrupted test\n        if: always()', "      - name: Retry owned fixture cleanup after an interrupted test\n        if: always() && runner.os == 'Linux'")
    path.write_text(text)
    git('add', 'scripts/tests/dev-stack.test.mjs', 'scripts/tests/public-docker-distribution.test.mjs', 'scripts/dev-stack-state.mjs', '.github/workflows/ci.yml')
    git('diff', UPSTREAM, '--check')
    actual = output('write-tree')
    if actual != TREE:
        raise SystemExit(f'Candidate tree mismatch: {actual} != {TREE}')
    print(f'VERIFIED_CANDIDATE_TREE={actual}', flush=True)
    print(f'VERIFIED_PR_PARENT={HEAD}', flush=True)
    print(f'VERIFIED_UPSTREAM_PARENT={UPSTREAM}', flush=True)

if __name__ == '__main__':
    main()
