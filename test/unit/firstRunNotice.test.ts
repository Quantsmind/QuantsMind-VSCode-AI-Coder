import { expect } from 'chai';
import { COMMANDS } from '../../src/commands/ids';
import {
  FIRST_RUN_NOTICE_KEY,
  configureProviderItem,
  setApiKeyItem,
  showFirstRunNotice,
  type FirstRunNoticeDependencies,
  type FirstRunProviderState,
} from '../../src/onboarding/firstRun';

interface Harness {
  deps: FirstRunNoticeDependencies;
  calls: string[];
  messages: string[];
  items: (readonly string[])[];
  commands: string[];
  errors: string[];
  shown: boolean;
}

const readyProvider: FirstRunProviderState = {
  displayName: 'OpenAI-compatible',
  model: 'gpt-4o-mini',
  endpointHost: 'api.openai.com',
  ready: true,
};

function createHarness(
  overrides: Partial<FirstRunNoticeDependencies> = {},
): Harness {
  const harness: Harness = {
    deps: {} as FirstRunNoticeDependencies,
    calls: [],
    messages: [],
    items: [],
    commands: [],
    errors: [],
    shown: false,
  };

  harness.deps = {
    isShown: () => {
      harness.calls.push('isShown');
      return harness.shown;
    },
    markShown: async () => {
      harness.calls.push('markShown');
      harness.shown = true;
    },
    getProvider: async () => {
      harness.calls.push('getProvider');
      return readyProvider;
    },
    show: async (message, items) => {
      harness.calls.push('show');
      harness.messages.push(message);
      harness.items.push(items);
      return undefined;
    },
    runCommand: async (command) => {
      harness.calls.push('runCommand');
      harness.commands.push(command);
    },
    onError: (message) => {
      harness.calls.push('onError');
      harness.errors.push(message);
    },
    ...overrides,
  };

  return harness;
}

suite('first-run notice', () => {
  test('stays hidden once the profile has seen it', async () => {
    const harness = createHarness();
    harness.shown = true;

    const outcome = await showFirstRunNotice(harness.deps);

    expect(outcome.kind).to.equal('skipped');
    expect(harness.calls).to.deep.equal(['isShown']);
  });

  test('names the two settings that matter and the current target', async () => {
    const harness = createHarness();

    await showFirstRunNotice(harness.deps);

    expect(harness.messages).to.have.length(1);
    const message = harness.messages[0];
    expect(message).to.contain('quantsmind.provider.baseUrl');
    expect(message).to.contain('quantsmind.provider.model');
    expect(message).to.contain('api.openai.com');
    expect(message).to.contain('gpt-4o-mini');
    expect(message).to.contain('OpenAI-compatible');
  });

  test('records the notice before showing it', async () => {
    const harness = createHarness();

    await showFirstRunNotice(harness.deps);

    expect(harness.calls.indexOf('markShown')).to.be.lessThan(harness.calls.indexOf('show'));
  });

  test('does not consume the notice when the provider status fails', async () => {
    const harness = createHarness({
      getProvider: async () => {
        throw new Error('status unavailable');
      },
    });

    const outcome = await showFirstRunNotice(harness.deps);

    expect(outcome.kind).to.equal('failed');
    expect(harness.calls).to.not.contain('markShown');
    expect(harness.calls).to.not.contain('show');
    expect(harness.errors).to.deep.equal(['first-run provider status unavailable']);
    expect(harness.shown).to.equal(false);
  });

  test('offers the API key action only when the provider is not ready', async () => {
    const notReady = createHarness({
      getProvider: async () => ({ ...readyProvider, ready: false }),
    });
    await showFirstRunNotice(notReady.deps);
    expect(notReady.items[0]).to.deep.equal([setApiKeyItem, configureProviderItem]);

    const ready = createHarness();
    await showFirstRunNotice(ready.deps);
    expect(ready.items[0]).to.deep.equal([configureProviderItem]);
  });

  test('reports an unusable endpoint instead of its host', async () => {
    const harness = createHarness({
      getProvider: async () => ({
        ...readyProvider,
        ready: false,
        endpointHost: 'invalid endpoint',
        configurationError: 'The provider base URL is not configured.',
      }),
    });

    await showFirstRunNotice(harness.deps);

    expect(harness.messages[0]).to.contain('The endpoint is not usable');
    expect(harness.messages[0]).to.contain('not configured');
    expect(harness.messages[0]).to.not.contain('invalid endpoint');
  });

  test('dismissal opens nothing', async () => {
    const harness = createHarness();

    const outcome = await showFirstRunNotice(harness.deps);

    expect(outcome).to.deep.equal({ kind: 'shown' });
    expect(harness.commands).to.deep.equal([]);
  });

  test('routes each action to its existing command', async () => {
    const configured = createHarness({
      show: async () => configureProviderItem,
    });
    await showFirstRunNotice(configured.deps);
    expect(configured.commands).to.deep.equal([COMMANDS.configureProvider]);

    const keyed = createHarness({
      getProvider: async () => ({ ...readyProvider, ready: false }),
      show: async () => setApiKeyItem,
    });
    const outcome = await showFirstRunNotice(keyed.deps);
    expect(keyed.commands).to.deep.equal([COMMANDS.setApiKey]);
    expect(outcome).to.deep.equal({ kind: 'shown', choice: setApiKeyItem });
  });

  test('swallows an action failure after the notice was shown', async () => {
    const harness = createHarness({
      show: async () => configureProviderItem,
      runCommand: async () => {
        throw new Error('command failed');
      },
    });

    const outcome = await showFirstRunNotice(harness.deps);

    expect(outcome).to.deep.equal({ kind: 'shown', choice: configureProviderItem });
    expect(harness.errors).to.deep.equal([`first-run action ${COMMANDS.configureProvider} failed`]);
  });

  test('persists under the documented global-state key', () => {
    expect(FIRST_RUN_NOTICE_KEY).to.equal('quantsmind.onboarding.firstRunNotice.v1');
  });
});
