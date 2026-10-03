import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatFileList, resolveInWorkspace } from '../src/util/project';

describe('formatFileList', () => {
  it('sorts paths and stops at the character budget', () => {
    const out = formatFileList(['b.ts', 'a.ts', 'c.ts'], 10);
    assert.equal(out.text, 'a.ts\nb.ts');
    assert.equal(out.shown, 2);
  });
  it('lists everything when it fits', () => {
    assert.equal(formatFileList(['x', 'y'], 100).shown, 2);
  });
});

describe('resolveInWorkspace', () => {
  const roots = ['/ws/a', '/ws/b'];
  it('gives one candidate per root for a relative path', () => {
    assert.deepEqual(resolveInWorkspace('src/x.ts', roots), ['/ws/a/src/x.ts', '/ws/b/src/x.ts']);
  });
  it('accepts an absolute path inside a root', () => {
    assert.deepEqual(resolveInWorkspace('/ws/b/x.ts', roots), ['/ws/b/x.ts']);
  });
  it('rejects paths that escape the workspace', () => {
    assert.deepEqual(resolveInWorkspace('../../etc/passwd', roots), []);
    assert.deepEqual(resolveInWorkspace('/etc/passwd', roots), []);
    assert.deepEqual(resolveInWorkspace('', roots), []);
  });
  it('normalizes backslashes', () => {
    assert.deepEqual(resolveInWorkspace('src\\x.ts', ['/ws/a']), ['/ws/a/src/x.ts']);
  });
});
