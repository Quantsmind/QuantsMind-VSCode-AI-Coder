import { COMMANDS } from '../commands/ids';

/** Persisted once per profile, before the notice is shown, so it never repeats. */
export const FIRST_RUN_NOTICE_KEY = 'quantsmind.onboarding.firstRunNotice.v1';

export const configureProviderItem = 'Configure provider';
export const setApiKeyItem = 'Set API key';

export interface FirstRunProviderState {
  readonly displayName: string;
  readonly model: string;
  readonly endpointHost: string;
  readonly ready: boolean;
  readonly configurationError?: string;
}

export interface FirstRunNoticeDependencies {
  isShown(): boolean;
  markShown(): Promise<unknown>;
  getProvider(): Promise<FirstRunProviderState>;
  show(message: string, items: readonly string[]): Promise<string | undefined>;
  runCommand(command: string): Promise<unknown>;
  onError(message: string, error: unknown): void;
}

export type FirstRunOutcome =
  | { readonly kind: 'skipped' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'shown'; readonly choice?: string };

export function buildFirstRunMessage(provider: FirstRunProviderState): string {
  const current = provider.configurationError !== undefined
    ? `The endpoint is not usable: ${provider.configurationError}`
    : `Currently ${provider.displayName}, model "${provider.model}", endpoint ${provider.endpointHost}.`;
  const credential = provider.ready
    ? 'Send a message whenever you are ready.'
    : 'A remote endpoint also needs an API key.';
  return [
    'QuantsMind: first run.',
    current,
    'Set the endpoint with "quantsmind.provider.baseUrl" and the model with',
    '"quantsmind.provider.model" — every other provider setting has a working',
    'default. ' + credential,
  ].join(' ');
}

/**
 * One-time orientation for a profile that has never seen the extension. The
 * notice is deliberately the only onboarding step: 21 settings with no pointer
 * is the failure mode this guards against.
 */
export async function showFirstRunNotice(
  deps: FirstRunNoticeDependencies,
): Promise<FirstRunOutcome> {
  if (deps.isShown()) {
    return { kind: 'skipped' };
  }

  let provider: FirstRunProviderState;
  try {
    provider = await deps.getProvider();
  } catch (error) {
    deps.onError('first-run provider status unavailable', error);
    return { kind: 'failed' };
  }

  const items = provider.ready
    ? [configureProviderItem]
    : [setApiKeyItem, configureProviderItem];

  try {
    await deps.markShown();
  } catch (error) {
    deps.onError('first-run notice could not be recorded', error);
    return { kind: 'failed' };
  }

  let choice: string | undefined;
  try {
    choice = await deps.show(buildFirstRunMessage(provider), items);
  } catch (error) {
    deps.onError('first-run notice could not be shown', error);
    return { kind: 'shown' };
  }

  if (choice === undefined) {
    return { kind: 'shown' };
  }

  const command =
    choice === setApiKeyItem ? COMMANDS.setApiKey : COMMANDS.configureProvider;
  try {
    await deps.runCommand(command);
  } catch (error) {
    deps.onError(`first-run action ${command} failed`, error);
  }

  return { kind: 'shown', choice };
}
