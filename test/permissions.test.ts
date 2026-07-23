// The permission broker mapping: policy × offered options → wire outcome.
// Precedence: cancelled marker > explicit optionId > action→first matching
// option > cancelled fallback.

import { describe, it, expect } from "vitest";
import { AcpQuery, InteractionBroker, type PermissionDecision } from "../src/index.js";
import { mockAcpAgent } from "../src/testing/mockAgent.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

type Outcome = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

/** Run one prompt turn whose agent asks permission with `options`; resolve the
 * queued interaction with `decision`; return the outcome the agent saw. */
async function askViaUi(
  options: Array<{ optionId: string; name: string; kind: string }> | undefined,
  decision: PermissionDecision,
): Promise<{ outcome: Outcome; broker: InteractionBroker<PermissionDecision> }> {
  const broker = new InteractionBroker<PermissionDecision>();
  const q = new AcpQuery({ interactions: broker });
  let outcome!: Outcome;
  q.connect(
    mockAcpAgent({
      onPrompt: async ({ askPermission }) => {
        outcome = await askPermission(options);
      },
    }),
  );
  const sid = await q.newSession();
  const turn = q.prompt(sid, "do it");
  for (let i = 0; i < 200 && broker.list().length === 0; i++) await tick();
  broker.resolve(broker.list()[0]!.id, decision);
  await turn;
  await q.close();
  return { outcome, broker };
}

const opts = (kinds: Array<[string, string]>) =>
  kinds.map(([optionId, kind]) => ({ optionId, name: optionId, kind }));

describe("permission mapping precedence", () => {
  it("explicit optionId wins over the action-based mapping", async () => {
    const { outcome } = await askViaUi(
      opts([["ok", "allow_once"], ["always", "allow_always"], ["no", "reject_once"]]),
      { action: "deny", optionId: "always" }, // contradictory action — optionId wins
    );
    expect(outcome).toEqual({ outcome: "selected", optionId: "always" });
  });

  it("approve without optionId picks the FIRST allow_* option", async () => {
    const { outcome } = await askViaUi(
      opts([["no", "reject_once"], ["ok", "allow_once"], ["always", "allow_always"]]),
      { action: "approve" },
    );
    expect(outcome).toEqual({ outcome: "selected", optionId: "ok" });
  });

  it("deny without optionId picks the FIRST reject_* option", async () => {
    const { outcome } = await askViaUi(
      opts([["ok", "allow_once"], ["never", "reject_always"], ["no", "reject_once"]]),
      { action: "deny" },
    );
    expect(outcome).toEqual({ outcome: "selected", optionId: "never" });
  });

  it("approve when the agent offered no allow option → cancelled", async () => {
    const { outcome } = await askViaUi(opts([["no", "reject_once"]]), { action: "approve" });
    expect(outcome).toEqual({ outcome: "cancelled" });
  });

  it("no options at all → cancelled regardless of decision", async () => {
    const { outcome } = await askViaUi([], { action: "approve" });
    expect(outcome).toEqual({ outcome: "cancelled" });
  });

  it("cancelled marker → cancelled even with an explicit optionId", async () => {
    const { outcome, broker } = await askViaUi(
      opts([["ok", "allow_once"], ["no", "reject_once"]]),
      { action: "deny", optionId: "ok", cancelled: true },
    );
    expect(outcome).toEqual({ outcome: "cancelled" });
    expect(broker.auditLog().at(-1)?.outcome).toBe("denied");
  });
});

describe("policy paths", () => {
  it('"allow" policy auto-approves with the first allow option (allow_always honored)', async () => {
    const broker = new InteractionBroker<PermissionDecision>({ policy: () => "allow" });
    const q = new AcpQuery({ interactions: broker });
    let outcome!: Outcome;
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ askPermission }) => {
          outcome = await askPermission(
            opts([["always", "allow_always"], ["ok", "allow_once"], ["no", "reject_once"]]),
          );
        },
      }),
    );
    const sid = await q.newSession();
    await q.prompt(sid, "go");
    expect(outcome).toEqual({ outcome: "selected", optionId: "always" });
    expect(broker.list()).toHaveLength(0); // never queued for a human
    expect(broker.auditLog().at(-1)?.outcome).toBe("auto-allow");
    await q.close();
  });

  it('"deny" policy with no reject option auto-answers cancelled', async () => {
    const broker = new InteractionBroker<PermissionDecision>({ policy: () => "deny" });
    const q = new AcpQuery({ interactions: broker });
    let outcome!: Outcome;
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ askPermission }) => {
          outcome = await askPermission(opts([["ok", "allow_once"]]));
        },
      }),
    );
    const sid = await q.newSession();
    await q.prompt(sid, "go");
    expect(outcome).toEqual({ outcome: "cancelled" });
    await q.close();
  });
});

describe("no-broker fail-safe", () => {
  it("with no reject option either, the request is answered cancelled", async () => {
    const q = new AcpQuery(); // no broker
    let outcome!: Outcome;
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ askPermission }) => {
          outcome = await askPermission(opts([["ok", "allow_once"], ["sure", "allow_always"]]));
        },
      }),
    );
    const sid = await q.newSession();
    await q.prompt(sid, "go");
    expect(outcome).toEqual({ outcome: "cancelled" });
    await q.close();
  });
});

describe("peer labeling", () => {
  it("connect(agent, {name}) labels broker interactions and audit entries", async () => {
    const broker = new InteractionBroker<PermissionDecision>();
    const q = new AcpQuery({ interactions: broker });
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ askPermission }) => {
          await askPermission();
        },
      }),
      { name: "claude-code" },
    );
    const sid = await q.newSession();
    const turn = q.prompt(sid, "go");
    for (let i = 0; i < 200 && broker.list().length === 0; i++) await tick();
    expect(broker.list()[0]!.peer).toBe("claude-code");
    broker.resolve(broker.list()[0]!.id, { action: "approve" });
    await turn;
    expect(broker.auditLog().at(-1)?.peer).toBe("claude-code");
    await q.close();
  });

  it("peer defaults to 'agent' when no label is given", async () => {
    const broker = new InteractionBroker<PermissionDecision>({ policy: () => "deny" });
    const q = new AcpQuery({ interactions: broker });
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ askPermission }) => {
          await askPermission();
        },
      }),
    );
    const sid = await q.newSession();
    await q.prompt(sid, "go");
    expect(broker.auditLog().at(-1)?.peer).toBe("agent");
    await q.close();
  });
});
