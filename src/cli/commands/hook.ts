export function hookMain(): Promise<void> {
  console.error('block-party hook: not implemented yet');
  process.exitCode = 2;
  return Promise.resolve();
}
