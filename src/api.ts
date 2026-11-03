import type { ProviderStatus } from './providers/completionService';

/**
 * Narrow public surface returned from activate(). It intentionally exposes no
 * credential values, no file contents, and no completion-execution hook.
 */
export interface QuantsMindApi {
  readonly version: string;
  getProviderStatus(): Promise<ProviderStatus>;
  revealChat(): Promise<void>;
}
