export async function settleQueuedPromptCleanup(
  afterPrompt: (() => Promise<void>) | undefined,
  stopTyping: (() => void) | undefined,
  reportError: (error: unknown) => void,
): Promise<void> {
  try {
    await afterPrompt?.();
  } catch (error) {
    reportError(error);
  } finally {
    stopTyping?.();
  }
}
