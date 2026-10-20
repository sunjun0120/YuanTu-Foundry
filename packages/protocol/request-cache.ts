/** Hashes and counts of serialized input; no prompt text or credentials are retained here. */
export interface RequestFingerprint {
  routeHash: string;
  systemHash: string;
  toolsHash: string;
  configurationHash: string;
  historyHash: string;
  messageCount: number;
}

/** Prefix hashes are transient comparison data and must not be copied into durable measurements. */
export interface PreparedRequestFingerprint extends RequestFingerprint {
  historyPrefixes: string[];
}
