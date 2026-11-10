import { spawn } from 'node:child_process';
import { planCommand } from '../commands/executionPlan';
import { redactSecrets } from '../security/redact';
import type { ToolchainInfo, ToolchainProbe } from './types';

const PROBE_TIMEOUT_MS = 8_000;
const MAX_PROBE_OUTPUT = 8_000;
const VERSION_PATTERN = /\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?/;

function probeOutput(child: ReturnType<typeof spawn>, limit: number): Promise<{ text: string; code: number | null }> {
  return new Promise((resolve) => {
    let text = '';
    const append = (chunk: Buffer | string): void => {
      if (text.length < limit) {
        text += chunk.toString('utf8').slice(0, limit - text.length);
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', () => resolve({ text: '', code: null }));
    child.on('close', (code) => resolve({ text: redactSecrets(text).text, code }));
  });
}

/**
 * Probes a bare command name with `--version`/`version` under the same
 * no-shell rules as the command runner. Never uses a shell or a completion
 * string; anything that does not resolve to a binary or batch wrapper is
 * reported unavailable instead of being approximated.
 */
export async function probeToolchain(probe: ToolchainProbe): Promise<ToolchainInfo> {
  const args = [...(probe.versionArgs.length > 0 ? probe.versionArgs : ['--version'])];
  const plan = planCommand({ tokens: [probe.executable, ...args] });
  if (!plan.ok) {
    return { available: false, name: probe.name, detail: plan.reason };
  }
  const execution = plan.plan;
  const child = spawn(execution.file, [...execution.args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: execution.verbatimArguments,
    env: process.env,
  });
  const timeout = setTimeout(() => {
    child.kill('SIGTERM');
  }, PROBE_TIMEOUT_MS);
  const { text, code } = await probeOutput(child, MAX_PROBE_OUTPUT);
  clearTimeout(timeout);
  const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
  if (code === null && text.length === 0) {
    return {
      available: false,
      name: probe.name,
      path: execution.file,
      detail: 'The executable could not be started.',
    };
  }
  // Prefer the first meaningful version match; fall back to scanning all output
  // (some tools print banners or separators before the version line).
  const firstLineVersion = VERSION_PATTERN.exec(firstLine);
  const versionMatch = firstLineVersion ?? VERSION_PATTERN.exec(text);
  return {
    available: true,
    name: probe.name,
    path: execution.file,
    version: versionMatch?.[0],
    detail: firstLine.trim().slice(0, 200),
  };
}
