// Cloudflare Queues shapes returned/consumed by the v4 management API.
//
// Official list returns `result[]` of queue objects keyed by `queue_id` with
// `queue_name`, `settings`, `consumers[]`, `producers[]` and counts. The
// installer maps `queue_id` into `id` (stable identity) and mirrors
// `queue_name` into `name` so callers have a consistent identity across
// resources (the R2/D1/KV convention).

interface QueueSettings {
  delivery_delay?: number;
  delivery_paused?: boolean;
  message_retention_period?: number;
}

export interface QueueConsumerSettings {
  batch_size?: number;
  max_concurrency?: number;
  max_retries?: number;
  max_wait_time_ms?: number;
  retry_delay?: number;
  visibility_timeout_ms?: number;
}

export interface QueueConsumer {
  type?: "worker" | "http_pull";
  consumer_id?: string;
  queue_name?: string;
  script_name?: string;
  dead_letter_queue?: string;
  created_on?: string;
  settings?: QueueConsumerSettings;
}

export interface Queue {
  id: string;
  queue_id: string;
  queue_name: string;
  // Mirrored from queue_name so callers reference the human-readable identity
  // without switching field names (the R2/D1/KV model convention).
  name: string;
  created_on?: string;
  settings?: QueueSettings;
  producers_total_count?: number;
  consumers_total_count?: number;
  producers?: Array<{ script?: string; bucket_name?: string; type?: string }>;
  consumers?: QueueConsumer[];
}

export interface QueueCreateRequest {
  queue_name: string;
  settings?: QueueSettings;
}

export interface QueueConsumerRequest {
  script_name: string;
  dead_letter_queue?: string;
  settings?: QueueConsumerSettings;
}
