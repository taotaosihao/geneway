export function isVisiblePersistedStreamingCheckpoint(input: Readonly<{
  invocationStatus: string | undefined;
  persistedStatus: string | undefined;
  persistedBody: string | undefined;
  browserText: string | null;
}>): boolean {
  const persistedBody = input.persistedBody ?? '';
  return ['pending', 'running'].includes(input.invocationStatus ?? '')
    && input.persistedStatus === 'streaming'
    && persistedBody.length > 0
    && input.browserText?.startsWith(persistedBody) === true;
}
