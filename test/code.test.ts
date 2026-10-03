import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildEditPrompt } from '../src/prompts';
import { cleanCompletion, extractCode, matchTrailingNewline } from '../src/util/code';
import { trimHistory } from '../src/util/history';

describe('extractCode', () => {
  it('takes the fenced block and ignores prose', () => {
    assert.equal(extractCode('Here:\n```ts\nconst a = 1;\n```\nDone.'), 'const a = 1;');
  });
  it('keeps nested fences by using the last closing fence', () => {
    assert.equal(extractCode('```md\n# T\n```js\nx\n```\n```'), '# T\n```js\nx\n```');
  });
  it('handles an unterminated fence', () => {
    assert.equal(extractCode('```py\nprint(1)\n'), 'print(1)\n');
  });
  it('treats an unfenced reply as the code', () => {
    assert.equal(extractCode('\nfoo()\n'), 'foo()');
  });
  it('preserves indentation', () => {
    assert.equal(extractCode('```\n    indented\n```'), '    indented');
  });
});

describe('matchTrailingNewline', () => {
  it('adds a newline only if the original had one', () => {
    assert.equal(matchTrailingNewline('a', 'x\n'), 'a\n');
    assert.equal(matchTrailingNewline('a\n\n', 'x'), 'a');
  });
});

describe('cleanCompletion', () => {
  it('strips fences, echoed cursor and trailing space', () => {
    assert.equal(cleanCompletion('```js\nreturn 1;\n```'), 'return 1;');
    assert.equal(cleanCompletion('foo<CURSOR>  \n'), 'foo');
  });
});

describe('trimHistory', () => {
  const m = (role: 'user' | 'assistant', content = 'x') => ({ role, content });
  it('keeps the newest messages and starts on a user turn', () => {
    const out = trimHistory([m('user', '1'), m('assistant', '2'), m('user', '3'), m('assistant', '4'), m('user', '5')], 4);
    assert.deepEqual(out.map((x) => x.content), ['3', '4', '5']);
  });
  it('drops old messages beyond the char budget but always keeps the newest', () => {
    const out = trimHistory([m('user', 'a'.repeat(50)), m('assistant', 'b'), m('user', 'c'.repeat(100))], 30, 60);
    assert.deepEqual(out.map((x) => x.content.length), [100]);
  });
});

describe('buildEditPrompt', () => {
  it('wraps code in tags and omits empty context', () => {
    const p = buildEditPrompt({ fileName: 'a.ts', languageId: 'typescript', instruction: 'do', code: 'x', before: '  ', after: 'y' });
    assert.ok(p.includes('<code_to_edit>\nx\n</code_to_edit>'));
    assert.ok(!p.includes('context_before'));
    assert.ok(p.includes('<context_after read_only="true">\ny\n</context_after>'));
  });
});
