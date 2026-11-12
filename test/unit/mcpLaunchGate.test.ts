import { expect } from 'chai';
import { decideMcpLaunchApproval } from '../../src/commands/mcpLaunchGate';

suite('MCP management launch gate', () => {
  test('refuses without a trust grant, even if the prompt would approve', async () => {
    let prompted = false;
    const outcome = await decideMcpLaunchApproval({
      trusted: () => false,
      prompt: async () => {
        prompted = true;
        return true;
      },
    });
    expect(outcome).to.deep.equal({ ok: false, reason: 'untrusted' });
    expect(prompted).to.equal(false);
  });

  test('a throwing trust check never escalates to a prompt or a grant', async () => {
    let prompted = false;
    const outcome = await decideMcpLaunchApproval({
      trusted: () => {
        throw new Error('host trust unavailable');
      },
      prompt: async () => {
        prompted = true;
        return true;
      },
    });
    expect(outcome).to.deep.equal({ ok: false, reason: 'untrusted' });
    expect(prompted).to.equal(false);
  });

  test('a non-boolean trust value is not a grant (only exact true passes)', async () => {
    const outcome = await decideMcpLaunchApproval({
      trusted: () => 1 as unknown as boolean,
      prompt: async () => true,
    });
    expect(outcome).to.deep.equal({ ok: false, reason: 'untrusted' });
  });

  test('trusted + denial stops the launch', async () => {
    const outcome = await decideMcpLaunchApproval({
      trusted: () => true,
      prompt: async () => false,
    });
    expect(outcome).to.deep.equal({ ok: false, reason: 'denied' });
  });

  test('a failing approval prompt is a denial, never a grant', async () => {
    const outcome = await decideMcpLaunchApproval({
      trusted: () => true,
      prompt: async () => {
        throw new Error('modal unavailable');
      },
    });
    expect(outcome).to.deep.equal({ ok: false, reason: 'denied' });
  });

  test('trusted + explicit approval launches', async () => {
    const outcome = await decideMcpLaunchApproval({
      trusted: () => true,
      prompt: async () => true,
    });
    expect(outcome).to.deep.equal({ ok: true });
  });
});
