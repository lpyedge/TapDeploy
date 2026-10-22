import { expect, it, vi } from "vitest";
import { createCloudflareClient } from "../../src/cloudflare/client/client.js";
import {
  consumerRequestFor,
  registerQueueConsumer,
} from "../../src/cloudflare/resources/queues.js";
it("Worker consumer uses documented type and a retry makes no duplicate create", async () => {
  let consumers: unknown[] = [];
  const writes = vi.fn();
  const client = createCloudflareClient({ accountId: "a".repeat(32), accessToken: "fake", fetcher: async (_url, init) => {
    if (init?.method === "GET") return Response.json({ success: true, result: consumers });
    const body = JSON.parse(String(init?.body));
    writes(body);
    expect(body).toEqual({ type: "worker", script_name: "app" });
    consumers = [{ consumer_id: "consumer", type: "worker", script_name: "app" }];
    return Response.json({ success: true, result: consumers[0] });
  } });
  expect(await registerQueueConsumer(client, "q", undefined, { script_name: "app" })).toBe("consumer");
  expect(await registerQueueConsumer(client, "q", undefined, { script_name: "app" })).toBe("consumer");
  expect(writes).toHaveBeenCalledOnce();
});
it("lookup-to-create cutover and existing other consumers stop before writes", async () => {
  for (const conflict of [false, true]) {
    const createQueueConsumer = vi.fn();
    const guard = vi.fn(async () => { throw new Error("external cutover"); });
    const client = { listQueueConsumers: vi.fn(async () => conflict ? [{ consumer_id: "other", type: "worker", script_name: "foreign" }] : []), createQueueConsumer } as unknown as ReturnType<typeof createCloudflareClient>;
    await expect(registerQueueConsumer(client, "q", undefined, { script_name: "app" }, guard)).rejects.toBeDefined();
    expect(createQueueConsumer).not.toHaveBeenCalled();
    expect(guard).toHaveBeenCalledTimes(conflict ? 0 : 1);
  }
});
it("settings/dead-letter consumer uses the official body and re-registration fails closed", async () => {
  let consumers: unknown[] = [];
  const writes = vi.fn();
  const client = createCloudflareClient({ accountId: "a".repeat(32), accessToken: "fake", fetcher: async (_url, init) => {
    if (init?.method === "GET") return Response.json({ success: true, result: consumers });
    const body = JSON.parse(String(init?.body));
    writes(body);
    expect(body).toEqual({
      type: "worker",
      script_name: "app",
      dead_letter_queue: "jobs-dlq",
      settings: {
        batch_size: 5,
        max_wait_time_ms: 30000,
        max_retries: 2,
        max_concurrency: 4,
        retry_delay: 10,
      },
    });
    consumers = [{ consumer_id: "consumer", type: "worker", script_name: "app" }];
    return Response.json({ success: true, result: consumers[0] });
  } });
  const request = consumerRequestFor(
    {
      queue: "jobs",
      type: "worker",
      max_batch_size: 5,
      max_batch_timeout: 30,
      max_retries: 2,
      max_concurrency: 4,
      retry_delay: 10,
      dead_letter_queue: "jobs-dlq",
    },
    "app",
  );
  expect(await registerQueueConsumer(client, "q", undefined, request)).toBe("consumer");
  expect(writes).toHaveBeenCalledOnce();
  // A settings-bearing re-registration cannot be proven identical (live
  // settings readback is identity-only); it fails closed without a write.
  await expect(
    registerQueueConsumer(client, "q", undefined, request),
  ).rejects.toThrow(/explicit immutable consumer identity/);
  expect(writes).toHaveBeenCalledOnce();
});
