export interface GreetingOptions {
  readonly name: string;
  readonly excited?: boolean;
}

export function greet(options: GreetingOptions): string {
  const suffix = options.excited === true ? '!' : '.';
  return `Hello, ${options.name}${suffix}`;
}

export const DEMO_API_KEY = 'sk-demo-not-a-real-key-000000000000';
