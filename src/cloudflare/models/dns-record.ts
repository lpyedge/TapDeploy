

export interface DnsRecord {
  id: string;
  // Full record name including the zone, in Punycode.
  name: string;
  type: string;
  content?: string;
  ttl?: number;
  proxied?: boolean;
  comment?: string;
  created_on?: string;
  modified_on?: string;
}

export interface DnsRecordCreateRequest {
  type: string;
  name: string;
  content: string;
  ttl?: number;
  proxied?: boolean;
  comment?: string;
}

export interface DnsRecordUpdateRequest {
  // Overwrite accepts the same shape as create; only the fields the installer
  // manages are forwarded (the provider keeps metadata like created_on).
  type?: string;
  name?: string;
  content?: string;
  ttl?: number;
  proxied?: boolean;
  comment?: string;
}
