// Cloudflare Queue adapter.
//
// A Queue is a distinct account resource. The installer only ever creates an
// explicitly-declared-and-permitted missing queue; an existing queue is
// preserved by identity and never recreated, drained, or overwritten. There is
// no delete path and no message mutation (the release owns its message
// lifecycle). The binding carried into the Worker version is the producer
// binding; a consumer trigger is registered separately on the queue's
// consumers subresource (never auto-drained or auto-deleted).

import type { CloudflareApiClient } from "../client/index.js";
import type { QueueBindingSpec } from "../../core/deploy-spec.js";
import type { Queue, QueueConsumerRequest, QueueConsumerSettings } from "../models/index.js";
import {
  ResourceConflictError,
  type ResourceAdapter,
  type ResourceSupport,
} from "./types.js";

export const QUEUE_SUPPORT: ResourceSupport = {
  kind: "queue",
  label: "Queue",
  install: "create-declared",
  upgrade: "preserve",
  deletes: "never",
  verified: "local-contract",
};

export const queueAdapter: ResourceAdapter = {
  support: QUEUE_SUPPORT,
  mutation: "ensureQueue",
};

export type QueueAction =
  | { binding?: string; queueName: string; action: "preserve"; id: string }
  | { binding?: string; queueName: string; action: "create" }
  | { binding?: string; queueName: string; action: "conflict"; detail: string };

type KnownQueues = readonly Pick<Queue, "name" | "id">[];

// Pure: decide what should happen to one declared queue binding against live queues.
export function queueActionFor(
  binding: QueueBindingSpec,
  knownQueues: KnownQueues,
): QueueAction {
  const existing = knownQueues.find((q) => q.name === binding.queueName);
  if (existing) {
    return {
      binding: binding.binding,
      queueName: binding.queueName,
      action: "preserve",
      id: existing.id,
    };
  }
  if (binding.createIfMissing) {
    return {
      binding: binding.binding,
      queueName: binding.queueName,
      action: "create",
    };
  }
  return {
    binding: binding.binding,
    queueName: binding.queueName,
    action: "conflict",
    detail: `Queue "${binding.queueName}" is missing and createIfMissing=false`,
  };
}

export interface EnsureQueueRequest {
  queueName: string;
  createIfMissing: boolean;
  knownQueues: KnownQueues;
}

export type EnsureQueueResult =
  | { action: "preserve"; name: string; id: string }
  | { action: "create"; name: string; id: string };

export async function ensureQueue(
  client: CloudflareApiClient,
  request: EnsureQueueRequest,
): Promise<EnsureQueueResult> {
  const action = queueActionFor(
    { binding: "", queueName: request.queueName, createIfMissing: request.createIfMissing },
    request.knownQueues,
  );
  if (action.action === "preserve") {
    return { action: "preserve", name: action.queueName, id: action.id };
  }
  if (action.action === "conflict") {
    throw new ResourceConflictError(action.detail);
  }
  const created = await client.createQueue({ queue_name: request.queueName });
  return { action: "create", name: created.name, id: created.id };
}

// Register (create-or-update) a consumer trigger on an existing queue. The
// consumer body is identity/trigger-only; the queue and its messages are never
// mutated here. `consumerId` lets a caller update an existing consumer; when
// absent the provider endpoint creates it.
export async function registerQueueConsumer(
  client: CloudflareApiClient,
  queueId: string,
  consumerId: string | undefined,
  request: QueueConsumerRequest,
  beforeMutation?: () => Promise<void>,
): Promise<string> {
  const consumers = await client.listQueueConsumers(queueId);
  const matching = consumers.filter(c => c.script_name === request.script_name && c.type === "worker");
  if (matching.length === 1 && matching[0]?.consumer_id && !consumerId && !request.settings && !request.dead_letter_queue) return matching[0].consumer_id;
  if (matching.length && !consumerId) throw new ResourceConflictError("existing consumer configuration changes require an explicit immutable consumer identity");
  if (consumers.some(c => c.type !== "worker" || c.script_name !== request.script_name || !c.consumer_id) || matching.length > 1 || (consumerId && matching[0]?.consumer_id !== consumerId)) throw new ResourceConflictError("existing consumer is ambiguous or belongs to another target; explicit consumer replacement is unsupported");
  await beforeMutation?.();
  const consumer = consumerId
    ? await client.putQueueConsumer(queueId, consumerId, request)
    : await client.createQueueConsumer(queueId, request);
  if (!consumer.consumer_id) throw new ResourceConflictError("provider consumer identity unavailable; inspect remote state before retry");
  return consumer.consumer_id;
}

// ---------------------------------------------------------------------------
// projections from the final Wrangler config (queues.producers /
// queues.consumers). A producer becomes a Worker environment binding; a
// consumer becomes a consumer-trigger registration on the queue's consumers
// subresource and never produces an environment binding.
// ---------------------------------------------------------------------------

// A declared consumer trigger from the final Wrangler config. Structurally
// matches WranglerV3QueueConsumer; the adapter takes the minimal shape so it
// stays independent of the manifest layer. `visibility_timeout_ms` is refused
// at parse time (the official worker-consumer upload never applies it).
export interface DeclaredQueueConsumer {
  queue: string;
  type: "worker";
  max_batch_size?: number;
  max_batch_timeout?: number;
  max_retries?: number;
  max_concurrency?: number | null;
  retry_delay?: number;
  dead_letter_queue?: string;
}

// Project one declared Wrangler queue consumer to the provider consumer
// request. Field mapping follows the official upload exactly:
//   max_batch_size      -> settings.batch_size
//   max_batch_timeout   -> settings.max_wait_time_ms (seconds × 1000)
//   max_retries         -> settings.max_retries
//   max_concurrency     -> settings.max_concurrency (null = explicitly
//                          unlimited, which the provider treats the same as
//                          unset, so it is omitted rather than sent as null)
//   retry_delay         -> settings.retry_delay (seconds)
//   dead_letter_queue   -> dead_letter_queue
// Only fields the release declared are sent; nothing is defaulted in. The
// caller supplies the verified script name (the Worker the trigger targets).
export function consumerRequestFor(
  consumer: DeclaredQueueConsumer,
  scriptName: string,
): QueueConsumerRequest {
  const settings: QueueConsumerSettings = {};
  if (consumer.max_batch_size !== undefined) {
    settings.batch_size = consumer.max_batch_size;
  }
  if (consumer.max_batch_timeout !== undefined) {
    settings.max_wait_time_ms = consumer.max_batch_timeout * 1000;
  }
  if (consumer.max_retries !== undefined) {
    settings.max_retries = consumer.max_retries;
  }
  if (consumer.max_concurrency !== undefined && consumer.max_concurrency !== null) {
    settings.max_concurrency = consumer.max_concurrency;
  }
  if (consumer.retry_delay !== undefined) {
    settings.retry_delay = consumer.retry_delay;
  }
  const request: QueueConsumerRequest = { script_name: scriptName };
  if (Object.keys(settings).length > 0) {
    request.settings = settings;
  }
  if (consumer.dead_letter_queue !== undefined) {
    request.dead_letter_queue = consumer.dead_letter_queue;
  }
  return request;
}

// does the live consumer already satisfy the declared consumer request?
// Only fields the release actually declares are compared; provider-defaulted
// settings the release does not manage are ignored so an undeclared default
// never forces a rewrite. Consumer identity (script target) is compared by the
// caller against the exact Worker.
export function declaredQueueConsumerMatches(
  request: QueueConsumerRequest,
  live: { settings?: QueueConsumerSettings; dead_letter_queue?: string },
): boolean {
  if (request.dead_letter_queue !== undefined && (live.dead_letter_queue ?? "") !== request.dead_letter_queue) {
    return false;
  }
  for (const [key, value] of Object.entries(request.settings ?? {})) {
    if ((live.settings as Record<string, unknown> | undefined)?.[key] !== value) {
      return false;
    }
  }
  return true;
}

// Project one declared producer to the official Worker binding shape
// ({type:"queue", name, queue_name}). `resolvedQueueName` is the queue name
// that the ensure step verified against the live account; the binding must
// carry that verified identity, never an unverified literal.
export function producerBindingFor(
  producer: { binding: string; queue: string },
  resolvedQueueName: string,
): { type: "queue"; name: string; queue_name: string } {
  return { type: "queue", name: producer.binding, queue_name: resolvedQueueName };
}
