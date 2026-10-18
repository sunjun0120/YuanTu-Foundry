/** The background-delivery policy and ledger a session exposes to its clients. */

export interface BackgroundPolicy {
  mode: 'notify' | 'auto';
  paused: boolean;
  maxWakeups: number;
  maxRunMs: number;
  epoch: string;
  used: number;
}
export interface BackgroundDelivery {
  id: string;
  kind: 'command' | 'subagent';
  producerId: string;
  childSessionId?: string;
  status: string;
  cleanupUnknown?: boolean;
  state: 'pending' | 'admitted' | 'processed';
  reason?: string;
  at: string;
}
export interface BackgroundState {
  policy: BackgroundPolicy;
  deliveries: BackgroundDelivery[];
}
export type BackgroundPolicyInput = Pick<
  BackgroundPolicy,
  'mode' | 'paused' | 'maxWakeups' | 'maxRunMs'
>;
