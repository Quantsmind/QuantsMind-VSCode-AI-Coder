import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planProviderModelSwitch, resolveProviderSettings } from '../../src/config/resolve';
import { listProviderProfileIds, providerModelDefault } from '../../src/providers/profiles';

const OPENAI_DEFAULT = 'gpt-4o-mini';
const GROQ_DEFAULT = 'llama-3.3-70b-versatile';
const GEMINI_DEFAULT = 'gemini-2.0-flash';
const EXPLICIT_GEMINI_MODEL = 'gemini-2.5-pro';

suite('provider switch model planning (D10)', () => {
  test('leaves the model untouched when the profile does not change', () => {
    const gemini = planProviderModelSwitch('gemini', 'gemini', EXPLICIT_GEMINI_MODEL);
    expect(gemini.model).to.equal(undefined);
    expect(gemini.requiresChoice).to.equal(false);
    expect(gemini.profileDefaultModel).to.equal(GEMINI_DEFAULT);

    const groq = planProviderModelSwitch('groq', 'groq', 'user-chosen-model');
    expect(groq.model).to.equal(undefined);
    expect(groq.requiresChoice).to.equal(false);
  });

  test('reported defect: an explicit gemini model is never silently carried into groq', () => {
    const plan = planProviderModelSwitch('gemini', 'groq', EXPLICIT_GEMINI_MODEL);

    // Neither failure mode is acceptable: keeping a model groq cannot serve, or
    // dropping an explicit user choice without asking.
    expect(plan.model).to.equal(GROQ_DEFAULT);
    expect(plan.model).to.not.equal(EXPLICIT_GEMINI_MODEL);
    expect(plan.requiresChoice).to.equal(true);
    expect(plan.profileDefaultModel).to.equal(GROQ_DEFAULT);
  });

  test('an explicit openai model switched to gemini requires a choice and offers the gemini default', () => {
    const plan = planProviderModelSwitch('openai', 'gemini', 'gpt-4.1');

    expect(plan.requiresChoice).to.equal(true);
    expect(plan.model).to.equal(GEMINI_DEFAULT);
    expect(plan.profileDefaultModel).to.equal(GEMINI_DEFAULT);
  });

  test('adopts the incoming default without prompting when the user never chose a model', () => {
    const fromGeneric = planProviderModelSwitch('openai-compatible', 'groq', OPENAI_DEFAULT);
    expect(fromGeneric.requiresChoice).to.equal(false);
    expect(fromGeneric.model).to.equal(GROQ_DEFAULT);

    const fromGemini = planProviderModelSwitch('gemini', 'groq', GEMINI_DEFAULT);
    expect(fromGemini.requiresChoice).to.equal(false);
    expect(fromGemini.model).to.equal(GROQ_DEFAULT);

    const fromGroq = planProviderModelSwitch('groq', 'gemini', GROQ_DEFAULT);
    expect(fromGroq.requiresChoice).to.equal(false);
    expect(fromGroq.model).to.equal(GEMINI_DEFAULT);
  });

  test('leaves the setting alone when the current model already is the incoming default', () => {
    const plan = planProviderModelSwitch('gemini', 'groq', GROQ_DEFAULT);

    expect(plan.model).to.equal(undefined);
    expect(plan.requiresChoice).to.equal(false);
    expect(plan.profileDefaultModel).to.equal(GROQ_DEFAULT);
    expect(resolveProviderSettings({ type: 'groq', model: plan.model }).model).to.equal(GROQ_DEFAULT);
  });

  test('does nothing for a target profile that has no default model', () => {
    for (const target of ['not-a-provider', '']) {
      const plan = planProviderModelSwitch('gemini', target, EXPLICIT_GEMINI_MODEL);
      expect(plan.model, target).to.equal(undefined);
      expect(plan.requiresChoice, target).to.equal(false);
      expect(plan.profileDefaultModel, target).to.equal(undefined);
    }
  });

  test('treats an empty current model as no explicit choice', () => {
    const plan = planProviderModelSwitch('gemini', 'groq', '');

    expect(plan.model).to.equal(GROQ_DEFAULT);
    expect(plan.requiresChoice).to.equal(false);
  });

  test('requires a choice when the outgoing profile has no default to compare against', () => {
    const plan = planProviderModelSwitch('unknown-outgoing-profile', 'groq', 'user-chosen-model');

    expect(plan.model).to.equal(GROQ_DEFAULT);
    expect(plan.requiresChoice).to.equal(true);
  });

  test('offers the target profile default for every ordered pair of known profiles', () => {
    const ids = listProviderProfileIds();
    for (const from of ids) {
      for (const to of ids) {
        if (from === to) {
          continue;
        }
        const plan = planProviderModelSwitch(from, to, 'user-chosen-model');
        const label = `${from} -> ${to}`;
        expect(plan.model, label).to.equal(providerModelDefault(to));
        expect(plan.profileDefaultModel, label).to.equal(providerModelDefault(to));
        expect(plan.requiresChoice, label).to.equal(true);
      }
    }
  });

  test('never requires a choice when no replacement model is offered', () => {
    const types = [...listProviderProfileIds(), 'not-a-provider', ''];
    for (const from of types) {
      for (const to of types) {
        const currents = [
          '',
          'user-chosen-model',
          providerModelDefault(from) ?? '',
          providerModelDefault(to) ?? '',
        ];
        for (const current of currents) {
          const plan = planProviderModelSwitch(from, to, current);
          const label = `${from} -> ${to} (current: "${current}")`;
          expect(plan.profileDefaultModel, label).to.equal(providerModelDefault(to));
          if (plan.model === undefined) {
            // The UI must not prompt when it has no alternative to offer.
            expect(plan.requiresChoice, label).to.equal(false);
          } else {
            expect(plan.model, label).to.equal(providerModelDefault(to));
            expect(plan.model, label).to.not.equal(current);
          }
        }
      }
    }
  });
});

suite('provider switch model resolution end to end (D10)', () => {
  test('the planned model resolves to a usable groq setting', () => {
    const plan = planProviderModelSwitch('gemini', 'groq', EXPLICIT_GEMINI_MODEL);
    const resolved = resolveProviderSettings({ type: 'groq', model: plan.model });

    expect(resolved.type).to.equal('groq');
    expect(resolved.model).to.equal(GROQ_DEFAULT);
    expect(resolved.baseUrl).to.equal('https://api.groq.com/openai/v1');
  });

  test('the planned model resolves to the target default for every profile', () => {
    for (const to of listProviderProfileIds()) {
      const plan = planProviderModelSwitch('gemini', to, EXPLICIT_GEMINI_MODEL);
      const resolved = resolveProviderSettings({ type: to, model: plan.model });
      expect(resolved.model, to).to.equal(providerModelDefault(to));
    }
  });
});

// Source contract, not behaviour: the quick pick and modal need an extension host.
// These pin the wiring that prevents a silent incompatible-model carry-over.
suite('provider switch UI wiring (D10)', () => {
  function selectProviderBody(): string {
    const source = readFileSync(join(__dirname, '..', '..', '..', 'src', 'extension.ts'), 'utf8');
    const start = source.indexOf('const selectProvider = async ()');
    expect(start, 'selectProvider must exist').to.be.at.least(0);
    const end = source.indexOf('\n  };', start);
    expect(end).to.be.greaterThan(start);
    return source.slice(start, end);
  }

  test('the switch plans the model from the current resolved settings', () => {
    const body = selectProviderBody();
    expect(body).to.contain('const currentModel = settings.getProviderSettings().model;');
    expect(body).to.contain('planProviderModelSwitch(current, picked.id, currentModel)');
  });

  test('an explicit incompatible model prompts, and dismissal writes nothing', () => {
    const body = selectProviderBody();
    const prompt = body.indexOf('if (plan.requiresChoice)');
    const update = body.indexOf('await settings.updateProviderType(');
    expect(prompt).to.be.at.least(0);
    expect(update).to.be.greaterThan(prompt);
    const guarded = body.slice(prompt, update);
    expect(guarded).to.contain('showQuickPick');
    expect(guarded).to.contain('if (choice === undefined)');
    expect(guarded).to.contain('return;');
    expect(guarded).to.contain("id: 'default'");
    expect(guarded).to.contain("id: 'keep'");
  });

  test('the chosen model is passed to the settings update', () => {
    expect(selectProviderBody()).to.contain(
      'await settings.updateProviderType(picked.id, baseUrl, model);',
    );
  });
});

suite('approval modal formatting (D10)', () => {
  test('change approval detail uses real newlines, not literal backslash-n', () => {
    const source = readFileSync(join(__dirname, '..', '..', '..', 'src', 'agent', 'runtime.ts'), 'utf8');
    const backslash = String.fromCharCode(92);
    expect(source).to.contain(`.join('${backslash}n')`);
    expect(source).to.not.contain(`${backslash}${backslash}n`);
  });
});