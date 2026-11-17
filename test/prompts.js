/** Accumulate terminal chunks; consume each prompt once, even across chunk boundaries. */
export function promptMatcher(write, answers) {
  let text = '', index = 0;
  return chunk => {
    text += String(chunk);
    while (true) {
      const next = answers?.[index] ?? (answers ? undefined : { prompt: 'Type "confirm"', answer: 'confirm' });
      if (!next) return;
      const at = text.indexOf(next.prompt);
      if (at < 0) return;
      text = text.slice(at + next.prompt.length); index++; write(next.answer + '\n');
    }
  };
}
