/**
 * Which adapter serves which protocol, as a table rather than a `switch`.
 *
 * A `switch` inside `createProvider` answered this before, which meant three things: only this repository could
 * add a protocol (a host embedding the kernel had to write its own factory and bypass the entry point), the set
 * of known protocols lived in the settings table *and* in the code, and "which protocols do you support?" had no
 * answer a caller, a doctor or an error message could ask for.
 *
 * The registry is keyed by protocol name and a later `registerProvider` for the same name replaces the earlier
 * one. Replacement rather than refusal is deliberate: a test double and a host that overrides one protocol are
 * both "same name, different factory", and both are legitimate.
 */
import type { Provider } from '../protocol/index.ts';
import type { ProviderConfig } from './config.ts';
import { BUILTIN_PROTOCOLS } from '../protocol/index.ts';
import { AnthropicProvider } from './anthropic.ts';
import { OpenAIProvider } from './openai.ts';
import { ResponsesProvider } from './responses.ts';
export type ProviderFactory = (config: ProviderConfig) => Provider;
const FACTORIES = new Map<string, ProviderFactory>();
/**
 * The names this build knows, in registration order.
 *
 * Read by `createProvider`'s error message and by callers that want to offer a choice, so an embedding host
 * never has to restate the list to explain a bad value.
 */
export function providerProtocols(): string[] {
  return [...FACTORIES.keys()];
}
export function hasProvider(protocol: string): boolean {
  return FACTORIES.has(protocol);
}
export function registerProvider(protocol: string, factory: ProviderFactory): void {
  if (!protocol.trim()) throw new Error('Provider protocol name must not be empty');
  FACTORIES.set(protocol, factory);
}
export function createProvider(config: ProviderConfig): Provider {
  const protocol = config.protocol ?? BUILTIN_PROTOCOLS[0];
  const factory = FACTORIES.get(protocol);
  if (!factory)
    throw new Error(
      `Unsupported model protocol: ${protocol}. Known protocols: ${providerProtocols().join(', ')}`,
    );
  return factory(config);
}
/**
 * The built-in adapters, registered at import time.
 *
 * Every protocol in `BUILTIN_PROTOCOLS` must have a factory here or `createProvider` would refuse a name the
 * settings table accepts; that is why the two are declared next to each other and why a missing one is a
 * startup error rather than a mystery at request time.
 */
registerProvider('anthropic', (config) => new AnthropicProvider(config));
registerProvider('openai', (config) => new OpenAIProvider(config));
registerProvider('openai-responses', (config) => new ResponsesProvider(config));
