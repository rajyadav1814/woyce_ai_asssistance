export const EDIT_SYSTEM =
  'You are a precise code-editing engine inside an IDE. Rewrite the code in <code_to_edit> according to the instruction. ' +
  'Reply with ONLY the complete replacement for that code inside a single fenced code block. ' +
  'No explanations. Keep the original indentation, style and language. Do not include the surrounding context in your reply.';

export const COMPLETION_SYSTEM =
  'You are a code completion engine. You get a file with a <CURSOR> marker. ' +
  'Output ONLY the text to insert at the cursor: no explanation, no markdown fences, and never repeat code that is already before the cursor. ' +
  'Keep it short (finish the current statement or block). If nothing sensible fits, output nothing.';

export interface EditPromptInput {
  fileName: string;
  languageId: string;
  instruction: string;
  code: string;
  before?: string;
  after?: string;
}

export function buildEditPrompt(p: EditPromptInput): string {
  const parts = [`File: ${p.fileName} (${p.languageId})`, `Instruction: ${p.instruction}`];
  if (p.before?.trim()) {
    parts.push(`<context_before read_only="true">\n${p.before}\n</context_before>`);
  }
  parts.push(`<code_to_edit>\n${p.code}\n</code_to_edit>`);
  if (p.after?.trim()) {
    parts.push(`<context_after read_only="true">\n${p.after}\n</context_after>`);
  }
  return parts.join('\n\n');
}

export function buildCompletionPrompt(fileName: string, languageId: string, prefix: string, suffix: string): string {
  return `File: ${fileName} (${languageId})\n\n${prefix}<CURSOR>${suffix}`;
}

export type EditKind = 'fix' | 'refactor' | 'docs';

export const EDIT_INSTRUCTIONS: Record<EditKind, string> = {
  fix: 'Fix the problems in this code with minimal changes.',
  refactor: 'Refactor this code for clarity and maintainability. Keep behavior identical.',
  docs:
    'Add concise documentation comments (idiomatic for the language: JSDoc, docstrings, etc.) to the functions, classes and methods. Do not change the code itself.',
};
